import type { OrcaDatabase } from "./db";
import { createIndexer } from "./indexer";
import { createCoalescingRunner } from "./index-scheduler";
import type { EnvironmentConfig, EnvironmentStore } from "./remote-environments";
import { pullAgents, runPull, type PullAgentsRequest, type PullResult, type RemotePullerOptions } from "./remote-pull";
import type { RemoteReadCursor } from "./remote-read-state";
import type { RemoteReadStats } from "./remote-read-state";
import { createRemoteEnvironmentSources, createRemoteProjectResolver } from "./sources/remote";

export interface EnvironmentHealth {
  name: string;
  enabled: boolean;
  syncing: boolean;
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  /** Informational state worth showing that is not a failure (e.g. no remote session dir yet). */
  note: string | null;
  lastBytes: number;
  lastFiles: number;
  truncated: boolean;
  indexedSessions: number;
  /** Last pull that completed without errors, even if the byte budget cut it short. */
  lastPullAt: number | null;
  /** Last round that actually committed a session. */
  lastCommitAt: number | null;
  /** Bytes still to fetch plus bytes fetched but not yet parsed, over active winning files. */
  pendingBytes: number;
  pendingFiles: number;
  /** Active files with a known read, parse, commit or oversized-record failure. */
  failedFiles: number;
}

export interface RemoteIndexing {
  /** Re-reads the store and starts/stops/restarts per-environment loops to match it. */
  reload(): void;
  /** Schedules an immediate round for one environment (после save/enable/send). */
  kick(name: string): void;
  health(): EnvironmentHealth[];
  close(): void;
}

interface RunnerState {
  running: boolean;
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  note: string | null;
  lastBytes: number;
  lastFiles: number;
  truncated: boolean;
  lastPullAt: number | null;
  lastCommitAt: number | null;
  /** Files this environment could not read, parse or commit on the most recent pass. */
  failedPaths: string[];
}

interface Runner {
  signature: string;
  timer: ReturnType<typeof setInterval>;
  state: RunnerState;
  pending(): RemoteReadStats;
  tick(): void;
  close(): void;
}

export interface RemoteIndexingOptions {
  db: OrcaDatabase;
  store: EnvironmentStore;
  pull?: (
    config: EnvironmentConfig, cursors: Record<string, RemoteReadCursor>, agents: PullAgentsRequest,
    lastPath: string | null,
  ) => Promise<PullResult>;
  pullOptions?: RemotePullerOptions;
  now?: () => number;
  onError?: (env: string, error: unknown) => void;
}

function indexable(config: EnvironmentConfig): boolean {
  const agents = pullAgents(config);
  return config.enabled && (agents.claude || agents.codex !== null);
}

function missingNote(round: PullResult, agents: PullAgentsRequest): string | null {
  const parts: string[] = [];
  if (agents.claude && round.missing.includes("claude")) parts.push("~/.claude/projects");
  if (agents.codex !== null && round.missing.includes("codex")) parts.push("~/.codex/sessions");
  if (parts.length === 0) return null;
  return `远端没有 ${parts.join(" 与 ")}——这台机器可能还没用过对应 CLI；有会话后会自动出现`;
}

