import type { Database } from "bun:sqlite";

/**
 * Durable reception state for one remote session file.
 *
 * Byte reception commits ahead of parsing: `pending` holds the contiguous bytes received but not
 * yet folded into a session, spanning `[receivedFrom, receivedTo)`. `sessions.parsed_offset` stays
 * the committed parse cursor and only ever counts complete newline-terminated records, so a
 * restart resumes from durable received data instead of re-requesting it.
 */

const BYTE_NEWLINE = 0x0a;
const EMPTY_BYTES = new Uint8Array(0);

/** Per-file ceiling on buffered bytes of a single incomplete JSONL record. */
export const DEFAULT_REMOTE_PENDING_MAX_BYTES = 64 * 1024 * 1024;

export interface RemoteReadState {
  /** Bumped on every detected replacement so a stale acknowledgement can never commit old bytes. */
  generation: number;
  receivedFrom: number;
  receivedTo: number;
  observedSize: number;
  observedMtime: number;
  /** An oversized record blocks this file until its stat moves or it is replaced. */
  blocked: boolean;
  /** The next commit of this generation must replace the session's transcript exactly once. */
  replacePending: boolean;
}
/** `offset` is bytes durably received; `size`/`mtime` describe the file that offset belongs to. */
export interface RemoteReadCursor {
  /** Read execution settings without rewinding the transcript transfer cursor. */
  executionAgent?: "claude" | "codex";
  /** Re-read an old truncated input index using the ordinary replacement/ACK protocol. */
  rebuild?: boolean;
  offset: number; size: number; mtime: number;
  /** An oversized record this caller cannot buffer: skip while the file's stat stands still. */
  skip?: boolean;
  /** A duplicate path the owner rule will never consume: never ship it at all. */
  exclude?: boolean;
}
export interface RemoteReadAck { env: string; path: string; generation: number; receivedFrom: number; consumed: number; }
export interface RemoteObservedStat { size: number; mtime: number; }
export interface RemoteChunk { offset: number; bytes: Uint8Array; }
export interface RemoteReception {
  state: RemoteReadState;
  /** Null leaves the durable buffer untouched; otherwise the exact bytes to persist. */
  pending: Uint8Array | null;
  changed: boolean;
  error: string | null;
}
export interface RemoteReceptionInput {
  path: string;
  /** Null when this file has never been observed under this environment. */
  state: RemoteReadState | null;
  pending: Uint8Array;
  stat: RemoteObservedStat;
  chunk: RemoteChunk | null;
  /** The collector reported that it restarted this file from zero. */
  rebuild: boolean;
  maxPendingBytes: number;
}

const UNOBSERVED: RemoteReadState = {
  generation: 0, receivedFrom: 0, receivedTo: 0, observedSize: 0, observedMtime: 0,
  blocked: false, replacePending: false,
};

export function remoteReadCursor(state: RemoteReadState): RemoteReadCursor {
  return {
    offset: state.receivedTo, size: state.observedSize, mtime: state.observedMtime,
    ...(state.blocked ? { skip: true } : {}),
  };
}

/** A session row indexed before this table existed still carries a usable committed cursor. */
export function legacyRemoteReadState(
  cursor: { parsedOffset: number; fileSize: number; fileMtime: number },
): RemoteReadState {
  return {
    generation: 0, receivedFrom: cursor.parsedOffset, receivedTo: cursor.parsedOffset,
    observedSize: cursor.fileSize, observedMtime: cursor.fileMtime, blocked: false, replacePending: false,
  };
}

/**
 * A shrink, or a same-size file whose mtime moved, is a different file: the append-only log
 * assumption only covers growth, so anything else starts a new read generation.
 */
export function isRemoteReplacement(state: RemoteReadState, stat: RemoteObservedStat): boolean {
  if (stat.size < state.observedSize) return true;
  if (stat.size === state.observedSize && stat.mtime !== state.observedMtime) return true;
  return stat.size < state.receivedTo;
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.byteLength === 0) return tail;
  const merged = new Uint8Array(head.byteLength + tail.byteLength);
  merged.set(head, 0);
  merged.set(tail, head.byteLength);
  return merged;
}

function lastNewlineIndex(bytes: Uint8Array): number {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).lastIndexOf(BYTE_NEWLINE);
}

