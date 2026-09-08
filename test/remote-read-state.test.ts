import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase, type StoredSession } from "../src/db";
import {
  DEFAULT_REMOTE_PENDING_MAX_BYTES, legacyRemoteReadState, receiveRemoteChunk, remoteReadCursor,
  remoteReadStats, type RemoteReadState,
} from "../src/remote-read-state";

const PATH = "/Users/mac/.claude/projects/-p/aaaaaaaa-1111-2222-3333-444444444444.jsonl";
const temporaryDirectories: string[] = [];
const databases: OrcaDatabase[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-read-state-"));
  temporaryDirectories.push(path);
  return path;
}

function makeDb(path = ":memory:"): OrcaDatabase {
  const db = new OrcaDatabase(path);
  databases.push(db);
  return db;
}

function bytes(text: string): Uint8Array { return Buffer.from(text, "utf8"); }

function receive(
  state: RemoteReadState | null,
  pending: string,
  stat: { size: number; mtime: number },
  chunk: { offset: number; bytes: Uint8Array } | null,
  options: { rebuild?: boolean; maxPendingBytes?: number } = {},
) {
  return receiveRemoteChunk({
    path: PATH, state, pending: bytes(pending), stat, chunk,
    rebuild: options.rebuild ?? false,
    maxPendingBytes: options.maxPendingBytes ?? DEFAULT_REMOTE_PENDING_MAX_BYTES,
  });
}

