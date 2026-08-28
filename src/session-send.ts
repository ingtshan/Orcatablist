import { AGENTS } from "./config";
import {
  errorText, OrcaError, resolveTerminalTarget, ValidationError, type OrcaJsonResult,
} from "./focus";
import { isSessionId, sessionIdentityKey } from "./session-identity";
import type { Agent, LiveInfo, LiveStatus } from "./types";

/**
 * Only a session Orca reports as finished may receive typed input. `waiting` is deliberately
 * excluded: it means a tool-permission prompt is on screen, where free text answers a dialog.
 */
export const SENDABLE_STATUSES: ReadonlySet<LiveStatus> = new Set(["done"]);
export const MAX_INPUT_CHARS = 4_000;
export const CONFIRMATION_INPUT_TOLERANCE_MS = 5_000;
export const CONFIRMATION_TIMEOUT_MS = 20_000;
export const CONFIRMATION_POLL_MS = 1_000;
const MAX_TRACKED_SENDS = 200;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type SendConflictCode =
  | "offline" | "not-waiting" | "status-changed" | "handle-changed" | "running-outside-orca";
export type ConfirmationState = "pending" | "verifying" | "confirmed" | "stalled";

export class SendConflictError extends Error {
  override name = "SendConflictError";
  constructor(readonly code: SendConflictCode, message: string) { super(message); }
}

export interface SentInput {
  agent: Agent;
  sid: string;
  text: string;
  handle: string;
  sentAt: number;
  workingObservedAt: number | null;
  confirmedAt: number | null;
  confirmedInputAt: number | null;
}

export interface SentInputRecord extends SentInput { state: ConfirmationState; }
export interface SentUserInputEvidence { text: string; ts: number | null; }

export interface SentInputStore {
  record(entry: SentInput): void;
  update(entry: SentInput): void;
  get(agent: Agent, sid: string): SentInput | null;
  list(): SentInput[];
  remove(agent: Agent, sid: string): void;
}

export interface SentInputConfirmationQueue {
  hasPending(): boolean;
  reconcile(options?: { forceLive?: boolean }): Promise<Record<string, SentInputRecord>>;
  records(): Record<string, SentInputRecord>;
}

export interface SentInputConfirmationQueueDeps {
  store: SentInputStore;
  refreshLive(force: boolean): Promise<Map<string, LiveInfo>>;
  getUserInputs(entries: readonly SentInput[]): Map<string, readonly SentUserInputEvidence[]>;
  now?(): number;
}

export interface SessionSendDeps {
  findLive(agent: Agent, sid: string): LiveInfo | null | Promise<LiveInfo | null>;
  psEnv(pid: number): Promise<string>;
  orcaJson(args: string[]): Promise<OrcaJsonResult>;
  store: SentInputStore;
  now?(): number;
  onSent?(entry: SentInput): void;
}

export interface SendExpectation { handle?: string; status?: string }

