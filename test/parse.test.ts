import { describe, expect, test } from "bun:test";
import { cleanPromptForDisplay, parseLine } from "../src/parse";
import {
  AI_TITLE_LINE, ASSISTANT_TEXT_LINE, ASSISTANT_TOOL_LINE, ATTACHMENT_LINE, LAST_PROMPT_LINE,
  META_USER_LINE, SYSTEM_LINE, TOOL_RESULT_USER_LINE, USER_PROMPT_LINE,
} from "./fixtures/lines";

describe("parseLine", () => {
  test("parses and trims ai-title", () => {
    expect(parseLine(AI_TITLE_LINE)).toEqual({ kind: "title", title: "Orca tab linking" });
    expect(parseLine('{"type":"ai-title","aiTitle":"   "}')).toEqual({ kind: "skip" });
  });

  test("parses a real string user prompt with metadata and timestamp", () => {
    expect(parseLine(USER_PROMPT_LINE)).toEqual({
      kind: "prompt",
      text: "orca 是否有链接可以打开对应的 tab，比如 uri_tab(claude, sessionId)",
      ts: Date.parse("2026-08-25T08:08:39.177Z"), cwd: "/Users/bb00/workspace/hermes",
      branch: "HEAD", version: "2.1.245",
    });
  });

  test("takes only a leading text block from array user content", () => {
    const line = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "数组输入" }, { type: "text", text: "忽略" }] } });
    expect(parseLine(line)).toEqual({ kind: "prompt", text: "数组输入", ts: null });
  });

  test("skips meta users and pure tool results", () => {
    expect(parseLine(META_USER_LINE)).toEqual({ kind: "skip" });
    expect(parseLine(TOOL_RESULT_USER_LINE)).toEqual({ kind: "skip" });
    expect(parseLine(JSON.stringify({ type: "user", message: { content: "  " } }))).toEqual({ kind: "skip" });
  });

  test("joins every assistant text block and ignores tool blocks", () => {
    expect(parseLine(ASSISTANT_TEXT_LINE)).toMatchObject({
      kind: "assistant-text", text: "我来查一下 orca-cli 的文档，看有没有 deep link / URI scheme 能定位到 tab。",
      ts: Date.parse("2026-08-25T08:08:43.552Z"), cwd: "/Users/bb00/workspace/hermes",
    });
    const mixed = JSON.stringify({ type: "assistant", message: { content: [
      { type: "text", text: "一" }, { type: "thinking", text: "秘密" }, { type: "text", text: "二" },
    ] }, timestamp: "bad" });
    expect(parseLine(mixed)).toEqual({ kind: "assistant-text", text: "一\n二", ts: null });
    expect(parseLine(ASSISTANT_TOOL_LINE)).toEqual({ kind: "skip" });
  });

  test("skips malformed, scalar, missing, and explicitly ignored event types", () => {
    expect(parseLine("{broken")).toEqual({ kind: "skip" });
    expect(parseLine("null")).toEqual({ kind: "skip" });
    expect(parseLine(LAST_PROMPT_LINE)).toEqual({ kind: "skip" });
    expect(parseLine(ATTACHMENT_LINE)).toEqual({ kind: "skip" });
    expect(parseLine(SYSTEM_LINE)).toEqual({ kind: "skip" });
    expect(parseLine('{"type":"mode"}')).toEqual({ kind: "skip" });
  });

  test("uses null for missing timestamps", () => {
    expect(parseLine('{"type":"user","message":{"content":"hello"}}')).toEqual({ kind: "prompt", text: "hello", ts: null });
  });
});

describe("cleanPromptForDisplay", () => {
  test("removes tags, folds whitespace, trims, and caps at 200 characters", () => {
    expect(cleanPromptForDisplay(" <system>secret</system>  课堂\n\t树 ")).toBe("secret 课堂 树");
    expect(cleanPromptForDisplay("x".repeat(250))).toHaveLength(200);
  });

  test("uses command-name without an empty command-args block", () => {
    expect(cleanPromptForDisplay("<command-message>ignored</command-message><command-name>review</command-name><command-args></command-args>"))
      .toBe("review");
  });

  test("combines command-name with non-empty command args", () => {
    expect(cleanPromptForDisplay("<command-name>mattpocock-skills:review</command-name><command-args>  src/db.ts  </command-args><command-message>ignore me</command-message>"))
      .toBe("mattpocock-skills:review src/db.ts");
  });

  test("leaves ordinary prompt cleanup unchanged", () => {
    expect(cleanPromptForDisplay("普通 <b>课堂</b>\n问题")).toBe("普通 课堂 问题");
  });
});

import { taskNotificationUser, slashCommandUser, legacyNoOriginUser } from "./fixtures/lines";

test("skips harness-injected task-notification user turns", () => {
  expect(parseLine(taskNotificationUser).kind).toBe("skip");
});

test("keeps slash-command human input as a prompt", () => {
  const event = parseLine(slashCommandUser);
  expect(event.kind).toBe("prompt");
  expect(event.text).toContain("codex-delegate");
});

test("treats a user turn without origin as human (backward compat)", () => {
  const event = parseLine(legacyNoOriginUser);
  expect(event.kind).toBe("prompt");
  expect(event.text).toContain("老版本");
});
