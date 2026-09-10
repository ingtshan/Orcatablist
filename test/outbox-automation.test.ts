import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionOutboxDatabase, SessionOutboxStore } from "../src/session-outbox";
import { createSessionOutboxRuntime, sendOutboxInput } from "../src/session-outbox-runtime";
import { createSentInputStore, createSentInputConfirmationQueue, sendSessionInput } from "../src/session-send";
import type { LiveInfo } from "../src/types";
import { OrcaDatabase } from "../src/db";
import { findLatestSentInputEvidence, sentInputEvidenceCount } from "../src/session-send-evidence";

const identity = { agent: "codex" as const, sid: "queue-session", env: "remote" };
const key = "remote:codex/queue-session";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function harness(path = ":memory:") {
  const outbox = new SessionOutboxStore(openSessionOutboxDatabase(path));
  cleanup.push(() => outbox.close());
  const store = createSentInputStore();
  const state = { status: "working", evidence: "", fail: false, fresh: true, now: 1000, inputCount: 0 };
  const calls: string[][] = [];
  let wait: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const deps = { outbox, store, now: () => state.now,
    findLive: async (): Promise<LiveInfo> => { await wait; return { status: state.status, pid: null,
      updatedAt: state.now, waitingFor: null, handle: "remote-terminal", name: null }; },
    psEnv: async () => "", orcaJson: async (args: string[]) => { calls.push(args); return state.fail
      ? { ok: false, error: "terminal unavailable" } : { ok: true, result: {} }; },
  };
  const queue = createSentInputConfirmationQueue({ store, now: () => state.now,
    getLatestUserInputs: () => new Map([[key, state.evidence ? [{ text: state.evidence, ts: state.now, inputCount: state.inputCount }] : []]]) });
  const runtime = createSessionOutboxRuntime({ ...deps, confirmationQueue: queue, startPolling: false, liveFresh: () => state.fresh });
  cleanup.push(runtime.close);
  return { outbox, store, state, calls, deps, runtime,
    hold() { wait = new Promise<void>((resolve) => { release = resolve; }); }, release() { release?.(); },
  };
}

