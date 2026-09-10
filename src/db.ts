import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ORCATAB_DATA_DIR, SEARCH_MIN_FTS_CHARS } from "./config";
import { querySessionMentions, type SessionMention } from "./db-mentions";
import { escapeLike, likeSnippet, sessionRow, storedSession } from "./db-rows";
import { LOCAL_ENV, normalizeEnv, sessionIdentityKey } from "./session-identity";
import { openDatabase } from "./db-schema";
import {
  acknowledgeRemoteRead, deleteRemoteReadState, getRemoteFairnessCursor, getRemotePending,
  listRemoteReadStates, pruneRemoteReadState, saveRemoteReadState, setRemoteFairnessCursor,
  type RemoteReadAck, type RemoteReadState,
} from "./remote-read-state";
import type { Agent, ProjectRow, SearchHit, SearchResult, SessionRow } from "./types";
import type { SessionExecution } from "./session-execution";
import { applyBriefEvents } from "./session-briefs";
import type { BriefEvent } from "./session-brief-events";
import { finishFullInputRebuild } from "./session-input-rebuild";

export type { SessionMention } from "./db-mentions";

const SEARCH_ROWS_MULTIPLIER = 3;
const MAX_HITS_PER_SESSION = 3;
const RECENT_USER_INPUT_LIMIT = 5;
const RECENT_USER_INPUT_MAX_CHARS = 320;

export interface StoredSession extends SessionExecution {
  agent: Agent; env?: string; sid: string; projectKey: string; cwd: string | null; worktreeRoot: string | null; branch: string | null;
  title: string | null; firstPrompt: string | null; lastPrompt: string | null; lastInputAt: number | null;
  promptCount: number; filePath: string; fileSize: number; fileMtime: number; parsedOffset: number;
  executionMetadataVersion?: number;
}

export interface FtsRow { text: string; env?: string; agent: Agent; sid: string; role: "user" | "assistant"; ts: number | null; }
/** Enough of an indexed file to rebuild a remote read cursor when no read state exists yet. */
export interface SessionCursor { path: string; parsedOffset: number; fileSize: number; fileMtime: number; executionMetadataVersion?: number; agent?: Agent; }
/** One session's next state plus everything committed with it in the same transaction. */
export interface SessionCommit {
  session: StoredSession;
  fts: FtsRow[];
  replaceFts: boolean;
  project: ProjectRecord;
  ack?: RemoteReadAck;
  briefEvents?: BriefEvent[];
}
export interface RecentUserInput { text: string; ts: number | null; }
export interface RecentUserInputPage { inputs: RecentUserInput[]; hasMore: boolean; }
export interface RecentUserInputPageOptions { limit?: number; offset?: number; fullText?: boolean; }
export interface ProjectRecord { key: string; name: string; root: string; color: string | null; }

class StaleRemoteRead extends Error {
  constructor(path: string) { super(`remote read state for ${path} moved on before the commit`); }
}

export class OrcaDatabase {
  readonly raw: Database;

  constructor(path = join(ORCATAB_DATA_DIR, "index.db"), options: { readonly?: boolean } = {}) {
    this.raw = options.readonly ? new Database(path, { readonly: true }) : openDatabase(path);
    if (options.readonly) this.raw.exec("PRAGMA busy_timeout = 5000;");
  }
  close(): void { this.raw.close(); }
  transaction<T>(work: () => T): T { return this.raw.transaction(work)(); }

