import { ORCATAB_ORCA_BIN } from "./config";
import type { LiveSource } from "./live-source";
import { createOrcaTabSource } from "./live-sources";
import { createOrcaTabReader, type RuntimeTab } from "./orca-tabs";
import type { EnvironmentStore } from "./remote-environments";

export interface RemoteLiveOptions {
  store: EnvironmentStore;
  orcaBin?: string;
  now?(): number;
  callRuntime?(env: string): Promise<unknown>;
}

/**
 * One `orca-tab@<env>` live source per enabled environment, read straight from that machine's
 * runtime — the local runtime only mirrors empty shells for remote worktrees. The factory is
 * re-evaluated on every live refresh so a GUI save takes effect without restarting the reader;
 * per-env source instances are cached so their snapshot TTLs and staleness budgets survive.
 */
export function createRemoteTabLiveSources(options: RemoteLiveOptions): () => LiveSource[] {
  const cached = new Map<string, LiveSource>();
  return () => {
    const enabled = new Set(options.store.listEnabled().map((config) => config.name));
    for (const name of [...cached.keys()]) {
      if (!enabled.has(name)) cached.delete(name);
    }
    for (const env of enabled) {
      if (cached.has(env)) continue;
      const reader = createOrcaTabReader({
        orcaBin: options.orcaBin ?? ORCATAB_ORCA_BIN,
        environment: env,
        ...(options.now ? { now: options.now } : {}),
        ...(options.callRuntime ? { callRuntime: () => options.callRuntime!(env) } : {}),
      });
      const readTabs = (_startedAt: number, force: boolean): Promise<RuntimeTab[]> =>
        reader.refresh(undefined, force);
      cached.set(env, createOrcaTabSource(readTabs, { name: `orca-tab@${env}`, env }));
    }
    return [...cached.values()];
  };
}
