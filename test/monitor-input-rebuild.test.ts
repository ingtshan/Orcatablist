import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OrcaDatabase } from "../src/db";
import { createIndexer } from "../src/indexer";
import { parseLine } from "../src/parse";
import { assemblePullOutput, COLLECTOR_SCRIPT, spawnExec, type PullResult } from "../src/remote-pull";
import { ensureFullInputSchema, needsFullInputRebuild } from "../src/session-input-rebuild";
import { indexJsonlSession, indexLocalJsonlSession } from "../src/sources/jsonl";
import { createRemoteEnvironmentSources } from "../src/sources/remote";

const SID = "cccccccc-1111-2222-3333-444444444444";
const INPUT = "长输入🦀".repeat(2_000) + "\n完整结尾";
const BYTES = Buffer.from(JSON.stringify({ type: "user", message: { content: INPUT }, timestamp: "2026-09-09T00:00:00Z" }) + "\n");
const PROJECT = { key: "fixture", name: "fixture", root: "/fixture", color: null };

function seedLegacy(db: OrcaDatabase, path: string, env?: string) {
  const info = { agent: "claude" as const, sid: SID, path, size: BYTES.length, mtime: 1, ...(env ? { env } : {}) };
  const update = indexJsonlSession({ info, stored: null, window: { offset: 0, bytes: BYTES, rebuild: true }, parseLine })!;
  db.applySessionUpdate({ ...update, fts: update.fts.map((row) => ({ ...row, text: row.text.slice(0, 8_000) })), project: PROJECT });
  db.raw.query("DELETE FROM meta WHERE key = 'full_user_inputs_v1'").run();
  ensureFullInputSchema(db.raw);
  return info;
}

test("unchanged local files backfill old input text without dropping sessions or duplicating history", async () => {
  const root = mkdtempSync(join(import.meta.dir, "../scratch/monitor-input-rebuild-"));
  const db = new OrcaDatabase(":memory:");
  const path = join(root, `${SID}.jsonl`);
  writeFileSync(path, BYTES);
  const info = seedLegacy(db, path);
  const indexer = createIndexer({ db, sources: [{ agent: "claude", discover: () => ({ files: [info], errors: [] }),
    index: (file, stored) => indexLocalJsonlSession(file, stored, { parseLine }) }],
    foldProjects: false, resolveProject: async () => PROJECT, resolveWorktree: () => null });
  try {
    expect(needsFullInputRebuild(db.raw, info)).toBe(true);
    expect(db.getRecentUserInputPages([info], { fullText: true }).get(`claude/${SID}`)!.inputs[0]!.text.length).toBe(8_000);
    expect((await indexer.indexAll()).errors).toEqual([]);
    expect(db.getRecentUserInputPages([info], { fullText: true }).get(`claude/${SID}`)!.inputs[0]!.text).toBe(INPUT);
    expect(db.countSessionFts("claude", SID)).toBe(1);
    expect(needsFullInputRebuild(db.raw, info)).toBe(false);
    expect(db.getListVersion()).toBeGreaterThan(0);
    expect((await indexer.indexAll()).changed).toBe(0);
  } finally { indexer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("remote backfill survives incomplete records and replaces history once after acknowledgement", async () => {
  const db = new OrcaDatabase(":memory:");
  const path = `/remote/${SID}.jsonl`;
  const info = seedLegacy(db, path, "remote");
  const split = Math.floor(BYTES.length / 2);
  let round = 0;
  const source = createRemoteEnvironmentSources({ db, env: "remote", agents: { claude: true, codex: null },
    pull: async (cursors): Promise<PullResult> => {
      round += 1;
      expect(cursors[path]?.rebuild === true).toBe(round === 1);
      const offset = round === 1 ? 0 : round === 2 ? split : BYTES.length;
      if (round > 1) expect(cursors[path]?.offset).toBe(offset);
      return { files: [{ path, size: BYTES.length, mtime: 1 }], codexFiles: [], codexIndex: null,
        chunks: round > 2 ? new Map() : new Map([[path, { offset, bytes: BYTES.subarray(offset, round === 1 ? split : BYTES.length) }]]),
        rebuilds: new Set(round === 1 ? [path] : []), truncated: false, done: true, lastPath: path, errors: [], missing: [] };
    } });
  const indexer = createIndexer({ db, sources: source.sources, foldProjects: false,
    resolveProject: async () => PROJECT, resolveWorktree: () => null });
  try {
    await source.runRound();
    expect((await indexer.indexAll()).changed).toBe(0);
    expect(needsFullInputRebuild(db.raw, info)).toBe(true);
    expect(db.countSessionFts("claude", SID, "remote")).toBe(1);
    await source.runRound();
    expect((await indexer.indexAll()).errors).toEqual([]);
    expect(needsFullInputRebuild(db.raw, info)).toBe(false);
    expect(db.getRecentUserInputPages([info], { fullText: true }).get(`remote:claude/${SID}`)!.inputs[0]!.text).toBe(INPUT);
    await source.runRound();
    expect((await indexer.indexAll()).changed).toBe(0);
    expect(db.countSessionFts("claude", SID, "remote")).toBe(1);
  } finally { source.close(); indexer.close(); db.close(); }
});

test("the real collector honors explicit rebuild even when an unchanged file was fully received", async () => {
  const root = mkdtempSync(join(import.meta.dir, "../scratch/monitor-collector-"));
  const dir = join(root, "projects");
  const project = join(dir, "fixture");
  mkdirSync(project, { recursive: true });
  const path = join(project, `${SID}.jsonl`);
  writeFileSync(path, BYTES);
  const stat = statSync(path);
  try {
    const result = await spawnExec(["python3", "-c", COLLECTOR_SCRIPT],
      JSON.stringify({ claude: { dir }, cursors: { [path]: {
        offset: stat.size, size: stat.size, mtime: Math.trunc(stat.mtimeMs), rebuild: true,
      } }, maxBytes: BYTES.length }), 10_000, BYTES.length * 2);
    expect(result.exitCode).toBe(0);
    const pull = assemblePullOutput(result.stdout);
    expect(pull.errors).toEqual([]);
    expect(pull.rebuilds.has(path)).toBe(true);
    expect(pull.chunks.get(path)?.offset).toBe(0);
    expect(Buffer.from(pull.chunks.get(path)!.bytes).equals(BYTES)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
