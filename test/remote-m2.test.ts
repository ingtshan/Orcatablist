import { describe, expect, test } from "bun:test";
import { OrcaDatabase } from "../src/db";
import { resolveFocus, type FocusDeps, type OrcaJsonResult } from "../src/focus";
import { createOrcaTabSource } from "../src/live-sources";
import { findLatestSentInputEvidence } from "../src/session-send-evidence";
import {
  confirmationState, createSentInputStore, sendSessionInput, REMOTE_CONFIRMATION_TIMEOUT_MS,
} from "../src/session-send";
import { mergeSessionLive } from "../src/session-live";
import type { LiveInfo, SessionRow } from "../src/types";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";

function remoteLive(status = "done"): LiveInfo {
  return {
    pid: null, status, updatedAt: 1, waitingFor: null, name: "远程会话",
    handle: "term_remote", tabId: "tab1", leafId: "leaf1", env: "feibo2",
  };
}

describe("remote send routing", () => {
  test("sends through --environment and records the entry under its environment", async () => {
    const calls: string[][] = [];
    const store = createSentInputStore();
    const record = await sendSessionInput("codex", SID, "远程输入", {
      findLive: (_agent, _sid, env) => (env === "feibo2" ? remoteLive() : null),
      psEnv: () => Promise.resolve(""),
      orcaJson: (args): Promise<OrcaJsonResult> => { calls.push(args); return Promise.resolve({ ok: true }); },
      store,
      now: () => 1000,
    }, {}, "feibo2");
    expect(calls[0]).toEqual([
      "terminal", "send", "--terminal", "term_remote", "--text", "远程输入", "--enter",
      "--environment", "feibo2", "--json",
    ]);
    expect(record).toMatchObject({ env: "feibo2", state: "pending" });
    expect(store.get("codex", SID, "feibo2")).toMatchObject({ env: "feibo2", handle: "term_remote" });
    expect(store.get("codex", SID)).toBeNull();
  });

  test("a local send keeps the historical argv exactly", async () => {
    const calls: string[][] = [];
    await sendSessionInput("claude", SID, "本地输入", {
      findLive: () => ({ ...remoteLive(), env: undefined } as unknown as LiveInfo),
      psEnv: () => Promise.resolve(""),
      orcaJson: (args): Promise<OrcaJsonResult> => { calls.push(args); return Promise.resolve({ ok: true }); },
      store: createSentInputStore(),
      now: () => 1000,
    });
    expect(calls[0]).toEqual([
      "terminal", "send", "--terminal", "term_remote", "--text", "本地输入", "--enter", "--json",
    ]);
  });

  test("remote confirmations get the longer pull-round timeout", () => {
    const base = { agent: "claude" as const, sid: SID, text: "x", handle: "h", sentAt: 0 };
    expect(confirmationState(base, 30_000)).toBe("stalled");
    expect(confirmationState({ ...base, env: "feibo2" }, 30_000)).toBe("pending");
    expect(confirmationState({ ...base, env: "feibo2" }, REMOTE_CONFIRMATION_TIMEOUT_MS)).toBe("stalled");
  });

  test("delivery evidence is scoped to the sending environment", () => {
    const db = new OrcaDatabase(":memory:");
    db.appendSessionFts([
      { text: "本地的输入", agent: "claude", sid: SID, role: "user", ts: 1 },
      { text: "远程的输入", agent: "claude", sid: SID, role: "user", ts: 2, env: "feibo2" },
    ]);
    const evidence = findLatestSentInputEvidence(db, [
      { agent: "claude", sid: SID, text: "x", handle: "h", sentAt: 0 },
      { agent: "claude", env: "feibo2", sid: SID, text: "x", handle: "h", sentAt: 0 },
    ]);
    expect(evidence.get(`claude/${SID}`)?.[0]?.text).toBe("本地的输入");
    expect(evidence.get(`feibo2:claude/${SID}`)?.[0]?.text).toBe("远程的输入");
  });
});

