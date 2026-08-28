import type { SessionIdentityKey } from "./session-identity";
import type { LiveInfo } from "./types";

/**
 * Liveness reaches the board from three places that fail independently: Claude's pid files, the
 * Orca runtime's tab snapshot, and a `ps` scan correlating Hermes TUIs to terminals. Fusing them
 * into one try/catch made a dead source and a genuinely quiet machine produce the same empty map,
 * so the board emptied itself and still claimed to be current.
 *
 * A source reports entries or throws. Whether a throw hides the board, shows a stale one, or is
 * merely annotated is the merge policy's call — one place, below — not each source's.
 */
export interface LiveEntry { key: SessionIdentityKey; info: LiveInfo; }

export interface LiveSource {
  readonly name: string;
  /** `force` tells a source that caches to skip its own TTL; sources without one ignore it. */
  read(startedAt: number, force: boolean): Promise<LiveEntry[]>;
}

export interface LiveSourceHealth {
  name: string;
  /** False when the most recent read threw. */
  ok: boolean;
  /** When the entries currently attributed to this source were read. Null if it never succeeded. */
  readAt: number | null;
  /** The read failed, but its last good entries are still inside the staleness budget. */
  stale: boolean;
  sessions: number;
  error: string | null;
}

export interface LiveSnapshot {
  at: number;
  live: Map<string, LiveInfo>;
  sources: LiveSourceHealth[];
}

export interface RememberedRead { entries: LiveEntry[]; readAt: number; }
export interface LiveSourceOutcome { name: string; entries: LiveEntry[] | null; error: string | null; }

export const EMPTY_LIVE_SNAPSHOT: LiveSnapshot = { at: 0, live: new Map(), sources: [] };

/**
 * Applies outcomes in order, so a later source wins a key a earlier one also claimed — today the
 * Orca tab snapshot refines what the pid files guessed.
 *
 * A source that just failed keeps serving its last good entries until the budget expires, marked
 * `stale`, because an Orca restart is measured in seconds and blanking the board for it is worse
 * than briefly showing a session whose tab has since closed.
 */
export function mergeLiveSources(
  outcomes: LiveSourceOutcome[],
  remembered: Map<string, RememberedRead>,
  at: number,
  staleBudgetMs: number,
): { snapshot: LiveSnapshot; remembered: Map<string, RememberedRead> } {
  const next = new Map(remembered);
  const live = new Map<string, LiveInfo>();
  const sources = outcomes.map((outcome): LiveSourceHealth => {
    if (outcome.entries !== null) {
      next.set(outcome.name, { entries: outcome.entries, readAt: at });
      for (const entry of outcome.entries) live.set(entry.key, entry.info);
      return {
        name: outcome.name, ok: true, readAt: at, stale: false,
        sessions: outcome.entries.length, error: null,
      };
    }
    const previous = remembered.get(outcome.name);
    const usable = previous !== undefined && at - previous.readAt < staleBudgetMs;
    if (!usable) next.delete(outcome.name);
    if (usable) for (const entry of previous.entries) live.set(entry.key, entry.info);
    return {
      name: outcome.name, ok: false, readAt: usable ? previous.readAt : null, stale: usable,
      sessions: usable ? previous.entries.length : 0, error: outcome.error,
    };
  });
  return { snapshot: { at, live, sources }, remembered: next };
}

/**
 * What an ETag may depend on. Excludes `at` and `readAt`, which move on every successful read and
 * would defeat the 304, but includes each source's health, because "Orca is down" is a change the
 * board must re-render for.
 */
export function liveSnapshotSignature(snapshot: LiveSnapshot): string {
  const live = [...snapshot.live].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, info]) => [
      key, info.pid, info.status, info.updatedAt, info.waitingFor, info.name,
      info.handle, info.tabId, info.leafId,
    ]);
  const sources = snapshot.sources.map(({ name, ok, stale, sessions }) => [name, ok, stale, sessions]);
  return JSON.stringify({ live, sources });
}

/** Runs every source, converting a throw into an outcome the merge policy can weigh. */
export async function readLiveSources(
  sources: readonly LiveSource[],
  startedAt: number,
  force = false,
): Promise<LiveSourceOutcome[]> {
  return Promise.all(sources.map(async (source): Promise<LiveSourceOutcome> => {
    try {
      return { name: source.name, entries: await source.read(startedAt, force), error: null };
    } catch (cause) {
      return {
        name: source.name, entries: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }));
}
