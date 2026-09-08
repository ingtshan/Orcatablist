import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase, type StoredSession } from "../src/db";
import { auditDirectories } from "../src/directory-governance";
import { handleFocusBoardRequest, type FocusBoardPayload } from "../src/focus-board-routes";
import { isVisibleOnBoard } from "../src/focus-board";
import { GoalsStore, openGoalsDatabase } from "../src/goals";
import type { LiveSnapshot } from "../src/live-source";
import { openProjectPreferencesDatabase, ProjectPreferencesStore } from "../src/project-preferences";
import type { SessionLiveReader } from "../src/session-live";
import type { LiveInfo, SessionRow } from "../src/types";
import { resolveLiveSessionRows, UNINDEXED_LIVE_PROJECT_KEY } from "../src/unindexed-live";
import {
  liveWorktreeRootFor, parseWorkspacePath, resolveWorktreeRoot, rowWorktreeGroupKey,
  worktreePreferenceKey,
} from "../src/worktree-identity";

/**
 * The same path on two machines is two directories. Everything below drives the real production
 * helpers with the shape the user actually hit: a `feibo1` Codex tab whose Orca workspace is
 * `/Users/feibo/orca/workspaces/lumina/class-plan-practice-v01`, sitting next to a local checkout
 * of the same name.
 */

const REMOTE_ENV = "feibo1";
const REMOTE_SID = "01a079d4-cce3-7a01-8f45-066d21c37940";
const LOCAL_SID = "44444444-4444-4444-4444-444444444444";
const WORKSPACE = "/Users/feibo/orca/workspaces/lumina/class-plan-practice-v01";
const WORKSPACE_KEY = `bd8d1516-ff77-4454-86e2-5a1ea570b169::${WORKSPACE}`;
const LOCAL_PROJECT = "/Users/bb00/workspace/lumina";
const REMOTE_PROJECT = `${REMOTE_ENV}:${WORKSPACE}`;
const NOON = new Date(2026, 8, 6, 12, 0, 0).getTime();
const BOARD_URL = new URL("http://127.0.0.1/api/board/focus");

const temporaryDirectories: string[] = [];
const stores: ProjectPreferencesStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function tab(name: string, env?: string, worktree?: string): LiveInfo {
  return {
    pid: 4321, status: "working", updatedAt: NOON - 1_000, waitingFor: null, name,
    ...(env === undefined ? {} : { env }),
    ...(worktree === undefined ? {} : { worktree }),
  };
}

function storedSession(sid: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    agent: "codex", sid, projectKey: LOCAL_PROJECT, cwd: WORKSPACE, worktreeRoot: WORKSPACE,
    branch: "main", title: null, firstPrompt: "hello", lastPrompt: "hello", lastInputAt: NOON,
    promptCount: 1, filePath: `/tmp/${sid}.jsonl`, fileSize: 1, fileMtime: 1, parsedOffset: 1,
    ...overrides,
  } as StoredSession;
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    agent: "codex", sid: LOCAL_SID, projectKey: LOCAL_PROJECT, cwd: null, worktreeRoot: WORKSPACE,
    branch: null, title: null, firstPrompt: null, lastPrompt: null, displayTitle: "session",
    lastInputAt: NOON, promptCount: 1, live: null, goals: [], indexed: true, ...overrides,
  } as SessionRow;
}

function openStore(path = ":memory:"): ProjectPreferencesStore {
  const store = new ProjectPreferencesStore(openProjectPreferencesDatabase(path));
  stores.push(store);
  return store;
}

function temporaryPath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return join(directory, "project-preferences.db");
}