describe("remote focus routing", () => {
  function focusDeps(overrides: Partial<FocusDeps>, calls: string[][]): FocusDeps {
    return {
      findLive: () => null,
      getSessionCwd: () => null,
      psEnv: () => Promise.resolve(""),
      orcaJson: (args): Promise<OrcaJsonResult> => {
        calls.push(args);
        return Promise.resolve({ ok: true, result: { focus: { tabId: "tab9" } } });
      },
      openOrca: () => Promise.resolve(),
      ...overrides,
    };
  }

  test("a live remote session delegates workspace and tab navigation to the remote activator", async () => {
    const calls: string[][] = [];
    const activations: Array<[string, string, string]> = [];
    const deps = focusDeps({
      findLive: (_a, _s, env) => (env === "feibo2"
        ? { ...remoteLive("working"), worktree: "repo::/Users/mac/workspace/we-orca" }
        : null),
      activateRemoteTab: (env, worktree, tabId) => {
        activations.push([env, worktree, tabId]);
        return Promise.resolve();
      },
    }, calls);
    const result = await resolveFocus("codex", SID, deps, { dryRun: false, env: "feibo2" });
    expect(result).toMatchObject({ action: "switched", handle: "term_remote", tabId: "tab1" });
    expect(activations).toEqual([["feibo2", "repo::/Users/mac/workspace/we-orca", "tab1"]]);
    expect(calls).toEqual([]);
  });

  test("without a worktree key the remote switch falls back to --environment terminal switch", async () => {
    const calls: string[][] = [];
    const deps = focusDeps({ findLive: (_a, _s, env) => (env === "feibo2" ? remoteLive("working") : null) }, calls);
    const result = await resolveFocus("codex", SID, deps, { dryRun: false, env: "feibo2" });
    expect(result).toMatchObject({ action: "switched", handle: "term_remote" });
    expect(calls[0]).toEqual(["terminal", "switch", "--terminal", "term_remote", "--environment", "feibo2", "--json"]);
  });

  test("a dead remote session answers with an ssh resume command instead of spawning remotely", async () => {
    const calls: string[][] = [];
    const deps = focusDeps({
      getSessionCwd: (_agent, _sid, env) => (env === "feibo2" ? "/Users/mac/workspace/we-orca" : null),
      remoteSshPrefix: (env) => (env === "feibo2" ? "ssh mac@192.168.24.117" : null),
    }, calls);
    const result = await resolveFocus("codex", SID, deps, { dryRun: false, env: "feibo2" });
    expect(result).toMatchObject({
      action: "manual", reason: "remote-environment",
      command: `ssh mac@192.168.24.117 -t 'cd '"'"'/Users/mac/workspace/we-orca'"'"' && codex resume ${SID}'`,
    });
    expect((result as { message?: string }).message).toContain("不在线");
    expect(calls).toEqual([]);
  });

  test("without a configured ssh destination the manual answer degrades to command-less", async () => {
    const deps = focusDeps({}, []);
    const result = await resolveFocus("claude", SID, deps, { dryRun: false, env: "feibo2" });
    expect(result).toMatchObject({ action: "manual", reason: "remote-environment", command: null });
  });
});

describe("remote live scoping", () => {
  test("an environment-scoped tab source prefixes keys and stamps LiveInfo", async () => {
    const source = createOrcaTabSource(() => Promise.resolve([{
      type: "terminal", terminal: "term_x", parentTabId: "t", leafId: "l", title: "远程",
      agentStatus: { agentType: "codex", state: "done", updatedAt: 5, providerSession: { id: SID } },
    }]), { name: "orca-tab@feibo2", env: "feibo2" });
    const entries = await source.read(0, false);
    expect(source.name).toBe("orca-tab@feibo2");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe(`feibo2:codex/${SID}`);
    expect(entries[0]!.info).toMatchObject({ env: "feibo2", status: "done", handle: "term_x" });
  });

  test("mergeSessionLive joins remote rows to their scoped live entries", () => {
    const rows: SessionRow[] = [{
      agent: "codex", env: "feibo2", sid: SID, projectKey: "feibo2:/x", cwd: null, worktreeRoot: null,
      branch: null, title: null, firstPrompt: null, lastPrompt: null, displayTitle: "远程", lastInputAt: null,
      promptCount: 0, live: null, goals: [],
    }];
    const live = new Map([[`feibo2:codex/${SID}`, remoteLive()]]);
    const merged = mergeSessionLive(rows, live);
    expect(merged[0]!.live).toMatchObject({ env: "feibo2", status: "done" });
  });
});
