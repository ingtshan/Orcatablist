import { lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { HERMES_PROCESS_CACHE_MS } from "./config";
import type { LiveEntry, LiveSource } from "./live-source";
import type { RuntimeTab } from "./orca-tabs";
import { listHermesProcessEnvironments } from "./process-environments";
import { isAgent, isSessionId, sessionIdentityKey, type SessionIdentityKey } from "./session-identity";
import type { Agent, LiveInfo } from "./types";

const ACTIVE_FILE_PATTERN = /^hermes-tui-active-session-[A-Za-z0-9._-]+\.json$/;
const ACTIVE_FILE_MAX_BYTES = 4_096;

export const CLAUDE_PID_SOURCE = "claude-pid";
export const ORCA_TAB_SOURCE = "orca-tab";
export const HERMES_PROCESS_SOURCE = "hermes-process";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numericTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function rawLiveStatus(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function tabHandle(tab: RuntimeTab): string | null {
  return stringValue(tab.terminal) ?? stringValue(tab.agentStatus?.terminalHandle);
}

/** A terminal tab with an agent attached is the only shape that carries a live status. */
export function toLiveInfo(tab: RuntimeTab): LiveInfo | null {
  const status = tab.agentStatus;
  const handle = tabHandle(tab);
  if (tab.type !== "terminal" || status === null || status === undefined || handle === null) return null;
  return {
    pid: null,
    status: rawLiveStatus(status.state),
    updatedAt: numericTimestamp(status.updatedAt),
    waitingFor: status.state === "waiting" ? stringValue(status.toolName) : null,
    name: stringValue(tab.title),
    handle,
    tabId: stringValue(tab.parentTabId),
    leafId: stringValue(tab.leafId),
  };
}

/** Claude's own pid files. Independent of Orca, so it survives an Orca restart. */
export function createClaudePidSource(getClaudeLiveMap: () => Map<string, LiveInfo>): LiveSource {
  return {
    name: CLAUDE_PID_SOURCE,
    read: async () => [...getClaudeLiveMap()].map(
      ([sid, info]): LiveEntry => ({ key: sessionIdentityKey("claude", sid), info }),
    ),
  };
}

function preferredTab(current: RuntimeTab | undefined, candidate: RuntimeTab): RuntimeTab {
  if (current === undefined) return candidate;
  const left = numericTimestamp(current.agentStatus?.updatedAt) ?? 0;
  const right = numericTimestamp(candidate.agentStatus?.updatedAt) ?? 0;
  return right > left ? candidate : current;
}

/** Tabs where Orca already knows the provider session id — the exact, cheap match. */
export function createOrcaTabSource(
  readTabs: (startedAt: number, force: boolean) => Promise<RuntimeTab[]>,
): LiveSource {
  return {
    name: ORCA_TAB_SOURCE,
    read: async (startedAt, force) => {
      const selected = new Map<SessionIdentityKey, RuntimeTab>();
      for (const tab of await readTabs(startedAt, force)) {
        const agent = tab.agentStatus?.agentType;
        const sid = stringValue(tab.agentStatus?.providerSession?.id);
        if (!isAgent(agent) || sid === null || !isSessionId(sid) || toLiveInfo(tab) === null) continue;
        const key = sessionIdentityKey(agent, sid);
        selected.set(key, preferredTab(selected.get(key), tab));
      }
      return [...selected].flatMap(([key, tab]): LiveEntry[] => {
        const info = toLiveInfo(tab);
        return info === null ? [] : [{ key, info }];
      });
    },
  };
}

/** Tabs Orca has an agent for but no session id — Hermes, whose sid lives in a temp file. */
export function hermesFallbackTabs(tabs: RuntimeTab[]): RuntimeTab[] {
  return tabs.filter((tab) => {
    if (tab.agentStatus?.agentType !== "hermes" || toLiveInfo(tab) === null) return false;
    const sid = stringValue(tab.agentStatus?.providerSession?.id);
    return sid === null || !isSessionId(sid);
  });
}

export function tabSignature(tabs: RuntimeTab[]): string {
  return tabs.map((tab) => [
    tabHandle(tab) ?? "", stringValue(tab.parentTabId) ?? "", stringValue(tab.leafId) ?? "",
  ].join(":"))
    .sort()
    .join("|");
}

function readSmallTextFile(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > ACTIVE_FILE_MAX_BYTES) {
    throw new Error(`invalid Hermes active-session file ${path}`);
  }
  return readFileSync(path, "utf8");
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
    return sid !== null && isSessionId(sid) ? sid : null;
  } catch { return null; }
}

export function hermesEntries(
  processText: string,
  tabsByHandle: Map<string, RuntimeTab>,
  readTextFile: (path: string) => string,
): LiveEntry[] {
  const result = new Map<string, LiveEntry>();
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
    if (sid && info) result.set(sid, { key: sessionIdentityKey("hermes", sid), info });
  }
  return [...result.values()];
}

export interface HermesProcessSourceOptions {
  readTabs(startedAt: number, force: boolean): Promise<RuntimeTab[]>;
  listProcessEnvironments?(): Promise<string>;
  readTextFile?(path: string): string;
}

/**
 * Scanning every process is expensive, so it is repeated only when the set of candidate tabs
 * changes or the cache ages out — a Hermes session's sid does not move under a stable tab.
 */
export function createHermesProcessSource(options: HermesProcessSourceOptions): LiveSource {
  const processScan = options.listProcessEnvironments ?? listHermesProcessEnvironments;
  const readTextFile = options.readTextFile ?? readSmallTextFile;
  let processText = "";
  let processTextAt = Number.NEGATIVE_INFINITY;
  let processTabSignature = "";

  return {
    name: HERMES_PROCESS_SOURCE,
    read: async (startedAt, force) => {
      const fallbackTabs = hermesFallbackTabs(await options.readTabs(startedAt, force));
      const tabsByHandle = new Map(fallbackTabs.flatMap((tab) => {
        const handle = tabHandle(tab);
        return handle === null ? [] : [[handle, tab] as const];
      }));
      if (tabsByHandle.size === 0) {
        processTabSignature = "";
        return [];
      }
      const signature = tabSignature(fallbackTabs);
      if (signature !== processTabSignature || startedAt - processTextAt >= HERMES_PROCESS_CACHE_MS) {
        processText = await processScan();
        processTextAt = startedAt;
        processTabSignature = signature;
      }
      return hermesEntries(processText, tabsByHandle, readTextFile);
    },
  };
}

export type { Agent };
