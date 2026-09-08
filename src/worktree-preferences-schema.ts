import type { Database } from "bun:sqlite";

/**
 * The preference database's shape, and the migrations that carry an older file onto it.
 *
 * Version 4 rekeys `worktree_preferences` on `(project_key, root)`. Under version 3 a path was the
 * whole key, so pinning `/Users/x/orca/workspaces/lumina/class-plan-practice-v01` on this machine
 * silently rewrote the `feibo1` project's row for the same path — the two are different
 * directories and must hold independent intent.
 */

export const PROJECT_PREFERENCES_SCHEMA_VERSION = "4";

const SCHEMA_VERSION_KEY = "project_preferences_schema_version";

const WORKTREE_PREFERENCES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS worktree_preferences (
  project_key TEXT NOT NULL,
  root TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 1 CHECK (archived IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_key, root)
);`;

const PROJECT_PREFERENCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_preferences (
  project_key TEXT PRIMARY KEY,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  updated_at INTEGER NOT NULL
);
${WORKTREE_PREFERENCES_TABLE_SQL}`;

interface ColumnInfo { name: string; pk: number }

function worktreeColumns(database: Database): ColumnInfo[] {
  return database.query("PRAGMA table_info(worktree_preferences)").all() as ColumnInfo[];
}

/** Version 2 stored no pin intent at all. */
function addMissingPinnedColumn(database: Database, columns: ColumnInfo[]): void {
  if (columns.some((column) => column.name === "pinned")) return;
  database.exec(`ALTER TABLE worktree_preferences
    ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));`);
}

/** Version 3 kept `root` as the whole primary key, so `project_key` was not part of it. */
function hasRootOnlyPrimaryKey(columns: ColumnInfo[]): boolean {
  const projectKey = columns.find((column) => column.name === "project_key");
  return projectKey !== undefined && projectKey.pk === 0;
}

/**
 * Copy every stored row onto the scoped key in one transaction: `root` was unique before, so no
 * pair can collide, and flags and timestamps carry over untouched. A crash between the two tables
 * rolls back to the version-3 file rather than losing a user's archive list.
 */
function migrateToScopedPrimaryKey(database: Database): void {
  database.transaction(() => {
    database.exec("ALTER TABLE worktree_preferences RENAME TO worktree_preferences_v3;");
    database.exec(WORKTREE_PREFERENCES_TABLE_SQL);
    database.exec(`INSERT INTO worktree_preferences (project_key, root, pinned, archived, updated_at)
      SELECT project_key, root, pinned, archived, updated_at FROM worktree_preferences_v3;`);
    database.exec("DROP TABLE worktree_preferences_v3;");
  })();
}

function writeSchemaVersion(database: Database): void {
  const version = database.query(`SELECT value FROM meta WHERE key = '${SCHEMA_VERSION_KEY}'`)
    .get() as { value: string } | null;
  if (version === null) {
    database.query(`INSERT INTO meta(key, value) VALUES ('${SCHEMA_VERSION_KEY}', ?)`)
      .run(PROJECT_PREFERENCES_SCHEMA_VERSION);
  } else if (version.value !== PROJECT_PREFERENCES_SCHEMA_VERSION) {
    database.query(`UPDATE meta SET value = ? WHERE key = '${SCHEMA_VERSION_KEY}'`)
      .run(PROJECT_PREFERENCES_SCHEMA_VERSION);
  }
}

/** The change counters the GUI's ETags are built from; never reset by a migration. */
function ensureChangeCounters(database: Database): void {
  database.exec(`INSERT INTO meta(key, value) SELECT 'project_preferences_version', '0'
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'project_preferences_version');`);
  database.exec(`INSERT INTO meta(key, value) SELECT 'worktree_preferences_version', '0'
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'worktree_preferences_version');`);
}

/** Idempotent: a database already at version 4 is inspected and left exactly as it was. */
export function applyPreferencesSchema(database: Database): void {
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  database.exec(PROJECT_PREFERENCES_SCHEMA_SQL);
  const columns = worktreeColumns(database);
  addMissingPinnedColumn(database, columns);
  if (hasRootOnlyPrimaryKey(columns)) migrateToScopedPrimaryKey(database);
  writeSchemaVersion(database);
  ensureChangeCounters(database);
}
