import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase } from "../src/db";
import { createIndexer, type SessionSource } from "../src/indexer";
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
  test("indexes mixed Claude and Codex sources by (agent, sid) with Codex offsets", async () => {
    const root = temporaryDirectory();
    const claudeDir = join(root, "claude");
    const codexDir = join(root, "codex");
    const claudeProject = join(claudeDir, "projects", "fixture");
    const codexSessions = join(codexDir, "sessions", "2026", "08", "25");
    mkdirSync(claudeProject, { recursive: true });
    mkdirSync(codexSessions, { recursive: true });
    writeFileSync(join(claudeProject, `${SID}.jsonl`), `${prompt("Claude 同号", "2026-08-25T08:00:00.000Z")}\n`);
    const codexPath = join(codexSessions, `rollout-2026-08-25T09-00-00-${SID}.jsonl`);
    writeFileSync(join(codexSessions, `rollout-2026-08-25T08-00-00-22222222-2222-2222-2222-222222222222.jsonl`), [
      JSON.stringify({ timestamp: "2026-08-25T08:00:00.000Z", type: "session_meta", payload: { session_id: SID, cwd: "/obsolete" } }),
      JSON.stringify({ timestamp: "2026-08-25T08:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "旧 rollout 不应覆盖最新文件" }] } }),
    ].join("\n") + "\n");
    const codexInitial = [
      JSON.stringify({ timestamp: "2026-08-25T09:00:00.000Z", type: "session_meta", payload: { session_id: SID, cwd: "/fixture/repo/worktree", git: { branch: "codex" } } }),
      JSON.stringify({ timestamp: "2026-08-25T09:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex 同号" }] } }),
    ].join("\n") + "\n";
    writeFileSync(codexPath, codexInitial);
    writeFileSync(join(codexDir, "session_index.jsonl"), `${JSON.stringify({ id: SID, thread_name: "Codex 标题" })}\n`);
    const db = new OrcaDatabase(join(root, "data", "index.db"));
    const indexer = createIndexer({
      claudeDir, codexDir, hermesDb: join(root, "hermes.db"), db,
      resolveProject: async () => ({ key: "/fixture/repo", name: "repo", root: "/fixture/repo", color: null }),
    });

    expect(await indexer.indexAll()).toMatchObject({ files: 2, changed: 2 });
    expect(db.getStoredSession("claude", SID)).toMatchObject({ agent: "claude", firstPrompt: "Claude 同号" });
    expect(db.getStoredSession("codex", SID)).toMatchObject({
      agent: "codex", title: "Codex 标题", firstPrompt: "Codex 同号", lastPrompt: "Codex 同号",
      branch: "codex", parsedOffset: Buffer.byteLength(codexInitial),
    });
    expect(db.countSessionFts("claude", SID)).toBe(1);
    expect(db.countSessionFts("codex", SID)).toBe(1);
    expect((await indexer.indexAll()).changed).toBe(0);

    const appended = `${JSON.stringify({
      timestamp: "2026-08-25T10:00:00.000Z", type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex 增量回答" }] },
    })}\n`;
    appendFileSync(codexPath, appended);
    expect((await indexer.indexAll()).changed).toBe(1);
    expect(db.getStoredSession("codex", SID)?.parsedOffset).toBe(Buffer.byteLength(codexInitial + appended));
    expect(db.countSessionFts("codex", SID)).toBe(2);

    writeFileSync(join(codexDir, "session_index.jsonl"), `${JSON.stringify({ id: SID, thread_name: "更新后的标题" })}\n`);
    expect((await indexer.indexAll()).changed).toBe(1);
    expect(db.getSession("codex", SID)?.title).toBe("更新后的标题");
    db.close();
  });

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
      codexDir: join(root, "codex"),
      hermesDb: join(root, "hermes.db"),
      db,
      resolveProject: async () => ({ key: "/fixture/repo", name: "repo", root: "/fixture/repo", color: null }),
    });

    const first = await indexer.indexAll();
    expect(first).toMatchObject({ files: 1, changed: 1 });
    expect(db.getDataVersion()).toBe(1);
    expect(db.getStoredSession("claude", SID)).toMatchObject({
      title: "Orca tab linking",
      firstPrompt: "orca 是否有链接可以打开对应的 tab，比如 uri_tab(claude, sessionId)",
      lastPrompt: "orca 是否有链接可以打开对应的 tab，比如 uri_tab(claude, sessionId)",
      lastInputAt: Date.parse("2026-08-25T08:08:39.177Z"), promptCount: 1,
      parsedOffset: Buffer.byteLength(initial),
    });
    expect(db.countSessionFts("claude", SID)).toBe(2);
    expect((await indexer.indexAll()).changed).toBe(0);
    expect(db.getDataVersion()).toBe(1);

    const appended = `${prompt("第二个问题", "2026-08-25T09:00:00.000Z")}\n${assistant("第二个回答", "2026-08-25T09:00:01.000Z")}\n`;
    appendFileSync(path, appended);
    expect((await indexer.indexAll()).changed).toBe(1);
    const afterAppend = db.getStoredSession("claude", SID)!;
    expect(afterAppend.promptCount).toBe(2);
    expect(afterAppend.lastPrompt).toBe("第二个问题");
    expect(afterAppend.parsedOffset).toBe(Buffer.byteLength(initial + appended));
    expect(db.countSessionFts("claude", SID)).toBe(4);

    const beforeHalfLine = afterAppend.parsedOffset;
    appendFileSync(path, '{"type":"user"');
    await indexer.indexAll();
    expect(db.getStoredSession("claude", SID)!.parsedOffset).toBe(beforeHalfLine);
    appendFileSync(path, ',"message":{"content":"半行完成"},"timestamp":"2026-08-25T10:00:00.000Z"}\n');
    await indexer.indexAll();
    expect(db.getStoredSession("claude", SID)!.promptCount).toBe(3);
    expect(db.getStoredSession("claude", SID)!.lastPrompt).toBe("半行完成");
    expect(db.getStoredSession("claude", SID)!.parsedOffset).toBe(readFileSync(path).byteLength);
    expect(db.countSessionFts("claude", SID)).toBe(5);

    const replacement = `${prompt("截断后问题", "2026-08-26T00:00:00.000Z")}\n`;
    writeFileSync(path, replacement);
    await indexer.indexAll();
    expect(db.getStoredSession("claude", SID)).toMatchObject({ title: null, firstPrompt: "截断后问题", lastPrompt: "截断后问题", promptCount: 1, parsedOffset: Buffer.byteLength(replacement) });
    expect(db.countSessionFts("claude", SID)).toBe(1);
    db.close();
  });

  test("does not consume a new file without a complete line", async () => {
    const root = temporaryDirectory();
    const projectDir = join(root, "projects", "x");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${SID}.jsonl`), AI_TITLE_LINE);
    const db = new OrcaDatabase(join(root, "index.db"));
    const indexer = createIndexer({
      claudeDir: root, codexDir: join(root, "codex"), hermesDb: join(root, "hermes.db"), db,
      resolveProject: async () => ({ key: "unknown", name: "未知", root: "", color: null }),
    });
    await indexer.indexAll();
    expect(db.getStoredSession("claude", SID)!.parsedOffset).toBe(0);
    expect(db.getStoredSession("claude", SID)!.title).toBeNull();
    expect(db.getStoredSession("claude", SID)!.lastPrompt).toBeNull();
    db.close();
  });

  test("tracks the first prompt and latest non-empty cleaned prompt independently", async () => {
    const root = temporaryDirectory();
    const projectDir = join(root, "projects", "prompts");
    mkdirSync(projectDir, { recursive: true });
    const path = join(projectDir, `${SID}.jsonl`);
    writeFileSync(path, [
      prompt("  第一条 <context>忽略标签</context>  ", "2026-08-25T08:00:00.000Z"),
      prompt("第二条\n最近问题", "2026-08-25T08:01:00.000Z"),
      prompt("<system-reminder></system-reminder>", "2026-08-25T08:02:00.000Z"),
    ].join("\n") + "\n");
    const db = new OrcaDatabase(join(root, "index.db"));
    const indexer = createIndexer({
      claudeDir: root, codexDir: join(root, "codex"), hermesDb: join(root, "hermes.db"), db,
      resolveProject: async () => ({ key: "/fixture/repo", name: "repo", root: "/fixture/repo", color: null }),
    });

    await indexer.indexAll();
    expect(db.getStoredSession("claude", SID)).toMatchObject({
      firstPrompt: "第一条 忽略标签",
      lastPrompt: "第二条 最近问题",
      promptCount: 3,
    });
    db.close();
  });

  test("keeps lastPrompt null when a session has no prompt", async () => {
    const root = temporaryDirectory();
    const projectDir = join(root, "projects", "title-only");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${SID}.jsonl`), `${AI_TITLE_LINE}\n`);
    const db = new OrcaDatabase(join(root, "index.db"));
    const indexer = createIndexer({
      claudeDir: root, codexDir: join(root, "codex"), hermesDb: join(root, "hermes.db"), db,
      resolveProject: async () => ({ key: "unknown", name: "未知", root: "", color: null }),
    });

    await indexer.indexAll();
    expect(db.getStoredSession("claude", SID)).toMatchObject({ title: "Orca tab linking", lastPrompt: null, promptCount: 0 });
    db.close();
  });

  test("uses deriveSession for database sources and replaces FTS only when the ledger changes", async () => {
    const root = temporaryDirectory();
    const db = new OrcaDatabase(join(root, "index.db"));
    let size = 3;
    let mtime = 1_000;
    let deriveCalls = 0;
    let parseCalls = 0;
    const baseSizes: number[] = [];
    const source: SessionSource = {
      agent: "hermes",
      discover: () => [{ agent: "hermes", sid: "20260811_031044_76b3bb", path: join(root, "state.db"), size, mtime }],
      parseLine: () => { parseCalls += 1; throw new Error("line parser must not run"); },
      deriveSession: (info, base) => {
        deriveCalls += 1;
        baseSizes.push(base.fileSize);
        const text = `派生第 ${deriveCalls} 次`;
        return {
          session: {
            agent: "hermes", sid: info.sid, projectKey: "unknown", cwd: "/fixture/hermes",
            branch: "main", title: null, firstPrompt: text, lastPrompt: text,
            lastInputAt: info.mtime, promptCount: deriveCalls, filePath: info.path,
            fileSize: info.size, fileMtime: info.mtime, parsedOffset: 0,
          },
          fts: [{ text, agent: "hermes", sid: info.sid, role: "user", ts: info.mtime }],
        };
      },
    };
    const indexer = createIndexer({
      sources: [source], db,
      resolveProject: async () => ({ key: "/fixture/hermes", name: "hermes", root: "/fixture/hermes", color: null }),
    });

    expect(await indexer.indexAll()).toMatchObject({ files: 1, changed: 1 });
    expect(await indexer.indexAll()).toMatchObject({ files: 1, changed: 0 });
    expect(deriveCalls).toBe(1);
    mtime = 2_000;
    expect(await indexer.indexAll()).toMatchObject({ files: 1, changed: 1 });
    expect(deriveCalls).toBe(2);
    size = 4;
    expect(await indexer.indexAll()).toMatchObject({ files: 1, changed: 1 });
    expect(deriveCalls).toBe(3);
    expect(parseCalls).toBe(0);
    expect(baseSizes).toEqual([0, 3, 3]);
    expect(db.getStoredSession("hermes", "20260811_031044_76b3bb")).toMatchObject({
      projectKey: "/fixture/hermes", firstPrompt: "派生第 3 次", promptCount: 3, fileSize: 4, fileMtime: 2_000,
    });
    expect(db.countSessionFts("hermes", "20260811_031044_76b3bb")).toBe(1);
    db.close();
  });

  test("fails with context when projects directory is missing", async () => {
    const root = temporaryDirectory();
    const db = new OrcaDatabase(join(root, "index.db"));
    const indexer = createIndexer({
      claudeDir: root, codexDir: join(root, "codex"), hermesDb: join(root, "hermes.db"), db,
    });
    await expect(indexer.indexAll()).rejects.toThrow("failed to read Claude projects directory");
    db.close();
  });

  test("fs.watch indexes an appended prompt within 1.5 seconds", async () => {
    const root = temporaryDirectory();
    const projectDir = join(root, "projects", "watch");
    mkdirSync(projectDir, { recursive: true });
    const path = join(projectDir, `${SID}.jsonl`);
    writeFileSync(path, `${prompt("watch 初始", "2026-08-25T08:00:00.000Z")}\n`);
    const db = new OrcaDatabase(join(root, "index.db"));
    const indexer = createIndexer({
      claudeDir: root, codexDir: join(root, "codex"), hermesDb: join(root, "hermes.db"), db,
      resolveProject: async () => ({ key: "/fixture/repo", name: "repo", root: "/fixture/repo", color: null }),
    });
    await indexer.indexAll();
    const watcher = indexer.startWatcher();
    expect(watcher.mode).toBe("fs.watch");
    await Bun.sleep(50);
    const startedAt = Date.now();
    appendFileSync(path, `${prompt("watch 新增", "2026-08-25T08:01:00.000Z")}\n`);
    try {
      while (db.getStoredSession("claude", SID)!.promptCount < 2 && Date.now() - startedAt < 3_000) {
        await Bun.sleep(50);
      }
      expect(db.getStoredSession("claude", SID)!.promptCount).toBe(2);
      expect(Date.now() - startedAt).toBeLessThanOrEqual(1_500);
    } finally {
      watcher.close();
      db.close();
    }
  });
});
