import { accessSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createCachedSnapshot, type CachedSnapshot } from "./cached-snapshot";
import { LIVE_CACHE_MS, ORCATAB_ORCA_BIN } from "./config";

/**
 * The Orca runtime's tab snapshot. Two live sources read it — provider-matched tabs and the Hermes
 * correlation — so it is fetched once and shared rather than pulled twice per refresh.
 */

const ORCA_RUNTIME_TIMEOUT_MS = 3_000;
const RUNTIME_CLIENT_RELATIVE_PATH = "app.asar.unpacked/out/cli/runtime-client.js";
const runtimeRequire = createRequire(import.meta.url);

interface RuntimeProviderSession { id?: unknown; }
export interface RuntimeAgentStatus {
  agentType?: unknown; state?: unknown; updatedAt?: unknown; toolName?: unknown;
  terminalHandle?: unknown; providerSession?: RuntimeProviderSession | null;
}
export interface RuntimeTab {
  type?: unknown; parentTabId?: unknown; leafId?: unknown; terminal?: unknown; title?: unknown;
  agentStatus?: RuntimeAgentStatus | null;
}
interface RuntimeSnapshot { tabs?: unknown; }
interface RuntimeResponse { ok?: unknown; result?: { snapshots?: unknown }; }
interface RuntimeClientLike { call(method: string, params: unknown): Promise<unknown>; }
interface RuntimeClientModule {
  RuntimeClient: new (userDataPath?: string, timeoutMs?: number) => RuntimeClientLike;
}

export interface OrcaTabReaderOptions {
  orcaBin?: string;
  now?(): number;
  callRuntime?(): Promise<unknown>;
}

export type OrcaTabReader = CachedSnapshot<void, RuntimeTab[]>;

function executablePath(command: string): string | null {
  const candidates = isAbsolute(command) || command.includes("/")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate);
      return realpathSync(candidate);
    } catch { continue; }
  }
  return null;
}

export function resolveRuntimeClientPath(orcaBin = ORCATAB_ORCA_BIN): string | null {
  const executable = executablePath(orcaBin);
  if (executable === null) return null;
  const candidate = join(dirname(dirname(executable)), RUNTIME_CLIENT_RELATIVE_PATH);
  try {
    accessSync(candidate);
    return candidate;
  } catch { return null; }
}

async function callRuntime(orcaBin: string): Promise<unknown> {
  const path = resolveRuntimeClientPath(orcaBin);
  if (path === null) throw new Error(`Orca runtime client not found for ${orcaBin}`);
  const module = runtimeRequire(path) as RuntimeClientModule;
  if (typeof module.RuntimeClient !== "function") throw new Error(`invalid Orca runtime client module ${path}`);
  return new module.RuntimeClient(undefined, ORCA_RUNTIME_TIMEOUT_MS).call("session.tabs.listAll", {});
}

export function runtimeTabs(value: unknown): RuntimeTab[] {
  const response = value as RuntimeResponse;
  if (response?.ok !== true) throw new Error("Orca runtime rejected session.tabs.listAll");
  const snapshots = response.result?.snapshots;
  if (!Array.isArray(snapshots)) throw new Error("Orca runtime returned no tab snapshots");
  return snapshots.flatMap((snapshot) => {
    const tabs = (snapshot as RuntimeSnapshot)?.tabs;
    return Array.isArray(tabs) ? tabs as RuntimeTab[] : [];
  });
}

export function createOrcaTabReader(options: OrcaTabReaderOptions = {}): OrcaTabReader {
  const call = options.callRuntime ?? (() => callRuntime(options.orcaBin ?? ORCATAB_ORCA_BIN));
  return createCachedSnapshot<void, RuntimeTab[]>({
    ttlMs: LIVE_CACHE_MS, now: options.now,
    load: async () => runtimeTabs(await call()),
  });
}