describe("reading a worktree's location off a live tab", () => {
  test("takes the path after the first separator of a real Orca workspace key", () => {
    expect(parseWorkspacePath(WORKSPACE_KEY)).toBe(WORKSPACE);
    expect(parseWorkspacePath("id::/a::b")).toBe("/a::b");
  });

  test("rejects every workspace key that is not an id plus an absolute path", () => {
    for (const value of ["", "::/abs", "id::relative", "id:/abs", "/abs", "id::", null, undefined, 7]) {
      expect(parseWorkspacePath(value as string | null | undefined)).toBeNull();
    }
  });

  test("a tab only describes a row on its own machine", () => {
    const remoteTab = tab("class-plan", REMOTE_ENV, WORKSPACE_KEY);
    expect(liveWorktreeRootFor({ env: REMOTE_ENV, live: remoteTab })).toBe(WORKSPACE);
    expect(liveWorktreeRootFor({ live: remoteTab })).toBeNull();
    expect(liveWorktreeRootFor({ env: "feibo2", live: remoteTab })).toBeNull();
    // Missing, empty and "local" are the same environment, so none of these conflict.
    const localTab = tab("class-plan", undefined, WORKSPACE_KEY);
    expect(liveWorktreeRootFor({ live: localTab })).toBe(WORKSPACE);
    expect(liveWorktreeRootFor({ env: "", live: localTab })).toBe(WORKSPACE);
    expect(liveWorktreeRootFor({ env: "local", live: localTab })).toBe(WORKSPACE);
  });

  test("resolution order is indexed root, same-machine tab, indexed cwd, then project root", () => {
    const live = tab("class-plan", undefined, WORKSPACE_KEY);
    expect(resolveWorktreeRoot({ worktreeRoot: "/indexed", cwd: "/cwd", live }, "/root")).toBe("/indexed");
    expect(resolveWorktreeRoot({ worktreeRoot: null, cwd: "/cwd", live }, "/root")).toBe(WORKSPACE);
    expect(resolveWorktreeRoot({ worktreeRoot: null, cwd: "/cwd", live: null }, "/root")).toBe("/cwd");
    expect(resolveWorktreeRoot({ worktreeRoot: null, cwd: null, live: null }, "/root")).toBe("/root");
    expect(resolveWorktreeRoot({})).toBe("");
  });
});

describe("the unindexed live placeholder", () => {
  function resolved(live: Map<string, LiveInfo>): SessionRow[] {
    const db = new OrcaDatabase(":memory:");
    try { return resolveLiveSessionRows(db, live).map((entry) => entry.session); }
    finally { db.close(); }
  }

  test("exposes the live workspace as its root while staying an unindexed unknown", () => {
    const [placeholder] = resolved(new Map([
      [`${REMOTE_ENV}:codex/${REMOTE_SID}`, tab("class-plan-practice-v01", REMOTE_ENV, WORKSPACE_KEY)],
    ]));
    expect(placeholder).toMatchObject({
      env: REMOTE_ENV, sid: REMOTE_SID, projectKey: UNINDEXED_LIVE_PROJECT_KEY,
      worktreeRoot: WORKSPACE, cwd: null, branch: null, indexed: false,
    });
  });

  test("a malformed or foreign workspace key leaves the placeholder without a root", () => {
    const rows = resolved(new Map([
      [`${REMOTE_ENV}:codex/${REMOTE_SID}`, tab("bad key", REMOTE_ENV, "no-separator")],
      // The env stamped on the tab disagrees with the identity's env: not this row's location.
      [`feibo2:codex/${LOCAL_SID}`, tab("wrong machine", REMOTE_ENV, WORKSPACE_KEY)],
    ]));
    expect(rows.map((entry) => entry.worktreeRoot)).toEqual([null, null]);
  });

  test("two environments running the same workspace stay in separate groups", () => {
    const rows = resolved(new Map([
      [`codex/${REMOTE_SID}`, tab("local copy", undefined, WORKSPACE_KEY)],
      [`${REMOTE_ENV}:codex/${REMOTE_SID}`, tab("remote copy", REMOTE_ENV, WORKSPACE_KEY)],
    ]));
    expect(rows.every((entry) => entry.worktreeRoot === WORKSPACE)).toBeTrue();
    expect(new Set(rows.map((entry) => rowWorktreeGroupKey(entry))).size).toBe(2);
  });

  test("two environments with no usable workspace key still partition on the empty root", () => {
    const rows = resolved(new Map([
      [`codex/${REMOTE_SID}`, tab("local shell")],
      [`${REMOTE_ENV}:codex/${REMOTE_SID}`, tab("remote shell", REMOTE_ENV)],
    ]));
    expect(rows.every((entry) => entry.worktreeRoot === null)).toBeTrue();
    expect(new Set(rows.map((entry) => rowWorktreeGroupKey(entry))).size).toBe(2);
  });
});

