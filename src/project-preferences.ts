import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectRow } from "./types";

const PROJECT_PREFERENCES_SCHEMA_VERSION = "2";

const PROJECT_PREFERENCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_preferences (
  project_key TEXT PRIMARY KEY,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worktree_preferences (
  root TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 1 CHECK (archived IN (0, 1)),
  updated_at INTEGER NOT NULL
);`;

export interface ProjectPreference {
  projectKey: string;
  pinned: boolean;
  archived: boolean;
}

export interface ProjectPreferencePatch {
  pinned?: boolean;
  archived?: boolean;
}

export interface WorktreePreference {
  root: string;
  projectKey: string;
  archived: boolean;
}

export function openProjectPreferencesDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  database.exec("PRAGMA busy_timeout=5000;");
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  database.exec(PROJECT_PREFERENCES_SCHEMA_SQL);
  const version = database.query("SELECT value FROM meta WHERE key = 'project_preferences_schema_version'")
    .get() as { value: string } | null;
  if (version === null) {
    database.query("INSERT INTO meta(key, value) VALUES ('project_preferences_schema_version', ?)")
      .run(PROJECT_PREFERENCES_SCHEMA_VERSION);
  } else if (version.value !== PROJECT_PREFERENCES_SCHEMA_VERSION) {
    database.query("UPDATE meta SET value = ? WHERE key = 'project_preferences_schema_version'")
      .run(PROJECT_PREFERENCES_SCHEMA_VERSION);
  }
  database.exec(`INSERT INTO meta(key, value) SELECT 'project_preferences_version', '0'
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'project_preferences_version');`);
  database.exec(`INSERT INTO meta(key, value) SELECT 'worktree_preferences_version', '0'
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'worktree_preferences_version');`);
  return database;
}

function preferenceFromRow(row: Record<string, unknown>): ProjectPreference {
  return {
    projectKey: String(row.project_key),
    pinned: Number(row.pinned) === 1,
    archived: Number(row.archived) === 1,
  };
}

function worktreePreferenceFromRow(row: Record<string, unknown>): WorktreePreference {
  return {
    root: String(row.root),
    projectKey: String(row.project_key),
    archived: Number(row.archived) === 1,
  };
}

export function sortProjects(projects: ProjectRow[]): ProjectRow[] {
  return [...projects].sort((left, right) => Number(left.archived) - Number(right.archived)
    || Number(right.pinned) - Number(left.pinned)
    || Number(right.lastInputAt !== null) - Number(left.lastInputAt !== null)
    || (right.lastInputAt ?? -1) - (left.lastInputAt ?? -1)
    || left.name.localeCompare(right.name, "zh-CN"));
}

export class ProjectPreferencesStore {
  constructor(private readonly database: Database) {}

  get preferencesVersion(): number {
    const row = this.database.query("SELECT value FROM meta WHERE key = 'project_preferences_version'")
      .get() as { value: string } | null;
    const parsed = Number.parseInt(row?.value ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  get worktreePreferencesVersion(): number {
    const row = this.database.query("SELECT value FROM meta WHERE key = 'worktree_preferences_version'")
      .get() as { value: string } | null;
    const parsed = Number.parseInt(row?.value ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  close(): void { this.database.close(); }

  getPreference(projectKey: string): ProjectPreference {
    const row = this.database.query("SELECT project_key, pinned, archived FROM project_preferences WHERE project_key = ?")
      .get(projectKey) as Record<string, unknown> | null;
    return row === null ? { projectKey, pinned: false, archived: false } : preferenceFromRow(row);
  }

  apply(projects: ProjectRow[]): ProjectRow[] {
    const preferences = new Map(this.listPreferences().map((item) => [item.projectKey, item]));
    return sortProjects(projects.map((project) => {
      const preference = preferences.get(project.key);
      return preference === undefined ? project : { ...project, pinned: preference.pinned, archived: preference.archived };
    }));
  }

  update(projectKey: string, patch: ProjectPreferencePatch): ProjectPreference {
    if (patch.pinned === true && patch.archived === true) throw new Error("project cannot be pinned and archived");
    const current = this.getPreference(projectKey);
    const archived = patch.pinned === true ? false : patch.archived ?? current.archived;
    const pinned = patch.archived === true ? false : patch.pinned ?? current.pinned;
    if (pinned === current.pinned && archived === current.archived) return current;

    this.database.transaction(() => {
      if (!pinned && !archived) {
        this.database.query("DELETE FROM project_preferences WHERE project_key = ?").run(projectKey);
      } else {
        this.database.query(`INSERT INTO project_preferences (project_key, pinned, archived, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(project_key) DO UPDATE SET
          pinned = excluded.pinned, archived = excluded.archived, updated_at = excluded.updated_at`)
          .run(projectKey, Number(pinned), Number(archived), Date.now());
      }
      this.database.query(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'project_preferences_version'`).run();
    })();
    return { projectKey, pinned, archived };
  }

  getWorktreePreference(root: string): WorktreePreference | null {
    const row = this.database.query(`SELECT root, project_key, archived FROM worktree_preferences
      WHERE root = ?`).get(root) as Record<string, unknown> | null;
    return row === null ? null : worktreePreferenceFromRow(row);
  }

  listWorktreePreferences(): WorktreePreference[] {
    const rows = this.database.query(`SELECT root, project_key, archived FROM worktree_preferences
      ORDER BY updated_at DESC, root`).all();
    return (rows as Record<string, unknown>[]).map(worktreePreferenceFromRow);
  }

  updateWorktree(projectKey: string, root: string, archived: boolean): WorktreePreference {
    const current = this.getWorktreePreference(root);
    if (current?.projectKey === projectKey && current.archived === archived) return current;
    if (current === null && !archived) return { root, projectKey, archived: false };

    this.database.transaction(() => {
      if (!archived) {
        this.database.query("DELETE FROM worktree_preferences WHERE root = ?").run(root);
      } else {
        this.database.query(`INSERT INTO worktree_preferences (root, project_key, archived, updated_at)
          VALUES (?, ?, 1, ?) ON CONFLICT(root) DO UPDATE SET
          project_key = excluded.project_key, archived = 1, updated_at = excluded.updated_at`)
          .run(root, projectKey, Date.now());
      }
      this.database.query(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'worktree_preferences_version'`).run();
    })();
    return { root, projectKey, archived };
  }

  private listPreferences(): ProjectPreference[] {
    const rows = this.database.query("SELECT project_key, pinned, archived FROM project_preferences").all();
    return (rows as Record<string, unknown>[]).map(preferenceFromRow);
  }
}
