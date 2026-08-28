import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openProjectPreferencesDatabase, ProjectPreferencesStore, sortProjects,
} from "../src/project-preferences";
import type { ProjectRow } from "../src/types";

const temporaryDirectories: string[] = [];
const stores: ProjectPreferencesStore[] = [];

function project(key: string, lastInputAt: number | null, pinned = false, archived = false): ProjectRow {
  return { key, name: key, root: `/${key}`, color: null, sessionCount: 1, lastInputAt, pinned, archived };
}

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("ProjectPreferencesStore", () => {
  test("sorts active pinned projects first and archived projects last", () => {
    expect(sortProjects([
      project("recent", 30), project("archived", 50, false, true), project("pinned", 10, true), project("older", 20),
    ]).map(({ key }) => key)).toEqual(["pinned", "recent", "older", "archived"]);
  });

  test("persists pin and archive intent independently from the index cache", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-project-preferences-"));
    temporaryDirectories.push(root);
    const path = join(root, "project-preferences.db");
    let store = new ProjectPreferencesStore(openProjectPreferencesDatabase(path));
    expect(store.preferencesVersion).toBe(0);
    expect(store.update("alpha", { pinned: true })).toEqual({ projectKey: "alpha", pinned: true, archived: false });
    expect(store.preferencesVersion).toBe(1);
    store.close();

    store = new ProjectPreferencesStore(openProjectPreferencesDatabase(path));
    stores.push(store);
    expect(store.apply([project("beta", 20), project("alpha", 10)]).map((item) => [item.key, item.pinned]))
      .toEqual([["alpha", true], ["beta", false]]);
    expect(store.update("alpha", { archived: true })).toEqual({ projectKey: "alpha", pinned: false, archived: true });
    expect(store.update("alpha", { archived: false })).toEqual({ projectKey: "alpha", pinned: false, archived: false });
    expect(store.preferencesVersion).toBe(3);
  });

  test("pinning an archived project restores it and unchanged updates do not bump version", () => {
    const store = new ProjectPreferencesStore(openProjectPreferencesDatabase(":memory:"));
    stores.push(store);
    store.update("alpha", { archived: true });
    expect(store.update("alpha", { archived: true })).toEqual({ projectKey: "alpha", pinned: false, archived: true });
    expect(store.preferencesVersion).toBe(1);
    expect(store.update("alpha", { pinned: true })).toEqual({ projectKey: "alpha", pinned: true, archived: false });
    expect(store.preferencesVersion).toBe(2);
    expect(() => store.update("alpha", { pinned: true, archived: true })).toThrow();
  });

  test("persists worktree archives independently and deletes the preference on restore", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-worktree-preferences-"));
    temporaryDirectories.push(root);
    const path = join(root, "project-preferences.db");
    let store = new ProjectPreferencesStore(openProjectPreferencesDatabase(path));
    expect(store.worktreePreferencesVersion).toBe(0);
    expect(store.listWorktreePreferences()).toEqual([]);
    expect(store.updateWorktree("alpha", "/repo/feature-a", { archived: true })).toEqual({
      projectKey: "alpha", root: "/repo/feature-a", pinned: false, archived: true,
    });
    expect(store.worktreePreferencesVersion).toBe(1);
    expect(store.preferencesVersion).toBe(0);
    expect(store.updateWorktree("alpha", "/repo/feature-a", { archived: true }).archived).toBeTrue();
    expect(store.worktreePreferencesVersion).toBe(1);
    store.close();

    store = new ProjectPreferencesStore(openProjectPreferencesDatabase(path));
    stores.push(store);
    expect(store.listWorktreePreferences()).toEqual([{
      projectKey: "alpha", root: "/repo/feature-a", pinned: false, archived: true,
    }]);
    expect(store.updateWorktree("alpha", "/repo/feature-a", { archived: false })).toEqual({
      projectKey: "alpha", root: "/repo/feature-a", pinned: false, archived: false,
    });
    expect(store.listWorktreePreferences()).toEqual([]);
    expect(store.worktreePreferencesVersion).toBe(2);
  });

  test("pinning and archiving a worktree are mutually exclusive", () => {
    const store = new ProjectPreferencesStore(openProjectPreferencesDatabase(":memory:"));
    stores.push(store);
    expect(store.updateWorktree("alpha", "/repo/feature-a", { archived: true })).toMatchObject({
      pinned: false, archived: true,
    });
    expect(store.updateWorktree("alpha", "/repo/feature-a", { pinned: true })).toMatchObject({
      pinned: true, archived: false,
    });
    expect(store.updateWorktree("alpha", "/repo/feature-a", { archived: true })).toMatchObject({
      pinned: false, archived: true,
    });
    expect(() => store.updateWorktree("alpha", "/repo/feature-a", { pinned: true, archived: true })).toThrow();
  });

  test("archives a deduplicated governance batch atomically and bumps each changed version once", () => {
    const store = new ProjectPreferencesStore(openProjectPreferencesDatabase(":memory:"));
    stores.push(store);
    store.update("alpha", { pinned: true });
    store.updateWorktree("beta", "/gone/history", { pinned: true });
    const beforeProjects = store.preferencesVersion;
    const beforeWorktrees = store.worktreePreferencesVersion;

    expect(store.archiveBatch(
      ["alpha", "alpha"],
      [
        { projectKey: "beta", root: "/gone/history" },
        { projectKey: "beta", root: "/gone/history" },
      ],
    )).toEqual({ projects: 1, worktrees: 1 });
    expect(store.getPreference("alpha")).toEqual({ projectKey: "alpha", pinned: false, archived: true });
    expect(store.getWorktreePreference("/gone/history")).toEqual({
      projectKey: "beta", root: "/gone/history", pinned: false, archived: true,
    });
    expect(store.preferencesVersion).toBe(beforeProjects + 1);
    expect(store.worktreePreferencesVersion).toBe(beforeWorktrees + 1);
    expect(store.archiveBatch(["alpha"], [{ projectKey: "beta", root: "/gone/history" }]))
      .toEqual({ projects: 0, worktrees: 0 });
    expect(store.preferencesVersion).toBe(beforeProjects + 1);
    expect(store.worktreePreferencesVersion).toBe(beforeWorktrees + 1);
  });

  test("adds worktree preferences to a v1 database without losing project preferences", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-preferences-v1-"));
    temporaryDirectories.push(root);
    const path = join(root, "project-preferences.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta(key, value) VALUES ('project_preferences_schema_version', '1');
      INSERT INTO meta(key, value) VALUES ('project_preferences_version', '7');
      CREATE TABLE project_preferences (
        project_key TEXT PRIMARY KEY, pinned INTEGER NOT NULL, archived INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO project_preferences(project_key, pinned, archived, updated_at) VALUES ('alpha', 1, 0, 1);
    `);
    legacy.close();

    const store = new ProjectPreferencesStore(openProjectPreferencesDatabase(path));
    stores.push(store);
    expect(store.getPreference("alpha")).toEqual({ projectKey: "alpha", pinned: true, archived: false });
    expect(store.preferencesVersion).toBe(7);
    expect(store.worktreePreferencesVersion).toBe(0);
    expect(store.updateWorktree("alpha", "/repo/feature-a", { archived: true }).archived).toBeTrue();
  });

  test("adds pinned to a v2 worktree archive without losing it", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-preferences-v2-"));
    temporaryDirectories.push(root);
    const path = join(root, "project-preferences.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta(key, value) VALUES ('project_preferences_schema_version', '2');
      INSERT INTO meta(key, value) VALUES ('project_preferences_version', '0');
      INSERT INTO meta(key, value) VALUES ('worktree_preferences_version', '4');
      CREATE TABLE project_preferences (
        project_key TEXT PRIMARY KEY, pinned INTEGER NOT NULL, archived INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE worktree_preferences (
        root TEXT PRIMARY KEY, project_key TEXT NOT NULL, archived INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO worktree_preferences(root, project_key, archived, updated_at)
        VALUES ('/repo/feature-a', 'alpha', 1, 1);
    `);
    legacy.close();

    const store = new ProjectPreferencesStore(openProjectPreferencesDatabase(path));
    stores.push(store);
    expect(store.getWorktreePreference("/repo/feature-a")).toEqual({
      projectKey: "alpha", root: "/repo/feature-a", pinned: false, archived: true,
    });
    expect(store.worktreePreferencesVersion).toBe(4);
    expect(store.updateWorktree("alpha", "/repo/feature-a", { pinned: true })).toMatchObject({
      pinned: true, archived: false,
    });
  });
});
