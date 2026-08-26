import { accessSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { HERMES_PROCESS_CACHE_MS, LIVE_CACHE_MS, ORCATAB_ORCA_BIN } from "./config";
import { sessionIdentityKey } from "./goals";
import { getLiveMap as getClaudeLiveMap } from "./live";
import { listHermesProcessEnvironments } from "./process-environments";
import type { Agent, LiveInfo, LiveStatus, SessionRow } from "./types";

const ACTIVE_FILE_PATTERN = /^hermes-tui-active-session-[A-Za-z0-9._-]+\.json$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIVE_FILE_MAX_BYTES = 4_096;
const ORCA_RUNTIME_TIMEOUT_MS = 3_000;
const RUNTIME_CLIENT_RELATIVE_PATH = "app.asar.unpacked/out/cli/runtime-client.js";
const runtimeRequire = createRequire(import.meta.url);

interface RuntimeProviderSession { id?: unknown; }
interface RuntimeAgentStatus {
  agentType?: unknown; state?: unknown; updatedAt?: unknown; toolName?: unknown;
  terminalHandle?: unknown; providerSession?: RuntimeProviderSession | null;
}
interface RuntimeTab {
  type?: unknown; parentTabId?: unknown; leafId?: unknown; terminal?: unknown; title?: unknown;
  agentStatus?: RuntimeAgentStatus | null;
}
interface RuntimeSnapshot { tabs?: unknown; }
interface RuntimeResponse { ok?: unknown; result?: { snapshots?: unknown }; }
interface RuntimeClientLike { call(method: string, params: unknown): Promise<unknown>; }
interface RuntimeClientModule { RuntimeClient: new (userDataPath?: string, timeoutMs?: number) => RuntimeClientLike; }

export interface SessionLiveReaderOptions {
  orcaBin?: string;
  now?(): number;
  getClaudeLiveMap?(): Map<string, LiveInfo>;
  callRuntime?(): Promise<unknown>;
  listProcessEnvironments?(): Promise<string>;
  readTextFile?(path: string): string;
  onError?(error: Error): void;
}

export interface SessionLiveReader {
  refresh(): Promise<Map<string, LiveInfo>>;
  getLiveMap(): Map<string, LiveInfo>;
  getLiveVersion(): number;
  findLive(agent: Agent, sid: string): Promise<LiveInfo | null>;
}

export function mergeSessionLive<T extends SessionRow>(rows: T[], live: Map<string, LiveInfo>): T[] {
  return rows.map((row) => ({ ...row, live: live.get(sessionIdentityKey(row.agent, row.sid)) ?? null }));
}

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

function readSmallTextFile(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > ACTIVE_FILE_MAX_BYTES) {
    throw new Error(`invalid Hermes active-session file ${path}`);
  }
  return readFileSync(path, "utf8");
}

function asAgent(value: unknown): Agent | null {
  return value === "claude" || value === "codex" || value === "hermes" ? value : null;
}

