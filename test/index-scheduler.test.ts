import { describe, expect, test } from "bun:test";
import { createCoalescingRunner } from "../src/index-scheduler";
import { createDebouncer, type DebounceTimers } from "../src/index-watch";

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void; }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

/** A pass that only finishes when the test says so, so run overlap is observable, not timed. */
function gatedPass() {
  const gates: Array<Deferred<string>> = [];
  let started = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const pass = async (): Promise<string> => {
    const gate = deferred<string>();
    gates.push(gate);
    started += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try { return await gate.promise; } finally { inFlight -= 1; }
  };
  return { pass, gates, started: () => started, maxInFlight: () => maxInFlight };
}

function fakeTimers() {
  interface Scheduled { at: number; fire: () => void; }
  const pending = new Map<number, Scheduled>();
  let nextId = 1;
  let now = 0;
  const timers: DebounceTimers = {
    schedule: (callback, delayMs) => {
      const id = nextId++;
      pending.set(id, { at: now + delayMs, fire: callback });
      return id;
    },
    cancel: (handle) => { pending.delete(handle as number); },
  };
  return {
    timers,
    pending: () => pending.size,
    advance(ms: number): void {
      now += ms;
      const due = [...pending.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        if (!pending.delete(id)) continue;
        timer.fire();
      }
    },
  };
}

describe("coalescing runner", () => {
  test("many requests during a run collapse into exactly one follow-up", async () => {
    const { pass, gates, started, maxInFlight } = gatedPass();
    const runner = createCoalescingRunner(pass);

    const first = runner.request();
    expect(started()).toBe(1);
    expect(runner.running()).toBeTrue();

    const queued = [runner.request(), runner.request(), runner.request()];
    expect(runner.queued()).toBeTrue();
    expect(started()).toBe(1);

    gates[0]!.resolve("first");
    expect(await first).toEqual({ status: "completed", value: "first" });
    // The three waiting callers share one follow-up pass, and it only starts once.
    expect(started()).toBe(2);

    gates[1]!.resolve("second");
    expect(await Promise.all(queued)).toEqual([
      { status: "completed", value: "second" },
      { status: "completed", value: "second" },
      { status: "completed", value: "second" },
    ]);
    expect(started()).toBe(2);
    expect(runner.queued()).toBeFalse();
    expect(maxInFlight()).toBe(1);
  });

  test("a failed pass reports the failure and still serves the queued work", async () => {
    const { pass, gates, started } = gatedPass();
    const runner = createCoalescingRunner(pass);
    const first = runner.request();
    const queued = runner.request();

    gates[0]!.reject(new Error("崩了"));
    const failure = await first;
    expect(failure.status).toBe("failed");
    expect((failure as { error: Error }).error.message).toBe("崩了");

    expect(started()).toBe(2);
    gates[1]!.resolve("recovered");
    expect(await queued).toEqual({ status: "completed", value: "recovered" });
  });

  test("close cancels queued work, refuses new work and starts no follow-up", async () => {
    const { pass, gates, started } = gatedPass();
    const runner = createCoalescingRunner(pass);
    const inFlight = runner.request();
    const queued = runner.request();

    runner.close();
    expect(await queued).toEqual({ status: "cancelled" });
    expect(await runner.request()).toEqual({ status: "cancelled" });

    // The pass already running is genuinely served; only future work is refused.
    gates[0]!.resolve("last");
    expect(await inFlight).toEqual({ status: "completed", value: "last" });
    expect(started()).toBe(1);
    expect(runner.closed()).toBeTrue();
  });
});

describe("watch debounce", () => {
  test("fires once after the quiet window", () => {
    const clock = fakeTimers();
    let fired = 0;
    const debouncer = createDebouncer(() => { fired += 1; }, { quietMs: 500, maxWaitMs: 2_000, timers: clock.timers });

    debouncer.signal();
    clock.advance(400);
    expect(fired).toBe(0);
    clock.advance(100);
    expect(fired).toBe(1);
    expect(clock.pending()).toBe(0);
    debouncer.close();
  });

  test("continuous activity cannot postpone the run past the maximum wait", () => {
    const clock = fakeTimers();
    let fired = 0;
    const debouncer = createDebouncer(() => { fired += 1; }, { quietMs: 500, maxWaitMs: 2_000, timers: clock.timers });

    // A write every 400 ms keeps resetting the quiet window but never the ceiling.
    for (let elapsed = 0; elapsed < 2_000; elapsed += 400) {
      debouncer.signal();
      expect(fired).toBe(0);
      clock.advance(400);
    }
    expect(fired).toBe(1);
    expect(clock.pending()).toBe(0);
    debouncer.close();
  });

  test("close drops pending timers so a shutdown starts no further work", () => {
    const clock = fakeTimers();
    let fired = 0;
    const debouncer = createDebouncer(() => { fired += 1; }, { quietMs: 500, maxWaitMs: 2_000, timers: clock.timers });
    debouncer.signal();
    debouncer.close();
    clock.advance(5_000);
    expect(fired).toBe(0);
    expect(clock.pending()).toBe(0);
    debouncer.signal();
    clock.advance(5_000);
    expect(fired).toBe(0);
  });
});