/** Folds one round's chunk for one file into its durable reception state. */
export function receiveRemoteChunk(input: RemoteReceptionInput): RemoteReception {
  const known = input.state !== null;
  const previous = input.state ?? UNOBSERVED;
  // Only the collector's own rebuild marker or an observed replacement opens a generation. A
  // chunk that merely restarts at zero is an invalid range and is refused below.
  const replaced = known && (input.rebuild || isRemoteReplacement(previous, input.stat));
  const fresh = replaced || !known;
  const base: RemoteReadState = fresh
    ? {
      generation: replaced ? previous.generation + 1 : 0, receivedFrom: 0, receivedTo: 0,
      observedSize: input.stat.size, observedMtime: input.stat.mtime, blocked: false, replacePending: true,
    }
    : { ...previous, observedSize: input.stat.size, observedMtime: input.stat.mtime };
  const moved = fresh || previous.observedSize !== input.stat.size || previous.observedMtime !== input.stat.mtime;
  const buffered = fresh ? EMPTY_BYTES : input.pending;
  if (input.chunk === null) {
    return { state: base, pending: fresh ? buffered : null, changed: moved, error: null };
  }
  if (input.chunk.offset !== base.receivedTo) {
    return {
      state: base, pending: fresh ? buffered : null, changed: moved,
      error: `remote chunk for ${input.path} starts at ${input.chunk.offset}, expected ${base.receivedTo}`,
    };
  }
  const merged = concatBytes(buffered, input.chunk.bytes);
  const complete = lastNewlineIndex(merged) + 1;
  const incomplete = merged.byteLength - complete;
  if (incomplete > input.maxPendingBytes) {
    // Keep every complete record already received and refuse the oversized tail: the committed
    // cursor never moves past data we did not parse, and `blocked` stops the retry loop.
    const accepted = Math.max(complete, buffered.byteLength);
    return {
      state: { ...base, receivedTo: base.receivedFrom + accepted, blocked: true },
      pending: merged.subarray(0, accepted), changed: true,
      error: `remote record in ${input.path} exceeds the ${input.maxPendingBytes}-byte pending limit`
        + ` at offset ${base.receivedFrom + accepted}; skipping this file until it changes`,
    };
  }
  return {
    state: { ...base, receivedTo: base.receivedFrom + merged.byteLength, blocked: false },
    pending: merged, changed: true, error: null,
  };
}

interface ReadStateRow {
  path: string; generation: number; received_from: number; received_to: number;
  observed_size: number; observed_mtime: number; blocked: number; replace_pending: number;
}

const STATE_COLUMNS = `path, generation, received_from, received_to, observed_size, observed_mtime,
  blocked, replace_pending`;

function toState(row: ReadStateRow): RemoteReadState {
  return {
    generation: Number(row.generation), receivedFrom: Number(row.received_from), receivedTo: Number(row.received_to),
    observedSize: Number(row.observed_size), observedMtime: Number(row.observed_mtime),
    blocked: Number(row.blocked) !== 0, replacePending: Number(row.replace_pending) !== 0,
  };
}

/** Metadata only — pending blobs are loaded one file at a time, never all at once. */
export function listRemoteReadStates(raw: Database, env: string): Map<string, RemoteReadState> {
  const rows = raw.query(`SELECT ${STATE_COLUMNS} FROM remote_read_state WHERE env = ?`).all(env) as ReadStateRow[];
  return new Map(rows.map((row) => [row.path, toState(row)]));
}

export function getRemotePending(raw: Database, env: string, path: string): Uint8Array {
  const row = raw.query("SELECT pending FROM remote_read_state WHERE env = ? AND path = ?")
    .get(env, path) as { pending: Uint8Array } | null;
  return row === null ? EMPTY_BYTES : row.pending;
}

export function saveRemoteReadState(
  raw: Database, env: string, path: string, state: RemoteReadState, pending: Uint8Array | null,
): void {
  const values = [
    env, path, state.generation, state.receivedFrom, state.receivedTo, state.observedSize,
    state.observedMtime, state.blocked ? 1 : 0, state.replacePending ? 1 : 0,
  ] as const;
  const assignments = `generation = excluded.generation, received_from = excluded.received_from,
    received_to = excluded.received_to, observed_size = excluded.observed_size,
    observed_mtime = excluded.observed_mtime, blocked = excluded.blocked,
    replace_pending = excluded.replace_pending`;
  if (pending === null) {
    raw.query(`INSERT INTO remote_read_state
      (env, path, generation, received_from, received_to, observed_size, observed_mtime, blocked, replace_pending, pending)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, x'')
      ON CONFLICT(env, path) DO UPDATE SET ${assignments}`).run(...values);
    return;
  }
  raw.query(`INSERT INTO remote_read_state
    (env, path, generation, received_from, received_to, observed_size, observed_mtime, blocked, replace_pending, pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(env, path) DO UPDATE SET ${assignments}, pending = excluded.pending`)
    .run(...values, Buffer.from(pending.buffer, pending.byteOffset, pending.byteLength));
}