function liveStatus(value: unknown): LiveStatus {
  if (value === "working") return "busy";
  if (value === "waiting") return "waiting";
  if (value === "shell") return "shell";
  return "idle";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function runtimeTabs(value: unknown): RuntimeTab[] {
  const response = value as RuntimeResponse;
  if (response?.ok !== true) throw new Error("Orca runtime rejected session.tabs.listAll");
  const snapshots = response.result?.snapshots;
  if (!Array.isArray(snapshots)) throw new Error("Orca runtime returned no tab snapshots");
  return snapshots.flatMap((snapshot) => {
    const tabs = (snapshot as RuntimeSnapshot)?.tabs;
    return Array.isArray(tabs) ? tabs as RuntimeTab[] : [];
  });
}

function toLiveInfo(tab: RuntimeTab): LiveInfo | null {
  const status = tab.agentStatus;
  const handle = stringValue(tab.terminal) ?? stringValue(status?.terminalHandle);
  if (tab.type !== "terminal" || status === null || status === undefined || handle === null) return null;
  return {
    pid: null,
    status: liveStatus(status.state),
    waitingFor: status.state === "waiting" ? stringValue(status.toolName) : null,
    name: stringValue(tab.title),
    handle,
    tabId: stringValue(tab.parentTabId),
    leafId: stringValue(tab.leafId),
  };
}

function preferredTab(current: RuntimeTab | undefined, candidate: RuntimeTab): RuntimeTab {
  if (current === undefined) return candidate;
  const left = Number(current.agentStatus?.updatedAt ?? 0);
  const right = Number(candidate.agentStatus?.updatedAt ?? 0);
  return right > left ? candidate : current;
}

function providerTabs(tabs: RuntimeTab[]): Map<string, LiveInfo> {
  const selected = new Map<string, RuntimeTab>();
  for (const tab of tabs) {
    const agent = asAgent(tab.agentStatus?.agentType);
    const sid = stringValue(tab.agentStatus?.providerSession?.id);
    if (agent === null || sid === null || !SESSION_ID_PATTERN.test(sid) || toLiveInfo(tab) === null) continue;
    const key = sessionIdentityKey(agent, sid);
    selected.set(key, preferredTab(selected.get(key), tab));
  }
  return new Map([...selected].flatMap(([key, tab]) => {
    const info = toLiveInfo(tab);
    return info === null ? [] : [[key, info] as const];
  }));
}

function hermesFallbackTabs(tabs: RuntimeTab[]): RuntimeTab[] {
  return tabs.filter((tab) => {
    if (asAgent(tab.agentStatus?.agentType) !== "hermes" || toLiveInfo(tab) === null) return false;
    const sid = stringValue(tab.agentStatus?.providerSession?.id);
    return sid === null || !SESSION_ID_PATTERN.test(sid);
  });
}

function tabSignature(tabs: RuntimeTab[]): string {
  return tabs.map((tab) => [
    stringValue(tab.terminal) ?? stringValue(tab.agentStatus?.terminalHandle) ?? "",
    stringValue(tab.parentTabId) ?? "", stringValue(tab.leafId) ?? "",
  ].join(":"))
    .sort()
    .join("|");
}

function environmentValue(line: string, name: string): string | null {
  const match = line.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)(?:\\s|$)`));
  return match?.[1] ?? null;
}

function trustedActiveFile(path: string): boolean {
  const withinTemp = relative(tmpdir(), path);
  return ACTIVE_FILE_PATTERN.test(path.slice(path.lastIndexOf("/") + 1)) &&
    withinTemp !== "" && !withinTemp.startsWith("..") && !isAbsolute(withinTemp);
}

function readHermesSid(path: string, readTextFile: (path: string) => string): string | null {
  if (!trustedActiveFile(path)) return null;
  try {
    const value = JSON.parse(readTextFile(path)) as { session_id?: unknown };
    const sid = stringValue(value.session_id);
    return sid !== null && SESSION_ID_PATTERN.test(sid) ? sid : null;
  } catch { return null; }
}

function hermesTabs(
  processText: string,
  tabsByHandle: Map<string, RuntimeTab>,
  readTextFile: (path: string) => string,
): Map<string, LiveInfo> {
  const result = new Map<string, LiveInfo>();
  const sidByFile = new Map<string, string | null>();
  for (const line of processText.split("\n")) {
    const file = environmentValue(line, "HERMES_TUI_ACTIVE_SESSION_FILE");
    const handle = environmentValue(line, "ORCA_TERMINAL_HANDLE");
    if (file === null || handle === null) continue;
    const tab = tabsByHandle.get(handle);
    if (tab === undefined) continue;
    const expectedTab = stringValue(tab.parentTabId);
    const expectedPane = expectedTab && stringValue(tab.leafId) ? `${expectedTab}:${String(tab.leafId)}` : null;
    const reportedTab = environmentValue(line, "ORCA_TAB_ID");
    const reportedPane = environmentValue(line, "ORCA_PANE_KEY");
    if (reportedTab && expectedTab && reportedTab !== expectedTab) continue;
    if (reportedPane && expectedPane && reportedPane !== expectedPane) continue;
    if (!sidByFile.has(file)) sidByFile.set(file, readHermesSid(file, readTextFile));
    const sid = sidByFile.get(file);
    const info = toLiveInfo(tab);
    if (sid && info) result.set(sessionIdentityKey("hermes", sid), info);
  }
  return result;
}

function liveMapsEqual(left: Map<string, LiveInfo>, right: Map<string, LiveInfo>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (!other || value.pid !== other.pid || value.status !== other.status || value.waitingFor !== other.waitingFor ||
      value.handle !== other.handle || value.tabId !== other.tabId || value.leafId !== other.leafId) return false;
  }
  return true;
}

export function createSessionLiveReader(options: SessionLiveReaderOptions = {}): SessionLiveReader {
  const now = options.now ?? Date.now;
  const claudeLive = options.getClaudeLiveMap ?? getClaudeLiveMap;
  const runtimeCall = options.callRuntime ?? (() => callRuntime(options.orcaBin ?? ORCATAB_ORCA_BIN));
  const processScan = options.listProcessEnvironments ?? listHermesProcessEnvironments;
  const readTextFile = options.readTextFile ?? readSmallTextFile;
  const onError = options.onError ?? ((error) => console.warn(error.message));
  let cached = new Map<string, LiveInfo>();
  let cachedAt = Number.NEGATIVE_INFINITY;
  let version = 0;
  let pending: Promise<Map<string, LiveInfo>> | null = null;
  let lastError = "";
  let processText = "";
  let processTextAt = Number.NEGATIVE_INFINITY;
  let processTabSignature = "";

  async function cachedProcessText(tabs: RuntimeTab[], current: number): Promise<string> {
    const signature = tabSignature(tabs);
    if (signature !== processTabSignature || current - processTextAt >= HERMES_PROCESS_CACHE_MS) {
      processText = await processScan();
      processTextAt = current;
      processTabSignature = signature;
    }
    return processText;
  }

  async function load(startedAt: number): Promise<Map<string, LiveInfo>> {
    const next: Map<string, LiveInfo> = new Map(
      [...claudeLive()].map(([sid, info]) => [sessionIdentityKey("claude", sid), info] as const),
    );
    try {
      const tabs = runtimeTabs(await runtimeCall());
      for (const [key, info] of providerTabs(tabs)) next.set(key, info);
      const fallbackTabs = hermesFallbackTabs(tabs);
      const tabsByHandle = new Map(fallbackTabs.flatMap((tab) => {
        const handle = stringValue(tab.terminal) ?? stringValue(tab.agentStatus?.terminalHandle);
        return handle === null ? [] : [[handle, tab] as const];
      }));
      if (tabsByHandle.size > 0) {
        const environments = await cachedProcessText(fallbackTabs, startedAt);
        for (const [key, info] of hermesTabs(environments, tabsByHandle, readTextFile)) next.set(key, info);
      } else processTabSignature = "";
      lastError = "";
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const error = new Error(`Orca open-tab refresh failed: ${detail}`, { cause });
      if (error.message !== lastError) onError(error);
      lastError = error.message;
    }
    if (!liveMapsEqual(cached, next)) version += 1;
    cached = next;
    cachedAt = startedAt;
    return cached;
  }

  async function refresh(): Promise<Map<string, LiveInfo>> {
    const current = now();
    if (current - cachedAt < LIVE_CACHE_MS) return cached;
    if (pending !== null) return pending;
    pending = load(current).finally(() => { pending = null; });
    return pending;
  }

  return {
    refresh,
    getLiveMap: () => cached,
    getLiveVersion: () => version,
    findLive: async (agent, sid) => (await refresh()).get(sessionIdentityKey(agent, sid)) ?? null,
  };
}
