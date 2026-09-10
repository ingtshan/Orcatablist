import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { activateRuntimeWorkspaceTab, guardSettledSocketErrors } from "../src/orca-tabs";

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

describe("settled remote socket errors", () => {
  /** Stands in for the runtime client's `ws` socket: same unhandled-'error' semantics. */
  class FakeSocket extends EventEmitter {}

  test("drops an error nobody is listening for instead of killing the process", () => {
    expect(guardSettledSocketErrors(FakeSocket)).toBe(true);
    const socket = new FakeSocket();

    // Orca's cleanup path: `once` is spent, and the CLOSED guard skips re-attaching a swallow.
    expect(() => socket.emit("error", new Error("Failed to connect"))).not.toThrow();
  });

  test("still delivers errors to an in-flight request", () => {
    const socket = new FakeSocket();
    const seen: string[] = [];
    socket.once("error", (error: Error) => seen.push(error.message));

    socket.emit("error", new Error("Could not connect to the remote Orca runtime."));

    expect(seen).toEqual(["Could not connect to the remote Orca runtime."]);
  });

  test("leaves every other event untouched", () => {
    const socket = new FakeSocket();
    const closed: number[] = [];
    socket.on("close", (code: number) => closed.push(code));

    expect(socket.emit("close", 1006)).toBe(true);
    expect(closed).toEqual([1006]);
  });

  test("reports nothing to guard when the module exposes no emitter", () => {
    expect(guardSettledSocketErrors({} as never)).toBe(false);
  });
});
