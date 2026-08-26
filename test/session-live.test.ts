import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionLiveReader } from "../src/session-live";
import type { LiveInfo } from "../src/types";

const CODEX_SID = "01a03bdb-4e55-79e1-9f72-906c5ee671f6";
const CLAUDE_SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";
const HERMES_SID = "20260811_031044_76b3bb";
const ACTIVE_FILE = join(tmpdir(), "hermes-tui-active-session-abcd.json");

function runtimeSnapshot(codexHandle = "term_codex") {
  return {
    ok: true,
    result: {
      snapshots: [{
        worktree: "repo::/workspace/orcatab",
        tabs: [
          {
            type: "terminal", parentTabId: "tab_codex", leafId: "leaf_codex",
            terminal: codexHandle, title: "Codex tab",
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
            terminal: "term_hermes", title: "Hermes tab",
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
    const reader = createSessionLiveReader({
      now: () => now,
      getClaudeLiveMap: () => new Map(),
      callRuntime: async () => { calls += 1; return runtimeSnapshot(handle); },
      listProcessEnvironments: async () => "",
    });
    await reader.refresh();
    expect(reader.getLiveVersion()).toBe(1);
    now = 100;
    await reader.refresh();
    expect(calls).toBe(1);
    now = 4_000;
    handle = "term_two";
    await reader.refresh();
    expect(calls).toBe(2);
    expect(reader.getLiveVersion()).toBe(2);
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
      listProcessEnvironments: async () => "HERMES_TUI_ACTIVE_SESSION_FILE=/etc/passwd ORCA_TERMINAL_HANDLE=term_unknown",
      readTextFile: () => { throw new Error("must not read"); },
    });
    expect((await reader.refresh()).size).toBe(0);
  });
});
