import { join } from "node:path";
import {
  ORCATAB_CLAUDE_DIR, ORCATAB_CODEX_DIR, ORCATAB_HERMES_DB, RESCAN_INTERVAL_MS,
} from "./config";
import { getDefaultDatabase, type OrcaDatabase, type StoredSession } from "./db";
import { createCoalescingRunner } from "./index-scheduler";
import { startSessionWatcher, type DebouncerOptions, type WatchHandle } from "./index-watch";
import {
  createProjectDeps, mergeDeletedWorktreeProjects, mergeOrcaWorkspaceProjects, resolveProjectKey,
} from "./projects";
import {
  errorText, selectSessionOwners, sourceIssue,
  type SessionFileInfo, type SessionSource, type SessionUpdate, type SourceIssue,
} from "./session-source";
import { createClaudeSource } from "./sources/claude";
import { createCodexSource } from "./sources/codex";
import { createHermesSource } from "./sources/hermes";
import { resolveWorktreeRoot } from "./worktrees";
import { needsFullInputRebuild } from "./session-input-rebuild";
import { LOCAL_ENV, normalizeEnv } from "./session-identity";

export type {
  DiscoveryResult, SessionFileInfo, SessionSource, SessionUpdate, SourceIssue, SourceStage,
} from "./session-source";
export type { WatchHandle } from "./index-watch";
export { completeLines } from "./sources/jsonl";

export interface IndexSummary { files: number; changed: number; ms: number; errors: SourceIssue[]; }
/** Immutable snapshot of how indexing is actually doing, for /healthz and operators. */
export interface IndexHealth {
  running: boolean;
  lastAttemptAt: number | null;
  /** Only advances on a pass that had no errors at all. */
  lastSuccessAt: number | null;
  errors: SourceIssue[];
}
interface IndexFileResult { changed: boolean; listChanged: boolean; }
interface OwnedFile { file: SessionFileInfo; source: SessionSource; }
export interface IndexerOptions {
  claudeDir?: string;
  codexDir?: string;
  hermesDb?: string;
  sources?: SessionSource[];
  db?: OrcaDatabase;
  resolveProject?: typeof resolveProjectKey;
  resolveWorktree?: typeof resolveWorktreeRoot;
  /** False for remote-environment indexers: project folding is local-machine semantics. */
  foldProjects?: boolean;
  /** False for remote-environment indexers: a remote round says nothing about local freshness. */
  markIndexedAt?: boolean;
  now?: () => number;
  /** Test hook for the watcher's quiet/maximum-wait clock. */
  debounce?: DebouncerOptions;
}

function sessionListChanged(previous: StoredSession | null, next: StoredSession): boolean {
  if (previous === null) return true;
  return previous.projectKey !== next.projectKey || previous.cwd !== next.cwd || previous.worktreeRoot !== next.worktreeRoot || previous.branch !== next.branch ||
    previous.title !== next.title || previous.firstPrompt !== next.firstPrompt || previous.lastPrompt !== next.lastPrompt ||
    previous.lastInputAt !== next.lastInputAt || previous.promptCount !== next.promptCount ||
    (previous.model ?? null) !== (next.model ?? null) || (previous.reasoningEffort ?? null) !== (next.reasoningEffort ?? null);
}

function issueSignature(errors: readonly SourceIssue[]): string {
  return errors.map((issue) => `${issue.stage}/${issue.source}/${issue.path ?? ""}/${issue.message}`).join("|");
}

