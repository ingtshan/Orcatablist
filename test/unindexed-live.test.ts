import { describe, expect, test } from "bun:test";
import { OrcaDatabase, type StoredSession } from "../src/db";
import {
  appendUnindexedLiveSessions, liveSessionRowsForList, liveSessionsPayload, resolveLiveSessionRows,
} from "../src/unindexed-live";
import type { LiveInfo, SessionRow } from "../src/types";

const INDEXED_SID = "11111111-1111-1111-1111-111111111111";
const UNKNOWN_SID = "22222222-2222-2222-2222-222222222222";
const SHARED_SID = "33333333-3333-3333-3333-333333333333";
const REMOTE_ENV = "feibo-n2";

const info: LiveInfo = { pid: 123, status: "working", waitingFor: null, name: "live process" };

function stored(sid: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    agent: "claude", sid, projectKey: "/repo", cwd: "/repo", worktreeRoot: "/repo", branch: "main",
    title: null, firstPrompt: "hello", lastPrompt: "hello", lastInputAt: 1_000, promptCount: 1,
    filePath: `/tmp/${sid}.jsonl`, fileSize: 1, fileMtime: 1, parsedOffset: 1, ...overrides,
  };
}

function database(rows: StoredSession[] = [stored(INDEXED_SID)]): OrcaDatabase {
  const db = new OrcaDatabase(":memory:");
  db.transaction(() => { for (const row of rows) db.upsertSession(row); });
  return db;
}

describe("resolving live identities against the index", () => {
  test("answers indexed from the database for the exact identity, not from any page of rows", () => {
    const db = database();
    try {
      const resolved = resolveLiveSessionRows(db, new Map([
        [`claude/${INDEXED_SID}`, info], [`claude/${UNKNOWN_SID}`, info],
      ]));
      expect(resolved.map((entry) => [entry.key, entry.indexed])).toEqual([
        [`claude/${INDEXED_SID}`, true], [`claude/${UNKNOWN_SID}`, false],
      ]);
      expect(resolved[0]!.session).toMatchObject({
        agent: "claude", sid: INDEXED_SID, projectKey: "/repo", indexed: true, live: info,
      });
      expect(resolved[1]!.session).toEqual({
        agent: "claude", sid: UNKNOWN_SID, projectKey: "__unindexed_live__", cwd: null,
        worktreeRoot: null, branch: null, title: null, firstPrompt: null, lastPrompt: "live process",
        displayTitle: "未索引在线会话", lastInputAt: null, promptCount: 0,
        live: info, goals: [], indexed: false,
      });
    } finally { db.close(); }
  });

  test("ignores keys this codebase did not produce", () => {
    const db = database();
    try {
      const resolved = resolveLiveSessionRows(db, new Map([
        ["malformed", info], ["/leading-slash", info], ["invalid/agent-name", info],
        [`claude/bad sid`, info], [`local:claude/${UNKNOWN_SID}`, info],
        [`claude/${INDEXED_SID}`, info],
      ]));
      expect(resolved.map((entry) => entry.key)).toEqual([`claude/${INDEXED_SID}`]);
    } finally { db.close(); }
  });

  test("a genuinely unindexed remote session keeps its environment", () => {
    const db = database();
    try {
      const [entry] = resolveLiveSessionRows(db, new Map([[`${REMOTE_ENV}/claude/${UNKNOWN_SID}`, info]]));
      expect(entry).toBeUndefined();
      const [remote] = resolveLiveSessionRows(db, new Map([[`${REMOTE_ENV}:claude/${UNKNOWN_SID}`, info]]));
      expect(remote!.key).toBe(`${REMOTE_ENV}:claude/${UNKNOWN_SID}`);
      expect(remote!.indexed).toBeFalse();
      expect(remote!.session).toMatchObject({ agent: "claude", env: REMOTE_ENV, sid: UNKNOWN_SID, indexed: false });
    } finally { db.close(); }
  });

  test("the same agent and sid in two environments stay distinct rows", () => {
    const db = database([stored(SHARED_SID), stored(SHARED_SID, { env: REMOTE_ENV, projectKey: `${REMOTE_ENV}:/repo` })]);
    try {
      const resolved = resolveLiveSessionRows(db, new Map([
        [`claude/${SHARED_SID}`, info], [`${REMOTE_ENV}:claude/${SHARED_SID}`, { ...info, env: REMOTE_ENV }],
      ]));
      expect(resolved).toHaveLength(2);
      expect(resolved.every((entry) => entry.indexed)).toBeTrue();
      expect(resolved[0]!.session.env).toBeUndefined();
      expect(resolved[1]!.session.env).toBe(REMOTE_ENV);
      expect(resolved[0]!.session.projectKey).not.toBe(resolved[1]!.session.projectKey);
    } finally { db.close(); }
  });

  test("a database miss for one environment does not answer for the other", () => {
    const db = database([stored(SHARED_SID, { env: REMOTE_ENV, projectKey: `${REMOTE_ENV}:/repo` })]);
    try {
      const resolved = resolveLiveSessionRows(db, new Map([
        [`claude/${SHARED_SID}`, info], [`${REMOTE_ENV}:claude/${SHARED_SID}`, info],
      ]));
      expect(resolved.map((entry) => entry.indexed)).toEqual([false, true]);
      expect(resolved[0]!.session.env).toBeUndefined();
      expect(resolved[1]!.session.env).toBe(REMOTE_ENV);
    } finally { db.close(); }
  });

  test("hands every resolved row to the caller's goal attachment, in order", () => {
    const db = database();
    try {
      const resolved = resolveLiveSessionRows(db, new Map([
        [`claude/${INDEXED_SID}`, info], [`claude/${UNKNOWN_SID}`, info],
      ]), { attachGoals: (rows) => rows.map((row) => ({ ...row, goals: [{ id: row.sid, name: "goal" }] })) });
      expect(resolved.map((entry) => entry.session.goals)).toEqual([
        [{ id: INDEXED_SID, name: "goal" }], [{ id: UNKNOWN_SID, name: "goal" }],
      ]);
    } finally { db.close(); }
  });
});

