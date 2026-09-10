import { AGENTS } from "./config";
import {
  errorText, OrcaError, resolveTerminalTarget, ValidationError, type OrcaJsonResult,
} from "./focus";
import { isSessionId, LOCAL_ENV, sessionIdentityKey } from "./session-identity";
import type { Agent, LiveInfo, LiveStatus } from "./types";

/**
 * Only a session Orca reports as finished may receive typed input. `waiting` is deliberately
 * excluded: it means a tool-permission prompt is on screen, where free text answers a dialog.
 */
export const SENDABLE_STATUSES: ReadonlySet<LiveStatus> = new Set(["done"]);
export const MAX_INPUT_CHARS = 4_000;
export const CONFIRMATION_TIMEOUT_MS = 20_000;
/** Remote evidence lands on the environment's next pull round, not on the next fs event. */
export const REMOTE_CONFIRMATION_TIMEOUT_MS = 60_000;
export const CONFIRMATION_POLL_MS = 1_000;
export const CONFIRMATION_FEEDBACK_TTL_MS = 15_000;
const MAX_TRACKED_SENDS = 200;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type SendConflictCode =
  | "offline" | "not-waiting" | "status-changed" | "handle-changed" | "running-outside-orca" | "send-pending";
export type ConfirmationState = "pending" | "stalled";

export class SendConflictError extends Error {
  override name = "SendConflictError";
  constructor(readonly code: SendConflictCode, message: string) { super(message); }
}

export interface SentInput {
  agent: Agent;
  /** Remote environment the terminal lives in; absent means this machine. */
  env?: string;
  sid: string;
  text: string;
  handle: string;
  sentAt: number;
  previousInputCount?: number;
}

export interface SentInputRecord extends SentInput { state: ConfirmationState; }
export interface ConfirmedSentInput extends SentInput {
  confirmedAt: number;
  confirmedInputAt: number | null;
}
export interface SentUserInputEvidence { text: string; ts: number | null; inputCount?: number; }

export interface SentInputStore {
  record(entry: SentInput): void;
  get(agent: Agent, sid: string, env?: string): SentInput | null;
  list(): SentInput[];
  remove(agent: Agent, sid: string, env?: string): void;
}

export interface SentInputConfirmationQueue {
  hasPending(): boolean;
  reconcile(): Promise<Record<string, SentInputRecord>>;
  records(): Record<string, SentInputRecord>;
  takeConfirmed(): ConfirmedSentInput[];
}

export interface SentInputConfirmationQueueDeps {
  store: SentInputStore;
  getLatestUserInputs(entries: readonly SentInput[]): Map<string, readonly SentUserInputEvidence[]>;
  now?(): number;
}

export interface SessionSendDeps {
  findLive(agent: Agent, sid: string, env?: string): LiveInfo | null | Promise<LiveInfo | null>;
  psEnv(pid: number): Promise<string>;
  orcaJson(args: string[]): Promise<OrcaJsonResult>;
  store: SentInputStore;
  now?(): number;
  onSent?(entry: SentInput): void;
  beforeSend?(): void;
  getInputCount?(agent: Agent, sid: string, env?: string): number;
}

export interface SendExpectation { handle?: string; status?: string }

