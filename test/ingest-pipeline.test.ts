import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase } from "../src/db";
import { createIndexer } from "../src/indexer";
import { assemblePullOutput, COLLECTOR_SCRIPT, spawnExec } from "../src/remote-pull";
import type { RemoteReadCursor } from "../src/remote-read-state";
import { createRemoteEnvironmentSources, createRemoteProjectResolver } from "../src/sources/remote";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const ENV = "feibo2";
const MEBIBYTE = 1024 * 1024;
const BUDGET = 8 * MEBIBYTE;
const COLLECTOR_TIMEOUT_MS = 60_000;
const STDOUT_CAP_BYTES = 64 * MEBIBYTE;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-ingest-"));
  temporaryDirectories.push(path);
  return path;
}

function prompt(text: string, timestamp: string): string {
  return `${JSON.stringify({
    type: "user", message: { content: text }, timestamp,
    cwd: "/Users/mac/workspace/we-orca", gitBranch: "main",
  })}\n`;
}

/** Shifts an mtime far enough that the collector sees a different second, whatever the filesystem. */
function touch(path: string, secondsAgo: number): void {
  const when = Math.trunc(Date.now() / 1000) - secondsAgo;
  utimesSync(path, when, when);
}

interface Pipeline {
  db: OrcaDatabase;
  transferred: number[];
  cursors: Array<Record<string, RemoteReadCursor>>;
  resumed: Array<string | null>;
  errors: string[];
  round(): Promise<void>;
}

/** The real local collector → NDJSON assembly → remote source → indexer → SQLite. */
function createPipeline(root: string, dbPath: string, maxBytes = BUDGET, quantum = MEBIBYTE): Pipeline {
  const db = new OrcaDatabase(dbPath);
  const transferred: number[] = [];
  const cursors: Array<Record<string, RemoteReadCursor>> = [];
  const errors: string[] = [];
  const resumed: Array<string | null> = [];
  const handle = createRemoteEnvironmentSources({
    env: ENV, db, agents: { claude: true, codex: null },
    pull: async (requested, _agents, lastPath) => {
      cursors.push(requested);
      resumed.push(lastPath);
      const result = await spawnExec(
        ["python3", "-c", COLLECTOR_SCRIPT],
        JSON.stringify({ claude: { dir: join(root, "projects") }, cursors: requested, maxBytes, quantum, lastPath }),
        COLLECTOR_TIMEOUT_MS, STDOUT_CAP_BYTES,
      );
      expect(result.exitCode).toBe(0);
      const assembled = assemblePullOutput(result.stdout);
      transferred.push([...assembled.chunks.values()].reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0));
      return assembled;
    },
  });
  const indexer = createIndexer({
    db, sources: handle.sources, foldProjects: false, markIndexedAt: false,
    resolveProject: (cwd) => createRemoteProjectResolver(ENV)(cwd),
    resolveWorktree: () => null,
  });
  return {
    db, transferred, cursors, resumed, errors,
    round: async () => {
      errors.push(...(await handle.runRound()).errors);
      await indexer.indexAll();
    },
  };
}

function sessionFile(root: string, content: string): string {
  const projects = join(root, "projects", "-Users-mac-workspace-we-orca");
  mkdirSync(projects, { recursive: true });
  const path = join(projects, `${SID}.jsonl`);
  writeFileSync(path, content);
  return path;
}

/** Fixtures deliberately make directories unreadable; give them back before removal. */
function restorePermissions(path: string): void {
  try { chmodSync(path, 0o700); } catch { return; }
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) if (entry.isDirectory()) restorePermissions(join(path, entry.name));
}

afterEach(() => {
  while (temporaryDirectories.length) {
    const path = temporaryDirectories.pop()!;
    restorePermissions(path);
    rmSync(path, { recursive: true, force: true });
  }
});

