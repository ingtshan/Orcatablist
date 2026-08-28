import { createCachedSnapshot } from "./cached-snapshot";
import { LIVE_CACHE_MS, ORCATAB_ORCA_BIN, STALE_LIVE_BUDGET_MS } from "./config";
import { getLiveMap as getClaudeLiveMap } from "./live";
import { createClaudePidSource, createHermesProcessSource, createOrcaTabSource } from "./live-sources";
import {
  EMPTY_LIVE_SNAPSHOT, liveSnapshotSignature, mergeLiveSources, readLiveSources,
  type LiveSnapshot, type LiveSource, type RememberedRead,
} from "./live-source";
import { createOrcaTabReader, type RuntimeTab } from "./orca-tabs";
import { sessionIdentityKey } from "./session-identity";
import type { Agent, LiveInfo, SessionRow } from "./types";

export interface SessionLiveReaderOptions {
  orcaBin?: string;
  now?(): number;
  getClaudeLiveMap?(): Map<string, LiveInfo>;
  callRuntime?(): Promise<unknown>;
  listProcessEnvironments?(): Promise<string>;
  readTextFile?(path: string): string;
  onError?(error: Error): void;
  /** Replaces the three built-in sources outright, so tests can drive the merge policy directly. */
  sources?: readonly LiveSource[];
  staleBudgetMs?: number;
}

export interface SessionLiveReader {
  refresh(force?: boolean): Promise<Map<string, LiveInfo>>;
  getLiveMap(): Map<string, LiveInfo>;
  getLiveVersion(): number;
  /** Liveness with per-source health, so callers can tell "nothing running" from "Orca is down". */
  getSnapshot(): LiveSnapshot;
  refreshSnapshot(force?: boolean): Promise<LiveSnapshot>;
  findLive(agent: Agent, sid: string): Promise<LiveInfo | null>;
}

export function mergeSessionLive<T extends SessionRow>(rows: T[], live: Map<string, LiveInfo>): T[] {
  return rows.map((row) => ({ ...row, live: live.get(sessionIdentityKey(row.agent, row.sid)) ?? null }));
}

function defaultSources(options: SessionLiveReaderOptions): LiveSource[] {
  const tabReader = createOrcaTabReader({
    orcaBin: options.orcaBin ?? ORCATAB_ORCA_BIN,
    ...(options.now ? { now: options.now } : {}),
    ...(options.callRuntime ? { callRuntime: options.callRuntime } : {}),
  });
  // Both Orca-derived sources share one tab snapshot, so a refresh costs one runtime call.
  const readTabs = (_startedAt: number, force: boolean): Promise<RuntimeTab[]> => tabReader.refresh(undefined, force);
  return [
    createClaudePidSource(options.getClaudeLiveMap ?? getClaudeLiveMap),
    createOrcaTabSource(readTabs),
    createHermesProcessSource({
      readTabs,
      ...(options.listProcessEnvironments ? { listProcessEnvironments: options.listProcessEnvironments } : {}),
      ...(options.readTextFile ? { readTextFile: options.readTextFile } : {}),
    }),
  ];
}

export function createSessionLiveReader(options: SessionLiveReaderOptions = {}): SessionLiveReader {
  const onError = options.onError ?? ((error: Error) => console.warn(error.message));
  const staleBudgetMs = options.staleBudgetMs ?? STALE_LIVE_BUDGET_MS;
  const sources = options.sources ?? defaultSources(options);
  let remembered = new Map<string, RememberedRead>();
  let reported = new Set<string>();

  const snapshot = createCachedSnapshot<void, LiveSnapshot>({
    ttlMs: LIVE_CACHE_MS,
    ...(options.now ? { now: options.now } : {}),
    signature: liveSnapshotSignature,
    load: async (_input, startedAt, force) => {
      const outcomes = await readLiveSources(sources, startedAt, force);
      const merged = mergeLiveSources(outcomes, remembered, startedAt, staleBudgetMs);
      remembered = merged.remembered;
      // The Orca-derived sources share a tab snapshot, so one dead runtime fails both. Group by
      // cause and report each distinct one once, until it changes or clears.
      const failures = new Map<string, string[]>();
      for (const outcome of outcomes) {
        if (outcome.error === null) continue;
        const affected = failures.get(outcome.error) ?? [];
        affected.push(outcome.name);
        failures.set(outcome.error, affected);
      }
      for (const [error, names] of failures) {
        if (!reported.has(error)) onError(new Error(`live sources ${names.join(", ")} failed: ${error}`));
      }
      reported = new Set(failures.keys());
      return merged.snapshot;
    },
  });

  const current = (): LiveSnapshot => snapshot.peek() ?? EMPTY_LIVE_SNAPSHOT;
  const refreshSnapshot = (force = false): Promise<LiveSnapshot> => snapshot.refresh(undefined, force);
  return {
    refresh: async (force = false) => (await refreshSnapshot(force)).live,
    refreshSnapshot,
    getLiveMap: () => current().live,
    getSnapshot: current,
    getLiveVersion: snapshot.getVersion,
    findLive: async (agent, sid) => (await refreshSnapshot()).live.get(sessionIdentityKey(agent, sid)) ?? null,
  };
}
