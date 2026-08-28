import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { OrcaDatabase } from "../src/db";
import { handleFocusBoardRequest, type FocusBoardPayload } from "../src/focus-board-routes";
import { GoalsStore, openGoalsDatabase } from "../src/goals";
import type { LiveSnapshot } from "../src/live-source";
import { openProjectPreferencesDatabase, ProjectPreferencesStore } from "../src/project-preferences";
import type { SessionLiveReader } from "../src/session-live";
import type { StoredSession } from "../src/db";
import type { LiveInfo } from "../src/types";

const SID = "77777777-7777-7777-7777-777777777777";
const OTHER_SID = "88888888-8888-8888-8888-888888888888";
const UNINDEXED_SID = "99999999-9999-9999-9999-999999999999";
const NOON = new Date(2026, 7, 28, 12, 0, 0).getTime();
const URL_ = new URL("http://127.0.0.1/api/board/focus");

function storedSession(sid: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    agent: "claude", sid, projectKey: "proj", cwd: "/work/proj", worktreeRoot: "/work/proj",
    branch: "main", title: null, firstPrompt: "hello", lastPrompt: "hello",
    lastInputAt: NOON, promptCount: 1, filePath: `/tmp/${sid}.jsonl`, fileSize: 1, fileMtime: 1,
    parsedOffset: 1, ...overrides,
  } as StoredSession;
}

function harness(live: Map<string, LiveInfo>, sources: LiveSnapshot["sources"] = []) {
  const db = new OrcaDatabase(":memory:");
  const goalsStore = new GoalsStore(openGoalsDatabase(":memory:"));
  const preferences = new ProjectPreferencesStore(openProjectPreferencesDatabase(":memory:"));
  db.upsertProject({ key: "proj", name: "proj", root: "/work/proj", color: null });
  db.upsertSession(storedSession(SID));
  db.upsertSession(storedSession(OTHER_SID));
  db.setMeta("indexed_at", String(NOON));
  let version = 1;
  const snapshot: LiveSnapshot = { at: NOON - 500, live, sources };
  const liveReader: SessionLiveReader = {
    refresh: async () => live,
    refreshSnapshot: async () => snapshot,
    getLiveMap: () => live,
    getSnapshot: () => snapshot,
    getLiveVersion: () => version,
    findLive: async () => null,
  };
  const deps = { db, goalsStore, preferences, liveReader, now: () => NOON };
  return {
    db, goalsStore, preferences, deps,
    bumpLive: () => { version += 1; },
    async get(etag?: string): Promise<Response> {
      const headers = etag ? { "If-None-Match": etag } : undefined;
      const response = await handleFocusBoardRequest(new Request(URL_, { headers }), URL_, deps);
      if (response === null) throw new Error("route did not match");
      return response;
    },
    close() { preferences.close(); goalsStore.close(); db.close(); },
  };
}

function working(updatedAt: number): LiveInfo {
  return { pid: null, status: "working", updatedAt, waitingFor: null, name: null };
}

describe("focus board route", () => {
  test("returns only live sessions, laned, with index freshness", async () => {
    const app = harness(new Map([[`claude/${SID}`, working(NOON)]]));
    try {
      const body = await (await app.get()).json() as FocusBoardPayload;
      expect(body.lanes.map((lane) => lane.key))
        .toEqual(["working", "non-working-today", "non-working-recent"]);
      expect(body.lanes[0]!.rows.map((row) => row.sid)).toEqual([SID]);
      // The other indexed session is not live, so it never reaches the board.
      expect(body.lanes.flatMap((lane) => lane.rows).map((row) => row.sid)).toEqual([SID]);
      expect(body.indexedAt).toBe(NOON);
    } finally { app.close(); }
  });

  test("includes a live session the indexer has not seen, as a placeholder row", async () => {
    const app = harness(new Map([[`claude/${UNINDEXED_SID}`, working(NOON)]]));
    try {
      const body = await (await app.get()).json() as FocusBoardPayload;
      expect(body.lanes[0]!.rows).toMatchObject([{ sid: UNINDEXED_SID, indexed: false }]);
    } finally { app.close(); }
  });

  test("carries source health so the board can tell a dead source from a quiet machine", async () => {
    const app = harness(new Map(), [
      { name: "orca-tab", ok: false, readAt: NOON - 9_000, stale: true, sessions: 0, error: "socket missing" },
    ]);
    try {
      const body = await (await app.get()).json() as FocusBoardPayload;
      expect(body.lanes.every((lane) => lane.rows.length === 0)).toBeTrue();
      expect(body.sources).toMatchObject([{ name: "orca-tab", ok: false, stale: true }]);
      expect(body.liveAt).toBe(NOON - 500);
    } finally { app.close(); }
  });

  test("304s an unchanged board", async () => {
    const app = harness(new Map([[`claude/${SID}`, working(NOON)]]));
    try {
      const first = await app.get();
      const etag = first.headers.get("ETag")!;
      expect(etag).toBeTruthy();
      const second = await app.get(etag);
      expect(second.status).toBe(304);
      expect(second.headers.get("ETag")).toBe(etag);
    } finally { app.close(); }
  });

  test("the ETag moves when liveness changes", async () => {
    const app = harness(new Map([[`claude/${SID}`, working(NOON)]]));
    try {
      const etag = (await app.get()).headers.get("ETag");
      app.bumpLive();
      expect((await app.get()).headers.get("ETag")).not.toBe(etag);
    } finally { app.close(); }
  });

  test("the ETag moves when a project is archived, because that hides rows", async () => {
    const app = harness(new Map([[`claude/${SID}`, working(NOON)]]));
    try {
      const first = await app.get();
      const etag = first.headers.get("ETag")!;
      expect((await first.json() as FocusBoardPayload).lanes[0]!.rows).toHaveLength(1);
      app.preferences.update("proj", { archived: true });
      const second = await app.get(etag);
      expect(second.status).toBe(200);
      expect((await second.json() as FocusBoardPayload).lanes[0]!.rows).toHaveLength(0);
    } finally { app.close(); }
  });

  test("the ETag moves across midnight, so lanes cannot freeze on yesterday", async () => {
    const app = harness(new Map([[`claude/${SID}`, working(NOON)]]));
    try {
      const etag = (await app.get()).headers.get("ETag")!;
      const tomorrow = NOON + 24 * 60 * 60 * 1_000;
      const url = new URL("http://127.0.0.1/api/board/focus");
      const response = await handleFocusBoardRequest(
        new Request(url, { headers: { "If-None-Match": etag } }), url,
        { ...app.deps, now: () => tomorrow },
      );
      expect(response!.status).toBe(200);
    } finally { app.close(); }
  });

  test("ignores anything that is not the board route", async () => {
    const app = harness(new Map());
    try {
      const other = new URL("http://127.0.0.1/api/live");
      expect(await handleFocusBoardRequest(new Request(other), other, app.deps)).toBeNull();
      expect(await handleFocusBoardRequest(
        new Request(URL_, { method: "POST" }), URL_, app.deps,
      )).toBeNull();
    } finally { app.close(); }
  });
});