describe("remote ingest through the real collector", () => {
  test("a 9 MiB record after ordinary ones converges within the byte budget", async () => {
    const root = temporaryDirectory();
    const ordinary = prompt("平常一问", "2026-08-30T01:00:00.000Z") + prompt("平常二问", "2026-08-30T01:01:00.000Z");
    const huge = prompt("X".repeat(9 * MEBIBYTE), "2026-08-30T02:00:00.000Z");
    const path = sessionFile(root, ordinary + huge);
    const total = statSync(path).size;
    const pipeline = createPipeline(root, join(root, "index.db"));

    await pipeline.round();
    let stored = pipeline.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.promptCount).toBe(2);
    expect(stored.parsedOffset).toBe(Buffer.byteLength(ordinary));
    expect(stored.fileSize).toBe(total);

    for (let attempt = 0; attempt < 5 && pipeline.db.getStoredSession("claude", SID, ENV)!.parsedOffset < total; attempt += 1) {
      await pipeline.round();
    }
    stored = pipeline.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.parsedOffset).toBe(total);
    expect(stored.promptCount).toBe(3);
    expect(stored.lastPrompt).toBe("X".repeat(200));
    expect(pipeline.db.countSessionFts("claude", SID, ENV)).toBe(3);
    expect(pipeline.errors).toEqual([]);
    // The record is larger than one round's budget: it must arrive across rounds, never at once.
    expect(pipeline.transferred.length).toBeGreaterThan(1);
    expect(pipeline.transferred[0]).toBe(BUDGET);
    expect(Math.max(...pipeline.transferred)).toBeLessThanOrEqual(BUDGET);
    pipeline.db.close();
  }, 120_000);

  test("received bytes survive a closed database and a rebuilt source", async () => {
    const root = temporaryDirectory();
    const first = prompt("第一条", "2026-08-30T01:00:00.000Z");
    const second = prompt("第二条", "2026-08-30T02:00:00.000Z");
    const path = sessionFile(root, first + second);
    const total = statSync(path).size;
    const partial = Buffer.byteLength(first) + 10;
    const dbPath = join(root, "index.db");

    const before = createPipeline(root, dbPath, partial);
    await before.round();
    expect(before.db.getStoredSession("claude", SID, ENV)!.parsedOffset).toBe(Buffer.byteLength(first));
    before.db.close();

    const after = createPipeline(root, dbPath, BUDGET);
    await after.round();
    // The second round resumes from the bytes already received, not from the parse cursor.
    expect(after.cursors[0]).toEqual({ [path]: { offset: partial, size: total, mtime: expect.any(Number) } });
    expect(after.transferred[0]).toBe(total - partial);
    const stored = after.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.parsedOffset).toBe(total);
    expect(stored.promptCount).toBe(2);
    expect(stored.lastPrompt).toBe("第二条");
    expect(after.db.countSessionFts("claude", SID, ENV)).toBe(2);
    after.db.close();
  }, 30_000);

  test("half a multi-byte character waits for its completion and lands exactly once", async () => {
    const root = temporaryDirectory();
    const first = prompt("第一条", "2026-08-30T01:00:00.000Z");
    const second = prompt("第二条内容", "2026-08-30T02:00:00.000Z");
    const path = sessionFile(root, first + second);
    const total = statSync(path).size;
    // Cut inside the leading multi-byte character of the second record's text.
    const cut = Buffer.byteLength(first) + second.indexOf("第二条内容") + 1;
    const pipeline = createPipeline(root, join(root, "index.db"), cut);

    await pipeline.round();
    let stored = pipeline.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.parsedOffset).toBe(Buffer.byteLength(first));
    expect(stored.promptCount).toBe(1);
    expect(pipeline.db.countSessionFts("claude", SID, ENV)).toBe(1);

    const finish = createPipeline(root, join(root, "index.db"), BUDGET);
    await finish.round();
    expect(finish.cursors[0]![path]!.offset).toBe(cut);
    stored = finish.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.parsedOffset).toBe(total);
    expect(stored.promptCount).toBe(2);
    expect(stored.lastPrompt).toBe("第二条内容");
    expect(finish.db.countSessionFts("claude", SID, ENV)).toBe(2);
    finish.db.close();
  }, 30_000);

  test("a same-size rewrite with a new mtime replaces the transcript exactly once", async () => {
    const root = temporaryDirectory();
    const path = sessionFile(root, prompt("旧内容", "2026-08-30T01:00:00.000Z"));
    touch(path, 600);
    const pipeline = createPipeline(root, join(root, "index.db"));
    await pipeline.round();
    expect(pipeline.db.getStoredSession("claude", SID, ENV)!.lastPrompt).toBe("旧内容");

    const rewritten = prompt("新内容", "2026-08-30T01:00:00.000Z");
    expect(Buffer.byteLength(rewritten)).toBe(statSync(path).size);
    writeFileSync(path, rewritten);
    touch(path, 60);
    await pipeline.round();

    const stored = pipeline.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.lastPrompt).toBe("新内容");
    expect(stored.firstPrompt).toBe("新内容");
    expect(stored.promptCount).toBe(1);
    expect(stored.parsedOffset).toBe(Buffer.byteLength(rewritten));
    expect(pipeline.db.countSessionFts("claude", SID, ENV)).toBe(1);
    pipeline.db.close();
  }, 30_000);

  test("a shrink still ahead of the parse cursor rebuilds from zero", async () => {
    const root = temporaryDirectory();
    const long = prompt("一号", "2026-08-30T01:00:00.000Z") + prompt("二号", "2026-08-30T02:00:00.000Z")
      + prompt("三号", "2026-08-30T03:00:00.000Z");
    const path = sessionFile(root, long);
    touch(path, 600);
    const firstRecord = Buffer.byteLength(prompt("一号", "2026-08-30T01:00:00.000Z"));
    const pipeline = createPipeline(root, join(root, "index.db"), firstRecord);
    await pipeline.round();
    expect(pipeline.db.getStoredSession("claude", SID, ENV)!.promptCount).toBe(1);

    const shorter = prompt("替换甲", "2026-08-31T01:00:00.000Z") + prompt("替换乙", "2026-08-31T02:00:00.000Z");
    expect(Buffer.byteLength(shorter)).toBeGreaterThan(firstRecord);
    expect(Buffer.byteLength(shorter)).toBeLessThan(Buffer.byteLength(long));
    writeFileSync(path, shorter);
    touch(path, 60);
    const resumed = createPipeline(root, join(root, "index.db"), BUDGET);
    await resumed.round();

    const stored = resumed.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.promptCount).toBe(2);
    expect(stored.firstPrompt).toBe("替换甲");
    expect(stored.lastPrompt).toBe("替换乙");
    expect(stored.parsedOffset).toBe(Buffer.byteLength(shorter));
    expect(resumed.db.countSessionFts("claude", SID, ENV)).toBe(2);
    resumed.db.close();
  }, 30_000);

  test("a file truncated to zero clears its stale content even though no chunk arrives", async () => {
    const root = temporaryDirectory();
    const path = sessionFile(root, prompt("将被清空", "2026-08-30T01:00:00.000Z"));
    touch(path, 600);
    const pipeline = createPipeline(root, join(root, "index.db"));
    await pipeline.round();
    expect(pipeline.db.countSessionFts("claude", SID, ENV)).toBe(1);

    writeFileSync(path, "");
    touch(path, 60);
    await pipeline.round();

    expect(pipeline.transferred[1]).toBe(0);
    const stored = pipeline.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.promptCount).toBe(0);
    expect(stored.lastPrompt).toBeNull();
    expect(stored.fileSize).toBe(0);
    expect(stored.parsedOffset).toBe(0);
    expect(pipeline.db.countSessionFts("claude", SID, ENV)).toBe(0);
    pipeline.db.close();
  }, 30_000);

  test("a listed file the budget never reached stays deferred instead of becoming an empty row", async () => {
    const root = temporaryDirectory();
    const projects = join(root, "projects", "-Users-mac-workspace-we-orca");
    mkdirSync(projects, { recursive: true });
    const busy = join(projects, `${SID}.jsonl`);
    const OTHER_SID = "cccccccc-3333-4444-5555-666666666666";
    const deferred = join(projects, `${OTHER_SID}.jsonl`);
    writeFileSync(busy, prompt("先到的会话", "2026-08-30T01:00:00.000Z"));
    writeFileSync(deferred, prompt("预算没轮到的会话", "2026-08-30T02:00:00.000Z"));
    // The collector ships freshest first, so the older file is listed with no bytes left to spend.
    touch(busy, 60);
    touch(deferred, 600);
    const budget = statSync(busy).size;
    const pipeline = createPipeline(root, join(root, "index.db"), budget);

    await pipeline.round();
    expect(pipeline.db.getStoredSession("claude", SID, ENV)!.lastPrompt).toBe("先到的会话");
    expect(pipeline.db.getStoredSession("claude", OTHER_SID, ENV)).toBeNull();
    expect(pipeline.db.countSessionFts("claude", OTHER_SID, ENV)).toBe(0);
    expect(pipeline.errors).toEqual([]);

    const finish = createPipeline(root, join(root, "index.db"), BUDGET);
    await finish.round();
    const arrived = finish.db.getStoredSession("claude", OTHER_SID, ENV)!;
    expect(arrived.lastPrompt).toBe("预算没轮到的会话");
    expect(arrived.parsedOffset).toBe(statSync(deferred).size);
    expect(finish.db.countSessionFts("claude", OTHER_SID, ENV)).toBe(1);
    finish.db.close();
    pipeline.db.close();
  }, 30_000);

  test("a cyclic quantum serves every eligible file even while one file keeps growing", async () => {
    const root = temporaryDirectory();
    const projects = join(root, "projects", "-Users-mac-workspace-we-orca");
    mkdirSync(projects, { recursive: true });
    const cold = ["c1111111", "c2222222", "c3333333", "c4444444"]
      .map((prefix) => `${prefix}-1111-2222-3333-444444444444`);
    const hotSid = "f1111111-1111-2222-3333-444444444444";
    const hot = join(projects, `${hotSid}.jsonl`);
    for (const sid of cold) {
      writeFileSync(join(projects, `${sid}.jsonl`), prompt(`冷文件 ${sid.slice(0, 4)}`, "2026-08-30T01:00:00.000Z"));
    }
    writeFileSync(hot, prompt("热文件第一条", "2026-08-30T02:00:00.000Z"));
    const quantum = 100;
    const pipeline = createPipeline(root, join(root, "index.db"), 2 * quantum, quantum);

    // Four rounds of two turns each is enough to reach five files, while the hot file is written
    // continuously and would win every mtime-ordered race.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      appendFileSync(hot, prompt(`热文件追加 ${attempt}`, "2026-08-30T03:00:00.000Z"));
      await pipeline.round();
    }

    const states = pipeline.db.remoteReadStates(ENV);
    for (const sid of [...cold, hotSid]) {
      const state = states.get(join(projects, `${sid}.jsonl`));
      expect(state?.receivedTo ?? 0).toBeGreaterThan(0);
    }
    expect(Math.max(...pipeline.transferred)).toBeLessThanOrEqual(2 * quantum);
    // The continuation point is persisted between rounds instead of restarting at the freshest file.
    expect(pipeline.resumed[0]).toBeNull();
    expect(pipeline.resumed.slice(1).every((path) => typeof path === "string")).toBeTrue();
    expect(pipeline.errors).toEqual([]);
    pipeline.db.close();
  }, 60_000);

  test("a same-size replacement holds its committed content until a whole record arrives", async () => {
    const root = temporaryDirectory();
    const projects = join(root, "projects", "-Users-mac-workspace-we-orca");
    mkdirSync(projects, { recursive: true });
    const path = join(projects, `${SID}.jsonl`);
    const old = prompt("旧内容", "2026-08-30T01:00:00.000Z");
    writeFileSync(path, old);
    touch(path, 600);
    // One quantum per round: the replacement can only arrive in pieces.
    const quantum = 40;
    const pipeline = createPipeline(root, join(root, "index.db"), quantum, quantum);
    for (let attempt = 0; attempt < 4; attempt += 1) await pipeline.round();
    expect(pipeline.db.getStoredSession("claude", SID, ENV)!.lastPrompt).toBe("旧内容");

    const rewritten = prompt("新内容", "2026-08-30T01:00:00.000Z");
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(old));
    writeFileSync(path, rewritten);
    touch(path, 60);

    // The replacement arrives one 40-byte quantum at a time, so the first rounds carry no record.
    await pipeline.round();
    let stored = pipeline.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.lastPrompt).toBe("旧内容");
    expect(stored.parsedOffset).toBe(Buffer.byteLength(old));
    expect(pipeline.db.countSessionFts("claude", SID, ENV)).toBe(1);
    expect(pipeline.db.remoteReadStates(ENV).get(path)).toMatchObject({ replacePending: true, receivedFrom: 0 });

    for (let attempt = 0; attempt < 4; attempt += 1) await pipeline.round();
    stored = pipeline.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.lastPrompt).toBe("新内容");
    expect(stored.parsedOffset).toBe(Buffer.byteLength(rewritten));
    // Replaced exactly once: the old transcript is gone and the new one is not doubled.
    expect(pipeline.db.countSessionFts("claude", SID, ENV)).toBe(1);
    pipeline.db.close();
  }, 60_000);

  test("an unreadable duplicate directory keeps the better owner and its transfer state", async () => {
    const root = temporaryDirectory();
    const projects = join(root, "projects");
    const winner = join(projects, "-z-winner");
    const loser = join(projects, "-a-loser");
    const healthy = join(projects, "-healthy");
    mkdirSync(winner, { recursive: true });
    mkdirSync(loser, { recursive: true });
    mkdirSync(healthy, { recursive: true });
    const SIBLING = "cccccccc-3333-4444-5555-666666666666";
    const winnerPath = join(winner, `${SID}.jsonl`);
    writeFileSync(winnerPath, prompt("胜出目录的新内容", "2026-08-30T02:00:00.000Z"));
    writeFileSync(join(loser, `${SID}.jsonl`), prompt("落选目录的旧内容", "2026-08-30T01:00:00.000Z"));
    const pipeline = createPipeline(root, join(root, "index.db"));

    await pipeline.round();
    expect(pipeline.db.getStoredSession("claude", SID, ENV)!.filePath).toBe(winnerPath);
    expect(pipeline.db.getStoredSession("claude", SID, ENV)!.lastPrompt).toBe("胜出目录的新内容");
    expect(pipeline.errors).toEqual([]);

    // The winner's directory becomes unreadable, and a brand-new healthy session appears.
    chmodSync(winner, 0o000);
    let readable = true;
    try { readdirSync(winner); } catch { readable = false; }
    expect(readable).toBeFalse();
    writeFileSync(join(healthy, `${SIBLING}.jsonl`), prompt("健康的兄弟会话", "2026-08-30T03:00:00.000Z"));

    await pipeline.round();
    await pipeline.round();

    // The listing is short because it failed, not because the file was deleted.
    expect(pipeline.errors.some((error) => error.includes(winner))).toBeTrue();
    const stored = pipeline.db.getStoredSession("claude", SID, ENV)!;
    expect(stored.filePath).toBe(winnerPath);
    expect(stored.lastPrompt).toBe("胜出目录的新内容");
    expect(pipeline.db.countSessionFts("claude", SID, ENV)).toBe(1);
    // An incomplete inventory cannot authorise cleanup either: the winner's cursor survives.
    expect(pipeline.db.remoteReadStates(ENV).has(winnerPath)).toBeTrue();
    // Healthy siblings still make progress through the degraded round.
    expect(pipeline.db.getStoredSession("claude", SIBLING, ENV)!.lastPrompt).toBe("健康的兄弟会话");
    chmodSync(winner, 0o700);
    pipeline.db.close();
  }, 60_000);

  test("a blocked oversized record is skipped until the file changes", async () => {
    const root = temporaryDirectory();
    // One record that never terminates: the buffer can only grow, so the limit is what stops it.
    const path = sessionFile(root, prompt("超长记录内容", "2026-08-30T01:00:00.000Z").trimEnd());
    touch(path, 600);
    const db = new OrcaDatabase(join(root, "index.db"));
    const transferred: number[] = [];
    const sent: Array<Record<string, RemoteReadCursor>> = [];
    const errors: string[] = [];
    const handle = createRemoteEnvironmentSources({
      env: ENV, db, agents: { claude: true, codex: null }, maxPendingBytes: 8,
      pull: async (requested) => {
        sent.push(requested);
        const result = await spawnExec(
          ["python3", "-c", COLLECTOR_SCRIPT],
          JSON.stringify({ claude: { dir: join(root, "projects") }, cursors: requested, maxBytes: BUDGET }),
          COLLECTOR_TIMEOUT_MS, STDOUT_CAP_BYTES,
        );
        const assembled = assemblePullOutput(result.stdout);
        transferred.push([...assembled.chunks.values()].reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0));
        return assembled;
      },
    });
    const indexer = createIndexer({
      db, sources: handle.sources, foldProjects: false, markIndexedAt: false,
      resolveProject: (cwd) => createRemoteProjectResolver(ENV)(cwd),
      resolveWorktree: () => null,
    });
    const round = async () => {
      errors.push(...(await handle.runRound()).errors);
      await indexer.indexAll();
    };

    await round();
    expect(errors.some((error) => error.includes("pending limit"))).toBeTrue();
    // Nothing parsable was ever received, so the session stays deferred rather than empty.
    expect(db.getStoredSession("claude", SID, ENV)).toBeNull();
    expect(db.countSessionFts("claude", SID, ENV)).toBe(0);

    await round();
    expect(sent[1]![path]).toMatchObject({ offset: 0, skip: true });
    expect(transferred[1]).toBe(0);
    // A skipped file is still an active winner, so its failure stays visible instead of vanishing.
    expect(handle.stats()).toMatchObject({ blockedPaths: [path], pendingFiles: 1 });

    // A replacement makes the file eligible again, and a record that fits commits normally.
    writeFileSync(path, prompt("短", "2026-08-31T01:00:00.000Z"));
    touch(path, 60);
    await round();
    expect(db.getStoredSession("claude", SID, ENV)!.lastPrompt).toBe("短");
    expect(db.countSessionFts("claude", SID, ENV)).toBe(1);
    db.close();
  }, 30_000);
});
