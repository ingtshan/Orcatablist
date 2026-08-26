import { closeSync, existsSync, openSync, readSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  FTS_TEXT_MAX_CHARS, ORCATAB_CLAUDE_DIR, ORCATAB_CODEX_DIR, ORCATAB_HERMES_DB,
  RESCAN_INTERVAL_MS, WATCH_DEBOUNCE_MS,
} from "./config";
import { getDefaultDatabase, type FtsRow, type OrcaDatabase, type StoredSession } from "./db";
import { cleanPromptForDisplay } from "./parse";
import {
  createProjectDeps, mergeDeletedWorktreeProjects, mergeOrcaWorkspaceProjects, resolveProjectKey,
} from "./projects";
import { createClaudeSource } from "./sources/claude";
import { createCodexSource } from "./sources/codex";
import { createHermesSource } from "./sources/hermes";
import type { Agent, ParsedEvent } from "./types";

const BYTE_NEWLINE = 0x0a;

export interface IndexSummary { files: number; changed: number; ms: number; }
export interface WatchHandle { mode: "fs.watch" | "timer"; close(): void; }
export interface SessionFileInfo { agent: Agent; sid: string; path: string; size: number; mtime: number; }
export interface DerivedSession { session: StoredSession; fts: FtsRow[]; }
export interface SessionSource {
  agent: Agent;
  discover(): SessionFileInfo[];
  parseLine(line: string): ParsedEvent;
  prepare?(): void;
  titleFor?(sid: string): string | null;
  deriveSession?(info: SessionFileInfo, base: StoredSession): DerivedSession;
}
export interface IndexerOptions {
  claudeDir?: string;
  codexDir?: string;
  hermesDb?: string;
  sources?: SessionSource[];
  db?: OrcaDatabase;
  resolveProject?: typeof resolveProjectKey;
  now?: () => number;
}

interface CompleteRead { lines: string[]; consumedBytes: number; }

function uniqueSessionFiles(files: SessionFileInfo[]): SessionFileInfo[] {
  const latestBySession = new Map<string, SessionFileInfo>();
  for (const file of files) {
    const key = `${file.agent}/${file.sid}`;
    const current = latestBySession.get(key);
    if (current === undefined || file.path.localeCompare(current.path) > 0) latestBySession.set(key, file);
  }
  return [...latestBySession.values()];
}