describe("projecting resolved rows onto the session list", () => {
  test("a page that excludes an indexed live row never turns it into a placeholder", () => {
    const db = database();
    try {
      const resolved = resolveLiveSessionRows(db, new Map([
        [`claude/${INDEXED_SID}`, info], [`claude/${UNKNOWN_SID}`, info],
      ]));
      // The page holds newer, unrelated rows — the indexed live session is off the end of it.
      const page: SessionRow[] = [{
        agent: "claude", sid: "newer", projectKey: "/repo", cwd: null, worktreeRoot: null, branch: null,
        title: null, firstPrompt: null, lastPrompt: null, displayTitle: "newer", lastInputAt: 9_000,
        promptCount: 1, live: null, goals: [],
      }];
      const rows = appendUnindexedLiveSessions(page, resolved);
      expect(rows.map((row) => row.sid)).toEqual([UNKNOWN_SID, "newer"]);
      expect(rows.some((row) => row.sid === INDEXED_SID && row.indexed === false)).toBeFalse();
    } finally { db.close(); }
  });

  test("does not duplicate a placeholder the page already carries", () => {
    const db = database();
    try {
      const resolved = resolveLiveSessionRows(db, new Map([[`claude/${UNKNOWN_SID}`, info]]));
      const rows = appendUnindexedLiveSessions([resolved[0]!.session], resolved);
      expect(rows).toHaveLength(1);
    } finally { db.close(); }
  });

  test("live=1 keeps unknowns first and orders indexed rows newest first, nulls last", () => {
    const db = database([
      stored(INDEXED_SID, { lastInputAt: 10 }),
      stored(SHARED_SID, { lastInputAt: 30 }),
      stored("no-input", { lastInputAt: null }),
    ]);
    try {
      const rows = liveSessionRowsForList(resolveLiveSessionRows(db, new Map([
        [`claude/${INDEXED_SID}`, info], ["claude/no-input", info],
        [`claude/${UNKNOWN_SID}`, info], [`claude/${SHARED_SID}`, info],
      ])));
      expect(rows.map((row) => row.sid)).toEqual([UNKNOWN_SID, SHARED_SID, INDEXED_SID, "no-input"]);
    } finally { db.close(); }
  });

  test("live=1 resolves by identity, so newer unrelated rows cannot hide an old live session", () => {
    const db = database([stored(INDEXED_SID, { lastInputAt: 1 })]);
    try {
      db.transaction(() => {
        for (let index = 0; index < 5_100; index += 1) {
          db.upsertSession(stored(`filler-${index}`, { lastInputAt: 1_000 + index }));
        }
      });
      expect(db.listSessions({ limit: 5_000 }).some((row) => row.sid === INDEXED_SID)).toBeFalse();
      const rows = liveSessionRowsForList(resolveLiveSessionRows(db, new Map([[`claude/${INDEXED_SID}`, info]])));
      expect(rows.map((row) => [row.sid, row.indexed])).toEqual([[INDEXED_SID, true]]);
    } finally { db.close(); }
  });
});