export function createRemoteIndexing(options: RemoteIndexingOptions): RemoteIndexing {
  const now = options.now ?? Date.now;
  const pull = options.pull ?? ((
    config: EnvironmentConfig, cursors: Record<string, RemoteReadCursor>, agents: PullAgentsRequest,
    lastPath: string | null,
  ) => runPull(config, cursors, options.pullOptions ?? {}, agents, lastPath));
  const onError = options.onError ?? ((env, error) => console.error(`orcatab remote pull failed for ${env}`, error));
  const runners = new Map<string, Runner>();

  function startRunner(config: EnvironmentConfig): Runner {
    const resolveProject = createRemoteProjectResolver(config.name);
    const agents = pullAgents(config);
    const state: RunnerState = {
      running: false, lastAttemptAt: null, lastOkAt: null, lastError: null, note: null,
      lastBytes: 0, lastFiles: 0, truncated: false, lastPullAt: null, lastCommitAt: null,
      failedPaths: [],
    };
    const environmentSources = createRemoteEnvironmentSources({
      env: config.name,
      db: options.db,
      agents,
      pull: (cursors, roundAgents, lastPath) => pull(config, cursors, roundAgents, lastPath),
    });
    const indexer = createIndexer({
      db: options.db,
      foldProjects: false,
      markIndexedAt: false,
      resolveProject: (cwd) => resolveProject(cwd),
      resolveWorktree: () => null,
      sources: environmentSources.sources,
    });

    let stopped = false;
    async function pass(): Promise<void> {
      if (stopped) return;
      state.running = true;
      state.lastAttemptAt = now();
      try {
        const round = await environmentSources.runRound();
        // A stop during the pull retires this runner; nothing after it may read or write state.
        if (stopped) return;
        state.lastBytes = [...round.chunks.values()].reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
        state.lastFiles = round.files.length + round.codexFiles.length;
        state.truncated = round.truncated;
        state.lastError = round.errors.length > 0 ? round.errors.join("; ") : null;
        state.note = missingNote(round, agents);
        const pulled = round.done && round.errors.length === 0;
        if (pulled) state.lastPullAt = now();
        const summary = await indexer.indexAll();
        if (summary.changed > 0) state.lastCommitAt = now();
        if (summary.errors.length > 0) {
          state.lastError = [state.lastError, ...summary.errors.map((issue) => issue.message)]
            .filter((message): message is string => message !== null).join("; ");
        }
        const owed = environmentSources.stats();
        // A file counts as failed whether the collector could not read it, the parser could not
        // buffer it, or the commit was rejected — all three leave the environment behind.
        const failed = new Set(owed.blockedPaths);
        for (const issue of summary.errors) if (issue.path !== undefined) failed.add(issue.path);
        state.failedPaths = [...failed];
        if (state.lastError === null && owed.blockedPaths.length > 0) {
          // A later pull skips a blocked file entirely, so without this the UI would go green
          // while the record still cannot be read.
          state.lastError = `${owed.blockedPaths.length} 个远端文件的记录超出缓冲上限，已跳过：`
            + owed.blockedPaths.join("、");
        }
        // Green means the machine is actually caught up: a clean pull, clean indexing, the whole
        // budget's worth of eligible bytes delivered, and no file still owing work.
        const settled = pulled && summary.errors.length === 0 && !round.truncated
          && owed.pendingFiles === 0 && failed.size === 0;
        if (settled) state.lastOkAt = now();
      } finally {
        state.running = false;
      }
    }

    const runner = createCoalescingRunner(pass);
    const tick = (): void => {
      void runner.request().then((result) => {
        if (result.status !== "failed") return;
        state.lastError = result.error instanceof Error ? result.error.message : String(result.error);
        onError(config.name, result.error);
      });
    };
    const timer = setInterval(tick, config.pollMs);
    timer.unref?.();
    tick();
    return {
      signature: JSON.stringify(config), timer, state, tick,
      pending: () => environmentSources.stats(),
      close: () => {
        // Fence the source first: a pull already in flight must not reach durable state or health.
        stopped = true;
        environmentSources.close();
        runner.close();
        indexer.close();
        clearInterval(timer);
      },
    };
  }

  function stopRunner(name: string): void {
    const runner = runners.get(name);
    if (runner === undefined) return;
    runner.close();
    runners.delete(name);
  }

  return {
    reload: () => {
      const desired = new Map(options.store.listEnabled().filter(indexable)
        .map((config) => [config.name, config]));
      for (const name of [...runners.keys()]) {
        const config = desired.get(name);
        if (config === undefined || JSON.stringify(config) !== runners.get(name)?.signature) stopRunner(name);
      }
      for (const [name, config] of desired) {
        if (!runners.has(name)) runners.set(name, startRunner(config));
      }
    },
    kick: (name) => { runners.get(name)?.tick(); },
    health: () => options.store.list().map((config): EnvironmentHealth => {
      const runner = runners.get(config.name);
      const owed = runner?.pending() ?? { pendingBytes: 0, pendingFiles: 0, blockedPaths: [] };
      const failed = new Set([...owed.blockedPaths, ...(runner?.state.failedPaths ?? [])]);
      return {
        name: config.name,
        enabled: config.enabled,
        syncing: runner?.state.running ?? false,
        lastAttemptAt: runner?.state.lastAttemptAt ?? null,
        lastOkAt: runner?.state.lastOkAt ?? null,
        lastError: runner?.state.lastError ?? null,
        note: runner?.state.note ?? null,
        lastBytes: runner?.state.lastBytes ?? 0,
        lastFiles: runner?.state.lastFiles ?? 0,
        truncated: runner?.state.truncated ?? false,
        indexedSessions: options.db.countSessionsByEnv(config.name),
        lastPullAt: runner?.state.lastPullAt ?? null,
        lastCommitAt: runner?.state.lastCommitAt ?? null,
        pendingBytes: owed.pendingBytes,
        pendingFiles: owed.pendingFiles,
        failedFiles: failed.size,
      };
    }),
    close: () => {
      for (const name of [...runners.keys()]) stopRunner(name);
    },
  };
}
