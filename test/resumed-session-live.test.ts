import { describe, expect, test } from "bun:test";
import { resolveFocus } from "../src/focus";
import type { RuntimeTab } from "../src/orca-tabs";
import { createSessionLiveReader } from "../src/session-live";

const SID = "11111111-1111-4111-8111-111111111111";
const OTHER_SID = "22222222-2222-4222-8222-222222222222";
const TAB: RuntimeTab = {
  type: "terminal", terminal: "term_resumed", parentTabId: "tab_resumed", leafId: "leaf_resumed",
  title: "codex resume", worktree: "repo::/fixture/worktree",
};
const PROCESS = {
  pid: 123, agent: "codex" as const, sid: SID, handle: "term_resumed",
  tabId: "tab_resumed", paneKey: "tab_resumed:leaf_resumed",
};

function fixture() {
  let tabs: RuntimeTab[] = [];
  let processes = [PROCESS];
  let now = 0;
  let scans = 0;
  const errors: Error[] = [];
  const options = {
    now: () => now,
    getClaudeLiveMap: () => new Map(),
    callRuntime: async () => ({ ok: true, result: { snapshots: [{ tabs }] } }),
    listProcessEnvironments: async () => "",
    listResumedProcesses: async () => { scans += 1; return processes; },
    onError: (error: Error) => { errors.push(error); },
  };
  return {
    reader: createSessionLiveReader(options), errors, scans: () => scans,
    setTabs: (value: RuntimeTab[]) => { tabs = value; },
    setProcesses: (value: typeof processes) => { processes = value; },
    tick: () => { now += 5_000; },
  };
}

describe("resumed sessions before Orca provider status arrives", () => {
  test("an existing resume process becomes live on the next poll, and a second focus switches its tab", async () => {
    const app = fixture();
    expect((await app.reader.refresh()).has(`codex/${SID}`)).toBeFalse();
    const offlineVersion = app.reader.getLiveVersion();
    app.setTabs([TAB]);
    app.tick();

    const live = await app.reader.refresh();
    expect(live.get(`codex/${SID}`)).toMatchObject({
      pid: 123, status: "unknown", handle: "term_resumed", tabId: "tab_resumed",
      leafId: "leaf_resumed", worktree: "repo::/fixture/worktree",
    });
    expect(app.reader.getLiveVersion()).toBeGreaterThan(offlineVersion);
    expect(await app.reader.findLive("codex", SID, "remote")).toBeNull();

    const calls: string[][] = [];
    const focused = await resolveFocus("codex", SID, {
      findLive: app.reader.findLive,
      getSessionCwd: () => "/fixture/worktree",
      psEnv: async () => { throw new Error("the handle is already attached"); },
      openOrca: async () => {},
      orcaJson: async (args) => { calls.push(args); return { ok: true }; },
    });
    expect(focused).toEqual({ action: "switched", handle: "term_resumed", tabId: "tab_resumed" });
    expect(calls).toEqual([["terminal", "switch", "--terminal", "term_resumed", "--json"]]);
  });

  test("process exit removes live state even if the terminal tab is still open", async () => {
    const app = fixture();
    app.setTabs([TAB]);
    expect((await app.reader.refresh()).has(`codex/${SID}`)).toBeTrue();
    const runningVersion = app.reader.getLiveVersion();
    app.setProcesses([]);
    app.tick();
    expect((await app.reader.refresh()).has(`codex/${SID}`)).toBeFalse();
    expect(app.reader.getLiveVersion()).toBeGreaterThan(runningVersion);
  });

  test("runtime status takes over without retaining the process fallback", async () => {
    const app = fixture();
    app.setTabs([TAB]);
    expect((await app.reader.refresh()).get(`codex/${SID}`)?.status).toBe("unknown");
    app.setTabs([{ ...TAB, agentStatus: {
      agentType: "codex", state: "working", updatedAt: 42, providerSession: { id: SID },
    } }]);
    app.tick();
    expect((await app.reader.refresh()).get(`codex/${SID}`)).toMatchObject({ status: "working", updatedAt: 42 });
    expect(app.scans()).toBe(1);
  });

  test("rejects mismatched tab or pane and conflicting provider identities", async () => {
    const app = fixture();
    for (const tab of [
      { ...TAB, terminal: "term_other" },
      { ...TAB, parentTabId: "tab_other" },
      { ...TAB, leafId: "leaf_other" },
      { ...TAB, agentStatus: { agentType: "claude", state: "working" } },
      { ...TAB, agentStatus: { agentType: "codex", state: "working", providerSession: { id: OTHER_SID } } },
    ]) {
      app.setTabs([tab]);
      app.tick();
      expect((await app.reader.refresh()).has(`codex/${SID}`)).toBeFalse();
    }
    expect(app.errors).toEqual([]);
  });

  test("does not guess between two session identities attached to the same terminal", async () => {
    const app = fixture();
    app.setTabs([TAB]);
    app.setProcesses([PROCESS, { ...PROCESS, pid: 456, sid: OTHER_SID }]);
    expect((await app.reader.refresh()).size).toBe(0);
  });
});