describe("the /api/live payload", () => {
  test("keeps the historical keys, drops invalid ones, and answers the index question for each", () => {
    const db = database([stored(INDEXED_SID), stored(SHARED_SID, { env: REMOTE_ENV, projectKey: `${REMOTE_ENV}:/repo` })]);
    try {
      const payload = liveSessionsPayload(db, new Map([
        [`claude/${INDEXED_SID}`, info],
        [`claude/${UNKNOWN_SID}`, info],
        [`${REMOTE_ENV}:claude/${SHARED_SID}`, { ...info, env: REMOTE_ENV }],
        ["malformed", info],
      ]));
      // The malformed key has no identity to look up, so it is dropped rather than echoed back.
      expect(Object.keys(payload)).toEqual([
        `claude/${INDEXED_SID}`, `claude/${UNKNOWN_SID}`, `${REMOTE_ENV}:claude/${SHARED_SID}`,
      ]);
      expect(payload[`claude/${INDEXED_SID}`]).toMatchObject({
        pid: 123, status: "working", name: "live process", projectKey: "/repo", indexed: true,
      });
      expect(payload[`claude/${INDEXED_SID}`]!.session).toMatchObject({ sid: INDEXED_SID, indexed: true, live: info });
      // A database miss leaves the project unknown; it is not an unindexed project key.
      expect(payload[`claude/${UNKNOWN_SID}`]!.projectKey).toBeNull();
      expect(payload[`claude/${UNKNOWN_SID}`]!.indexed).toBeFalse();
      expect(payload[`${REMOTE_ENV}:claude/${SHARED_SID}`]!.session).toMatchObject({ env: REMOTE_ENV, indexed: true });
      // Every returned entry answers the index question; none is left without one.
      expect(Object.values(payload).every((entry) => typeof entry.indexed === "boolean")).toBeTrue();
      expect(Object.values(payload).every((entry) => entry.session.agent === "claude")).toBeTrue();
    } finally { db.close(); }
  });

  test("newly indexing a live session flips its entry without any live change", () => {
    const db = database([]);
    const live = new Map([[`claude/${INDEXED_SID}`, info]]);
    try {
      expect(liveSessionsPayload(db, live)[`claude/${INDEXED_SID}`]).toMatchObject({
        indexed: false, projectKey: null,
      });
      db.upsertSession(stored(INDEXED_SID));
      expect(liveSessionsPayload(db, live)[`claude/${INDEXED_SID}`]).toMatchObject({
        indexed: true, projectKey: "/repo",
      });
    } finally { db.close(); }
  });
});
