import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase, type StoredSession } from "../src/db";
import { GoalsStore, openGoalsDatabase, sessionIdentityKey } from "../src/goals";

const SID = "11111111-1111-1111-1111-111111111111";
const SECOND_SID = "22222222-2222-2222-2222-222222222222";
const roots: string[] = [];
const stores: GoalsStore[] = [];
const indexes: OrcaDatabase[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orcatab-goals-"));
  roots.push(root);
  return root;
}

function openStore(path = ":memory:"): GoalsStore {
  const store = new GoalsStore(openGoalsDatabase(path));
  stores.push(store);
  return store;
}

function storedSession(sid: string): StoredSession {
  return {
    agent: "claude", sid, projectKey: "/repo/orcatab", cwd: "/repo/orcatab", worktreeRoot: "/repo/orcatab", branch: "main",
    title: "OrcaTab 目标", firstPrompt: "实现目标", lastPrompt: "验证目标", lastInputAt: 42,
    promptCount: 2, filePath: `/tmp/${sid}.jsonl`, fileSize: 1, fileMtime: 2, parsedOffset: 1,
  };
}

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (indexes.length) indexes.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("GoalsStore", () => {
  test("configures its durable schema and performs goal CRUD", () => {
    const root = temporaryRoot();
    const database = openGoalsDatabase(join(root, "goals.db"));
    expect((database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5_000);
    expect((database.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((database.query("SELECT value FROM meta WHERE key = 'goals_schema_version'").get() as { value: string }).value).toBe("1");
    const store = new GoalsStore(database);
    stores.push(store);

    const created = store.createGoal({ name: "发布 P7", externalRef: "gtd:5", color: "#0e6c75" });
    expect(created).toMatchObject({ name: "发布 P7", status: "active", externalRef: "gtd:5", color: "#0e6c75" });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.goalsVersion).toBe(1);
    expect(store.listGoals()).toEqual([created]);
    expect(store.countGoals()).toBe(1);

    const updated = store.updateGoal(created.id, { name: "完成 P7", status: "done", externalRef: null });
    expect(updated).toMatchObject({ name: "完成 P7", status: "done", externalRef: null, color: "#0e6c75" });
    expect(store.goalsVersion).toBe(2);
    expect(store.updateGoal("missing", { name: "无" })).toBeNull();
    expect(store.deleteGoal("missing")).toBeFalse();
    expect(store.deleteGoal(created.id)).toBeTrue();
    expect(store.getGoal(created.id)).toBeNull();
    expect(store.countGoals()).toBe(0);
  });

  test("upserts link kind, removes links, and reports confirmed versus excluded", () => {
    const store = openStore();
    const goal = store.createGoal({ name: "链接测试" });
    store.setLink(goal.id, "claude", SID, "confirmed");
    expect(store.confirmedLinks(goal.id)).toEqual([{ agent: "claude", sid: SID }]);
    expect(store.goalsForSession("claude", SID)).toEqual([{ id: goal.id, name: "链接测试" }]);

    store.setLink(goal.id, "claude", SID, "dismissed");
    expect(store.confirmedLinks(goal.id)).toEqual([]);
    expect(store.excludedLinks(goal.id)).toEqual([{ agent: "claude", sid: SID }]);
    expect(store.goalsForSession("claude", SID)).toEqual([]);

    store.removeLink(goal.id, "claude", SID);
    expect(store.excludedLinks(goal.id)).toEqual([]);
    expect(store.goalsVersion).toBe(4);
  });

  test("batch-loads goal refs by agent and sid without mixing equal sids", () => {
    const store = openStore();
    const first = store.createGoal({ name: "目标一" });
    const second = store.createGoal({ name: "目标二" });
    store.setLink(first.id, "claude", SID, "confirmed");
    store.setLink(second.id, "claude", SID, "confirmed");
    store.setLink(first.id, "codex", SID, "confirmed");
    store.setLink(second.id, "hermes", SECOND_SID, "dismissed");

    const refs = store.goalsForSessions([
      { agent: "claude", sid: SID }, { agent: "claude", sid: SID },
      { agent: "codex", sid: SID }, { agent: "hermes", sid: SECOND_SID },
    ]);
    expect(refs.get(sessionIdentityKey("claude", SID))?.map((goal) => goal.name).sort()).toEqual(["目标一", "目标二"]);
    expect(refs.get(sessionIdentityKey("codex", SID))).toEqual([{ id: first.id, name: "目标一" }]);
    expect(refs.get(sessionIdentityKey("hermes", SECOND_SID))).toEqual([]);
    expect(store.goalsForSessions([]).size).toBe(0);

    store.deleteGoal(first.id);
    expect(store.excludedLinks(first.id)).toEqual([]);
    expect(store.goalsForSession("codex", SID)).toEqual([]);
  });

  test("applies a schema mismatch additively without losing user intent", () => {
    const root = temporaryRoot();
    const path = join(root, "goals.db");
    const store = openStore(path);
    const goal = store.createGoal({ name: "不可重建的目标" });
    store.setLink(goal.id, "claude", SID, "confirmed");
    stores.pop()!.close();

    const raw = new Database(path);
    raw.query("UPDATE meta SET value = '0' WHERE key = 'goals_schema_version'").run();
    raw.close();
    const reopened = openStore(path);
    expect(reopened.getGoal(goal.id)?.name).toBe("不可重建的目标");
    expect(reopened.confirmedLinks(goal.id)).toEqual([{ agent: "claude", sid: SID }]);
  });

  test("index 重建后 goals 存活", () => {
    const root = temporaryRoot();
    const indexPath = join(root, "index.db");
    const goalsPath = join(root, "goals.db");
    const index = new OrcaDatabase(indexPath);
    indexes.push(index);
    index.upsertSession(storedSession(SID));
    const store = openStore(goalsPath);
    const goal = store.createGoal({ name: "跨索引重建保留" });
    store.setLink(goal.id, "claude", SID, "confirmed");
    stores.pop()!.close();
    indexes.pop()!.close();

    const staleIndex = new Database(indexPath);
    staleIndex.query("UPDATE meta SET value = 'stale' WHERE key = 'schema_version'").run();
    staleIndex.close();
    const rebuilt = new OrcaDatabase(indexPath);
    indexes.push(rebuilt);
    expect(rebuilt.countSessions()).toBe(0);

    const durable = openStore(goalsPath);
    expect(durable.getGoal(goal.id)?.name).toBe("跨索引重建保留");
    expect(durable.confirmedLinks(goal.id)).toEqual([{ agent: "claude", sid: SID }]);
  });
});
