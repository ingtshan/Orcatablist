import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectRow } from "./types";
import { applyPreferencesSchema } from "./worktree-preferences-schema";
import { worktreePreferenceKey } from "./worktree-identity";

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
  pinned: boolean;
  archived: boolean;
}

export interface WorktreePreferencePatch {
  pinned?: boolean;
  archived?: boolean;
}

export interface WorktreeArchiveTarget {
  projectKey: string;
  root: string;
}

export function openProjectPreferencesDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  database.exec("PRAGMA busy_timeout=5000;");
  applyPreferencesSchema(database);
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
    pinned: Number(row.pinned) === 1,
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

  /**
   * Scoped by project on purpose: the same path under the local project and under `feibo1` is two
   * directories on two machines, and a root-only lookup would hand one project the other's intent.
   */
  getWorktreePreference(projectKey: string, root: string): WorktreePreference | null {
    const row = this.database.query(`SELECT root, project_key, pinned, archived FROM worktree_preferences
      WHERE project_key = ? AND root = ?`).get(projectKey, root) as Record<string, unknown> | null;
    return row === null ? null : worktreePreferenceFromRow(row);
  }

  listWorktreePreferences(): WorktreePreference[] {
    const rows = this.database.query(`SELECT root, project_key, pinned, archived FROM worktree_preferences
      ORDER BY updated_at DESC, project_key, root`).all();
    return (rows as Record<string, unknown>[]).map(worktreePreferenceFromRow);
  }

  updateWorktree(projectKey: string, root: string, patch: WorktreePreferencePatch): WorktreePreference {
    if (patch.pinned === true && patch.archived === true) throw new Error("worktree cannot be pinned and archived");
    const current = this.getWorktreePreference(projectKey, root)
      ?? { root, projectKey, pinned: false, archived: false };
    const archived = patch.pinned === true ? false : patch.archived ?? current.archived;
    const pinned = patch.archived === true ? false : patch.pinned ?? current.pinned;
    if (current.pinned === pinned && current.archived === archived) return current;

    this.database.transaction(() => {
      if (!pinned && !archived) {
        this.database.query("DELETE FROM worktree_preferences WHERE project_key = ? AND root = ?")
          .run(projectKey, root);
      } else {
        this.database.query(`INSERT INTO worktree_preferences (root, project_key, pinned, archived, updated_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_key, root) DO UPDATE SET
          pinned = excluded.pinned, archived = excluded.archived, updated_at = excluded.updated_at`)
          .run(root, projectKey, Number(pinned), Number(archived), Date.now());
      }
      this.database.query(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'worktree_preferences_version'`).run();
    })();
    return { root, projectKey, pinned, archived };
  }

  archiveBatch(projectKeys: string[], worktrees: WorktreeArchiveTarget[]): { projects: number; worktrees: number } {
    const projectTargets = [...new Set(projectKeys)]
      .filter((projectKey) => {
        const current = this.getPreference(projectKey);
        return current.pinned || !current.archived;
      });
    const worktreeTargets = [...new Map(worktrees
      .filter((target) => target.root)
      .map((target) => [worktreePreferenceKey(target.projectKey, target.root), target])).values()]
      .filter((target) => {
        const current = this.getWorktreePreference(target.projectKey, target.root);
        return current === null || current.pinned || !current.archived;
      });
    if (projectTargets.length === 0 && worktreeTargets.length === 0) return { projects: 0, worktrees: 0 };

    this.database.transaction(() => {
      const updatedAt = Date.now();
      const archiveProject = this.database.query(`INSERT INTO project_preferences
        (project_key, pinned, archived, updated_at) VALUES (?, 0, 1, ?)
        ON CONFLICT(project_key) DO UPDATE SET pinned = 0, archived = 1, updated_at = excluded.updated_at`);
      const archiveWorktree = this.database.query(`INSERT INTO worktree_preferences
        (root, project_key, pinned, archived, updated_at) VALUES (?, ?, 0, 1, ?)
        ON CONFLICT(project_key, root) DO UPDATE SET
        pinned = 0, archived = 1, updated_at = excluded.updated_at`);
      for (const projectKey of projectTargets) archiveProject.run(projectKey, updatedAt);
      for (const target of worktreeTargets) archiveWorktree.run(target.root, target.projectKey, updatedAt);
      if (projectTargets.length > 0) {
        this.database.query(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
          WHERE key = 'project_preferences_version'`).run();
      }
      if (worktreeTargets.length > 0) {
        this.database.query(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
          WHERE key = 'worktree_preferences_version'`).run();
      }
    })();
    return { projects: projectTargets.length, worktrees: worktreeTargets.length };
  }

  private listPreferences(): ProjectPreference[] {
    const rows = this.database.query("SELECT project_key, pinned, archived FROM project_preferences").all();
    return (rows as Record<string, unknown>[]).map(preferenceFromRow);
  }
}
