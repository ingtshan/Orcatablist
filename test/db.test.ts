import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabaseReadOnly, OrcaDatabase, type FtsRow, type StoredSession } from "../src/db";
import type { Agent } from "../src/types";

const databases: OrcaDatabase[] = [];
const temporaryDirectories: string[] = [];

function makeDb(): OrcaDatabase {
  const db = new OrcaDatabase(":memory:");
  databases.push(db);
  return db;
}

function session(sid: string, lastInputAt = 1, agent: Agent = "claude"): StoredSession {
  return {
    agent, sid, projectKey: "/repo", cwd: "/repo/wt", branch: "main", title: null,
    firstPrompt: "首条问题", lastPrompt: "最近问题", lastInputAt, promptCount: 1, filePath: `/tmp/${sid}.jsonl`,
    fileSize: 10, fileMtime: 20, parsedOffset: 10,
  };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("OrcaDatabase", () => {
  test("stores sessions and builds non-empty display titles", () => {
    const db = makeDb();
    db.upsertProject({ key: "/repo", name: "repo", root: "/repo", color: null });
    db.upsertSession(session("11111111-1111-1111-1111-111111111111"));
    const row = db.getSession("claude", "11111111-1111-1111-1111-111111111111");
    expect(row?.displayTitle).toBe("首条问题");
    expect(row?.lastPrompt).toBe("最近问题");
    expect(db.listProjects()[0]).toMatchObject({ name: "repo", sessionCount: 1, lastInputAt: 1 });
    expect(db.listSessions({ limit: 10 })).toEqual([row!]);
  });

  test("MATCH finds Chinese trigram text and emits highlighted snippets", () => {
    const db = makeDb();
    const sid = "11111111-1111-1111-1111-111111111111";
    db.upsertSession(session(sid));
    db.replaceSessionFts("claude", sid, [{ text: "这里展示课堂树的结构", agent: "claude", sid, role: "assistant", ts: 3 }]);
    const results = db.search("课堂树", 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.hits[0]).toMatchObject({ role: "assistant", ts: 3 });
    expect(results[0]!.hits[0]!.snippet).toContain("‹课堂树›");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  test("escapes quotes in MATCH phrases", () => {
    const db = makeDb();
    const sid = "22222222-2222-2222-2222-222222222222";
    db.upsertSession(session(sid));
    db.appendSessionFts([{ text: '前文他说"你好"后文', agent: "claude", sid, role: "user", ts: null }]);
    expect(db.search('他说"你好"', 10)).toHaveLength(1);
  });

  test("short queries use escaped LIKE and local snippets", () => {
    const db = makeDb();
    const sid = "33333333-3333-3333-3333-333333333333";
    db.upsertSession(session(sid));
    db.appendSessionFts([
      { text: "短词课可以命中", agent: "claude", sid, role: "user", ts: 4 },
      { text: "literal % and _ and \\ markers", agent: "claude", sid, role: "assistant", ts: 5 },
    ]);
    expect(db.search("课", 10)[0]!.hits[0]!.snippet).toContain("‹课›");
    expect(db.search("%", 10)).toHaveLength(1);
    expect(db.search("_", 10)).toHaveLength(1);
    expect(db.search("\\", 10)).toHaveLength(1);
    expect(db.search("  ", 10)).toEqual([]);
  });

  test("aggregates at most three hits per session and applies session limit", () => {
    const db = makeDb();
    for (let index = 1; index <= 3; index += 1) {
      const sid = `${String(index).repeat(8)}-${String(index).repeat(4)}-${String(index).repeat(4)}-${String(index).repeat(4)}-${String(index).repeat(12)}`;
      db.upsertSession(session(sid, index));
      const rows: FtsRow[] = Array.from({ length: 5 }, (_, row) => ({ text: `共同关键字 第${row}条`, agent: "claude", sid, role: "user", ts: row }));
      db.appendSessionFts(rows);
    }
    const results = db.search("共同关键字", 2);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.hits.length <= 3)).toBeTrue();
  });

  test("uses (agent, sid) as the session and FTS identity", () => {
    const db = makeDb();
    const sid = "77777777-7777-7777-7777-777777777777";
    db.upsertSession(session(sid, 1, "claude"));
    db.upsertSession({ ...session(sid, 2, "codex"), title: "Codex 同号会话" });
    db.appendSessionFts([
      { text: "跨 agent 聚合测试", agent: "claude", sid, role: "user", ts: 1 },
      { text: "跨 agent 聚合测试", agent: "codex", sid, role: "assistant", ts: 2 },
    ]);

    expect(db.countSessions()).toBe(2);
    expect(db.getStoredSession("claude", sid)?.agent).toBe("claude");
    expect(db.getSession("codex", sid)?.displayTitle).toBe("Codex 同号会话");
    expect(db.countSessionFts("claude", sid)).toBe(1);
    expect(db.countSessionFts("codex", sid)).toBe(1);
    expect(db.search("跨 agent 聚合", 10).map((row) => row.agent).sort()).toEqual(["claude", "codex"]);
  });

  test("returns Hermes as its own agent and bounds a stored title only for display", () => {
    const db = makeDb();
    const sid = "20260811_031044_76b3bb";
    const title = "赫".repeat(100);
    db.upsertSession({ ...session(sid, 3, "hermes"), title });
    expect(db.getStoredSession("hermes", sid)?.title).toBe(title);
    expect(db.getSession("hermes", sid)).toMatchObject({ agent: "hermes", displayTitle: "赫".repeat(80) });
  });

  test("uses a 5 second busy timeout and permits reads during another connection's write", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-db-"));
    temporaryDirectories.push(root);
    const path = join(root, "index.db");
    const writer = new OrcaDatabase(path);
    const reader = new OrcaDatabase(path);
    databases.push(writer, reader);
    const timeout = writer.raw.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(timeout.timeout).toBe(5_000);
    const schemaVersion = writer.getMeta("schema_version");
    expect(schemaVersion).toBeTruthy(); // version value is not the point; cross-connection agreement below is
    writer.raw.exec("BEGIN IMMEDIATE");
    try {
      writer.setMeta("held_write", "yes");
      expect(reader.getMeta("schema_version")).toBe(schemaVersion);
    } finally {
      writer.raw.exec("ROLLBACK");
    }
  });

  test("opens an existing cache read-only and returns null for a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-readonly-"));
    temporaryDirectories.push(root);
    const path = join(root, "index.db");
    const writable = new OrcaDatabase(path);
    writable.upsertSession(session("55555555-5555-5555-5555-555555555555"));
    writable.close();
    const readonly = openDatabaseReadOnly(path)!;
    databases.push(readonly);
    expect(readonly.getSession("claude", "55555555-5555-5555-5555-555555555555")?.cwd).toBe("/repo/wt");
    expect(openDatabaseReadOnly(join(root, "missing.db"))).toBeNull();
  });

  test("increments dataVersion atomically from zero", () => {
    const db = makeDb();
    expect(db.getDataVersion()).toBe(0);
    expect(db.bumpDataVersion()).toBe(1);
    expect(db.bumpDataVersion()).toBe(2);
  });
});