function readCompleteLines(path: string, offset: number, size: number): CompleteRead {
  const byteLength = size - offset;
  if (byteLength <= 0) return { lines: [], consumedBytes: 0 };
  const buffer = Buffer.allocUnsafe(byteLength);
  const descriptor = openSync(path, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < byteLength) {
      const count = readSync(descriptor, buffer, bytesRead, byteLength - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(descriptor);
  }
  const complete = buffer.subarray(0, bytesRead);
  const finalNewline = complete.lastIndexOf(BYTE_NEWLINE);
  if (finalNewline < 0) return { lines: [], consumedBytes: 0 };
  const text = complete.subarray(0, finalNewline).toString("utf8");
  return { lines: text ? text.split("\n") : [], consumedBytes: finalNewline + 1 };
}

function emptySession(file: SessionFileInfo): StoredSession {
  return {
    agent: file.agent, sid: file.sid, projectKey: "unknown", cwd: null, branch: null, title: null,
    firstPrompt: null, lastPrompt: null, lastInputAt: null, promptCount: 0, filePath: file.path,
    fileSize: 0, fileMtime: 0, parsedOffset: 0,
  };
}

function applyLines(base: StoredSession, lines: string[], source: SessionSource): { session: StoredSession; fts: FtsRow[] } {
  let session = { ...base };
  const fts: FtsRow[] = [];
  for (const line of lines) {
    const event = source.parseLine(line);
    if (session.cwd === null && event.cwd) {
      session = { ...session, cwd: event.cwd, branch: event.branch ?? session.branch };
    }
    if (event.kind === "title" && event.title !== undefined) session = { ...session, title: event.title };
    if (event.kind === "prompt" && event.text !== undefined) {
      const cleaned = cleanPromptForDisplay(event.text);
      session = {
        ...session,
        firstPrompt: session.firstPrompt ?? (cleaned || null),
        lastPrompt: cleaned ? cleaned : session.lastPrompt,
        lastInputAt: event.ts === null || event.ts === undefined
          ? session.lastInputAt : Math.max(session.lastInputAt ?? event.ts, event.ts),
        promptCount: session.promptCount + 1,
      };
      fts.push({ text: event.text.slice(0, FTS_TEXT_MAX_CHARS), agent: session.agent, sid: session.sid, role: "user", ts: event.ts ?? null });
    }
    if (event.kind === "assistant-text" && event.text !== undefined) {
      fts.push({ text: event.text.slice(0, FTS_TEXT_MAX_CHARS), agent: session.agent, sid: session.sid, role: "assistant", ts: event.ts ?? null });
    }
  }
  return { session, fts };
}

export function createIndexer(options: IndexerOptions = {}) {
  const claudeDir = options.claudeDir ?? ORCATAB_CLAUDE_DIR;
  const codexDir = options.codexDir ?? ORCATAB_CODEX_DIR;
  const hermesDb = options.hermesDb ?? ORCATAB_HERMES_DB;
  const sources = options.sources ?? [
    createClaudeSource(claudeDir), createCodexSource(codexDir), createHermesSource(hermesDb),
  ];
  const sourcesByAgent = new Map(sources.map((source) => [source.agent, source]));
  const watchPaths = [join(claudeDir, "projects"), join(codexDir, "sessions")];
  const db = options.db ?? getDefaultDatabase();
  const projectDeps = createProjectDeps(db);
  const projectResolver = options.resolveProject ?? resolveProjectKey;
  const now = options.now ?? Date.now;
  let activeRun: Promise<IndexSummary> | null = null;
  let rerunRequested = false;

  async function indexFile(file: SessionFileInfo): Promise<boolean> {
    const source = sourcesByAgent.get(file.agent);
    if (source === undefined) throw new Error(`missing session source for ${file.agent}`);
    const stored = db.getStoredSession(file.agent, file.sid);
    const sourceTitle = source.titleFor?.(file.sid);
    if (stored && stored.filePath === file.path && stored.fileSize === file.size && stored.fileMtime === file.mtime) {
      if (source.titleFor === undefined || stored.title === sourceTitle) return false;
      db.upsertSession({ ...stored, title: sourceTitle ?? null });
      return true;
    }
    if (source.deriveSession !== undefined) {
      const derived = source.deriveSession(file, stored ?? emptySession(file));
      const project = await projectResolver(derived.session.cwd, projectDeps);
      const session: StoredSession = {
        ...derived.session, projectKey: project.key, filePath: file.path,
        fileSize: file.size, fileMtime: file.mtime,
      };
      db.transaction(() => {
        db.deleteSessionFts(file.agent, file.sid);
        db.upsertProject(project);
        db.appendSessionFts(derived.fts);
        db.upsertSession(session);
      });
      return true;
    }
    const rebuild = stored === null || stored.filePath !== file.path || file.size < stored.fileSize
      || (file.size === stored.fileSize && file.mtime !== stored.fileMtime);
    const base = rebuild ? emptySession(file) : stored;
    const parseBase = source.titleFor === undefined ? base : { ...base, title: null };
    const offset = rebuild ? 0 : base.parsedOffset;
    const read = readCompleteLines(file.path, offset, file.size);
    const parsed = applyLines(parseBase, read.lines, source);
    const project = await projectResolver(parsed.session.cwd, projectDeps);
    const session: StoredSession = {
      ...parsed.session, title: sourceTitle ?? parsed.session.title, projectKey: project.key, filePath: file.path,
      fileSize: file.size, fileMtime: file.mtime, parsedOffset: offset + read.consumedBytes,
    };
    db.transaction(() => {
      if (rebuild) db.deleteSessionFts(file.agent, file.sid);
      db.upsertProject(project);
      db.appendSessionFts(parsed.fts);
      db.upsertSession(session);
    });
    return true;
  }

  async function performIndexAll(): Promise<IndexSummary> {
    const startedAt = now();
    for (const source of sources) source.prepare?.();
    const files = uniqueSessionFiles(sources.flatMap((source) => source.discover()));
    let changed = 0;
    for (const file of files) if (await indexFile(file)) changed += 1;
    if (changed > 0) db.bumpDataVersion();
    mergeOrcaWorkspaceProjects(db);
    mergeDeletedWorktreeProjects(db);
    db.setMeta("indexed_at", String(now()));
    return { files: files.length, changed, ms: Math.max(0, Math.round(now() - startedAt)) };
  }

  function indexAll(): Promise<IndexSummary> {
    if (activeRun !== null) {
      rerunRequested = true;
      return activeRun;
    }
    activeRun = (async () => {
      let summary: IndexSummary;
      do {
        rerunRequested = false;
        summary = await performIndexAll();
      } while (rerunRequested);
      return summary;
    })().finally(() => { activeRun = null; });
    return activeRun;
  }

  function runBackground(source: string): void {
    void indexAll().catch((error) => console.error(`orcatab ${source} rescan failed`, error));
  }

  function startWatcher(onFailure?: () => void): WatchHandle {
    const watchers: FSWatcher[] = [];
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let failed = false;
    const close = () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      for (const watcher of watchers) watcher.close();
    };
    try {
      for (const path of watchPaths.filter(existsSync)) {
        watchers.push(watch(path, { recursive: true }, () => {
          if (debounceTimer !== null) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => runBackground("watch"), WATCH_DEBOUNCE_MS);
          debounceTimer.unref?.();
        }));
      }
      if (watchers.length === 0) throw new Error("no session directories available to watch");
      const handle: WatchHandle = { mode: "fs.watch", close };
      for (const watcher of watchers) {
        watcher.on("error", (error) => {
          if (failed) return;
          failed = true;
          handle.mode = "timer";
          console.error("orcatab fs.watch failed; using timer fallback", error);
          close();
          onFailure?.();
        });
      }
      return handle;
    } catch (error) {
      console.error("orcatab fs.watch failed; using timer fallback", error);
      close();
      return { mode: "timer", close: () => {} };
    }
  }

  function startRescanTimer(intervalMs = RESCAN_INTERVAL_MS): ReturnType<typeof setInterval> {
    const timer = setInterval(() => runBackground("timer"), intervalMs);
    timer.unref?.();
    return timer;
  }

  return { indexAll, startWatcher, startRescanTimer };
}

let defaultIndexer: ReturnType<typeof createIndexer> | null = null;
function getDefaultIndexer(): ReturnType<typeof createIndexer> { return defaultIndexer ??= createIndexer(); }
export async function indexAll(): Promise<IndexSummary> { return getDefaultIndexer().indexAll(); }
export function startWatcher(onFailure?: () => void): WatchHandle { return getDefaultIndexer().startWatcher(onFailure); }
export function startRescanTimer(intervalMs = RESCAN_INTERVAL_MS): ReturnType<typeof setInterval> {
  return getDefaultIndexer().startRescanTimer(intervalMs);
}