export function createSentInputStore(capacity = MAX_TRACKED_SENDS): SentInputStore {
  const entries = new Map<string, SentInput>();
  return {
    record: (entry) => {
      const key = sessionIdentityKey(entry.agent, entry.sid, entry.env);
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    get: (agent, sid, env) => entries.get(sessionIdentityKey(agent, sid, env)) ?? null,
    list: () => [...entries.values()],
    remove: (agent, sid, env) => { entries.delete(sessionIdentityKey(agent, sid, env)); },
  };
}

/**
 * One line, no control characters: `orca terminal send --enter` types the payload into a TUI, so a
 * newline would submit early and an escape sequence would drive the terminal instead of the agent.
 */
export function normalizeInputText(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("text is required");
  const text = value.trim();
  if (!text) throw new ValidationError("text is required");
  if (text.length > MAX_INPUT_CHARS) throw new ValidationError(`text must be at most ${MAX_INPUT_CHARS} characters`);
  if (/[\n\r]/.test(text)) throw new ValidationError("text must be a single line");
  if (CONTROL_CHARACTERS.test(text)) throw new ValidationError("text must not contain control characters");
  return text;
}

export function confirmationState(entry: SentInput, now: number): ConfirmationState {
  const timeout = entry.env === undefined ? CONFIRMATION_TIMEOUT_MS : REMOTE_CONFIRMATION_TIMEOUT_MS;
  if (now - entry.sentAt >= timeout) return "stalled";
  return "pending";
}

export function sentInputRecords(
  store: SentInputStore,
  now: number,
): Record<string, SentInputRecord> {
  return Object.fromEntries(store.list().map((entry) => {
    const key = sessionIdentityKey(entry.agent, entry.sid, entry.env);
    return [key, { ...entry, state: confirmationState(entry, now) }];
  }));
}

function isPending(entry: SentInput, now: number): boolean {
  return confirmationState(entry, now) === "pending";
}

function removeCurrent(store: SentInputStore, entry: SentInput): boolean {
  const current = store.get(entry.agent, entry.sid, entry.env);
  if (current?.sentAt !== entry.sentAt) return false;
  store.remove(entry.agent, entry.sid, entry.env);
  return true;
}

export function createSentInputConfirmationQueue(
  deps: SentInputConfirmationQueueDeps,
): SentInputConfirmationQueue {
  const now = deps.now ?? Date.now;
  let active: Promise<Record<string, SentInputRecord>> | null = null;
  const confirmed = new Map<string, ConfirmedSentInput>();

  const records = () => sentInputRecords(deps.store, now());
  const hasPending = () => deps.store.list().some((entry) => isPending(entry, now()));

  async function run(): Promise<Record<string, SentInputRecord>> {
    const checkedAt = now();
    const queued = deps.store.list();
    if (queued.length === 0) return sentInputRecords(deps.store, checkedAt);
    const inputs = deps.getLatestUserInputs(queued);
    for (const entry of queued) {
      const key = sessionIdentityKey(entry.agent, entry.sid, entry.env);
      const latest = inputs.get(key)?.[0];
      if (latest?.text !== entry.text) continue;
      if (entry.previousInputCount !== undefined && (latest.inputCount ?? 0) <= entry.previousInputCount) continue;
      if (!removeCurrent(deps.store, entry)) continue;
      confirmed.set(key, { ...entry, confirmedAt: checkedAt, confirmedInputAt: latest.ts });
    }
    return sentInputRecords(deps.store, checkedAt);
  }

  return {
    hasPending,
    records,
    takeConfirmed: () => {
      const cutoff = now() - CONFIRMATION_FEEDBACK_TTL_MS;
      const entries = [...confirmed.values()].filter((entry) => entry.confirmedAt >= cutoff);
      confirmed.clear();
      return entries;
    },
    reconcile: () => {
      if (active !== null) return active;
      active = run().finally(() => { active = null; });
      return active;
    },
  };
}

const ACTIVE_SENDS = new WeakMap<SentInputStore, Set<string>>();

export async function sendSessionInput(
  agent: Agent, sid: string, text: unknown, deps: SessionSendDeps, expected: SendExpectation = {}, env?: string,
): Promise<SentInputRecord> {
  const active = ACTIVE_SENDS.get(deps.store) ?? new Set<string>();
  ACTIVE_SENDS.set(deps.store, active);
  const key = sessionIdentityKey(agent, sid, env);
  if (active.has(key) || deps.store.get(agent, sid, env)) {
    throw new SendConflictError("send-pending", "previous input is still being sent or awaiting confirmation");
  }
  active.add(key);
  try { return await sendSessionInputOnce(agent, sid, text, deps, expected, env); }
  finally { active.delete(key); }
}

async function sendSessionInputOnce(
  agent: Agent,
  sid: string,
  text: unknown,
  deps: SessionSendDeps,
  expected: SendExpectation = {},
  env?: string,
): Promise<SentInputRecord> {
  if (!AGENTS.some((candidate) => candidate === agent)) throw new ValidationError("invalid agent");
  if (!isSessionId(sid)) throw new ValidationError("invalid session id");
  const payload = normalizeInputText(text);
  const scope = env !== undefined && env !== LOCAL_ENV ? env : undefined;
  const envArgs = scope === undefined ? [] : ["--environment", scope];
  const live = await deps.findLive(agent, sid, scope);
  if (live === null) throw new SendConflictError("offline", "session is no longer live in Orca");
  if (!SENDABLE_STATUSES.has(live.status) || live.waitingFor) {
    throw new SendConflictError("not-waiting", `session is ${live.status}, not waiting for input`);
  }
  if (expected.status !== undefined && expected.status !== live.status) {
    throw new SendConflictError("status-changed", `session moved to ${live.status} since the card was rendered`);
  }
  const target = await resolveTerminalTarget(live, deps);
  if (target.handle === null) {
    throw new SendConflictError("running-outside-orca", "session runs outside an Orca terminal");
  }
  if (expected.handle !== undefined && expected.handle !== target.handle) {
    throw new SendConflictError("handle-changed", "session moved to another Orca terminal");
  }
  deps.beforeSend?.();
  const previousInputCount = deps.getInputCount?.(agent, sid, scope);
  const sent = await deps.orcaJson([
    "terminal", "send", "--terminal", target.handle, "--text", payload, "--enter", ...envArgs, "--json",
  ]);
  if (!sent.ok) throw new OrcaError(`orca terminal send failed: ${errorText(sent.error)}`);
  const sentAt = (deps.now ?? Date.now)();
  const entry: SentInput = {
    agent, ...(scope === undefined ? {} : { env: scope }), sid, text: payload, handle: target.handle, sentAt,
    ...(previousInputCount === undefined ? {} : { previousInputCount }),
  };
  deps.store.record(entry);
  deps.onSent?.(entry);
  return { ...entry, state: "pending" };
}
