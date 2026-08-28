import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_VERSION = "7"; // bump whenever parse/derivation rules change so stale caches rebuild

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  agent TEXT NOT NULL, sid TEXT NOT NULL, project_key TEXT NOT NULL, cwd TEXT, worktree_root TEXT, git_branch TEXT,
  title TEXT, first_prompt TEXT,
  last_prompt TEXT, last_input_at INTEGER, prompt_count INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL, file_size INTEGER NOT NULL DEFAULT 0, file_mtime INTEGER NOT NULL DEFAULT 0,
  parsed_offset INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, sid)
);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_input_at DESC);
CREATE TABLE IF NOT EXISTS projects (key TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, color TEXT);
CREATE TABLE IF NOT EXISTS cwd_cache (cwd TEXT PRIMARY KEY, project_key TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(text, agent UNINDEXED, sid UNINDEXED, role UNINDEXED, ts UNINDEXED, tokenize='trigram');`;

function removeDatabaseFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

function configureWritableDatabase(database: Database): void {
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
}

export function openDatabase(path: string): Database {
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
  database.exec(`INSERT INTO meta(key, value)
    SELECT 'list_version', COALESCE((SELECT value FROM meta WHERE key = 'data_version'), '0')
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'list_version');`);
  return database;
}
