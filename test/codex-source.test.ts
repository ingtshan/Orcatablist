import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCodexSource, discoverCodexSessionFiles, parseCodexLine,
} from "../src/sources/codex";
import { CODEX_FIXTURE_LINES, CODEX_SID } from "./fixtures/codex";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-codex-source-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("Codex session source", () => {
  test("parses the frozen rollout fixture and filters injected user messages", () => {
    const events = CODEX_FIXTURE_LINES.map(parseCodexLine);
    expect(events[0]).toEqual({ kind: "meta", cwd: "/Users/bb00/workspace/plan-review-skill", branch: "main" });
    expect(events[1]).toEqual({ kind: "skip" });
    expect(events[2]).toEqual({
      kind: "prompt", text: "ROLE: EXECUTOR 真实用户输入", ts: Date.parse("2026-08-25T11:29:19.259Z"),
    });
    expect(events[3]).toEqual({
      kind: "assistant-text", text: "助手回复用于搜索 独特词 鲸鱼", ts: Date.parse("2026-08-25T11:30:00.000Z"),
    });
    expect(events[4]).toEqual({ kind: "skip" });

    const memory = JSON.stringify({
      timestamp: "bad-time", type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "## Memory\nsecret" }] },
    });
    expect(parseCodexLine(memory)).toEqual({ kind: "skip" });
    const userInstructions = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "  <user_instructions>x</user_instructions>  " }] },
    });
    expect(parseCodexLine(userInstructions)).toEqual({ kind: "skip" });
  });

  test("joins user input blocks and uses assistant text only as output_text fallback", () => {
    const user = JSON.stringify({
      timestamp: "2026-08-25T12:00:00.000Z", type: "response_item",
      payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "第一段" }, { type: "image", url: "x" }, { type: "input_text", text: "第二段" },
      ] },
    });
    expect(parseCodexLine(user)).toMatchObject({ kind: "prompt", text: "第一段\n第二段" });
    const outputWins = JSON.stringify({
      type: "response_item", payload: { type: "message", role: "assistant", content: [
        { type: "text", text: "fallback" }, { type: "output_text", text: "authoritative" },
      ] },
    });
    expect(parseCodexLine(outputWins)).toEqual({ kind: "assistant-text", text: "authoritative", ts: null });
    const fallback = JSON.stringify({
      type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "fallback" }] },
    });
    expect(parseCodexLine(fallback)).toEqual({ kind: "assistant-text", text: "fallback", ts: null });
  });

  test("recursively discovers rollout files, prefers meta sid, and ignores archives", () => {
    const root = temporaryDirectory();
    const deep = join(root, "sessions", "2026", "08", "25");
    const archived = join(root, "archived_sessions");
    mkdirSync(deep, { recursive: true });
    mkdirSync(archived, { recursive: true });
    const filenameSid = "11111111-1111-1111-1111-111111111111";
    const path = join(deep, `rollout-2026-08-25T11-27-29-${filenameSid}.jsonl`);
    const largeMeta = JSON.stringify({
      timestamp: "2026-08-25T11:27:29.935Z", type: "session_meta",
      payload: { session_id: CODEX_SID, cwd: "/large-meta", padding: "x".repeat(70_000) },
    });
    writeFileSync(path, `${largeMeta}\n${CODEX_FIXTURE_LINES.slice(1).join("\n")}\n`);
    writeFileSync(join(deep, "not-a-rollout.jsonl"), `${CODEX_FIXTURE_LINES[0]}\n`);
    writeFileSync(join(archived, `rollout-old-${CODEX_SID}.jsonl`), `${CODEX_FIXTURE_LINES[0]}\n`);

    const files = discoverCodexSessionFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ agent: "codex", sid: CODEX_SID, path });
    expect(files[0]!.size).toBeGreaterThan(0);
    expect(discoverCodexSessionFiles(join(root, "missing"))).toEqual([]);
  });

  test("keeps only the resumable parent rollout when child agents share its session id", () => {
    const root = temporaryDirectory();
    const sessions = join(root, "sessions", "2026", "08", "26");
    mkdirSync(sessions, { recursive: true });
    const childId = "33333333-3333-3333-3333-333333333333";
    const parentPath = join(sessions, `rollout-2026-08-26T08-00-00-${CODEX_SID}.jsonl`);
    const childPath = join(sessions, `rollout-2026-08-26T09-00-00-${childId}.jsonl`);
    writeFileSync(parentPath, `${JSON.stringify({
      type: "session_meta", payload: { id: CODEX_SID, session_id: CODEX_SID, cwd: "/parent" },
    })}\n`);
    writeFileSync(childPath, `${JSON.stringify({
      type: "session_meta", payload: {
        id: childId, session_id: CODEX_SID, cwd: "/parent", source: { subagent: "worker" },
      },
    })}\n`);

    expect(discoverCodexSessionFiles(root)).toEqual([
      expect.objectContaining({ agent: "codex", sid: CODEX_SID, path: parentPath }),
    ]);
  });

  test("loads thread names on prepare and returns null for missing titles", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "session_index.jsonl"), [
      JSON.stringify({ id: CODEX_SID, thread_name: "  P5 Codex 标题  ", updated_at: "2026-08-25" }),
      "not-json",
      JSON.stringify({ id: "missing-title" }),
    ].join("\n"));
    const source = createCodexSource(root);
    expect(source.titleFor?.(CODEX_SID)).toBeNull();
    source.prepare?.();
    expect(source.titleFor?.(CODEX_SID)).toBe("P5 Codex 标题");
    expect(source.titleFor?.("unknown")).toBeNull();
  });

  test("skips malformed and irrelevant events", () => {
    expect(parseCodexLine("not-json")).toEqual({ kind: "skip" });
    expect(parseCodexLine("null")).toEqual({ kind: "skip" });
    expect(parseCodexLine(JSON.stringify({ type: "world_state", payload: {} }))).toEqual({ kind: "skip" });
    expect(parseCodexLine(JSON.stringify({ type: "response_item", payload: { type: "tool", role: "user" } }))).toEqual({ kind: "skip" });
    expect(parseCodexLine(JSON.stringify({ type: "response_item", payload: { type: "message", role: "tool", content: [] } }))).toEqual({ kind: "skip" });
    expect(parseCodexLine(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } }))).toEqual({ kind: "skip" });
  });
});
