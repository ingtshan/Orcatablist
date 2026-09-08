import { describe, expect, test } from "bun:test";
import { activateRuntimeWorkspaceTab } from "../src/orca-tabs";

describe("remote runtime tab activation", () => {
  test("publishes the tab follow intent before revealing its worktree", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    await activateRuntimeWorkspaceTab((method, params) => {
      calls.push({ method, params });
      return Promise.resolve({ ok: true });
    }, "repo::/workspace", "tab-1");

    expect(calls).toEqual([
      {
        method: "session.tabs.activate",
        params: {
          worktree: "id:repo::/workspace", tabId: "tab-1", notifyClients: true,
          navigation: "clients", intent: "user",
        },
      },
      {
        method: "worktree.activate",
        params: { worktree: "id:repo::/workspace", notifyClients: true, navigation: "clients" },
      },
    ]);
  });

  test("does not reveal the worktree when tab selection is rejected", async () => {
    const methods: string[] = [];
    const activation = activateRuntimeWorkspaceTab((method) => {
      methods.push(method);
      return Promise.resolve({ ok: false, error: { code: "selector_not_found" } });
    }, "id:repo::/workspace", "tab-1");

    await expect(activation).rejects.toThrow("session.tabs.activate rejected");
    expect(methods).toEqual(["session.tabs.activate"]);
  });
});