describe("worktree preferences scoped by project", () => {
  test("the same path pins and archives independently under two projects", () => {
    const path = temporaryPath("orcatab-worktree-env-");
    let store = openStore(path);
    expect(store.updateWorktree(LOCAL_PROJECT, WORKSPACE, { archived: true }).archived).toBeTrue();
    expect(store.updateWorktree(REMOTE_PROJECT, WORKSPACE, { pinned: true }).pinned).toBeTrue();
    expect(store.getWorktreePreference(LOCAL_PROJECT, WORKSPACE))
      .toEqual({ projectKey: LOCAL_PROJECT, root: WORKSPACE, pinned: false, archived: true });
    expect(store.getWorktreePreference(REMOTE_PROJECT, WORKSPACE))
      .toEqual({ projectKey: REMOTE_PROJECT, root: WORKSPACE, pinned: true, archived: false });
    stores.pop();
    store.close();

    // Both survive a restart, and clearing one leaves the other exactly as it was.
    store = openStore(path);
    expect(store.listWorktreePreferences()).toHaveLength(2);
    expect(store.updateWorktree(LOCAL_PROJECT, WORKSPACE, { archived: false }).archived).toBeFalse();
    expect(store.getWorktreePreference(LOCAL_PROJECT, WORKSPACE)).toBeNull();
    expect(store.getWorktreePreference(REMOTE_PROJECT, WORKSPACE)?.pinned).toBeTrue();
  });

  test("a governance batch deduplicates by project and path together", () => {
    const store = openStore();
    expect(store.archiveBatch([], [
      { projectKey: LOCAL_PROJECT, root: WORKSPACE },
      { projectKey: LOCAL_PROJECT, root: WORKSPACE },
      { projectKey: REMOTE_PROJECT, root: WORKSPACE },
    ])).toEqual({ projects: 0, worktrees: 2 });
    expect(store.getWorktreePreference(LOCAL_PROJECT, WORKSPACE)?.archived).toBeTrue();
    expect(store.getWorktreePreference(REMOTE_PROJECT, WORKSPACE)?.archived).toBeTrue();
    expect(store.archiveBatch([], [{ projectKey: REMOTE_PROJECT, root: WORKSPACE }]))
      .toEqual({ projects: 0, worktrees: 0 });
  });
});

