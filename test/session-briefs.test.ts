import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase, type StoredSession } from "../src/db";
import { FTS_TEXT_MAX_CHARS } from "../src/config";
import { parseLine } from "../src/parse";
import { parseCodexLine } from "../src/sources/codex";
import { foldTranscript } from "../src/sources/transcript";
import { jsonlBriefEvent, responseTail } from "../src/session-brief-events";
import { completeLiveBriefs, getBrief, listBriefs, markBriefsRead } from "../src/session-briefs";
import { sessionIdentityKey } from "../src/session-identity";
import type { Agent, LiveInfo } from "../src/types";

const SID = "99999999-1111-2222-3333-444444444444";
const databases: OrcaDatabase[] = [];
const directories: string[] = [];
function database(path = ":memory:"): OrcaDatabase {
  const db = new OrcaDatabase(path); db.setMeta("briefs_enabled_at", "0"); databases.push(db); return db;
}
function session(agent: Agent = "codex", env?: string): StoredSession {
  return { agent, sid: SID, ...(env ? { env } : {}), projectKey: "project", cwd: "/fixture", worktreeRoot: "/fixture",
    branch: "main", title: "brief fixture", firstPrompt: null, lastPrompt: null, lastInputAt: null, promptCount: 0,
    filePath: "/fixture/session.jsonl", fileSize: 0, fileMtime: 0, parsedOffset: 0,
    model: null, reasoningEffort: null, executionMetadataVersion: 1 };
}
function codex(role: "user" | "assistant", text: string, at: number, channel?: string): string {
  return JSON.stringify({ type: "response_item", timestamp: new Date(at).toISOString(),
    payload: { type: "message", role, ...(channel ? { channel } : {}),
      content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
}
function commit(db: OrcaDatabase, lines: string[], original = session(), replaceFts = false): void {
  const parse = original.agent === "claude" ? parseLine : parseCodexLine;
  const folded = foldTranscript(original, lines, parse);
  db.applySessionUpdate({ ...folded, replaceFts, project: { key: "project", name: "Project", root: "/fixture", color: null } });
}
afterEach(() => {
  while (databases.length) databases.pop()!.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("completion briefs", () => {
  test("keeps the latest raw input and the final six reply lines beyond the FTS cutoff", () => {
    const db = database();
    const input = "最新输入\n保留 <tag> 和代码缩进";
    const response = "开头".repeat(FTS_TEXT_MAX_CHARS) + "\n1\n2\n3\n4\n尚未部署\n最终结论";
    commit(db, [codex("user", "旧输入", 1), codex("user", input, 2), codex("assistant", response, 3, "final")]);
    const [brief] = listBriefs(db.raw);
    expect(brief!.input).toBe(input);
    expect(brief!.response).toBe("…\n1\n2\n3\n4\n尚未部署\n最终结论");
    expect(getBrief(db.raw, brief!.id)!.response).toBe(response);
    expect(brief!.readAt).toBeNull();
  });

  test("tail clipping preserves the last characters of a long single line", () => {
    expect(responseTail("a\r\nb\r\nc\n")).toBe("a\nb\nc");
    const clipped = responseTail("x".repeat(5_000) + "重要结尾");
    expect(clipped.startsWith("…\n")).toBeTrue();
    expect(clipped.endsWith("重要结尾")).toBeTrue();
  });

  test("commentary and analysis cannot become completion briefs on their own", () => {
    const db = database();
    commit(db, [codex("user", "实现", 1), codex("assistant", "准备开始", 2, "commentary"),
      codex("assistant", "内部推理", 3, "analysis")]);
    expect(listBriefs(db.raw)).toEqual([]);
    expect(db.raw.query("SELECT response_text FROM brief_sessions").get()).toEqual({ response_text: "准备开始" });
  });

  test("Claude end_turn completes while tool_use does not", () => {
    const db = database();
    const user = JSON.stringify({ type: "user", timestamp: new Date(1).toISOString(), message: { content: "用户原文" } });
    const reply = (text: string, reason: string, at: number) => JSON.stringify({ type: "assistant", uuid: String(at),
      timestamp: new Date(at).toISOString(), message: { content: [{ type: "text", text }], stop_reason: reason } });
    commit(db, [user, reply("先查一下", "tool_use", 2)], session("claude"));
    expect(listBriefs(db.raw)).toHaveLength(0);
    commit(db, [reply("结果在结尾", "end_turn", 3)], db.getStoredSession("claude", SID)!);
    expect(listBriefs(db.raw)[0]).toMatchObject({ input: "用户原文", response: "结果在结尾" });
  });

  test("an explicit duration/complete record can finish the latest assistant text once", () => {
    const db = database();
    const lines = [codex("user", "本轮输入", 1), codex("assistant", "完整结果", 2),
      JSON.stringify({ type: "event_msg", timestamp: new Date(3).toISOString(), payload: { type: "task_complete" } })];
    commit(db, lines);
    commit(db, lines, session(), true);
    expect(listBriefs(db.raw)).toHaveLength(1);
    const duration = JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: new Date(4).toISOString() });
    expect(jsonlBriefEvent("claude", duration, parseLine(duration), 0)).toMatchObject({ kind: "complete", at: 4 });
  });

  test("re-indexing and duplicate final signals preserve the existing read receipt", () => {
    const db = database();
    const lines = [codex("user", "输入", 1), codex("assistant", "结果", 2, "final")];
    commit(db, lines);
    const id = listBriefs(db.raw)[0]!.id;
    markBriefsRead(db.raw, [id], true, 10);
    commit(db, lines, session(), true);
    expect(listBriefs(db.raw)).toHaveLength(1);
    expect(getBrief(db.raw, id)!.readAt).toBe(10);
  });

  test("task_complete can supply the final reply without duplicating an already recorded final", () => {
    const db = database();
    const done = (at: number) => JSON.stringify({ type: "event_msg", timestamp: new Date(at).toISOString(),
      payload: { type: "task_complete", last_agent_message: "最终回复的结尾" } });
    commit(db, [codex("user", "输入", 1), codex("assistant", "过程回复", 2, "commentary"), done(3)]);
    expect(listBriefs(db.raw)).toHaveLength(1);
    expect(listBriefs(db.raw)[0]!.response).toBe("最终回复的结尾");
    commit(db, [codex("user", "第二轮", 4), codex("assistant", "最终回复的结尾", 5, "final"), done(6)], db.getStoredSession("codex", SID)!);
    expect(listBriefs(db.raw)).toHaveLength(2);
  });

  test("a new input clears the previous reply and each new round keeps its own immutable pair", () => {
    const db = database();
    commit(db, [codex("user", "第一轮", 1), codex("assistant", "第一轮结果", 2, "final")]);
    const first = listBriefs(db.raw)[0]!;
    markBriefsRead(db.raw, [first.id], true, 3);
    commit(db, [codex("user", "第二轮", 4)], db.getStoredSession("codex", SID)!);
    completeLiveBriefs(db.raw, new Map([[sessionIdentityKey("codex", SID), { status: "done", updatedAt: 5, waitingFor: null, pid: null, name: null }]]));
    expect(listBriefs(db.raw)).toHaveLength(1);
    commit(db, [codex("assistant", "第二轮结果", 6, "final")], db.getStoredSession("codex", SID)!);
    const briefs = listBriefs(db.raw);
    expect(briefs[0]).toMatchObject({ input: "第二轮", response: "第二轮结果", readAt: null });
    expect(getBrief(db.raw, first.id)).toMatchObject({ input: "第一轮", response: "第一轮结果", readAt: 3 });
  });

  test("bulk read cannot consume a completion arriving after the selected snapshot", () => {
    const db = database();
    commit(db, [codex("user", "第一轮", 1), codex("assistant", "结果一", 2, "final")]);
    const ids = listBriefs(db.raw).map((brief) => brief.id);
    commit(db, [codex("user", "第二轮", 3), codex("assistant", "结果二", 4, "final")], db.getStoredSession("codex", SID)!);
    markBriefsRead(db.raw, ids, true, 5);
    expect(listBriefs(db.raw).filter((brief) => brief.readAt === null)).toHaveLength(1);
    markBriefsRead(db.raw, ids, false);
    expect(listBriefs(db.raw).filter((brief) => brief.readAt === null)).toHaveLength(2);
  });

  test("same session IDs on two environments keep independent input, reply and receipts", () => {
    const db = database();
    const lines = [codex("user", "输入", 1), codex("assistant", "结果", 2, "final")];
    commit(db, lines); commit(db, lines, session("codex", "remote"));
    const briefs = listBriefs(db.raw);
    expect(new Set(briefs.map((brief) => brief.id)).size).toBe(2);
    markBriefsRead(db.raw, [briefs.find((brief) => !brief.env)!.id], true, 3);
    expect(briefs.find((brief) => brief.env === "remote")!.readAt).toBeNull();
    expect(listBriefs(db.raw).find((brief) => brief.env === "remote")!.readAt).toBeNull();
  });

  test("old history is not announced on first enable", () => {
    const db = database(); db.setMeta("briefs_enabled_at", "100");
    commit(db, [codex("user", "旧任务", 1), codex("assistant", "旧结果", 2, "final")]);
    expect(listBriefs(db.raw)).toHaveLength(0);
    commit(db, [codex("user", "新任务", 101), codex("assistant", "新结果", 102, "final")], db.getStoredSession("codex", SID)!);
    expect(listBriefs(db.raw)).toHaveLength(1);
  });

  test("only explicit done after the reply can finish a provider without final markers", () => {
    const db = database();
    commit(db, [codex("user", "任务", 1), codex("assistant", "回复", 10)]);
    const live = (status: string, updatedAt: number, waitingFor: string | null = null): Map<string, LiveInfo> =>
      new Map([[sessionIdentityKey("codex", SID), { status, updatedAt, waitingFor, pid: null, name: null }]]);
    for (const state of [live("working", 11), live("idle", 11), live("done", 5), live("done", 11, "approval")]) completeLiveBriefs(db.raw, state);
    expect(listBriefs(db.raw)).toHaveLength(0);
    completeLiveBriefs(db.raw, live("done", 11));
    expect(listBriefs(db.raw)).toHaveLength(1);
  });

  test("transcript transaction failure rolls back the brief and its pending input", () => {
    const db = database();
    db.raw.exec("CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
    expect(() => commit(db, [codex("user", "输入", 1), codex("assistant", "结果", 2, "final")])).toThrow("fixture failure");
    expect(listBriefs(db.raw)).toHaveLength(0);
    expect(db.raw.query("SELECT COUNT(*) AS count FROM brief_sessions").get()).toEqual({ count: 0 });
  });

  test("raw text and receipts survive closing and reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "orcatab-briefs-")); directories.push(dir);
    const path = join(dir, "index.db"); const db = database(path);
    commit(db, [codex("user", "输入", 1), codex("assistant", "结尾", 2, "final")]);
    const id = listBriefs(db.raw)[0]!.id; markBriefsRead(db.raw, [id], true, 3);
    databases.pop()!.close();
    const reopened = database(path);
    expect(getBrief(reopened.raw, id)).toMatchObject({ input: "输入", response: "结尾", readAt: 3 });
  });
});