function session(env: string, sid: string, path: string): StoredSession {
  return {
    agent: "claude", env, sid, projectKey: `${env}:/p`, cwd: "/p", worktreeRoot: null, branch: null,
    title: null, firstPrompt: "问", lastPrompt: "问", lastInputAt: 5, promptCount: 1,
    filePath: path, fileSize: 40, fileMtime: 7, parsedOffset: 20,
  };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("remote reception state", () => {
  test("a first sighting starts generation zero and asks for a replacing commit", () => {
    const first = receive(null, "", { size: 6, mtime: 3 }, { offset: 0, bytes: bytes("a\nbc") });
    expect(first.state).toMatchObject({ generation: 0, receivedFrom: 0, receivedTo: 4, replacePending: true });
    expect(Buffer.from(first.pending!).toString()).toBe("a\nbc");
    expect(first.error).toBeNull();
  });

  test("appends only at the received end and refuses a chunk that leaves a gap", () => {
    const state: RemoteReadState = {
      generation: 1, receivedFrom: 4, receivedTo: 6, observedSize: 20, observedMtime: 9,
      blocked: false, replacePending: false,
    };
    const appended = receive(state, "bc", { size: 20, mtime: 9 }, { offset: 6, bytes: bytes("d\n") });
    expect(appended.state.receivedTo).toBe(8);
    expect(Buffer.from(appended.pending!).toString()).toBe("bcd\n");

    const gapped = receive(state, "bc", { size: 20, mtime: 9 }, { offset: 11, bytes: bytes("zz") });
    expect(gapped.state.receivedTo).toBe(6);
    expect(gapped.pending).toBeNull();
    expect(gapped.error).toContain("expected 6");
  });

  test("a shrink or a same-size mtime change opens a new generation from zero", () => {
    const state: RemoteReadState = {
      generation: 2, receivedFrom: 10, receivedTo: 30, observedSize: 60, observedMtime: 100,
      blocked: false, replacePending: false,
    };
    const shrunk = receive(state, "tail", { size: 40, mtime: 200 }, null);
    expect(shrunk.state).toMatchObject({ generation: 3, receivedFrom: 0, receivedTo: 0, replacePending: true });
    expect(shrunk.pending!.byteLength).toBe(0);

    const rewritten = receive(state, "tail", { size: 60, mtime: 101 }, null);
    expect(rewritten.state).toMatchObject({ generation: 3, receivedFrom: 0, receivedTo: 0, replacePending: true });

    const truncated = receive(state, "tail", { size: 0, mtime: 300 }, null);
    expect(truncated.state).toMatchObject({ generation: 3, observedSize: 0, replacePending: true });

    // Growth past the observed size is an append under the append-only log assumption.
    const grown = receive(state, "tail", { size: 90, mtime: 300 }, null);
    expect(grown.state).toMatchObject({ generation: 2, receivedFrom: 10, receivedTo: 30, observedSize: 90 });
  });

  test("an oversized incomplete record keeps its complete prefix, blocks and then unblocks", () => {
    const first = receive(null, "", { size: 200, mtime: 1 }, { offset: 0, bytes: bytes("ok\n") }, { maxPendingBytes: 8 });
    expect(first.state).toMatchObject({ receivedTo: 3, blocked: false });
    // The commit that parsed "ok\n" trimmed the buffer and advanced the acknowledged start.
    const parsed: RemoteReadState = { ...first.state, receivedFrom: 3, replacePending: false };

    const overflow = receive(parsed, "", { size: 200, mtime: 1 }, { offset: 3, bytes: bytes("0123456789") }, { maxPendingBytes: 8 });
    expect(overflow.state).toMatchObject({ receivedTo: 3, blocked: true });
    expect(overflow.error).toContain("exceeds the 8-byte pending limit");
    expect(remoteReadCursor(overflow.state)).toEqual({ offset: 3, size: 200, mtime: 1, skip: true });

    const replaced = receive(overflow.state, "", { size: 4, mtime: 2 }, { offset: 0, bytes: bytes("hi\n") }, { maxPendingBytes: 8 });
    expect(replaced.state).toMatchObject({ blocked: false, replacePending: true, receivedTo: 3 });
    expect(remoteReadCursor(replaced.state).skip).toBeUndefined();
  });

  test("a pre-existing session row seeds a cursor when no read state exists yet", () => {
    const state = legacyRemoteReadState({ parsedOffset: 120, fileSize: 120, fileMtime: 44 });
    expect(remoteReadCursor(state)).toEqual({ offset: 120, size: 120, mtime: 44 });
  });
});

describe("remote read state storage", () => {
  test("acknowledges only the exact generation and range it was handed", () => {
    const db = makeDb();
    db.saveRemoteReadState("feibo2", PATH, {
      generation: 4, receivedFrom: 10, receivedTo: 16, observedSize: 30, observedMtime: 8,
      blocked: false, replacePending: true,
    }, bytes("ab\ncd\n"));

    const stale = db.applySessionUpdate({
      session: session("feibo2", "aaaaaaaa-1111-2222-3333-444444444444", PATH),
      fts: [{ text: "不应写入", agent: "claude", sid: "aaaaaaaa-1111-2222-3333-444444444444", role: "user", ts: 1, env: "feibo2" }],
      replaceFts: true,
      project: { key: "feibo2:/p", name: "p", root: "", color: null },
      ack: { env: "feibo2", path: PATH, generation: 3, receivedFrom: 10, consumed: 3 },
    });
    expect(stale).toBeFalse();
    expect(db.countSessions()).toBe(0);
    expect(db.remoteReadStates("feibo2").get(PATH)).toMatchObject({ receivedFrom: 10, replacePending: true });
    expect(Buffer.from(db.remotePendingBytes("feibo2", PATH)).toString()).toBe("ab\ncd\n");

    const applied = db.applySessionUpdate({
      session: session("feibo2", "aaaaaaaa-1111-2222-3333-444444444444", PATH),
      fts: [{ text: "写入", agent: "claude", sid: "aaaaaaaa-1111-2222-3333-444444444444", role: "user", ts: 1, env: "feibo2" }],
      replaceFts: true,
      project: { key: "feibo2:/p", name: "p", root: "", color: null },
      ack: { env: "feibo2", path: PATH, generation: 4, receivedFrom: 10, consumed: 3 },
    });
    expect(applied).toBeTrue();
    expect(db.remoteReadStates("feibo2").get(PATH)).toMatchObject({
      generation: 4, receivedFrom: 13, receivedTo: 16, replacePending: false,
    });
    expect(Buffer.from(db.remotePendingBytes("feibo2", PATH)).toString()).toBe("cd\n");
    expect(db.countSessionFts("claude", "aaaaaaaa-1111-2222-3333-444444444444", "feibo2")).toBe(1);
  });

  test("refuses an acknowledgement that is not a whole number of received bytes", () => {
    const db = makeDb();
    const state: RemoteReadState = {
      generation: 1, receivedFrom: 0, receivedTo: 4, observedSize: 4, observedMtime: 1,
      blocked: false, replacePending: false,
    };
    db.saveRemoteReadState("feibo2", PATH, state, bytes("ab\n\n"));
    const commit = (consumed: number) => db.applySessionUpdate({
      session: session("feibo2", "aaaaaaaa-1111-2222-3333-444444444444", PATH),
      fts: [], replaceFts: false,
      project: { key: "feibo2:/p", name: "p", root: "", color: null },
      ack: { env: "feibo2", path: PATH, generation: 1, receivedFrom: 0, consumed },
    });
    for (const consumed of [5, -1, 1.5, Number.NaN]) expect(commit(consumed)).toBeFalse();
    expect(db.remoteReadStates("feibo2").get(PATH)).toEqual(state);
    expect(commit(3)).toBeTrue();
    expect(db.remoteReadStates("feibo2").get(PATH)!.receivedFrom).toBe(3);
  });

  test("an existing v8 database gains the table without losing sessions, transcripts or meta", () => {
    const path = join(temporaryDirectory(), "index.db");
    const before = new OrcaDatabase(path);
    before.upsertProject({ key: "feibo2:/p", name: "p", root: "", color: null });
    before.upsertSession(session("feibo2", "aaaaaaaa-1111-2222-3333-444444444444", PATH));
    before.appendSessionFts([{ text: "历史记录", agent: "claude", sid: "aaaaaaaa-1111-2222-3333-444444444444", role: "user", ts: 1, env: "feibo2" }]);
    before.setMeta("indexed_at", "12345");
    // Reproduce a database written before this table existed.
    before.raw.exec("DROP TABLE remote_read_state");
    expect(before.getMeta("schema_version")).toBe("8");
    before.close();

    const after = makeDb(path);
    expect(after.getMeta("schema_version")).toBe("8");
    expect(after.getMeta("indexed_at")).toBe("12345");
    expect(after.countSessions()).toBe(1);
    expect(after.countSessionFts("claude", "aaaaaaaa-1111-2222-3333-444444444444", "feibo2")).toBe(1);
    expect(after.remoteReadStates("feibo2").size).toBe(0);
    after.saveRemoteReadState("feibo2", PATH, {
      generation: 0, receivedFrom: 20, receivedTo: 20, observedSize: 40, observedMtime: 7,
      blocked: false, replacePending: false,
    }, null);
    expect(after.remoteReadStates("feibo2").get(PATH)!.receivedTo).toBe(20);
  });

  test("pending counts cover unreceived bytes, unparsed bytes and unacknowledged resets", () => {
    const db = makeDb();
    const other = "/remote/other.jsonl";
    const emptied = "/remote/emptied.jsonl";
    const loser = "/remote/loser.jsonl";
    // 40 bytes still to fetch and 10 received but unparsed.
    db.saveRemoteReadState("feibo2", PATH, {
      generation: 1, receivedFrom: 50, receivedTo: 60, observedSize: 100, observedMtime: 3,
      blocked: false, replacePending: false,
    }, bytes("0123456789"));
    db.saveRemoteReadState("feibo2", other, {
      generation: 2, receivedFrom: 20, receivedTo: 20, observedSize: 20, observedMtime: 4,
      blocked: true, replacePending: false,
    }, null);
    // A zero-byte replacement owes no bytes but still owes its acknowledgement.
    db.saveRemoteReadState("feibo2", emptied, {
      generation: 3, receivedFrom: 0, receivedTo: 0, observedSize: 0, observedMtime: 5,
      blocked: false, replacePending: true,
    }, null);
    // A duplicate the indexer will never read must not hold the environment stale.
    db.saveRemoteReadState("feibo2", loser, {
      generation: 0, receivedFrom: 0, receivedTo: 0, observedSize: 9_999, observedMtime: 6,
      blocked: true, replacePending: true,
    }, null);

    const active = new Set([PATH, other, emptied]);
    expect(remoteReadStats(db.remoteReadStates("feibo2"), active))
      .toEqual({ pendingBytes: 50, pendingFiles: 2, blockedPaths: [other] });
    // A duplicate loser is not active, so it can never hold the environment stale.
    expect(remoteReadStats(db.remoteReadStates("feibo2"), new Set()))
      .toEqual({ pendingBytes: 0, pendingFiles: 0, blockedPaths: [] });
  });

  test("purging one environment removes only its read state", () => {
    const db = makeDb();
    const empty: RemoteReadState = {
      generation: 0, receivedFrom: 0, receivedTo: 2, observedSize: 2, observedMtime: 1,
      blocked: false, replacePending: false,
    };
    db.saveRemoteReadState("feibo2", PATH, empty, bytes("ab"));
    db.saveRemoteReadState("feibo3", PATH, empty, bytes("cd"));
    db.upsertSession(session("feibo2", "aaaaaaaa-1111-2222-3333-444444444444", PATH));
    db.upsertSession(session("feibo3", "bbbbbbbb-1111-2222-3333-444444444444", PATH));

    db.setRemoteFairnessCursor("feibo2", PATH);
    db.setRemoteFairnessCursor("feibo3", PATH);

    db.purgeEnvironment("feibo2");
    expect(db.remoteReadStates("feibo2").size).toBe(0);
    expect(db.remoteReadStates("feibo3").size).toBe(1);
    expect(db.countSessionsByEnv("feibo3")).toBe(1);
    // The fairness continuation is per-environment metadata and goes with it.
    expect(db.getRemoteFairnessCursor("feibo2")).toBeNull();
    expect(db.getRemoteFairnessCursor("feibo3")).toBe(PATH);
  });
});