export function createSentInputStore(capacity = MAX_TRACKED_SENDS): SentInputStore {
  const entries = new Map<string, SentInput>();
  return {
    record: (entry) => {
      const key = sessionIdentityKey(entry.agent, entry.sid);
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    update: (entry) => {
      const key = sessionIdentityKey(entry.agent, entry.sid);
      if (entries.has(key)) entries.set(key, entry);
    },
    get: (agent, sid) => entries.get(sessionIdentityKey(agent, sid)) ?? null,
    list: () => [...entries.values()],
    remove: (agent, sid) => { entries.delete(sessionIdentityKey(agent, sid)); },
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
  if (entry.confirmedAt !== null) return "confirmed";
  if (now - entry.sentAt >= CONFIRMATION_TIMEOUT_MS) return "stalled";
  return entry.workingObservedAt === null ? "pending" : "verifying";
}

export function sentInputRecords(
  store: SentInputStore,
  now: number,
): Record<string, SentInputRecord> {
  return Object.fromEntries(store.list().map((entry) => {
    const key = sessionIdentityKey(entry.agent, entry.sid);
    return [key, { ...entry, state: confirmationState(entry, now) }];
  }));
}

function workingEventAt(entry: SentInput, live: LiveInfo | undefined, now: number): number | null {
  if (entry.workingObservedAt !== null) return entry.workingObservedAt;
  if (live?.status !== "working") return null;
  const updatedAt = typeof live.updatedAt === "number" ? live.updatedAt : null;
  if (updatedAt !== null && updatedAt < entry.sentAt - CONFIRMATION_INPUT_TOLERANCE_MS) return null;
  return updatedAt ?? now;
}

function matchingEvidence(
  entry: SentInput,
  inputs: readonly SentUserInputEvidence[],
): SentUserInputEvidence | null {
  return inputs.find((input) => input.ts !== null && input.text === entry.text
    && Math.abs(input.ts - entry.sentAt) <= CONFIRMATION_INPUT_TOLERANCE_MS) ?? null;
}

function isPending(entry: SentInput, now: number): boolean {
  const state = confirmationState(entry, now);
  return state === "pending" || state === "verifying";
}

function updateCurrent(store: SentInputStore, previous: SentInput, next: SentInput): SentInput {
  const current = store.get(previous.agent, previous.sid);
  if (current?.sentAt !== previous.sentAt) return current ?? previous;
  store.update(next);
  return next;
}

export function createSentInputConfirmationQueue(
  deps: SentInputConfirmationQueueDeps,
): SentInputConfirmationQueue {
  const now = deps.now ?? Date.now;
  let active: Promise<Record<string, SentInputRecord>> | null = null;

  const records = () => sentInputRecords(deps.store, now());
  const hasPending = () => deps.store.list().some((entry) => isPending(entry, now()));

  async function run(forceLive: boolean): Promise<Record<string, SentInputRecord>> {
    const checkedAt = now();
    const queued = deps.store.list().filter((entry) => isPending(entry, checkedAt));
    if (queued.length === 0) return sentInputRecords(deps.store, checkedAt);
    const live = await deps.refreshLive(forceLive);
    const observed = queued.map((entry) => {
      const workingObservedAt = workingEventAt(entry, live.get(sessionIdentityKey(entry.agent, entry.sid)), checkedAt);
      if (workingObservedAt === entry.workingObservedAt) return entry;
      return updateCurrent(deps.store, entry, { ...entry, workingObservedAt });
    });
    const candidates = observed.filter((entry) => entry.workingObservedAt !== null && entry.confirmedAt === null);
    const inputs = candidates.length === 0 ? new Map<string, readonly SentUserInputEvidence[]>()
      : deps.getUserInputs(candidates);
    for (const entry of candidates) {
      const key = sessionIdentityKey(entry.agent, entry.sid);
      const evidence = matchingEvidence(entry, inputs.get(key) ?? []);
      if (evidence === null) continue;
      updateCurrent(deps.store, entry, {
        ...entry, confirmedAt: checkedAt, confirmedInputAt: evidence.ts,
      });
    }
    return sentInputRecords(deps.store, checkedAt);
  }

  return {
    hasPending,
    records,
    reconcile: (options = {}) => {
      if (active !== null) return active;
      active = run(options.forceLive === true).finally(() => { active = null; });
      return active;
    },
  };
}

export async function sendSessionInput(
  agent: Agent,
  sid: string,
  text: unknown,
  deps: SessionSendDeps,
  expected: SendExpectation = {},
): Promise<SentInputRecord> {
  if (!AGENTS.some((candidate) => candidate === agent)) throw new ValidationError("invalid agent");
  if (!isSessionId(sid)) throw new ValidationError("invalid session id");
  const payload = normalizeInputText(text);
  const live = await deps.findLive(agent, sid);
  if (live === null) throw new SendConflictError("offline", "session is no longer live in Orca");
  if (!SENDABLE_STATUSES.has(live.status)) {
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
  const sent = await deps.orcaJson([
    "terminal", "send", "--terminal", target.handle, "--text", payload, "--enter", "--json",
  ]);
  if (!sent.ok) throw new OrcaError(`orca terminal send failed: ${errorText(sent.error)}`);
  const sentAt = (deps.now ?? Date.now)();
  const entry: SentInput = {
    agent, sid, text: payload, handle: target.handle, sentAt,
    workingObservedAt: null, confirmedAt: null, confirmedInputAt: null,
  };
  deps.store.record(entry);
  deps.onSent?.(entry);
  return { ...entry, state: "pending" };
}
