import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { OrcaDatabase } from "../src/db";
import { EnvironmentStore, openEnvironmentsDatabase } from "../src/remote-environments";
import { createRemoteIndexing, type EnvironmentHealth } from "../src/remote-poller";
import type { PullResult } from "../src/remote-pull";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const REMOTE_PATH = `/Users/mac/.claude/projects/-p/${SID}.jsonl`;
const ENV = "feibo2";
const IDLE_POLL_MS = 3_600_000;
const closers: Array<() => void> = [];

function prompt(text: string, timestamp: string): string {
  return `${JSON.stringify({ type: "user", message: { content: text }, timestamp, cwd: "/p", gitBranch: "main" })}\n`;
}

function round(content: string | null, options: { size?: number; mtime?: number } = {}): PullResult {
  const bytes = content === null ? null : Buffer.from(content, "utf8");
  const size = options.size ?? bytes?.byteLength ?? 0;
  return {
    files: [{ path: REMOTE_PATH, size, mtime: options.mtime ?? 10 }],
    codexFiles: [],
    chunks: bytes === null ? new Map() : new Map([[REMOTE_PATH, { offset: 0, bytes }]]),
    rebuilds: new Set(), codexIndex: null, truncated: false, done: true, lastPath: REMOTE_PATH,
    errors: [], missing: [],
  };
}

