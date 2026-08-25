import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FTS_TEXT_MAX_CHARS, ORCATAB_CLAUDE_DIR, RESCAN_INTERVAL_MS } from "./config";
import { getDefaultDatabase, type FtsRow, type OrcaDatabase, type StoredSession } from "./db";
import { cleanPromptForDisplay, parseLine } from "./parse";
import { createProjectDeps, mergeOrcaWorkspaceProjects, resolveProjectKey } from "./projects";

const SESSION_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const BYTE_NEWLINE = 0x0a;

export interface IndexSummary { files: number; changed: number; ms: number; }
export interface IndexerOptions {
  claudeDir?: string;
  db?: OrcaDatabase;
  resolveProject?: typeof resolveProjectKey;
  now?: () => number;
}

interface FileInfo { path: string; sid: string; size: number; mtime: number; }
interface CompleteRead { lines: string[]; consumedBytes: number; }

function discoverSessionFiles(claudeDir: string): FileInfo[] {
  const projectsDir = join(claudeDir, "projects");
  let projectEntries;
  try {
    projectEntries = readdirSync(projectsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`failed to read Claude projects directory ${projectsDir}: ${String(error)}`);
  }
  const files: FileInfo[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const directory = join(projectsDir, projectEntry.name);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !SESSION_FILE_PATTERN.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const stat = statSync(path);
      files.push({ path, sid: entry.name.slice(0, -6), size: stat.size, mtime: Math.trunc(stat.mtimeMs) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
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

function emptySession(file: FileInfo): StoredSession {
  return {
    sid: file.sid, projectKey: "unknown", cwd: null, branch: null, title: null,
    firstPrompt: null, lastInputAt: null, promptCount: 0, filePath: file.path,
    fileSize: 0, fileMtime: 0, parsedOffset: 0,
  };
}

function applyLines(base: StoredSession, lines: string[]): { session: StoredSession; fts: FtsRow[] } {
  let session = { ...base };
  const fts: FtsRow[] = [];
  for (const line of lines) {
    const event = parseLine(line);
    if (session.cwd === null && event.cwd) {
      session = { ...session, cwd: event.cwd, branch: event.branch ?? session.branch };
    }
    if (event.kind === "title" && event.title !== undefined) session = { ...session, title: event.title };
    if (event.kind === "prompt" && event.text !== undefined) {
      const cleaned = cleanPromptForDisplay(event.text);
      session = {
        ...session,
        firstPrompt: session.firstPrompt ?? (cleaned || null),
        lastInputAt: event.ts === null || event.ts === undefined
          ? session.lastInputAt : Math.max(session.lastInputAt ?? event.ts, event.ts),
        promptCount: session.promptCount + 1,
      };
      fts.push({ text: event.text.slice(0, FTS_TEXT_MAX_CHARS), sid: session.sid, role: "user", ts: event.ts ?? null });
    }
    if (event.kind === "assistant-text" && event.text !== undefined) {
      fts.push({ text: event.text.slice(0, FTS_TEXT_MAX_CHARS), sid: session.sid, role: "assistant", ts: event.ts ?? null });
    }
  }
  return { session, fts };
}

export function createIndexer(options: IndexerOptions = {}) {
  const claudeDir = options.claudeDir ?? ORCATAB_CLAUDE_DIR;
  const db = options.db ?? getDefaultDatabase();
  const projectDeps = createProjectDeps(db);
  const projectResolver = options.resolveProject ?? resolveProjectKey;
  const now = options.now ?? Date.now;
  let rescanRunning = false;

  async function indexFile(file: FileInfo): Promise<boolean> {
    const stored = db.getStoredSession(file.sid);
    if (stored && stored.filePath === file.path && stored.fileSize === file.size && stored.fileMtime === file.mtime) return false;
    const rebuild = stored === null || stored.filePath !== file.path || file.size < stored.fileSize
      || (file.size === stored.fileSize && file.mtime !== stored.fileMtime);
    const base = rebuild ? emptySession(file) : stored;
    const offset = rebuild ? 0 : base.parsedOffset;
    const read = readCompleteLines(file.path, offset, file.size);
    const parsed = applyLines(base, read.lines);
    const project = await projectResolver(parsed.session.cwd, projectDeps);
    const session: StoredSession = {
      ...parsed.session, projectKey: project.key, filePath: file.path,
      fileSize: file.size, fileMtime: file.mtime, parsedOffset: offset + read.consumedBytes,
    };
    db.transaction(() => {
      if (rebuild) db.deleteSessionFts(file.sid);
      db.upsertProject(project);
      db.appendSessionFts(parsed.fts);
      db.upsertSession(session);
    });
    return true;
  }

  async function indexAll(): Promise<IndexSummary> {
    const startedAt = now();
    const files = discoverSessionFiles(claudeDir);
    let changed = 0;
    for (const file of files) if (await indexFile(file)) changed += 1;
    mergeOrcaWorkspaceProjects(db);
    db.setMeta("indexed_at", String(now()));
    return { files: files.length, changed, ms: Math.max(0, Math.round(now() - startedAt)) };
  }

  function startRescanTimer(): ReturnType<typeof setInterval> {
    const timer = setInterval(async () => {
      if (rescanRunning) return;
      rescanRunning = true;
      try { await indexAll(); }
      catch (error) { console.error("orcatab rescan failed", error); }
      finally { rescanRunning = false; }
    }, RESCAN_INTERVAL_MS);
    timer.unref?.();
    return timer;
  }

  return { indexAll, startRescanTimer };
}

let defaultIndexer: ReturnType<typeof createIndexer> | null = null;
function getDefaultIndexer(): ReturnType<typeof createIndexer> { return defaultIndexer ??= createIndexer(); }
export async function indexAll(): Promise<IndexSummary> { return getDefaultIndexer().indexAll(); }
export function startRescanTimer(): ReturnType<typeof setInterval> { return getDefaultIndexer().startRescanTimer(); }