export function createIndexer(options: IndexerOptions = {}) {
  const claudeDir = options.claudeDir ?? ORCATAB_CLAUDE_DIR;
  const codexDir = options.codexDir ?? ORCATAB_CODEX_DIR;
  const hermesDb = options.hermesDb ?? ORCATAB_HERMES_DB;
  const sources = options.sources ?? [
    createClaudeSource(claudeDir), createCodexSource(codexDir), createHermesSource(hermesDb),
  ];
  const watchPaths = [join(claudeDir, "projects"), join(codexDir, "sessions")];
  const db = options.db ?? getDefaultDatabase();
  const projectDeps = createProjectDeps(db);
  const projectResolver = options.resolveProject ?? resolveProjectKey;
  const worktreeResolver = options.resolveWorktree ?? resolveWorktreeRoot;
  const now = options.now ?? Date.now;
  const health = { running: false, lastAttemptAt: null as number | null, lastSuccessAt: null as number | null, errors: [] as SourceIssue[] };
  let loggedSignature = "";
  let closed = false;
  // Committed but not yet versioned: shutdown flushes these while the database is still open.
  let unversionedChanges = 0;
  let unversionedListChanges = false;

  function flushVersions(): void {
    if (unversionedChanges > 0) db.bumpDataVersion();
    if (unversionedListChanges) db.bumpListVersion();
    unversionedChanges = 0;
    unversionedListChanges = false;
  }

  async function indexFile(owned: OwnedFile, degraded: boolean, errors: SourceIssue[]): Promise<IndexFileResult> {
    const { file, source } = owned;
    const context = { path: file.path, sid: file.sid, ...(file.env === undefined ? {} : { env: file.env }) };
    const unchanged = { changed: false, listChanged: false };
    const stored = db.getStoredSession(file.agent, file.sid, file.env);
    const inputRebuild = needsFullInputRebuild(db.raw, file);
    // An inventory that failed part way cannot prove the better owner is gone, so committed data
    // stays with the path that already owns it until a clean inventory says otherwise.
    if (degraded && stored !== null && stored.filePath.localeCompare(file.path) > 0) return unchanged;
    let update: SessionUpdate | null;
    try {
      update = source.index(file, inputRebuild && normalizeEnv(file.env) === LOCAL_ENV ? null : stored);
    } catch (error) {
      errors.push(sourceIssue("read", file.agent, errorText(error), context));
      return unchanged;
    }
    if (update === null) return unchanged;
    let session: StoredSession;
    let applied: boolean;
    try {
      const project = await projectResolver(update.session.cwd, projectDeps);
      if (closed) return unchanged;
      session = {
        ...update.session, projectKey: project.key, worktreeRoot: worktreeResolver(update.session.cwd),
      };
      applied = db.applySessionUpdate({ ...update, session, project });
    } catch (error) {
      errors.push(sourceIssue("commit", file.agent, errorText(error), context));
      return unchanged;
    }
    if (!applied) return unchanged;
    // Booked in the same synchronous step as the transaction. A shutdown that lands between the
    // commit and this caller's resumption still finds the data marked dirty, so it gets versioned.
    const listChanged = inputRebuild || sessionListChanged(stored, session);
    unversionedChanges += 1;
    unversionedListChanges ||= listChanged;
    return { changed: true, listChanged };
  }

  async function performIndexAll(): Promise<IndexSummary> {
    const startedAt = now();
    health.running = true;
    health.lastAttemptAt = startedAt;
    const errors: SourceIssue[] = [];
    const owners: OwnedFile[] = [];
    const degradedSources = new Set<SessionSource>();
    try {
      for (const source of sources) {
        if (closed) break;
        try {
          await source.prepare?.();
        } catch (error) {
          // A failure caused by the shutdown itself is cancellation, not a source fault.
          if (closed) break;
          errors.push(sourceIssue("prepare", source.agent, errorText(error)));
          degradedSources.add(source);
        }
        // Preparing is an await boundary: a close landing here must stop before discovery runs.
        if (closed) break;
        try {
          const discovered = source.discover();
          errors.push(...discovered.errors);
          if (discovered.errors.length > 0) degradedSources.add(source);
          for (const file of discovered.files) owners.push({ file, source });
        } catch (error) {
          errors.push(sourceIssue("discover", source.agent, errorText(error)));
          degradedSources.add(source);
        }
      }
      // The winner carries the adapter that actually found it, so a duplicate never gets handed
      // to a different agent's source.
      const selected = selectSessionOwners(owners, (owned) => owned.file);
      let changed = 0;
      for (const owned of selected) {
        if (closed) break;
        const result = await indexFile(owned, degradedSources.has(owned.source), errors);
        if (result.changed) changed += 1;
      }
      if (!closed) {
        // Partial success still moves the versions: what did commit is real and readers need it.
        flushVersions();
        if (options.foldProjects !== false) {
          mergeOrcaWorkspaceProjects(db);
          mergeDeletedWorktreeProjects(db);
        }
        // Freshness is a claim that the index matches the sources, so only a clean pass may make it.
        if (errors.length === 0) {
          health.lastSuccessAt = now();
          if (options.markIndexedAt !== false) db.setMeta("indexed_at", String(now()));
        }
      }
      if (closed) return { files: selected.length, changed, ms: Math.max(0, Math.round(now() - startedAt)), errors: [] };
      health.errors = errors;
      const signature = issueSignature(errors);
      if (errors.length > 0 && signature !== loggedSignature) {
        console.error(`orcatab indexing degraded: ${errors.map((issue) => issue.message).join("; ")}`);
      }
      loggedSignature = signature;
      return { files: selected.length, changed, ms: Math.max(0, Math.round(now() - startedAt)), errors };
    } finally {
      health.running = false;
    }
  }

  const runner = createCoalescingRunner(performIndexAll);

  async function indexAll(): Promise<IndexSummary> {
    const result = await runner.request();
    if (result.status === "completed") return result.value;
    if (result.status === "failed") throw result.error;
    // A shutdown is not an indexing failure; it simply means this pass never ran.
    return { files: 0, changed: 0, ms: 0, errors: [] };
  }

  function runBackground(trigger: string): void {
    void indexAll().catch((error) => console.error(`orcatab ${trigger} rescan failed`, error));
  }

  function startWatcher(onFailure?: () => void): WatchHandle {
    return startSessionWatcher(watchPaths, () => runBackground("watch"), {
      ...(onFailure === undefined ? {} : { onFailure }),
      ...(options.debounce === undefined ? {} : { debounce: options.debounce }),
    });
  }

  function startRescanTimer(intervalMs = RESCAN_INTERVAL_MS): ReturnType<typeof setInterval> {
    const timer = setInterval(() => runBackground("timer"), intervalMs);
    timer.unref?.();
    return timer;
  }

  function getHealth(): IndexHealth {
    const errors: SourceIssue[] = health.errors.map((issue) => Object.freeze({ ...issue }));
    Object.freeze(errors);
    return Object.freeze({
      running: health.running,
      lastAttemptAt: health.lastAttemptAt,
      lastSuccessAt: health.lastSuccessAt,
      errors,
    });
  }

  /** Synchronous on purpose: it runs while the database is still open, so committed work is versioned. */
  function close(): void {
    closed = true;
    runner.close();
    flushVersions();
  }

  return { indexAll, startWatcher, startRescanTimer, getHealth, close };
}

let defaultIndexer: ReturnType<typeof createIndexer> | null = null;
function getDefaultIndexer(): ReturnType<typeof createIndexer> { return defaultIndexer ??= createIndexer(); }
export async function indexAll(): Promise<IndexSummary> { return getDefaultIndexer().indexAll(); }
export function startWatcher(onFailure?: () => void): WatchHandle { return getDefaultIndexer().startWatcher(onFailure); }
export function startRescanTimer(intervalMs = RESCAN_INTERVAL_MS): ReturnType<typeof setInterval> {
  return getDefaultIndexer().startRescanTimer(intervalMs);
}
