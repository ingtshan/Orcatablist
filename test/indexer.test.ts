import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase } from "../src/db";
import { createIndexer } from "../src/indexer";
import { AI_TITLE_LINE, ASSISTANT_TEXT_LINE, REAL_SAMPLE_LINES, USER_PROMPT_LINE } from "./fixtures/lines";

const temporaryDirectories: string[] = [];
const SID = "11111111-1111-1111-1111-111111111111";

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-indexer-"));
  temporaryDirectories.push(path);
  return path;
}

function prompt(text: string, timestamp: string): string {
  return JSON.stringify({
    type: "user", message: { content: text }, timestamp,
    cwd: "/fixture/repo/worktree", gitBranch: "feature/test", version: "2.1.245",
  });
}

function assistant(text: string, timestamp: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp });
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("incremental indexer", () => {
  test("discovers only direct UUID files and incrementally maintains offsets and FTS", async () => {
    const root = temporaryDirectory();
    const projectDir = join(root, "projects", "-tmp-a");
    mkdirSync(join(projectDir, "nested"), { recursive: true });
    const path = join(projectDir, `${SID}.jsonl`);
    const initial = `${REAL_SAMPLE_LINES.join("\n")}\n`;
    writeFileSync(path, initial);
    writeFileSync(join(projectDir, "agent-x.jsonl"), `${USER_PROMPT_LINE}\n`);
    writeFileSync(join(projectDir, "nested", "22222222-2222-2222-2222-222222222222.jsonl"), `${USER_PROMPT_LINE}\n`);
    const db = new OrcaDatabase(join(root, "data", "index.db"));
    const indexer = createIndexer({
      claudeDir: root,
      db,
      resolveProject: async () => ({ key: "/fixture/repo", name: "repo", root: "/fixture/repo", color: null }),
    });

    const first = await indexer.indexAll();
    expect(first).toMatchObject({ files: 1, changed: 1 });
    expect(db.getStoredSession(SID)).toMatchObject({
      title: "Orca tab linking",
      firstPrompt: "orca 是否有链接可以打开对应的 tab，比如 uri_tab(claude, sessionId)",
      lastInputAt: Date.parse("2026-08-25T08:08:39.177Z"), promptCount: 1,
      parsedOffset: Buffer.byteLength(initial),
    });
    expect(db.countSessionFts(SID)).toBe(2);
    expect((await indexer.indexAll()).changed).toBe(0);

    const appended = `${prompt("第二个问题", "2026-08-25T09:00:00.000Z")}\n${assistant("第二个回答", "2026-08-25T09:00:01.000Z")}\n`;
    appendFileSync(path, appended);
    expect((await indexer.indexAll()).changed).toBe(1);
    const afterAppend = db.getStoredSession(SID)!;
    expect(afterAppend.promptCount).toBe(2);
    expect(afterAppend.parsedOffset).toBe(Buffer.byteLength(initial + appended));
    expect(db.countSessionFts(SID)).toBe(4);

    const beforeHalfLine = afterAppend.parsedOffset;
    appendFileSync(path, '{"type":"user"');
    await indexer.indexAll();
    expect(db.getStoredSession(SID)!.parsedOffset).toBe(beforeHalfLine);
    appendFileSync(path, ',"message":{"content":"半行完成"},"timestamp":"2026-08-25T10:00:00.000Z"}\n');
    await indexer.indexAll();
    expect(db.getStoredSession(SID)!.promptCount).toBe(3);
    expect(db.getStoredSession(SID)!.parsedOffset).toBe(readFileSync(path).byteLength);
    expect(db.countSessionFts(SID)).toBe(5);

    const replacement = `${prompt("截断后问题", "2026-08-26T00:00:00.000Z")}\n`;
    writeFileSync(path, replacement);
    await indexer.indexAll();
    expect(db.getStoredSession(SID)).toMatchObject({ title: null, firstPrompt: "截断后问题", promptCount: 1, parsedOffset: Buffer.byteLength(replacement) });
    expect(db.countSessionFts(SID)).toBe(1);
    db.close();
  });

  test("does not consume a new file without a complete line", async () => {
    const root = temporaryDirectory();
    const projectDir = join(root, "projects", "x");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${SID}.jsonl`), AI_TITLE_LINE);
    const db = new OrcaDatabase(join(root, "index.db"));
    const indexer = createIndexer({ claudeDir: root, db, resolveProject: async () => ({ key: "unknown", name: "未知", root: "", color: null }) });
    await indexer.indexAll();
    expect(db.getStoredSession(SID)!.parsedOffset).toBe(0);
    expect(db.getStoredSession(SID)!.title).toBeNull();
    db.close();
  });

  test("fails with context when projects directory is missing", async () => {
    const root = temporaryDirectory();
    const db = new OrcaDatabase(join(root, "index.db"));
    const indexer = createIndexer({ claudeDir: root, db });
    await expect(indexer.indexAll()).rejects.toThrow("failed to read Claude projects directory");
    db.close();
  });
});