describe("migrating a version 3 preference file", () => {
  /** A real root-keyed file, with pin and archive intent and timestamps a user would lose. */
  function writeLegacyDatabase(path: string): void {
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta(key, value) VALUES ('project_preferences_schema_version', '3');
      INSERT INTO meta(key, value) VALUES ('project_preferences_version', '9');
      INSERT INTO meta(key, value) VALUES ('worktree_preferences_version', '12');
      CREATE TABLE project_preferences (
        project_key TEXT PRIMARY KEY, pinned INTEGER NOT NULL, archived INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO project_preferences(project_key, pinned, archived, updated_at) VALUES ('alpha', 1, 0, 111);
      CREATE TABLE worktree_preferences (
        root TEXT PRIMARY KEY, project_key TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
      );
      INSERT INTO worktree_preferences(root, project_key, pinned, archived, updated_at)
        VALUES ('${WORKSPACE}', '${LOCAL_PROJECT}', 0, 1, 222);
      INSERT INTO worktree_preferences(root, project_key, pinned, archived, updated_at)
        VALUES ('/gone/history', 'beta', 1, 0, 333);
    `);
    legacy.close();
  }

  test("carries every row, flag, timestamp and counter onto the scoped key", () => {
    const path = temporaryPath("orcatab-worktree-v3-");
    writeLegacyDatabase(path);
    const store = openStore(path);

    expect(store.getPreference("alpha")).toEqual({ projectKey: "alpha", pinned: true, archived: false });
    expect(store.preferencesVersion).toBe(9);
    expect(store.worktreePreferencesVersion).toBe(12);
    expect(store.getWorktreePreference(LOCAL_PROJECT, WORKSPACE))
      .toEqual({ projectKey: LOCAL_PROJECT, root: WORKSPACE, pinned: false, archived: true });
    expect(store.getWorktreePreference("beta", "/gone/history"))
      .toEqual({ projectKey: "beta", root: "/gone/history", pinned: true, archived: false });

    const raw = new Database(path);
    try {
      expect(raw.query("SELECT root, updated_at FROM worktree_preferences ORDER BY root").all())
        .toEqual([{ root: WORKSPACE, updated_at: 222 }, { root: "/gone/history", updated_at: 333 }]);
      expect(raw.query("SELECT value FROM meta WHERE key = 'project_preferences_schema_version'").get())
        .toEqual({ value: "4" });
      expect(raw.query("PRAGMA table_info(worktree_preferences)").all()
        .filter((column) => (column as { pk: number }).pk > 0)
        .map((column) => (column as { name: string }).name).sort())
        .toEqual(["project_key", "root"]);
      expect(raw.query("SELECT name FROM sqlite_master WHERE name = 'worktree_preferences_v3'").all())
        .toEqual([]);
    } finally { raw.close(); }
  });

  test("reopening is idempotent and the migrated file accepts a second project for one path", () => {
    const path = temporaryPath("orcatab-worktree-v3-reopen-");
    writeLegacyDatabase(path);
    const first = openStore(path);
    const before = first.listWorktreePreferences();
    stores.pop();
    first.close();

    const store = openStore(path);
    expect(store.listWorktreePreferences()).toEqual(before);
    expect(store.worktreePreferencesVersion).toBe(12);
    expect(store.updateWorktree(REMOTE_PROJECT, WORKSPACE, { archived: true }).archived).toBeTrue();
    expect(store.getWorktreePreference(LOCAL_PROJECT, WORKSPACE)?.archived).toBeTrue();
    expect(store.listWorktreePreferences()).toHaveLength(3);
  });
});

describe("board visibility across environments", () => {
  test("archiving the local copy of a path leaves the remote row on the board", () => {
    const visibility = {
      archivedProjects: new Set<string>(),
      archivedWorktrees: new Set([worktreePreferenceKey(LOCAL_PROJECT, WORKSPACE)]),
      projectRoots: new Map([[LOCAL_PROJECT, LOCAL_PROJECT], [REMOTE_PROJECT, ""]]),
    };
    expect(isVisibleOnBoard(row(), visibility)).toBeFalse();
    expect(isVisibleOnBoard(row({ env: REMOTE_ENV, projectKey: REMOTE_PROJECT }), visibility)).toBeTrue();
  });

  test("the focus route hides only the archived project's copy of the shared path", async () => {
    const db = new OrcaDatabase(":memory:");
    const goalsStore = new GoalsStore(openGoalsDatabase(":memory:"));
    const preferences = openStore();
    db.upsertProject({ key: LOCAL_PROJECT, name: "lumina", root: LOCAL_PROJECT, color: null });
    db.upsertProject({ key: REMOTE_PROJECT, name: `class-plan-practice-v01 @${REMOTE_ENV}`, root: "", color: null });
    db.upsertSession(storedSession(LOCAL_SID));
    db.upsertSession(storedSession(REMOTE_SID, { env: REMOTE_ENV, projectKey: REMOTE_PROJECT }));
    const live = new Map<string, LiveInfo>([
      [`codex/${LOCAL_SID}`, tab("local", undefined, WORKSPACE_KEY)],
      [`${REMOTE_ENV}:codex/${REMOTE_SID}`, tab("remote", REMOTE_ENV, WORKSPACE_KEY)],
    ]);
    const snapshot: LiveSnapshot = { at: NOON - 500, live, sources: [] };
    const liveReader: SessionLiveReader = {
      refresh: async () => live,
      refreshSnapshot: async () => snapshot,
      getLiveMap: () => live,
      getSnapshot: () => snapshot,
      getLiveVersion: () => 1,
      findLive: async () => null,
    };
    const deps = { db, goalsStore, preferences, liveReader, now: () => NOON };
    const read = async (): Promise<FocusBoardPayload> => {
      const response = await handleFocusBoardRequest(new Request(BOARD_URL), BOARD_URL, deps);
      if (response === null) throw new Error("route did not match");
      return await response.json() as FocusBoardPayload;
    };

    try {
      const before = await read();
      expect(before.lanes.flatMap((lane) => lane.rows).map((entry) => entry.sid).sort())
        .toEqual([REMOTE_SID, LOCAL_SID].sort());
      preferences.updateWorktree(LOCAL_PROJECT, WORKSPACE, { archived: true });
      const after = await read();
      expect(after.lanes.flatMap((lane) => lane.rows).map((entry) => entry.sid)).toEqual([REMOTE_SID]);
    } finally {
      goalsStore.close();
      db.close();
    }
  });
});

describe("the local directory audit stops at this machine", () => {
  function auditRow(overrides: Partial<SessionRow> = {}): SessionRow {
    return row({ cwd: WORKSPACE, worktreeRoot: WORKSPACE, ...overrides });
  }

  function project(key: string, root: string) {
    return { key, name: key, root, color: null, sessionCount: 1, lastInputAt: NOON, pinned: false, archived: false };
  }

  test("never stats a remote path, audits no remote-only project, and plans no remote archive", () => {
    const checked: string[] = [];
    const audit = auditDirectories(
      [project(LOCAL_PROJECT, "/Users/bb00/workspace/lumina"), project(REMOTE_PROJECT, "")],
      [
        auditRow({ cwd: "/Users/bb00/workspace/lumina/gone", worktreeRoot: "/Users/bb00/workspace/lumina/gone" }),
        auditRow({ sid: REMOTE_SID, env: REMOTE_ENV, projectKey: REMOTE_PROJECT }),
      ],
      [],
      (path) => { checked.push(path); return false; },
      () => NOON,
    );

    expect(checked).not.toContain(WORKSPACE);
    expect(checked.every((path) => path.startsWith("/Users/bb00/"))).toBeTrue();
    expect(audit.projects.map((entry) => entry.projectKey)).toEqual([LOCAL_PROJECT]);
    expect(audit.directories.map((entry) => entry.root)).toEqual(["/Users/bb00/workspace/lumina/gone"]);
    expect(audit.archivePlan.projectKeys).toEqual([LOCAL_PROJECT]);
    expect(audit.archivePlan.worktrees).toEqual([]);
    expect(audit.summary).toMatchObject({ projectRoots: 1, directoryGroups: 1 });
  });

  test("an environment that also has a local session keeps its project in the local audit", () => {
    const checked: string[] = [];
    const audit = auditDirectories(
      [project(LOCAL_PROJECT, "/Users/bb00/workspace/lumina")],
      [
        auditRow(),
        auditRow({ sid: REMOTE_SID, env: REMOTE_ENV, cwd: "/elsewhere", worktreeRoot: "/elsewhere" }),
      ],
      [],
      (path) => { checked.push(path); return true; },
      () => NOON,
    );

    expect(checked).not.toContain("/elsewhere");
    expect(audit.projects.map((entry) => entry.projectKey)).toEqual([LOCAL_PROJECT]);
    expect(audit.directories.map((entry) => [entry.root, entry.sessionCount])).toEqual([[WORKSPACE, 1]]);
  });

  test("an empty or missing env is this machine, exactly as the identity layer reads it", () => {
    const audit = auditDirectories(
      [project(LOCAL_PROJECT, "/Users/bb00/workspace/lumina")],
      [auditRow({ env: "" }), auditRow({ sid: REMOTE_SID, env: "local" })],
      [], () => true, () => NOON,
    );
    expect(audit.directories.map((entry) => entry.sessionCount)).toEqual([2]);
  });
});
