import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase } from "../src/db";
import { createIndexer } from "../src/indexer";
import { parseLine } from "../src/parse";
import { executionSettings, hermesExecutionSettings } from "../src/session-execution";
import { createCodexSource, parseCodexLine } from "../src/sources/codex";
import { emptySession, foldTranscript } from "../src/sources/transcript";

const SID = "11111111-1111-4111-8111-111111111111";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orcatab-session-execution-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new OrcaDatabase(join(root, "index.db"));
  cleanup.push(() => db.close());
  return { root, db };
}

function context(model: string, effort?: string) {
  return JSON.stringify({ type: "turn_context", payload: { model, ...(effort ? { effort } : {}) } });
}

describe("session execution settings", () => {
  test("reads typed Codex and Claude records, including tool-only assistant turns", () => {
    expect(parseCodexLine(context("codex-model", "xhigh")))
      .toEqual({ kind: "meta", model: "codex-model", reasoningEffort: "xhigh" });
    expect(parseLine(JSON.stringify({ type: "assistant", effort: "max", message: {
      model: "claude-model", content: [{ type: "tool_use", name: "Read" }],
    } }))).toMatchObject({ kind: "meta", model: "claude-model", reasoningEffort: "max" });
    expect(executionSettings("<synthetic>", "high")).toEqual({});
    expect(hermesExecutionSettings("hermes-model", '{"reasoning":{"effort":"medium"}}'))
      .toEqual({ model: "hermes-model", reasoningEffort: "medium" });
    expect(hermesExecutionSettings("hermes-model", "bad-json")).toEqual({ model: "hermes-model", reasoningEffort: null });
  });

  test("a newer settings snapshot clears missing effort without affecting prompts or search", () => {
    const file = { agent: "codex" as const, sid: SID, path: "/fixture", size: 0, mtime: 1 };
    const result = foldTranscript(emptySession(file), [context("first", "high"), context("second")], parseCodexLine);
    expect(result.session).toMatchObject({ model: "second", reasoningEffort: null, promptCount: 0 });
    expect(result.fts).toEqual([]);
  });

  test("incremental model-only changes invalidate list data and preserve conversation history", async () => {
    const { root, db } = fixture();
    mkdirSync(join(root, "sessions"));
    const path = join(root, "sessions", `rollout-fixture-${SID}.jsonl`);
    const prompt = JSON.stringify({ type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text: "searchable prompt" }],
    } });
    writeFileSync(path, [JSON.stringify({ type: "session_meta", payload: { session_id: SID, cwd: root } }), context("first", "high"), prompt, ""].join("\n"));
    const indexer = createIndexer({ db, sources: [createCodexSource(root)], foldProjects: false,
      resolveProject: async () => ({ key: "project", name: "project", root, color: null }), resolveWorktree: () => root });
    await indexer.indexAll();
    const version = db.getListVersion();
    expect(db.getSession("codex", SID)).toMatchObject({ model: "first", reasoningEffort: "high", promptCount: 1 });
    appendFileSync(path, `${context("second", "max")}\n`);
    await indexer.indexAll();
    expect(db.getListVersion()).toBeGreaterThan(version);
    expect(db.search("searchable", 10)[0]).toMatchObject({ model: "second", reasoningEffort: "max", promptCount: 1 });
    expect(db.countSessionFts("codex", SID)).toBe(1);
    expect((await indexer.indexAll()).changed).toBe(0);

    // Simulate a pre-upgrade cursor: supplement metadata without rewriting existing FTS or prompts.
    db.raw.query("UPDATE sessions SET model=NULL, reasoning_effort=NULL, execution_metadata_version=0").run();
    const original = db.getStoredSession("codex", SID)!;
    const source = createCodexSource(root);
    const info = source.discover().files[0]!;
    const update = source.index(info, original)!;
    expect(update).toMatchObject({ replaceFts: false, fts: [], session: {
      model: "second", reasoningEffort: "max", executionMetadataVersion: 1, parsedOffset: original.parsedOffset,
    } });
    expect(statSync(path).size).toBe(original.fileSize);
    await indexer.indexAll();
    expect(db.countSessionFts("codex", SID)).toBe(1);
    expect(db.getStoredSession("codex", SID)?.promptCount).toBe(1);
    expect((await indexer.indexAll()).changed).toBe(0);
  });

  test("upgrades the existing database additively, retaining FTS and pending remote bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-execution-migration-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "index.db");
    const initial = new OrcaDatabase(path);
    initial.upsertSession(emptySession({ agent: "codex", sid: SID, path: "/fixture", size: 0, mtime: 1 }));
    initial.appendSessionFts([{ agent: "codex", sid: SID, text: "preserved search", role: "user", ts: 1 }]);
    initial.raw.exec("INSERT INTO remote_read_state(env,path,generation,pending) VALUES('remote','/fixture',7,x'616263');");
    initial.close();
    const legacy = new Database(path);
    legacy.exec("ALTER TABLE sessions DROP COLUMN model; ALTER TABLE sessions DROP COLUMN reasoning_effort; ALTER TABLE sessions DROP COLUMN execution_metadata_version;");
    legacy.close();
    const upgraded = new OrcaDatabase(path);
    cleanup.push(() => upgraded.close());
    expect(upgraded.countSessions()).toBe(1);
    expect(upgraded.search("preserved", 10)).toHaveLength(1);
    expect(upgraded.getStoredSession("codex", SID)).toMatchObject({ model: null, reasoningEffort: null, executionMetadataVersion: 0 });
    expect(upgraded.raw.query("SELECT generation, hex(pending) AS pending FROM remote_read_state").get())
      .toEqual({ generation: 7, pending: "616263" });
  });
});