describe("ordered automatic outbox", () => {
  test("SQLite delivery evidence distinguishes a repeated message from its previous occurrence", async () => {
    const db = new OrcaDatabase(":memory:");
    try {
      const app = harness(); app.state.status = "done";
      db.appendSessionFts([{ ...identity, role: "user", text: "继续", ts: null }]);
      const item = app.outbox.add({ ...identity, text: "继续" });
      const record = await sendOutboxInput(item.id, { ...app.deps,
        getInputCount: (agent, sid, env) => sentInputEvidenceCount(db, agent, sid, env) });
      expect(record.previousInputCount).toBe(1);
      const queue = createSentInputConfirmationQueue({ store: app.store,
        getLatestUserInputs: entries => findLatestSentInputEvidence(db, entries) });
      await queue.reconcile(); expect(app.store.list()).toHaveLength(1);
      db.appendSessionFts([{ ...identity, role: "user", text: "继续", ts: null }]);
      await queue.reconcile(); expect(app.store.list()).toHaveLength(0);
    } finally { db.close(); }
  });

  test("identical queued text needs a new transcript input before the next send", async () => {
    const app = harness(); app.state.status = "done"; app.state.evidence = "继续"; app.state.inputCount = 1;
    const item = app.outbox.add({ ...identity, text: "继续" });
    app.outbox.add({ ...identity, text: "next" });
    await sendOutboxInput(item.id, { ...app.deps, getInputCount: () => app.state.inputCount });
    app.outbox.updateSetting(identity, { autoSend: true });
    await app.runtime.tick(); expect(app.calls).toHaveLength(1);
    app.state.inputCount += 1;
    await app.runtime.tick(); expect(app.calls).toHaveLength(2);
  });

  test("manual by default; ordered sends wait for both confirmation and readiness", async () => {
    const app = harness();
    const first = app.outbox.add({ ...identity, text: "first" });
    const second = app.outbox.add({ ...identity, text: "second" });
    app.outbox.reorder(identity, [second.id, first.id], app.outbox.version);
    app.state.status = "done";
    await app.runtime.tick(); expect(app.calls).toHaveLength(0);
    app.outbox.updateSetting(identity, { autoSend: true });
    await Promise.all([app.runtime.tick(), app.runtime.tick()]);
    expect(app.calls).toHaveLength(1); expect(app.calls[0]).toContain("second");
    expect(app.calls[0]).toContain("--environment");
    await app.runtime.tick(); expect(app.calls).toHaveLength(1);
    app.state.evidence = "second"; app.state.status = "working";
    await app.runtime.tick(); expect(app.calls).toHaveLength(1);
    app.state.status = "done";
    await app.runtime.tick(); expect(app.calls).toHaveLength(2); expect(app.calls[1]).toContain("first");
  });

  test("turning off automatic mode cancels a send still checking live state", async () => {
    const app = harness(); app.outbox.add({ ...identity, text: "queued" });
    app.outbox.updateSetting(identity, { autoSend: true }); app.state.status = "done"; app.hold();
    const pending = app.runtime.tick();
    app.outbox.updateSetting(identity, { autoSend: false }); app.release(); await pending;
    expect(app.calls).toHaveLength(0); expect(app.outbox.list()).toHaveLength(1);
  });

  test("manual and automatic sends cannot race on the same message or session", async () => {
    const app = harness(); app.state.status = "done"; app.hold();
    const item = app.outbox.add({ ...identity, text: "once" });
    const first = sendOutboxInput(item.id, app.deps);
    await expect(sendOutboxInput(item.id, app.deps)).rejects.toMatchObject({ code: "send-pending" });
    await expect(sendSessionInput(identity.agent, identity.sid, "competing direct input", app.deps, {}, identity.env))
      .rejects.toMatchObject({ code: "send-pending" });
    app.release(); await first; expect(app.calls).toHaveLength(1);
  });

  test("stale live state does not auto send; an Orca error retains input and pauses auto", async () => {
    const app = harness(); app.state.status = "done"; app.state.fresh = false;
    app.outbox.add({ ...identity, text: "keep" }); app.outbox.updateSetting(identity, { autoSend: true });
    await app.runtime.tick(); expect(app.calls).toHaveLength(0);
    app.state.fresh = true; app.state.fail = true;
    await app.runtime.tick(); expect(app.outbox.list()).toHaveLength(1);
    expect(app.outbox.setting(identity)).toMatchObject({ autoSend: false, pending: null });
    expect(app.outbox.setting(identity).error).toContain("发送失败");
  });

  test("confirmation timeout pauses the remaining queue", async () => {
    const app = harness(); app.state.status = "done";
    app.outbox.add({ ...identity, text: "one" }); app.outbox.add({ ...identity, text: "two" });
    app.outbox.updateSetting(identity, { autoSend: true }); await app.runtime.tick();
    app.state.now += 61000; await app.runtime.tick();
    expect(app.calls).toHaveLength(1); expect(app.outbox.setting(identity).autoSend).toBeFalse();
    expect(app.outbox.list()[0]?.text).toBe("two");
  });

  test("a server restart restores the pending delivery and preserves order and mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-reopen-")); cleanup.unshift(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "outbox.db"); const first = harness(path); first.state.status = "done";
    first.outbox.add({ ...identity, text: "one" }); first.outbox.add({ ...identity, text: "two" });
    first.outbox.updateSetting(identity, { autoSend: true }); await first.runtime.tick(); first.runtime.close();
    const second = harness(path); second.state.status = "done";
    await second.runtime.tick(); expect(second.calls).toHaveLength(0);
    expect(second.store.get(identity.agent, identity.sid, identity.env)?.text).toBe("one");
    expect(second.outbox.setting(identity).autoSend).toBeTrue();
    second.state.evidence = "one"; await second.runtime.tick();
    expect(second.calls[0]).toContain("two");
  });

  test("reordering rejects stale versions and cross-environment IDs", () => {
    const app = harness(); const one = app.outbox.add({ ...identity, text: "one" });
    const two = app.outbox.add({ ...identity, env: "elsewhere", text: "two" });
    expect(() => app.outbox.reorder(identity, [one.id], app.outbox.version - 1)).toThrow("queue changed");
    expect(() => app.outbox.reorder(identity, [two.id], app.outbox.version)).toThrow("exactly");
    expect(app.outbox.list().map((item) => item.text)).toEqual(["one", "two"]);
  });

  test("v1 migration retains messages in creation order", () => {
    const directory = mkdtempSync(join(tmpdir(), "outbox-v1-")); cleanup.unshift(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "outbox.db"); const old = new Database(path);
    old.exec("CREATE TABLE session_outbox(id TEXT PRIMARY KEY, env TEXT, agent TEXT, sid TEXT, text TEXT, created_at INTEGER)");
    old.exec("INSERT INTO session_outbox VALUES ('b','local','codex','s','second',20), ('a','local','codex','s','first',10)"); old.close();
    const app = harness(path); expect(app.outbox.list().map((item) => item.text)).toEqual(["first", "second"]);
  });
});
