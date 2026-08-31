import { describe, expect, test } from "bun:test";
import {
  liveSnapshotSignature, mergeLiveSources, readLiveSources,
  type LiveEntry, type LiveSource, type LiveSourceOutcome, type RememberedRead,
} from "../src/live-source";
import type { LiveInfo } from "../src/types";

const BUDGET = 30_000;

function info(status: string, extra: Partial<LiveInfo> = {}): LiveInfo {
  return { pid: null, status, waitingFor: null, name: null, ...extra };
}

function entry(key: string, status: string, extra: Partial<LiveInfo> = {}): LiveEntry {
  return { key: key as `${string}/${string}`, info: info(status, extra) };
}

function ok(name: string, entries: LiveEntry[]): LiveSourceOutcome {
  return { name, entries, error: null };
}

function failed(name: string, error: string): LiveSourceOutcome {
  return { name, entries: null, error };
}

function merge(outcomes: LiveSourceOutcome[], remembered = new Map<string, RememberedRead>(), at = 1_000) {
  return mergeLiveSources(outcomes, remembered, at, BUDGET);
}

describe("live source merge policy", () => {
  test("a later source refines a key an earlier one claimed", () => {
    const { snapshot } = merge([
      ok("claude-pid", [entry("claude/a", "idle", { pid: 7 })]),
      ok("orca-tab", [entry("claude/a", "working", { handle: "term_1" })]),
    ]);
    expect(snapshot.live.get("claude/a")).toMatchObject({ status: "working", handle: "term_1" });
    expect(snapshot.sources.map((source) => source.name)).toEqual(["claude-pid", "orca-tab"]);
  });

  test("one dead source does not blank the others", () => {
    const { snapshot } = merge([
      ok("claude-pid", [entry("claude/a", "idle")]),
      failed("orca-tab", "socket missing"),
    ]);
    expect(snapshot.live.has("claude/a")).toBeTrue();
    expect(snapshot.sources[1]).toMatchObject({ name: "orca-tab", ok: false, error: "socket missing", sessions: 0 });
  });

  test("a source that just failed serves its last good read, marked stale", () => {
    const first = merge([ok("orca-tab", [entry("codex/b", "working")])], new Map(), 0);
    const second = mergeLiveSources([failed("orca-tab", "restarting")], first.remembered, 10_000, BUDGET);
    expect(second.snapshot.live.get("codex/b")).toMatchObject({ status: "working" });
    expect(second.snapshot.sources[0]).toMatchObject({ ok: false, stale: true, readAt: 0, sessions: 1 });
  });

  test("stale entries are dropped once the budget expires", () => {
    const first = merge([ok("orca-tab", [entry("codex/b", "working")])], new Map(), 0);
    const second = mergeLiveSources([failed("orca-tab", "gone")], first.remembered, BUDGET, BUDGET);
    expect(second.snapshot.live.size).toBe(0);
    expect(second.snapshot.sources[0]).toMatchObject({ ok: false, stale: false, readAt: null, sessions: 0 });
    // Once dropped, the memory is released so a later failure cannot resurrect it.
    expect(second.remembered.has("orca-tab")).toBeFalse();
  });

  test("a recovered source replaces its stale entries wholesale", () => {
    const first = merge([ok("orca-tab", [entry("codex/b", "working"), entry("codex/c", "done")])], new Map(), 0);
    const stalled = mergeLiveSources([failed("orca-tab", "blip")], first.remembered, 5_000, BUDGET);
    const recovered = mergeLiveSources([ok("orca-tab", [entry("codex/b", "done")])], stalled.remembered, 6_000, BUDGET);
    expect([...recovered.snapshot.live.keys()]).toEqual(["codex/b"]);
    expect(recovered.snapshot.sources[0]).toMatchObject({ ok: true, stale: false, sessions: 1 });
  });
});

describe("live snapshot signature", () => {
  test("ignores the read clock so an unchanged board keeps its ETag", () => {
    const outcomes = [ok("orca-tab", [entry("codex/b", "working")])];
    const left = mergeLiveSources(outcomes, new Map(), 1_000, BUDGET).snapshot;
    const right = mergeLiveSources(outcomes, new Map(), 9_999, BUDGET).snapshot;
    expect(liveSnapshotSignature(left)).toBe(liveSnapshotSignature(right));
  });

  test("is insensitive to source ordering of the same live map", () => {
    const left = merge([ok("a", [entry("codex/x", "working"), entry("claude/y", "done")])]).snapshot;
    const right = merge([ok("a", [entry("claude/y", "done"), entry("codex/x", "working")])]).snapshot;
    expect(liveSnapshotSignature(left)).toBe(liveSnapshotSignature(right));
  });

  test("changes when a session's status changes", () => {
    const left = merge([ok("a", [entry("codex/x", "working")])]).snapshot;
    const right = merge([ok("a", [entry("codex/x", "done")])]).snapshot;
    expect(liveSnapshotSignature(left)).not.toBe(liveSnapshotSignature(right));
  });

  test("changes when a source goes down, so the board re-renders the warning", () => {
    const healthy = merge([ok("orca-tab", [])]).snapshot;
    const down = merge([failed("orca-tab", "socket missing")]).snapshot;
    expect(liveSnapshotSignature(healthy)).not.toBe(liveSnapshotSignature(down));
  });

  test("does not change when only the error text moves", () => {
    // Health drives the ETag; the message is detail the payload carries but need not re-fetch for.
    const first = merge([failed("orca-tab", "socket missing")]).snapshot;
    const second = merge([failed("orca-tab", "connection refused")]).snapshot;
    expect(liveSnapshotSignature(first)).toBe(liveSnapshotSignature(second));
  });
});

describe("reading live sources", () => {
  function source(name: string, read: LiveSource["read"]): LiveSource {
    return { name, read };
  }

  test("converts a throw into an outcome instead of failing the whole read", async () => {
    const outcomes = await readLiveSources([
      source("good", async () => [entry("claude/a", "idle")]),
      source("bad", async () => { throw new Error("nope"); }),
    ], 1_000);
    expect(outcomes[0]).toMatchObject({ name: "good", error: null });
    expect(outcomes[1]).toMatchObject({ name: "bad", entries: null, error: "nope" });
  });

  test("passes the clock and the force flag through to every source", async () => {
    const seen: Array<[number, boolean]> = [];
    await readLiveSources([
      source("a", async (startedAt, force) => { seen.push([startedAt, force]); return []; }),
      source("b", async (startedAt, force) => { seen.push([startedAt, force]); return []; }),
    ], 42, true);
    expect(seen).toEqual([[42, true], [42, true]]);
  });

  test("runs sources concurrently rather than in series", async () => {
    let running = 0;
    let peak = 0;
    const slow = (name: string) => source(name, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      return [];
    });
    await readLiveSources([slow("a"), slow("b"), slow("c")], 0);
    expect(peak).toBeGreaterThan(1);
  });
});