/**
 * Trims exactly the acknowledged prefix, and only while the row still holds the generation and
 * range the caller parsed, and only within the bytes actually received. Anything else returns
 * false so the caller can abort its transaction.
 */
export function acknowledgeRemoteRead(raw: Database, ack: RemoteReadAck): boolean {
  if (!Number.isSafeInteger(ack.consumed) || ack.consumed < 0) return false;
  const result = raw.query(`UPDATE remote_read_state
    SET received_from = received_from + ?, pending = COALESCE(substr(pending, ? + 1), x''), replace_pending = 0
    WHERE env = ? AND path = ? AND generation = ? AND received_from = ?
      AND ? >= 0 AND received_from + ? <= received_to`)
    .run(ack.consumed, ack.consumed, ack.env, ack.path, ack.generation, ack.receivedFrom,
      ack.consumed, ack.consumed);
  return result.changes > 0;
}

export function deleteRemoteReadState(raw: Database, env: string): void {
  raw.query("DELETE FROM remote_read_state WHERE env = ?").run(env);
  raw.query("DELETE FROM meta WHERE key = ?").run(fairnessKey(env));
}

/**
 * Transfer state that still owes this environment work. Counted over the files the indexer will
 * actually consume, so a disabled agent, an out-of-window rollout or a duplicate loser can never
 * hold a healthy environment permanently stale.
 */
export interface RemoteReadStats {
  /** Bytes still to fetch plus bytes fetched but not yet parsed. */
  pendingBytes: number;
  pendingFiles: number;
  /** Active paths parked on a record too large to buffer; they stay failed across skipped pulls. */
  blockedPaths: string[];
}

export function remoteReadStats(
  states: ReadonlyMap<string, RemoteReadState>, active: ReadonlySet<string>,
): RemoteReadStats {
  let pendingBytes = 0;
  let pendingFiles = 0;
  const blockedPaths: string[] = [];
  for (const [path, state] of states) {
    if (!active.has(path)) continue;
    const outstanding = Math.max(0, state.observedSize - state.receivedFrom);
    pendingBytes += outstanding;
    // A zero-byte replacement owes no bytes but still owes an acknowledgement.
    if (outstanding > 0 || state.replacePending) pendingFiles += 1;
    if (state.blocked) blockedPaths.push(path);
  }
  return { pendingBytes, pendingFiles, blockedPaths };
}

/**
 * Drops buffered transfer state for files a completed inventory no longer wants — vanished paths
 * and duplicate losers. Indexed sessions and their transcripts are never touched: only an
 * inventory that actually completed can prove a path is gone, and history outlives the file.
 */
export function pruneRemoteReadState(raw: Database, env: string, keep: ReadonlySet<string>): number {
  const rows = raw.query("SELECT path FROM remote_read_state WHERE env = ?").all(env) as Array<{ path: string }>;
  const stale = rows.map((row) => row.path).filter((path) => !keep.has(path));
  if (stale.length === 0) return 0;
  const remove = raw.query("DELETE FROM remote_read_state WHERE env = ? AND path = ?");
  for (const path of stale) remove.run(env, path);
  return stale.length;
}

function fairnessKey(env: string): string { return `remote_fair_path:${env}`; }

/** Where the previous completed round stopped, so the next one continues instead of restarting. */
export function getRemoteFairnessCursor(raw: Database, env: string): string | null {
  const row = raw.query("SELECT value FROM meta WHERE key = ?").get(fairnessKey(env)) as { value: string } | null;
  return row?.value ?? null;
}

export function setRemoteFairnessCursor(raw: Database, env: string, path: string | null): void {
  if (typeof path !== "string" || !path) return;
  raw.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(fairnessKey(env), path);
}
