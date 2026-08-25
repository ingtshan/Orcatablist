import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DISPLAY_TITLE_MAX_CHARS, ORCATAB_DATA_DIR, SEARCH_MIN_FTS_CHARS } from "./config";
import type { ProjectRow, SearchHit, SearchResult, SessionRow } from "./types";

const SCHEMA_VERSION = "3"; // bump whenever parse/derivation rules change so stale caches rebuild
const SEARCH_ROWS_MULTIPLIER = 3;
const MAX_HITS_PER_SESSION = 3;
const LIKE_CONTEXT_CHARS = 40;

export interface StoredSession {
  sid: string; projectKey: string; cwd: string | null; branch: string | null;
  title: string | null; firstPrompt: string | null; lastPrompt: string | null; lastInputAt: number | null;
  promptCount: number; filePath: string; fileSize: number; fileMtime: number; parsedOffset: number;
}

export interface FtsRow { text: string; sid: string; role: "user" | "assistant"; ts: number | null; }
export interface ProjectRecord { key: string; name: string; root: string; color: string | null; }

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY, project_key TEXT NOT NULL, cwd TEXT, git_branch TEXT,
  title TEXT, first_prompt TEXT,
  last_prompt TEXT, last_input_at INTEGER, prompt_count INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL, file_size INTEGER NOT NULL DEFAULT 0, file_mtime INTEGER NOT NULL DEFAULT 0,
  parsed_offset INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_input_at DESC);
CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, color TEXT);
CREATE TABLE IF NOT EXISTS cwd_cache (cwd TEXT PRIMARY KEY, project_key TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(text, sid UNINDEXED, role UNINDEXED, ts UNINDEXED, tokenize='trigram');`;

function removeDatabaseFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

function configureWritableDatabase(database: Database): void {
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
}

function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  let database = new Database(path, { create: true });
  configureWritableDatabase(database);
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  let row = database.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null;
  if (row !== null && row.value !== SCHEMA_VERSION) {
    database.close();
    if (path !== ":memory:") removeDatabaseFiles(path);
    database = new Database(path, { create: true });
    configureWritableDatabase(database);
    database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
    row = null;
  }
  database.exec(SCHEMA_SQL);
  if (row === null) {
    database.query("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }
  return database;
}

function sessionRow(row: Record<string, unknown>): SessionRow {
  const sid = String(row.sid);
  const title = typeof row.title === "string" && row.title ? row.title : null;
  const firstPrompt = typeof row.first_prompt === "string" && row.first_prompt ? row.first_prompt : null;
  const lastPrompt = typeof row.last_prompt === "string" && row.last_prompt ? row.last_prompt : null;
  return {
    sid,
    projectKey: String(row.project_key),
    cwd: typeof row.cwd === "string" ? row.cwd : null,
    branch: typeof row.git_branch === "string" ? row.git_branch : null,
    title,
    firstPrompt,
    lastPrompt,
    displayTitle: title ?? firstPrompt?.slice(0, DISPLAY_TITLE_MAX_CHARS) ?? sid.slice(0, 8),
    lastInputAt: typeof row.last_input_at === "number" ? row.last_input_at : null,
    promptCount: Number(row.prompt_count),
    live: null,
  };
}

function storedSession(row: Record<string, unknown>): StoredSession {
  return {
    ...sessionRow(row),
    filePath: String(row.file_path), fileSize: Number(row.file_size),
    fileMtime: Number(row.file_mtime), parsedOffset: Number(row.parsed_offset),
  };
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function likeSnippet(text: string, query: string): string {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text.slice(0, LIKE_CONTEXT_CHARS * 2);
  const start = Math.max(0, index - LIKE_CONTEXT_CHARS);
  const end = Math.min(text.length, index + query.length + LIKE_CONTEXT_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, index)}‹${text.slice(index, index + query.length)}›${text.slice(index + query.length, end)}${end < text.length ? "…" : ""}`;
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
  countSessions(): number {
    return Number((this.raw.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count);
  }
  upsertSession(row: StoredSession): void {
    this.raw.query(`INSERT INTO sessions
      (sid, project_key, cwd, git_branch, title, first_prompt, last_prompt, last_input_at, prompt_count, file_path, file_size, file_mtime, parsed_offset)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET project_key=excluded.project_key, cwd=excluded.cwd,
      git_branch=excluded.git_branch, title=excluded.title, first_prompt=excluded.first_prompt,
      last_prompt=excluded.last_prompt, last_input_at=excluded.last_input_at, prompt_count=excluded.prompt_count, file_path=excluded.file_path,
      file_size=excluded.file_size, file_mtime=excluded.file_mtime, parsed_offset=excluded.parsed_offset`)
      .run(row.sid, row.projectKey, row.cwd, row.branch, row.title, row.firstPrompt, row.lastPrompt,
        row.lastInputAt, row.promptCount, row.filePath, row.fileSize, row.fileMtime, row.parsedOffset);
  }
  getStoredSession(sid: string): StoredSession | null {
    const row = this.raw.query("SELECT * FROM sessions WHERE sid = ?").get(sid) as Record<string, unknown> | null;
    return row ? storedSession(row) : null;
  }
  getSession(sid: string): SessionRow | null {
    const row = this.raw.query("SELECT * FROM sessions WHERE sid = ?").get(sid) as Record<string, unknown> | null;
    return row ? sessionRow(row) : null;
  }
  replaceSessionFts(sid: string, rows: FtsRow[]): void {
    this.deleteSessionFts(sid); this.appendSessionFts(rows);
  }
  appendSessionFts(rows: FtsRow[]): void {
    const insert = this.raw.query("INSERT INTO msg_fts(text, sid, role, ts) VALUES (?, ?, ?, ?)");
    for (const row of rows) insert.run(row.text, row.sid, row.role, row.ts);
  }
  deleteSessionFts(sid: string): void { this.raw.query("DELETE FROM msg_fts WHERE sid = ?").run(sid); }
  countSessionFts(sid: string): number {
    return Number((this.raw.query("SELECT COUNT(*) AS count FROM msg_fts WHERE sid = ?").get(sid) as { count: number }).count);
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
    return this.raw.query(`SELECT p.key, p.name, p.root, p.color, COUNT(s.sid) AS sessionCount,
      MAX(s.last_input_at) AS lastInputAt FROM projects p LEFT JOIN sessions s ON s.project_key = p.key
      GROUP BY p.key ORDER BY lastInputAt IS NULL, lastInputAt DESC`).all() as ProjectRow[];
  }
  listSessions(options: { projectKey?: string; limit: number }): SessionRow[] {
    const rows = options.projectKey === undefined
      ? this.raw.query("SELECT * FROM sessions ORDER BY last_input_at IS NULL, last_input_at DESC LIMIT ?").all(options.limit)
      : this.raw.query("SELECT * FROM sessions WHERE project_key = ? ORDER BY last_input_at IS NULL, last_input_at DESC LIMIT ?").all(options.projectKey, options.limit);
    return (rows as Record<string, unknown>[]).map(sessionRow);
  }
  search(query: string, limit: number): SearchResult[] {
    const q = query.trim();
    if (!q) return [];
    const rowLimit = limit * SEARCH_ROWS_MULTIPLIER;
    type MatchRow = { sid: string; role: "user" | "assistant"; ts: number | null; snippet: string; score: number };
    let rows: MatchRow[];
    if (q.length >= SEARCH_MIN_FTS_CHARS) {
      const match = `"${q.replace(/"/g, '""')}"`;
      rows = this.raw.query(`SELECT sid, role, CAST(ts AS INTEGER) AS ts,
        snippet(msg_fts, 0, '‹', '›', '…', 20) AS snippet, -rank AS score
        FROM msg_fts WHERE msg_fts MATCH ? ORDER BY rank LIMIT ?`).all(match, rowLimit) as MatchRow[];
    } else {
      const matches = this.raw.query("SELECT text, sid, role, CAST(ts AS INTEGER) AS ts FROM msg_fts WHERE text LIKE ? ESCAPE '\\' LIMIT ?")
        .all(`%${escapeLike(q)}%`, rowLimit) as Array<Omit<MatchRow, "snippet" | "score"> & { text: string }>;
      rows = matches.map((row) => ({ ...row, snippet: likeSnippet(row.text, q), score: 1 }));
    }
    const grouped = new Map<string, { hits: SearchHit[]; score: number }>();
    for (const row of rows) {
      const entry = grouped.get(row.sid) ?? { hits: [], score: row.score };
      if (entry.hits.length < MAX_HITS_PER_SESSION) entry.hits.push({ role: row.role, ts: row.ts, snippet: row.snippet });
      entry.score = Math.max(entry.score, row.score);
      grouped.set(row.sid, entry);
    }
    return [...grouped.entries()]
      .map(([sid, entry]) => {
        const session = this.getSession(sid);
        return session ? { ...session, ...entry } : null;
      })
      .filter((row): row is SearchResult => row !== null)
      .sort((a, b) => b.score - a.score || (b.lastInputAt ?? -1) - (a.lastInputAt ?? -1))
      .slice(0, limit);
  }
}

let defaultDatabase: OrcaDatabase | null = null;
export function getDefaultDatabase(): OrcaDatabase { return defaultDatabase ??= new OrcaDatabase(); }
export function upsertSession(row: StoredSession): void { getDefaultDatabase().upsertSession(row); }
export function replaceSessionFts(sid: string, rows: FtsRow[]): void { getDefaultDatabase().replaceSessionFts(sid, rows); }
export function deleteSessionFts(sid: string): void { getDefaultDatabase().deleteSessionFts(sid); }
export function listProjects(): ProjectRow[] { return getDefaultDatabase().listProjects(); }
export function listSessions(options: { projectKey?: string; limit: number }): SessionRow[] { return getDefaultDatabase().listSessions(options); }
export function search(q: string, limit: number): SearchResult[] { return getDefaultDatabase().search(q, limit); }
export function getSession(sid: string): SessionRow | null { return getDefaultDatabase().getSession(sid); }
export function openDatabaseReadOnly(path: string): OrcaDatabase | null {
  return existsSync(path) ? new OrcaDatabase(path, { readonly: true }) : null;
}