function makeStore(pollMs = IDLE_POLL_MS): EnvironmentStore {
  const store = new EnvironmentStore(openEnvironmentsDatabase(":memory:"));
  closers.push(() => store.close());
  store.upsert({
    name: ENV, sshUser: "mac", sshHost: "192.168.24.117", sshPort: null,
    enabled: true, agents: { claude: true }, pollMs,
  });
  return store;
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/** Drains promise work only: the pipeline is all microtasks, so nothing here waits on real time. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`condition never held: ${label}`);
}

function health(all: EnvironmentHealth[]): EnvironmentHealth {
  return all.find((entry) => entry.name === ENV)!;
}

afterEach(() => {
  while (closers.length) closers.pop()!();
});

describe("remote runner scheduling and health", () => {
  test("kicks during an in-flight pull collapse into one follow-up round", async () => {
    const db = new OrcaDatabase(":memory:");
    closers.push(() => db.close());
    const gates: Array<Deferred<PullResult>> = [];
    let pulls = 0;
    const indexing = createRemoteIndexing({
      db, store: makeStore(),
      pull: () => {
        pulls += 1;
        const gate = deferred<PullResult>();
        gates.push(gate);
        return gate.promise;
      },
    });
    closers.push(() => indexing.close());

    indexing.reload();
    await until(() => pulls === 1, "first pull started");
    indexing.kick(ENV);
    indexing.kick(ENV);
    indexing.kick(ENV);
    expect(pulls).toBe(1);

    const content = prompt("第一轮", "2026-09-05T01:00:00.000Z");
    gates[0]!.resolve(round(content));
    await until(() => pulls === 2, "one follow-up round");
    gates[1]!.resolve(round(null, { size: Buffer.byteLength(content) }));
    await until(() => !health(indexing.health()).syncing, "runner idle");
    // Three kicks, one follow-up — never three, never none.
    expect(pulls).toBe(2);
  });

  test("a reload fences the old pull before it can touch state or health", async () => {
    const db = new OrcaDatabase(":memory:");
    closers.push(() => db.close());
    const store = makeStore();
    const gates: Array<Deferred<PullResult>> = [];
    const indexing = createRemoteIndexing({
      db, store,
      pull: () => {
        const gate = deferred<PullResult>();
        gates.push(gate);
        return gate.promise;
      },
    });
    closers.push(() => indexing.close());

    indexing.reload();
    await until(() => gates.length === 1, "old pull in flight");

    // The environment is edited while the first pull is still outstanding.
    store.upsert({
      name: ENV, sshUser: "mac", sshHost: "192.168.24.117", sshPort: null,
      enabled: true, agents: { claude: true }, pollMs: IDLE_POLL_MS - 1,
    });
    indexing.reload();
    await until(() => gates.length === 2, "new runner pulling");

    const fresh = prompt("NEW", "2026-09-05T03:00:00.000Z");
    gates[1]!.resolve(round(fresh));
    await until(() => health(indexing.health()).lastCommitAt !== null, "new content committed");
    expect(db.getStoredSession("claude", SID, ENV)!.lastPrompt).toBe("NEW");
    const committed = db.remoteReadStates(ENV).get(REMOTE_PATH)!;
    const okAfterNew = health(indexing.health()).lastCommitAt;
    expect(okAfterNew).not.toBeNull();

    // The retired pull finally answers with an older machine state; nothing of it may land.
    gates[0]!.resolve(round(prompt("OLD", "2026-09-05T01:00:00.000Z"), { mtime: 5 }));
    await until(() => true, "old pull settled");
    await Promise.resolve();
    await Promise.resolve();

    const stored = db.getStoredSession("claude", SID, ENV)!;
    expect(stored.lastPrompt).toBe("NEW");
    expect(stored.parsedOffset).toBe(Buffer.byteLength(fresh));
    expect(db.countSessionFts("claude", SID, ENV)).toBe(1);
    expect(db.remoteReadStates(ENV).get(REMOTE_PATH)).toEqual(committed);
    expect(health(indexing.health()).lastCommitAt).toBe(okAfterNew);
  });

  test("a commit failure holds back freshness, keeps the bytes and recovers on retry", async () => {
    const db = new OrcaDatabase(":memory:");
    closers.push(() => db.close());
    const content = prompt("提交失败后重试", "2026-09-05T02:00:00.000Z");
    let rounds = 0;
    const indexing = createRemoteIndexing({
      db, store: makeStore(),
      // Round one delivers the bytes; later rounds only re-list the same file.
      pull: () => Promise.resolve(rounds++ === 0 ? round(content) : round(null, { size: Buffer.byteLength(content) })),
    });
    closers.push(() => indexing.close());

    const failing = spyOn(db, "appendSessionFts").mockImplementation(() => { throw new Error("磁盘写入失败"); });
    indexing.reload();
    await until(() => health(indexing.health()).lastPullAt !== null && !health(indexing.health()).syncing, "first round settled");
    failing.mockRestore();

    const degraded = health(indexing.health());
    expect(degraded.lastPullAt).not.toBeNull();
    expect(degraded.lastOkAt).toBeNull();
    expect(degraded.lastCommitAt).toBeNull();
    expect(degraded.lastError).toContain("磁盘写入失败");
    // The bytes are durably held and honestly reported as still owed, and the file that could
    // not be committed counts as failed — not only records too large to buffer.
    expect(degraded.pendingBytes).toBe(Buffer.byteLength(content));
    expect(degraded.pendingFiles).toBe(1);
    expect(degraded.failedFiles).toBe(1);
    expect(db.countSessionFts("claude", SID, ENV)).toBe(0);
    expect(db.getMeta("indexed_at")).toBeNull();

    indexing.kick(ENV);
    await until(() => health(indexing.health()).lastCommitAt !== null, "retry committed");
    await until(() => !health(indexing.health()).syncing, "retry settled");

    const recovered = health(indexing.health());
    expect(recovered.lastOkAt).not.toBeNull();
    expect(recovered.lastError).toBeNull();
    expect(recovered.pendingBytes).toBe(0);
    expect(recovered.pendingFiles).toBe(0);
    expect(recovered.failedFiles).toBe(0);
    expect(db.getStoredSession("claude", SID, ENV)!.lastPrompt).toBe("提交失败后重试");
    expect(db.countSessionFts("claude", SID, ENV)).toBe(1);
    // A remote round says nothing about how fresh the local index is.
    expect(db.getMeta("indexed_at")).toBeNull();
  });

  test("a blocked record keeps reporting a failure even when later pulls skip the file", async () => {
    const db = new OrcaDatabase(":memory:");
    closers.push(() => db.close());
    // Seed a file already parked on a record too large to buffer.
    db.saveRemoteReadState(ENV, REMOTE_PATH, {
      generation: 1, receivedFrom: 0, receivedTo: 4, observedSize: 100, observedMtime: 10,
      blocked: true, replacePending: false,
    }, Buffer.from("xxxx"));
    const cursors: Array<Record<string, { skip?: boolean }>> = [];
    const indexing = createRemoteIndexing({
      db, store: makeStore(),
      pull: (_config, requested) => {
        cursors.push(requested);
        return Promise.resolve({ ...round(null, { size: 100 }), lastPath: null });
      },
    });
    closers.push(() => indexing.close());

    indexing.reload();
    await until(() => health(indexing.health()).lastPullAt !== null && !health(indexing.health()).syncing, "skip-only round");

    // The collector was told to skip it rather than being handed a forged offset.
    expect(cursors[0]![REMOTE_PATH]!.skip).toBeTrue();
    const state = health(indexing.health());
    expect(state.failedFiles).toBe(1);
    expect(state.pendingBytes).toBe(100);
    // A pull that skips the problem must not let the environment go green and silent.
    expect(state.lastOkAt).toBeNull();
    expect(state.lastError).toContain(REMOTE_PATH);
  });

  test("a budget-truncated round reports pending work and withholds the ok stamp", async () => {
    const db = new OrcaDatabase(":memory:");
    closers.push(() => db.close());
    const first = prompt("已到达", "2026-09-05T02:00:00.000Z");
    const indexing = createRemoteIndexing({
      db, store: makeStore(),
      pull: () => Promise.resolve({ ...round(first, { size: Buffer.byteLength(first) + 400 }), truncated: true }),
    });
    closers.push(() => indexing.close());

    indexing.reload();
    await until(() => health(indexing.health()).lastPullAt !== null && !health(indexing.health()).syncing, "round settled");

    const state = health(indexing.health());
    expect(state.lastPullAt).not.toBeNull();
    expect(state.lastCommitAt).not.toBeNull();
    // The pull was clean but the machine is not caught up: 400 bytes were never delivered.
    expect(state.lastOkAt).toBeNull();
    expect(state.truncated).toBeTrue();
    expect(state.pendingBytes).toBe(400);
    expect(state.pendingFiles).toBe(1);
    expect(db.getStoredSession("claude", SID, ENV)!.lastPrompt).toBe("已到达");
  });
});