  getMeta(key: string): string | null {
    const row = this.raw.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.raw.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
  }
  getDataVersion(): number {
    const parsed = Number.parseInt(this.getMeta("data_version") ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  bumpDataVersion(): number {
    this.raw.query(`INSERT INTO meta(key, value) VALUES ('data_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)`).run();
    return this.getDataVersion();
  }
  getListVersion(): number {
    const parsed = Number.parseInt(this.getMeta("list_version") ?? String(this.getDataVersion()), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  bumpListVersion(): number {
    this.raw.query(`INSERT INTO meta(key, value) VALUES ('list_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)`).run();
    return this.getListVersion();
  }
  countSessions(): number {
    return Number((this.raw.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count);
  }
  upsertSession(row: StoredSession): void {
    this.raw.query(`INSERT INTO sessions
      (env, agent, sid, project_key, cwd, worktree_root, git_branch, title, first_prompt, last_prompt, last_input_at, prompt_count, file_path, file_size, file_mtime, parsed_offset, model, reasoning_effort, execution_metadata_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(env, agent, sid) DO UPDATE SET project_key=excluded.project_key, cwd=excluded.cwd,
      worktree_root=excluded.worktree_root, git_branch=excluded.git_branch, title=excluded.title, first_prompt=excluded.first_prompt,
      last_prompt=excluded.last_prompt, last_input_at=excluded.last_input_at, prompt_count=excluded.prompt_count, file_path=excluded.file_path,
      file_size=excluded.file_size, file_mtime=excluded.file_mtime, parsed_offset=excluded.parsed_offset,
      model=excluded.model, reasoning_effort=excluded.reasoning_effort, execution_metadata_version=excluded.execution_metadata_version`)
      .run(normalizeEnv(row.env), row.agent, row.sid, row.projectKey, row.cwd, row.worktreeRoot, row.branch, row.title, row.firstPrompt, row.lastPrompt,
        row.lastInputAt, row.promptCount, row.filePath, row.fileSize, row.fileMtime, row.parsedOffset,
        row.model ?? null, row.reasoningEffort ?? null, row.executionMetadataVersion ?? 0);
  }
  getStoredSession(agent: Agent, sid: string, env?: string): StoredSession | null {
    const row = this.raw.query("SELECT * FROM sessions WHERE env = ? AND agent = ? AND sid = ?")
      .get(normalizeEnv(env), agent, sid) as Record<string, unknown> | null;
    return row ? storedSession(row) : null;
  }
  getSession(agent: Agent, sid: string, env?: string): SessionRow | null {
    const row = this.raw.query("SELECT * FROM sessions WHERE env = ? AND agent = ? AND sid = ?")
      .get(normalizeEnv(env), agent, sid) as Record<string, unknown> | null;
    return row ? sessionRow(row) : null;
  }
  /** Environments holding this identity, local first — the cheap "is this session remote-only?" probe. */
  sessionEnvs(agent: Agent, sid: string): string[] {
    const rows = this.raw.query(`SELECT env FROM sessions WHERE agent = ? AND sid = ?
      ORDER BY env = '${LOCAL_ENV}' DESC, env`).all(agent, sid) as Array<{ env: string }>;
    return rows.map((row) => row.env);
  }
  /** Byte cursors of every indexed session file in one environment — the pull request payload. */
  sessionCursors(env: string): SessionCursor[] {
    return (this.raw.query(`SELECT file_path AS path, parsed_offset AS parsedOffset,
      file_size AS fileSize, file_mtime AS fileMtime, execution_metadata_version AS executionMetadataVersion, agent FROM sessions WHERE env = ?`)
      .all(normalizeEnv(env)) as SessionCursor[]);
  }
  countSessionsByEnv(env: string): number {
    return Number((this.raw.query("SELECT COUNT(*) AS count FROM sessions WHERE env = ?")
      .get(normalizeEnv(env)) as { count: number }).count);
  }
  /** Removing a machine removes its indexed sessions, transcripts and namespaced projects. */
  purgeEnvironment(env: string): void {
    if (normalizeEnv(env) === LOCAL_ENV) throw new Error("refusing to purge the local environment");
    this.transaction(() => {
      this.raw.query("DELETE FROM sessions WHERE env = ?").run(env);
      this.raw.query("DELETE FROM msg_fts WHERE env = ?").run(env);
      this.raw.query("DELETE FROM session_briefs WHERE env = ?").run(env);
      this.raw.query("DELETE FROM brief_sessions WHERE env = ?").run(env);
      this.raw.query("DELETE FROM projects WHERE key LIKE ? ESCAPE '\\'").run(`${escapeLike(env)}:%`);
      deleteRemoteReadState(this.raw, env);
    });
    this.bumpDataVersion();
    this.bumpListVersion();
  }
  /**
   * The one atomic commit path: a rejected acknowledgement (a newer read generation, or a range
   * that no longer matches) rolls the whole update back, leaving cursor, FTS and buffer untouched.
   */
  applySessionUpdate(commit: SessionCommit): boolean {
    try {
      this.transaction(() => {
        if (commit.ack !== undefined && !acknowledgeRemoteRead(this.raw, commit.ack)) {
          throw new StaleRemoteRead(commit.ack.path);
        }
        applyBriefEvents(this.raw, commit.session, commit.briefEvents ?? []);
        if (commit.replaceFts) this.deleteSessionFts(commit.session.agent, commit.session.sid, commit.session.env);
        this.upsertProject(commit.project);
        this.appendSessionFts(commit.fts);
        this.upsertSession(commit.session);
        if (commit.replaceFts) finishFullInputRebuild(this.raw, commit.session);
      });
    } catch (error) {
      if (error instanceof StaleRemoteRead) return false;
      throw error;
    }
    return true;
  }
  remoteReadStates(env: string): Map<string, RemoteReadState> {
    return listRemoteReadStates(this.raw, normalizeEnv(env));
  }
  remotePendingBytes(env: string, path: string): Uint8Array {
    return getRemotePending(this.raw, normalizeEnv(env), path);
  }
  saveRemoteReadState(env: string, path: string, state: RemoteReadState, pending: Uint8Array | null): void {
    saveRemoteReadState(this.raw, normalizeEnv(env), path, state, pending);
  }
  /** Only ever called with the keep-set of a completed inventory; never touches sessions or FTS. */
  pruneRemoteReadState(env: string, keep: ReadonlySet<string>): number {
    return pruneRemoteReadState(this.raw, normalizeEnv(env), keep);
  }
  getRemoteFairnessCursor(env: string): string | null {
    return getRemoteFairnessCursor(this.raw, normalizeEnv(env));
  }
  setRemoteFairnessCursor(env: string, path: string | null): void {
    setRemoteFairnessCursor(this.raw, normalizeEnv(env), path);
  }
  getSessionsByIdentity(
    pairs: ReadonlyArray<{ agent: Agent; sid: string; env?: string }>,
  ): Map<`${string}/${string}`, SessionRow> {
    const unique = [...new Map(pairs.map((pair) => [sessionIdentityKey(pair.agent, pair.sid, pair.env), pair])).values()];
    const result = new Map<`${string}/${string}`, SessionRow>();
    if (unique.length === 0) return result;
    const rows = this.raw.query(`WITH requested(env, agent, sid) AS (
      SELECT COALESCE(json_extract(value, '$.env'), '${LOCAL_ENV}'), json_extract(value, '$.agent'), json_extract(value, '$.sid') FROM json_each(?)
    )
    SELECT sessions.* FROM sessions JOIN requested
      ON requested.env = sessions.env AND requested.agent = sessions.agent AND requested.sid = sessions.sid`)
      .all(JSON.stringify(unique)) as Record<string, unknown>[];
    for (const row of rows) {
      const session = sessionRow(row);
      result.set(sessionIdentityKey(session.agent, session.sid, session.env), session);
    }
    return result;
  }
  getSessionsBySid(sids: readonly string[]): Map<string, SessionRow> {
    const unique = [...new Set(sids)];
    const result = new Map<string, SessionRow>();
    if (unique.length === 0) return result;
    const rows = this.raw.query(`WITH requested(sid) AS (SELECT value FROM json_each(?))
      SELECT sessions.* FROM sessions JOIN requested ON requested.sid = sessions.sid
      ORDER BY sessions.env = '${LOCAL_ENV}' DESC, sessions.rowid`).all(JSON.stringify(unique)) as Record<string, unknown>[];
    for (const row of rows) {
      const session = sessionRow(row);
      if (!result.has(session.sid)) result.set(session.sid, session);
    }
    return result;
  }
  getSessionBySid(sid: string): SessionRow | null {
    const row = this.raw.query(`SELECT * FROM sessions WHERE sid = ?
      ORDER BY env = '${LOCAL_ENV}' DESC, rowid LIMIT 1`).get(sid) as Record<string, unknown> | null;
    return row ? sessionRow(row) : null;
  }
  countUserActivitySince(sid: string, since: number): number {
    const row = this.raw.query("SELECT COUNT(*) AS count FROM msg_fts WHERE sid = ? AND role = 'user' AND ts > ?")
      .get(sid, since) as { count: number };
    return Number(row.count);
  }
  countUserActivitySinceBySid(sids: readonly string[], since: number): Map<string, number> {
    const unique = [...new Set(sids)];
    const result = new Map(unique.map((sid) => [sid, 0]));
    if (unique.length === 0) return result;
    const rows = this.raw.query(`WITH requested(sid) AS (SELECT value FROM json_each(?))
      SELECT msg_fts.sid, COUNT(*) AS count FROM msg_fts JOIN requested ON requested.sid = msg_fts.sid
      WHERE msg_fts.role = 'user' AND msg_fts.ts > ? GROUP BY msg_fts.sid`)
      .all(JSON.stringify(unique), since) as Array<{ sid: string; count: number }>;
    for (const row of rows) result.set(row.sid, Number(row.count));
    return result;
  }
  getRecentUserInputs(
    pairs: ReadonlyArray<{ agent: Agent; sid: string; env?: string }>,
  ): Map<`${string}/${string}`, RecentUserInput[]> {
    return new Map([...this.getRecentUserInputPages(pairs)].map(([key, page]) => [key, page.inputs]));
  }
  getRecentUserInputPages(
    pairs: ReadonlyArray<{ agent: Agent; sid: string; env?: string }>,
    options: RecentUserInputPageOptions = {},
  ): Map<`${string}/${string}`, RecentUserInputPage> {
    const limit = options.limit ?? RECENT_USER_INPUT_LIMIT;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("user input page limit must be a positive integer");
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError("user input page offset must be a non-negative integer");
    const unique = [...new Map(pairs.map((pair) => [sessionIdentityKey(pair.agent, pair.sid, pair.env), pair])).values()];
    const grouped = new Map<`${string}/${string}`, RecentUserInput[]>(
      unique.map((pair) => [sessionIdentityKey(pair.agent, pair.sid, pair.env), []]),
    );
    if (unique.length === 0) return new Map();
    const rows = this.raw.query(`WITH requested(env, agent, sid) AS (
      SELECT COALESCE(json_extract(value, '$.env'), '${LOCAL_ENV}'), json_extract(value, '$.agent'), json_extract(value, '$.sid') FROM json_each(?)
    ), ranked AS (
      SELECT msg_fts.env, msg_fts.agent, msg_fts.sid,
        CASE WHEN ? = 0 AND length(msg_fts.text) > ? THEN substr(msg_fts.text, 1, ?) || '…' ELSE msg_fts.text END AS text,
        msg_fts.ts,
        ROW_NUMBER() OVER (PARTITION BY msg_fts.env, msg_fts.agent, msg_fts.sid ORDER BY msg_fts.rowid DESC) AS input_rank
      FROM msg_fts JOIN requested
        ON requested.env = msg_fts.env AND requested.agent = msg_fts.agent AND requested.sid = msg_fts.sid
      WHERE msg_fts.role = 'user' AND length(trim(msg_fts.text)) > 0
    )
    SELECT env, agent, sid, text, ts FROM ranked
      WHERE input_rank > ? AND input_rank <= ? ORDER BY agent, sid, input_rank`)
      .all(JSON.stringify(unique), Number(options.fullText === true), RECENT_USER_INPUT_MAX_CHARS, RECENT_USER_INPUT_MAX_CHARS - 1,
        offset, offset + limit + 1) as Array<{ env: string; agent: string; sid: string; text: string; ts: number | null }>;
    for (const row of rows) {
      const timestamp = row.ts === null ? null : Number(row.ts);
      grouped.get(sessionIdentityKey(row.agent, row.sid, row.env))?.push({
        text: row.text, ts: Number.isFinite(timestamp) ? timestamp : null,
      });
    }
    return new Map([...grouped].map(([key, inputs]) => [key, {
      inputs: inputs.slice(0, limit), hasMore: inputs.length > limit,
    }]));
  }
  replaceSessionFts(agent: Agent, sid: string, rows: FtsRow[], env?: string): void {
    this.deleteSessionFts(agent, sid, env); this.appendSessionFts(rows);
  }
  appendSessionFts(rows: FtsRow[]): void {
    const insert = this.raw.query("INSERT INTO msg_fts(text, env, agent, sid, role, ts) VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of rows) insert.run(row.text, normalizeEnv(row.env), row.agent, row.sid, row.role, row.ts);
  }
  deleteSessionFts(agent: Agent, sid: string, env?: string): void {
    this.raw.query("DELETE FROM msg_fts WHERE env = ? AND agent = ? AND sid = ?").run(normalizeEnv(env), agent, sid);
  }
  countSessionFts(agent: Agent, sid: string, env?: string): number {
    return Number((this.raw.query("SELECT COUNT(*) AS count FROM msg_fts WHERE env = ? AND agent = ? AND sid = ?")
      .get(normalizeEnv(env), agent, sid) as { count: number }).count);
  }
  upsertProject(project: ProjectRecord): void {
    this.raw.query(`INSERT INTO projects(key, name, root, color) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET root = CASE WHEN projects.root = '' THEN excluded.root ELSE projects.root END`)
      .run(project.key, project.name, project.root, project.color);
  }
  listProjectRecords(): ProjectRecord[] {
    return this.raw.query("SELECT key, name, root, color FROM projects").all() as ProjectRecord[];
  }
  updateProjectMetadata(key: string, name: string, color: string | null): boolean {
    const result = this.raw.query(`UPDATE projects SET name = ?, color = ? WHERE key = ?
      AND (name IS NOT ? OR color IS NOT ?)`).run(name, color, key, name, color);
    return result.changes > 0;
  }
  rewriteProjectKey(from: string, to: string): void {
    this.transaction(() => {
      this.raw.query("UPDATE sessions SET project_key = ? WHERE project_key = ?").run(to, from);
      this.raw.query("UPDATE cwd_cache SET project_key = ? WHERE project_key = ?").run(to, from);
      this.raw.query("DELETE FROM projects WHERE key = ?").run(from);
    });
  }
  getCachedProjectKey(cwd: string): string | null {
    const row = this.raw.query("SELECT project_key FROM cwd_cache WHERE cwd = ?").get(cwd) as { project_key: string } | null;
    return row?.project_key ?? null;
  }
  setCachedProjectKey(cwd: string, projectKey: string): void {
    this.raw.query("INSERT OR REPLACE INTO cwd_cache(cwd, project_key) VALUES (?, ?)").run(cwd, projectKey);
  }
  listProjects(): ProjectRow[] {
    const rows = this.raw.query(`SELECT p.key, p.name, p.root, p.color, COUNT(s.sid) AS sessionCount,
      MAX(s.last_input_at) AS lastInputAt FROM projects p LEFT JOIN sessions s ON s.project_key = p.key
      GROUP BY p.key ORDER BY lastInputAt IS NULL, lastInputAt DESC`).all() as Array<Omit<ProjectRow, "pinned" | "archived">>;
    return rows.map((row) => ({ ...row, pinned: false, archived: false }));
  }
  listSessions(options: { projectKey?: string; limit: number }): SessionRow[] {
    const rows = options.projectKey === undefined
      ? this.raw.query("SELECT * FROM sessions ORDER BY last_input_at IS NULL, last_input_at DESC LIMIT ?").all(options.limit)
      : this.raw.query("SELECT * FROM sessions WHERE project_key = ? ORDER BY last_input_at IS NULL, last_input_at DESC LIMIT ?").all(options.projectKey, options.limit);
    return (rows as Record<string, unknown>[]).map(sessionRow);
  }
  hasWorktree(projectKey: string, root: string): boolean {
    const row = this.raw.query(`SELECT 1 AS found FROM sessions s
      LEFT JOIN projects p ON p.key = s.project_key
      WHERE s.project_key = ?
        AND COALESCE(NULLIF(s.worktree_root, ''), NULLIF(s.cwd, ''), NULLIF(p.root, ''), '') = ?
      LIMIT 1`).get(projectKey, root) as { found: number } | null;
    return row !== null;
  }
  /**
   * Sessions whose indexed text contains any of the exact tokens, most mentions first.
   * Used to map opaque external ids (Orca orchestration runs, tasks, dispatches) onto sessions.
   */
  findSessionsMentioning(tokens: readonly string[]): SessionMention[] {
    return querySessionMentions(this.raw, tokens);
  }
  search(query: string, limit: number): SearchResult[] {
    const q = query.trim();
    if (!q) return [];
    const rowLimit = limit * SEARCH_ROWS_MULTIPLIER;
    type MatchRow = { env: string; agent: Agent; sid: string; role: "user" | "assistant"; ts: number | null; snippet: string; score: number };
    let rows: MatchRow[];
    if (q.length >= SEARCH_MIN_FTS_CHARS) {
      const match = `"${q.replace(/"/g, '""')}"`;
      rows = this.raw.query(`SELECT env, agent, sid, role, CAST(ts AS INTEGER) AS ts,
        snippet(msg_fts, 0, '‹', '›', '…', 20) AS snippet, -rank AS score
        FROM msg_fts WHERE msg_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, rowLimit) as MatchRow[];
    } else {
      const matches = this.raw.query("SELECT text, env, agent, sid, role, CAST(ts AS INTEGER) AS ts FROM msg_fts WHERE text LIKE ? ESCAPE '\\' LIMIT ?")
        .all(`%${escapeLike(q)}%`, rowLimit) as Array<Omit<MatchRow, "snippet" | "score"> & { text: string }>;
      rows = matches.map((row) => ({ ...row, snippet: likeSnippet(row.text, q), score: 1 }));
    }
    const grouped = new Map<string, { env: string; agent: Agent; sid: string; hits: SearchHit[]; score: number }>();
    for (const row of rows) {
      const key = sessionIdentityKey(row.agent, row.sid, row.env);
      const entry = grouped.get(key) ?? { env: row.env, agent: row.agent, sid: row.sid, hits: [], score: row.score };
      if (entry.hits.length < MAX_HITS_PER_SESSION) entry.hits.push({ role: row.role, ts: row.ts, snippet: row.snippet });
      entry.score = Math.max(entry.score, row.score);
      grouped.set(key, entry);
    }
    const entries = [...grouped.values()];
    const sessions = this.getSessionsByIdentity(entries);
    return entries
      .map((entry) => {
        const session = sessions.get(sessionIdentityKey(entry.agent, entry.sid, entry.env));
        return session ? { ...session, hits: entry.hits, score: entry.score } : null;
      })
      .filter((row): row is SearchResult => row !== null)
      .sort((a, b) => b.score - a.score || (b.lastInputAt ?? -1) - (a.lastInputAt ?? -1))
      .slice(0, limit);
  }
}

let defaultDatabase: OrcaDatabase | null = null;
export function getDefaultDatabase(): OrcaDatabase { return defaultDatabase ??= new OrcaDatabase(); }
export function upsertSession(row: StoredSession): void { getDefaultDatabase().upsertSession(row); }
export function replaceSessionFts(agent: Agent, sid: string, rows: FtsRow[], env?: string): void { getDefaultDatabase().replaceSessionFts(agent, sid, rows, env); }
export function deleteSessionFts(agent: Agent, sid: string, env?: string): void { getDefaultDatabase().deleteSessionFts(agent, sid, env); }
export function listProjects(): ProjectRow[] { return getDefaultDatabase().listProjects(); }
export function listSessions(options: { projectKey?: string; limit: number }): SessionRow[] { return getDefaultDatabase().listSessions(options); }
export function search(q: string, limit: number): SearchResult[] { return getDefaultDatabase().search(q, limit); }
export function getSession(agent: Agent, sid: string): SessionRow | null { return getDefaultDatabase().getSession(agent, sid); }
export function openDatabaseReadOnly(path: string): OrcaDatabase | null {
  return existsSync(path) ? new OrcaDatabase(path, { readonly: true }) : null;
}
