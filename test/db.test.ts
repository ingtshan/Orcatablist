import { afterEach, describe, expect, test } from "bun:test";
import { OrcaDatabase, type FtsRow, type StoredSession } from "../src/db";

const databases: OrcaDatabase[] = [];

function makeDb(): OrcaDatabase {
  const db = new OrcaDatabase(":memory:");
  databases.push(db);
  return db;
}

function session(sid: string, lastInputAt = 1): StoredSession {
  return {
    sid, projectKey: "/repo", cwd: "/repo/wt", branch: "main", title: null,
    firstPrompt: "首条问题", lastInputAt, promptCount: 1, filePath: `/tmp/${sid}.jsonl`,
    fileSize: 10, fileMtime: 20, parsedOffset: 10,
  };
}

afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("OrcaDatabase", () => {
  test("stores sessions and builds non-empty display titles", () => {
    const db = makeDb();
    db.upsertProject({ key: "/repo", name: "repo", root: "/repo", color: null });
    db.upsertSession(session("11111111-1111-1111-1111-111111111111"));
    const row = db.getSession("11111111-1111-1111-1111-111111111111");
    expect(row?.displayTitle).toBe("首条问题");
    expect(db.listProjects()[0]).toMatchObject({ name: "repo", sessionCount: 1, lastInputAt: 1 });
    expect(db.listSessions({ limit: 10 })).toHaveLength(1);
  });

  test("MATCH finds Chinese trigram text and emits highlighted snippets", () => {
    const db = makeDb();
    const sid = "11111111-1111-1111-1111-111111111111";
    db.upsertSession(session(sid));
    db.replaceSessionFts(sid, [{ text: "这里展示课堂树的结构", sid, role: "assistant", ts: 3 }]);
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
    db.appendSessionFts([{ text: '前文他说"你好"后文', sid, role: "user", ts: null }]);
    expect(db.search('他说"你好"', 10)).toHaveLength(1);
  });

  test("short queries use escaped LIKE and local snippets", () => {
    const db = makeDb();
    const sid = "33333333-3333-3333-3333-333333333333";
    db.upsertSession(session(sid));
    db.appendSessionFts([
      { text: "短词课可以命中", sid, role: "user", ts: 4 },
      { text: "literal % and _ and \\ markers", sid, role: "assistant", ts: 5 },
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
      const rows: FtsRow[] = Array.from({ length: 5 }, (_, row) => ({ text: `共同关键字 第${row}条`, sid, role: "user", ts: row }));
      db.appendSessionFts(rows);
    }
    const results = db.search("共同关键字", 2);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.hits.length <= 3)).toBeTrue();
  });
});
