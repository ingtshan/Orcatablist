import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FTS_TEXT_MAX_CHARS } from "../src/config";
import { createHermesSource, findHermesSessionCwd } from "../src/sources/hermes";

const HERMES_SID = "20260811_031044_76b3bb";
const TITLE_ONLY_SID = "8eaf06c7-dcec-46bf-9766-c83154361d92";
const EMPTY_SID = "20260812_000000_empty";
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-hermes-source-"));
  temporaryDirectories.push(path);
  return path;
}

function createFixture(path: string): void {
  const database = new Database(path, { create: true });
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, source TEXT, title TEXT, display_name TEXT, cwd TEXT,
      git_branch TEXT, started_at REAL, ended_at REAL, message_count INTEGER,
      archived INTEGER, pinned INTEGER
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      timestamp REAL, active INTEGER
    );
  `);
  const insertSession = database.query(`INSERT INTO sessions
    (id, source, title, display_name, cwd, git_branch, started_at, message_count, archived, pinned)
    VALUES (?, 'cli', ?, ?, ?, ?, ?, ?, 0, 0)`);
  insertSession.run(HERMES_SID, "", "  Hermes 回退标题  ", "/fixture/hermes-worktree", "feature/hermes", 100, 9);
  insertSession.run(TITLE_ONLY_SID, "  仅标题会话  ", "备用标题", null, null, 200, 0);
  insertSession.run(EMPTY_SID, null, null, null, null, 300, 0);

  const insertMessage = database.query(`INSERT INTO messages
    (id, session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, ?, ?)`);
  insertMessage.run(1, HERMES_SID, "user", "[System: injected]", 101, 1);
  insertMessage.run(2, HERMES_SID, "user", "  [System injected]  ", 102, 1);
  insertMessage.run(3, HERMES_SID, "user", "[CONTEXT COMPACTION hidden]", 103, 1);
  insertMessage.run(4, HERMES_SID, "user", "<system-reminder>hidden</system-reminder>", 104, 1);
  insertMessage.run(5, HERMES_SID, "user", "  第一条 <context>展示文本</context>  ", 105, 1);
  insertMessage.run(6, HERMES_SID, "assistant", `可搜索的 Hermes 回复 ${"答".repeat(FTS_TEXT_MAX_CHARS)}`, 106, 1);
  insertMessage.run(7, HERMES_SID, "tool", "工具结果不索引", 107, 1);
  insertMessage.run(8, HERMES_SID, "user", "已回退输入不索引", 108, 0);
  insertMessage.run(9, HERMES_SID, "user", "最后一条真实输入", 109, 1);
  database.close();
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("Hermes SQLite session source", () => {
  test("discovers eligible sessions and derives active, non-injected prompts and searchable assistant text", () => {
    const root = temporaryDirectory();
    const path = join(root, "state.db");
    createFixture(path);
    const source = createHermesSource(path);

    const { files, errors } = source.discover();
    expect(errors).toEqual([]);
    expect(files.map((file) => file.sid).sort()).toEqual([HERMES_SID, TITLE_ONLY_SID].sort());
    const info = files.find((file) => file.sid === HERMES_SID)!;
    expect(info).toMatchObject({ agent: "hermes", path, size: 9, mtime: 109_000 });

    const derived = source.index(info, null)!;
    expect(derived.replaceFts).toBeTrue();
    expect(derived.session).toEqual({
      agent: "hermes", sid: HERMES_SID, projectKey: "unknown", cwd: "/fixture/hermes-worktree",
      worktreeRoot: null, branch: "feature/hermes", title: "Hermes 回退标题", firstPrompt: "第一条 展示文本",
      lastPrompt: "最后一条真实输入", lastInputAt: 109_000, promptCount: 2,
      filePath: path, fileSize: 9, fileMtime: 109_000, parsedOffset: 0,
      model: null, reasoningEffort: null, executionMetadataVersion: 1,
    });
    expect(derived.fts).toHaveLength(3);
    expect(derived.fts.map((row) => row.role)).toEqual(["user", "assistant", "user"]);
    expect(derived.fts.some((row) => row.text.includes("injected") || row.text.includes("已回退"))).toBeFalse();
    // An unchanged ledger stat is not re-derived.
    expect(source.index(info, derived.session)).toBeNull();
    expect(derived.fts[1]!.text.startsWith("可搜索的 Hermes 回复")).toBeTrue();
    expect(derived.fts[1]!.text.length).toBe(FTS_TEXT_MAX_CHARS);

    const titleOnly = files.find((file) => file.sid === TITLE_ONLY_SID)!;
    expect(source.index(titleOnly, null)!.session).toMatchObject({
      title: "仅标题会话", firstPrompt: null, lastPrompt: null, promptCount: 0,
    });
    expect(findHermesSessionCwd(HERMES_SID, path)).toBe("/fixture/hermes-worktree");
  });

  test("returns no sessions or cwd when the database file does not exist", () => {
    const path = join(temporaryDirectory(), "missing.db");
    expect(createHermesSource(path).discover()).toEqual({ files: [], errors: [] });
    expect(findHermesSessionCwd(HERMES_SID, path)).toBeNull();
  });

  test("reads optional model settings and notices a settings-only change", () => {
    const path = join(temporaryDirectory(), "state.db");
    createFixture(path);
    const writer = new Database(path);
    writer.exec("ALTER TABLE sessions ADD COLUMN model TEXT; ALTER TABLE sessions ADD COLUMN model_config TEXT;");
    writer.query("UPDATE sessions SET model=?, model_config=? WHERE id=?")
      .run("model-one", JSON.stringify({ reasoning_effort: "high" }), HERMES_SID);
    const source = createHermesSource(path);
    const info = source.discover().files.find((file) => file.sid === HERMES_SID)!;
    const first = source.index(info, null)!;
    expect(first.session).toMatchObject({ model: "model-one", reasoningEffort: "high" });
    writer.query("UPDATE sessions SET model=?, model_config=? WHERE id=?").run("model-two", "{}", HERMES_SID);
    source.discover();
    expect(source.index(info, first.session)?.session).toMatchObject({ model: "model-two", reasoningEffort: null });
    writer.close();
  });
});
