import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionLiveReader } from "../src/session-live";
import type { LiveInfo } from "../src/types";

const CODEX_SID = "01a03bdb-4e55-79e1-9f72-906c5ee671f6";
const CLAUDE_SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";
const HERMES_SID = "20260811_031044_76b3bb";
const ACTIVE_FILE = join(tmpdir(), "hermes-tui-active-session-abcd.json");

function runtimeSnapshot(codexHandle = "term_codex", hermesHandle = "term_hermes", codexTitle = "Codex tab") {
  return {
    ok: true,
    result: {
      snapshots: [{
        worktree: "repo::/workspace/orcatab",
        tabs: [
          {
            type: "terminal", parentTabId: "tab_codex", leafId: "leaf_codex",
            terminal: codexHandle, title: codexTitle,
            agentStatus: {
              agentType: "codex", state: "working", updatedAt: 30,
              providerSession: { key: "session_id", id: CODEX_SID },
            },
          },
          {
            type: "terminal", parentTabId: "tab_claude", leafId: "leaf_claude",
            terminal: "term_claude", title: "Claude tab",
            agentStatus: {
              agentType: "claude", state: "done", updatedAt: 20,
              providerSession: { key: "session_id", id: CLAUDE_SID },
            },
          },
          {
            type: "terminal", parentTabId: "tab_hermes", leafId: "leaf_hermes",
            terminal: hermesHandle, title: "Hermes tab",
            agentStatus: { agentType: "hermes", state: "waiting", toolName: "approval", updatedAt: 10 },
          },
        ],
      }],
    },
  };
}

describe("multi-agent open-session reader", () => {
  test("maps Orca provider sessions and Hermes active-session files to exact tabs", async () => {
    const claudeFallback: LiveInfo = {
      pid: 42, status: "busy", waitingFor: "question", name: "fallback",
    };
    const reader = createSessionLiveReader({
      now: () => 0,
      getClaudeLiveMap: () => new Map([[CLAUDE_SID, claudeFallback]]),
      callRuntime: async () => runtimeSnapshot(),
      listProcessEnvironments: async () => [
        `123 hermes HERMES_TUI_ACTIVE_SESSION_FILE=${ACTIVE_FILE}`,
        "ORCA_TERMINAL_HANDLE=term_hermes ORCA_TAB_ID=tab_hermes ORCA_PANE_KEY=tab_hermes:leaf_hermes",
      ].join(" "),
      readTextFile: (path) => {
        expect(path).toBe(ACTIVE_FILE);
        return JSON.stringify({ session_id: HERMES_SID });
      },
    });

    const live = await reader.refresh();
    expect(live.get(`codex/${CODEX_SID}`)).toEqual({
      pid: null, status: "busy", waitingFor: null, name: "Codex tab",
      handle: "term_codex", tabId: "tab_codex", leafId: "leaf_codex",
    });
    expect(live.get(`claude/${CLAUDE_SID}`)).toMatchObject({
      pid: null, status: "idle", handle: "term_claude", tabId: "tab_claude",
    });
    expect(live.get(`hermes/${HERMES_SID}`)).toEqual({
      pid: null, status: "waiting", waitingFor: "approval", name: "Hermes tab",
      handle: "term_hermes", tabId: "tab_hermes", leafId: "leaf_hermes",
    });
    expect(await reader.findLive("codex", CODEX_SID)).toEqual(live.get(`codex/${CODEX_SID}`)!);
  });

  test("caches runtime reads and versions handle changes", async () => {
    let now = 0;
    let calls = 0;
    let handle = "term_one";
    let title = "first title";
    const reader = createSessionLiveReader({
      now: () => now,
      getClaudeLiveMap: () => new Map(),
      callRuntime: async () => { calls += 1; return runtimeSnapshot(handle, "term_hermes", title); },
      listProcessEnvironments: async () => "",
    });
    await reader.refresh();
    expect(reader.getLiveVersion()).toBe(1);
    now = 100;
    await reader.refresh();
    expect(calls).toBe(1);
    now = 4_000;
    title = "renamed title";
    await reader.refresh();
    expect(calls).toBe(2);
    expect(reader.getLiveVersion()).toBe(1);
    now = 8_000;
    handle = "term_two";
    await reader.refresh();
    expect(calls).toBe(3);
    expect(reader.getLiveVersion()).toBe(2);
  });

  test("reuses Hermes process mappings while rereading the active session and rescans changed tabs", async () => {
    let now = 0;
    let scans = 0;
    let sid = HERMES_SID;
    let hermesHandle = "term_hermes";
    const reader = createSessionLiveReader({
      now: () => now,
      getClaudeLiveMap: () => new Map(),
      callRuntime: async () => runtimeSnapshot("term_codex", hermesHandle),
      listProcessEnvironments: async () => {
        scans += 1;
        return `HERMES_TUI_ACTIVE_SESSION_FILE=${ACTIVE_FILE} ORCA_TERMINAL_HANDLE=${hermesHandle}`;
      },
      readTextFile: () => JSON.stringify({ session_id: sid }),
    });

    expect((await reader.refresh()).has(`hermes/${HERMES_SID}`)).toBeTrue();
    expect(scans).toBe(1);
    now = 4_000;
    sid = "20260811_031044_changed";
    expect((await reader.refresh()).has(`hermes/${sid}`)).toBeTrue();
    expect(scans).toBe(1);
    now = 8_000;
    hermesHandle = "term_hermes_new";
    expect((await reader.refresh()).get(`hermes/${sid}`)?.handle).toBe(hermesHandle);
    expect(scans).toBe(2);
    now = 39_000;
    await reader.refresh();
    expect(scans).toBe(3);
  });

  test("keeps Claude fallback when the Orca runtime is unavailable and reports context", async () => {
    const errors: Error[] = [];
    const reader = createSessionLiveReader({
      now: () => 0,
      getClaudeLiveMap: () => new Map([[CLAUDE_SID, {
        pid: 7, status: "idle", waitingFor: null, name: null,
      }]]),
      callRuntime: async () => { throw new Error("socket missing"); },
      listProcessEnvironments: async () => { throw new Error("must not run"); },
      onError: (error) => errors.push(error),
    });
    const live = await reader.refresh();
    expect(live.get(`claude/${CLAUDE_SID}`)?.pid).toBe(7);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Orca open-tab refresh failed");
  });

  test("ignores malformed providers and untrusted Hermes active-file paths", async () => {
    let scans = 0;
    const reader = createSessionLiveReader({
      now: () => 0,
      getClaudeLiveMap: () => new Map(),
      callRuntime: async () => ({
        ok: true,
        result: { snapshots: [{ tabs: [{
          type: "terminal", terminal: "term_unknown", parentTabId: "tab", leafId: "leaf",
          agentStatus: { agentType: "unknown", state: "working", providerSession: { id: "sid" } },
        }] }] },
      }),
      listProcessEnvironments: async () => {
        scans += 1;
        return "HERMES_TUI_ACTIVE_SESSION_FILE=/etc/passwd ORCA_TERMINAL_HANDLE=term_unknown";
      },
      readTextFile: () => { throw new Error("must not read"); },
    });
    expect((await reader.refresh()).size).toBe(0);
    expect(scans).toBe(0);
  });
});
