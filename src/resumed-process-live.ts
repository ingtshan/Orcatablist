import type { LiveEntry, LiveSource } from "./live-source";
import { toLiveInfo } from "./live-sources";
import type { RuntimeTab } from "./orca-tabs";
import { listResumedProcesses, type ResumedProcess } from "./resumed-processes";
import { isAgent, isSessionId, sessionIdentityKey } from "./session-identity";

export const RESUME_PROCESS_SOURCE = "resume-process";

function needsResumeIdentity(tab: RuntimeTab): boolean {
  if (tab.type !== "terminal" || typeof tab.terminal !== "string" || !tab.terminal) return false;
  if (isSessionId(tab.agentStatus?.providerSession?.id)) return false;
  return tab.agentStatus == null || isAgent(tab.agentStatus.agentType);
}

function matchesTab(process: ResumedProcess, tab: RuntimeTab): boolean {
  if (tab.agentStatus != null && tab.agentStatus.agentType !== process.agent) return false;
  if (process.tabId !== null && process.tabId !== tab.parentTabId) return false;
  if (process.paneKey !== null && process.paneKey !== `${tab.parentTabId}:${tab.leafId}`) return false;
  return true;
}

/** A resumed TUI can be alive long before its first provider-status event reaches Orca. */
export function createResumedProcessSource(options: {
  readTabs(startedAt: number, force: boolean): Promise<RuntimeTab[]>;
  listProcesses?(): Promise<ResumedProcess[]>;
}): LiveSource {
  const listProcesses = options.listProcesses ?? listResumedProcesses;
  return {
    name: RESUME_PROCESS_SOURCE,
    read: async (startedAt, force) => {
      const tabs = (await options.readTabs(startedAt, force)).filter(needsResumeIdentity);
      if (tabs.length === 0) return [];
      const processes = await listProcesses();
      return tabs.flatMap((tab): LiveEntry[] => {
        const attached = processes.filter((process) => process.handle === tab.terminal && matchesTab(process, tab));
        const identities = new Set(attached.map((process) => sessionIdentityKey(process.agent, process.sid)));
        // Node launcher + native child is one identity; nested different sessions are ambiguous.
        if (identities.size !== 1) return [];
        const process = attached[0]!;
        const info = toLiveInfo(tab) ?? {
          pid: null, status: "unknown", updatedAt: null, waitingFor: null,
          name: typeof tab.title === "string" ? tab.title : null,
          handle: process.handle,
          tabId: typeof tab.parentTabId === "string" ? tab.parentTabId : null,
          leafId: typeof tab.leafId === "string" ? tab.leafId : null,
          ...(typeof tab.worktree === "string" ? { worktree: tab.worktree } : {}),
        };
        return [{ key: sessionIdentityKey(process.agent, process.sid), info: { ...info, pid: process.pid } }];
      });
    },
  };
}
