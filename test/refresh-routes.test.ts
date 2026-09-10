import { describe, expect, test } from "bun:test";
import { handleRefreshRequest, type RefreshDeps, type RefreshSummary } from "../src/refresh-routes";
import type { LiveSnapshot } from "../src/live-source";
import type { SessionLiveReader } from "../src/session-live";
import type { LiveInfo } from "../src/types";

const live = new Map<string, LiveInfo>([
  ["claude/s-1", { pid: 1, status: "working", waitingFor: null, name: "tab" }],
]);

function snapshotWith(sources: LiveSnapshot["sources"]): LiveSnapshot {
  return { at: 7, live, sources };
}

interface Harness { deps: RefreshDeps; forced: boolean[]; indexPasses: number; kicked: string[] }

function harness(overrides: { sources?: LiveSnapshot["sources"]; environments?: string[] } = {}): Harness {
  const state: Harness = { forced: [], indexPasses: 0, kicked: [], deps: null as never };
  const sources = overrides.sources ?? [
    { name: "orca-tab", ok: true, readAt: 7, stale: false, sessions: 1, error: null },
  ];
  const reader = {
    refresh: async () => live,
    refreshSnapshot: async (force = false) => { state.forced.push(force); return snapshotWith(sources); },
    getLiveMap: () => live,
    getSnapshot: () => snapshotWith(sources),
    getLiveVersion: () => 1,
    findLive: async () => null,
  } satisfies SessionLiveReader;
  state.deps = {
    indexAll: async () => {
      state.indexPasses += 1;
      return { files: 12, changed: 3, ms: 41, errors: [] };
    },
    liveReader: reader,
    kickEnvironments: () => {
      const names = overrides.environments ?? ["feibo1", "feibo2"];
      state.kicked.push(...names);
      return names;
    },
    // Only a completed pass stamps this, so returning it proves the read happened after the await.
    indexedAt: () => (state.indexPasses === 0 ? null : 1_700),
  };
  return state;
}

async function post(deps: RefreshDeps): Promise<Response> {
  const url = new URL("http://127.0.0.1/api/refresh");
  const response = await handleRefreshRequest(new Request(url, { method: "POST" }), url, deps);
  if (response === null) throw new Error("expected the refresh route to claim this request");
  return response;
}

describe("manual refresh", () => {
  test("re-indexes, forces the live read, and kicks every enabled environment", async () => {
    const state = harness();

    const body = await (await post(state.deps)).json() as RefreshSummary;

    expect(state.indexPasses).toBe(1);
    // Without `force` the reader would answer from its TTL and the press would change nothing.
    expect(state.forced).toEqual([true]);
    expect(state.kicked).toEqual(["feibo1", "feibo2"]);
    expect(body).toEqual({
      indexed: { files: 12, changed: 3, ms: 41, errors: [] },
      sources: [{ name: "orca-tab", ok: true, readAt: 7, stale: false, sessions: 1, error: null }],
      environments: ["feibo1", "feibo2"],
      indexedAt: 1_700,
    });
  });

  test("reports a source that is still failing rather than claiming success", async () => {
    const state = harness({
      sources: [{ name: "orca-tab", ok: false, readAt: 3, stale: true, sessions: 1, error: "runtime down" }],
    });

    const body = await (await post(state.deps)).json() as RefreshSummary;

    expect(body.sources[0]).toMatchObject({ ok: false, stale: true, error: "runtime down" });
  });

  test("says so when no environment is enabled", async () => {
    const state = harness({ environments: [] });

    const body = await (await post(state.deps)).json() as RefreshSummary;

    expect(body.environments).toEqual([]);
    expect(state.kicked).toEqual([]);
  });

  test("leaves other requests to the routes that own them", async () => {
    const state = harness();
    const refresh = new URL("http://127.0.0.1/api/refresh");
    const sessions = new URL("http://127.0.0.1/api/sessions");

    expect(await handleRefreshRequest(new Request(refresh), refresh, state.deps)).toBeNull();
    expect(await handleRefreshRequest(new Request(sessions, { method: "POST" }), sessions, state.deps)).toBeNull();
    expect(state.indexPasses).toBe(0);
  });

  test("rejects a cross-site press", async () => {
    const state = harness();
    const url = new URL("http://127.0.0.1/api/refresh");
    const request = new Request(url, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } });

    await expect(handleRefreshRequest(request, url, state.deps)).rejects.toThrow("cross-site");
    expect(state.indexPasses).toBe(0);
  });
});
