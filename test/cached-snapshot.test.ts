import { describe, expect, test } from "bun:test";
import { createCachedSnapshot } from "../src/cached-snapshot";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("cached snapshot", () => {
  test("loads once per ttl and serves the cache in between", async () => {
    let clock = 0;
    let loads = 0;
    const snapshot = createCachedSnapshot<void, number>({
      ttlMs: 3_000, now: () => clock, load: async () => ++loads,
    });
    expect(await snapshot.refresh()).toBe(1);
    clock = 2_999;
    expect(await snapshot.refresh()).toBe(1);
    expect(loads).toBe(1);
    clock = 3_000;
    expect(await snapshot.refresh()).toBe(2);
    expect(loads).toBe(2);
  });

  test("advances the version only when the signature changes", async () => {
    let clock = 0;
    let value = "stable";
    const snapshot = createCachedSnapshot<void, { value: string }>({
      ttlMs: 10, now: () => clock, load: async () => ({ value }),
    });
    await snapshot.refresh();
    expect(snapshot.getVersion()).toBe(1);
    clock += 10;
    await snapshot.refresh();
    expect(snapshot.getVersion()).toBe(1);
    clock += 10;
    value = "changed";
    await snapshot.refresh();
    expect(snapshot.getVersion()).toBe(2);
  });

  test("honours a custom signature so unimportant churn does not bump the version", async () => {
    let clock = 0;
    let name = "first";
    const snapshot = createCachedSnapshot<void, { status: string; name: string }>({
      ttlMs: 10, now: () => clock,
      load: async () => ({ status: "working", name }),
      signature: (value) => value.status,
    });
    await snapshot.refresh();
    expect(snapshot.getVersion()).toBe(1);
    clock += 10;
    name = "renamed";
    await snapshot.refresh();
    expect(snapshot.getVersion()).toBe(1);
    expect(snapshot.peek()).toEqual({ status: "working", name: "renamed" });
  });

  test("shares one in-flight load between concurrent callers", async () => {
    let loads = 0;
    const gate = deferred<void>();
    const snapshot = createCachedSnapshot<void, number>({
      ttlMs: 1_000, now: () => 0,
      load: async () => { loads += 1; await gate.promise; return loads; },
    });
    const both = Promise.all([snapshot.refresh(), snapshot.refresh()]);
    gate.resolve();
    expect(await both).toEqual([1, 1]);
    expect(loads).toBe(1);
  });

  test("serves a separate slot per cache key and reloads when the key changes", async () => {
    let clock = 0;
    const seen: string[] = [];
    const snapshot = createCachedSnapshot<string, string>({
      ttlMs: 1_000, now: () => clock,
      cacheKey: (input) => input,
      load: async (input) => { seen.push(input); return input.toUpperCase(); },
    });
    expect(await snapshot.refresh("a")).toBe("A");
    expect(await snapshot.refresh("a")).toBe("A");
    expect(await snapshot.refresh("b")).toBe("B");
    expect(seen).toEqual(["a", "b"]);
  });

  test("peek stays null until the first load resolves", async () => {
    const gate = deferred<void>();
    const snapshot = createCachedSnapshot<void, string>({
      ttlMs: 1_000, now: () => 0,
      load: async () => { await gate.promise; return "ready"; },
    });
    expect(snapshot.peek()).toBeNull();
    const pending = snapshot.refresh();
    expect(snapshot.peek()).toBeNull();
    gate.resolve();
    await pending;
    expect(snapshot.peek()).toBe("ready");
  });

  test("a failed load leaves the previous value and version intact", async () => {
    let clock = 0;
    let fail = false;
    const snapshot = createCachedSnapshot<void, string>({
      ttlMs: 10, now: () => clock,
      load: async () => { if (fail) throw new Error("scan failed"); return "value"; },
    });
    await snapshot.refresh();
    expect(snapshot.getVersion()).toBe(1);
    clock += 10;
    fail = true;
    await expect(snapshot.refresh()).rejects.toThrow("scan failed");
    expect(snapshot.peek()).toBe("value");
    expect(snapshot.getVersion()).toBe(1);
    clock += 10;
    fail = false;
    expect(await snapshot.refresh()).toBe("value");
  });
});
