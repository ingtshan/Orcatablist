import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase } from "../src/db";
import { createIndexer } from "../src/indexer";
import { assemblePullOutput, COLLECTOR_SCRIPT, spawnExec } from "../src/remote-pull";
import type { RemoteReadCursor } from "../src/remote-read-state";
import { createRemoteEnvironmentSources } from "../src/sources/remote";
import { emptySession } from "../src/sources/transcript";

const SID = "11111111-1111-4111-8111-111111111111";
const CODEX_SID = "22222222-2222-4222-8222-222222222222";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orcatab-remote-execution-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  mkdirSync(join(claude, "project"), { recursive: true });
  mkdirSync(join(codex, "sessions"), { recursive: true });
  const claudePath = join(claude, "project", `${SID}.jsonl`);
  const codexPath = join(codex, "sessions", `rollout-fixture-${CODEX_SID}.jsonl`);
  writeFileSync(claudePath, [
    JSON.stringify({ type: "assistant", effort: "max", message: { model: "claude-model", content: [] } }),
    JSON.stringify({ type: "assistant", effort: "low", message: { model: "<synthetic>", content: [] } }), "",
  ].join("\n"));
  writeFileSync(codexPath, [
    JSON.stringify({ type: "turn_context", payload: { model: "codex-model", effort: "xhigh" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "中".repeat(70000) }] } }),
    JSON.stringify({ type: "turn_context", payload: { model: "partial-must-not-win", effort: "low" } }),
  ].join("\n"));
  const collect = async (cursors: Record<string, RemoteReadCursor>) => {
    const result = await spawnExec(["/usr/bin/python3", "-c", COLLECTOR_SCRIPT], JSON.stringify({
      claude: { dir: claude }, codex: { dir: codex, sinceDays: null, index: null },
      cursors, maxBytes: 1024 * 1024, quantum: 1024 * 1024, lastPath: null,
    }), 10_000, 4 * 1024 * 1024);
    expect(result.exitCode).toBe(0);
    expect(result.stderrTail).toBe("");
    return assemblePullOutput(result.stdout);
  };
  return { root, claudePath, codexPath, collect };
}

describe("remote execution metadata", () => {
  test("collects the latest complete typed settings without shipping or rewinding transcripts", async () => {
    const { claudePath, codexPath, collect } = fixture();
    const cursor = (path: string, agent: "claude" | "codex") => ({
      offset: statSync(path).size, size: statSync(path).size, mtime: Math.trunc(statSync(path).mtimeMs), executionAgent: agent,
    });
    const result = await collect({ [claudePath]: cursor(claudePath, "claude"), [codexPath]: cursor(codexPath, "codex") });
    expect(result.errors).toEqual([]);
    expect(result.done).toBeTrue();
    expect(result.chunks.size).toBe(0);
    expect(result.rebuilds.size).toBe(0);
    expect(result.executionMetadata?.get(claudePath)).toEqual({ model: "claude-model", reasoningEffort: "max" });
    expect(result.executionMetadata?.get(codexPath)).toEqual({ model: "codex-model", reasoningEffort: "xhigh" });
  });

  test("backfills a settled remote row exactly once, preserving history and cursor", async () => {
    const { claudePath, collect } = fixture();
    const db = new OrcaDatabase(":memory:");
    cleanup.push(() => db.close());
    const stat = statSync(claudePath);
    const info = { agent: "claude" as const, env: "remote", sid: SID, path: claudePath, size: stat.size, mtime: Math.trunc(stat.mtimeMs) };
    db.upsertSession({ ...emptySession(info), projectKey: "project", firstPrompt: "preserved", lastPrompt: "preserved",
      promptCount: 1, parsedOffset: stat.size, fileSize: stat.size, fileMtime: info.mtime, executionMetadataVersion: 0 });
    db.appendSessionFts([{ agent: "claude", env: "remote", sid: SID, role: "user", text: "preserved history", ts: 1 }]);
    const requests: Array<Record<string, RemoteReadCursor>> = [];
    const handle = createRemoteEnvironmentSources({
      env: "remote", db, agents: { claude: true, codex: null },
      pull: async (cursors) => { requests.push(cursors); return collect(cursors); },
    });
    cleanup.push(() => handle.close());
    const indexer = createIndexer({ db, sources: handle.sources, foldProjects: false,
      resolveProject: async () => ({ key: "project", name: "project", root: "", color: null }), resolveWorktree: () => null });
    await handle.runRound();
    expect((await indexer.indexAll()).changed).toBe(1);
    expect(db.getStoredSession("claude", SID, "remote")).toMatchObject({
      model: "claude-model", reasoningEffort: "max", executionMetadataVersion: 1, promptCount: 1, parsedOffset: stat.size,
    });
    expect(db.search("preserved", 10)).toHaveLength(1);
    expect(db.countSessionFts("claude", SID, "remote")).toBe(1);
    expect(requests[0]![claudePath]).toMatchObject({ offset: stat.size, executionAgent: "claude" });
    await handle.runRound();
    expect((await indexer.indexAll()).changed).toBe(0);
    expect(requests[1]![claudePath]?.executionAgent).toBeUndefined();
    expect(requests[1]![claudePath]?.offset).toBe(stat.size);
  });
});
