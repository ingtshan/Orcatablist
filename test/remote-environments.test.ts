import { describe, expect, test } from "bun:test";
import { OrcaDatabase } from "../src/db";
import {
  EnvironmentStore, openEnvironmentsDatabase, validateEnvironmentPatch,
} from "../src/remote-environments";
import { handleEnvironmentRequest, type RemoteRouteDeps } from "../src/remote-routes";
import type { EnvironmentHealth, RemoteIndexing } from "../src/remote-poller";

const VALID = { name: "feibo2", sshUser: "bb00", sshHost: "192.168.24.117" };

describe("environment validation", () => {
  test("accepts a plain user@host and applies defaults", () => {
    const config = validateEnvironmentPatch(VALID);
    expect(config).toMatchObject({
      name: "feibo2", sshUser: "bb00", sshHost: "192.168.24.117", sshPort: null,
      enabled: false, agents: { claude: true }, pollMs: 15_000,
    });
  });

  test.each([
    [{ ...VALID, name: "local" }],
    [{ ...VALID, name: "has space" }],
    [{ ...VALID, name: "a:b" }],
    [{ ...VALID, sshUser: "-oProxyCommand=evil" }],
    [{ ...VALID, sshHost: "-oProxyCommand=evil" }],
    [{ ...VALID, sshHost: "host evil" }],
    [{ ...VALID, sshHost: "host;rm" }],
    [{ ...VALID, sshPort: 0 }],
    [{ ...VALID, sshPort: 70_000 }],
    [{ ...VALID, pollMs: 100 }],
  ])("rejects unsafe or malformed input %#", (body) => {
    expect(() => validateEnvironmentPatch(body as never)).toThrow();
  });
});

describe("environment store", () => {
  test("upserts, versions and removes configs", () => {
    const store = new EnvironmentStore(openEnvironmentsDatabase(":memory:"), () => 42);
    expect(store.version).toBe(0);
    store.upsert(validateEnvironmentPatch({ ...VALID, enabled: true, pollMs: 30_000 }));
    expect(store.version).toBe(1);
    expect(store.get("feibo2")).toMatchObject({ enabled: true, pollMs: 30_000, updatedAt: 42 });
    expect(store.listEnabled()).toHaveLength(1);
    store.upsert(validateEnvironmentPatch({ ...VALID, enabled: false }));
    expect(store.listEnabled()).toHaveLength(0);
    expect(store.remove("feibo2")).toBe(true);
    expect(store.remove("feibo2")).toBe(false);
    expect(store.list()).toHaveLength(0);
  });
});

interface FakeIndexing extends RemoteIndexing { reloads: number; kicks: string[]; }

function fakeIndexing(store: EnvironmentStore): FakeIndexing {
  const state = { reloads: 0, kicks: [] as string[] };
  return {
    get reloads() { return state.reloads; },
    get kicks() { return state.kicks; },
    reload: () => { state.reloads += 1; },
    kick: (name) => { state.kicks.push(name); },
    health: () => store.list().map((config): EnvironmentHealth => ({
      name: config.name, enabled: config.enabled, syncing: false, lastAttemptAt: null, lastOkAt: null,
      lastError: null, note: null, lastBytes: 0, lastFiles: 0, truncated: false, indexedSessions: 0,
      lastPullAt: null, lastCommitAt: null, pendingBytes: 0, pendingFiles: 0, failedFiles: 0,
    })),
    close: () => {},
  };
}

function request(method: string, path: string, body?: unknown): [Request, URL] {
  const url = new URL(`http://127.0.0.1${path}`);
  return [new Request(url, {
    method,
    headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), url];
}

function createDeps(): { deps: RemoteRouteDeps; indexing: FakeIndexing; db: OrcaDatabase } {
  const db = new OrcaDatabase(":memory:");
  const store = new EnvironmentStore(openEnvironmentsDatabase(":memory:"));
  const indexing = fakeIndexing(store);
  const deps: RemoteRouteDeps = {
    db, store, indexing,
    orcaJson: () => Promise.resolve({
      ok: true,
      result: { environments: [{ name: "feibo2", endpoints: [{ endpoint: "ws://192.168.24.117:6768" }] }] },
    } as never),
    probe: () => Promise.resolve({
      python: "3.9.6", home: "/Users/bb00",
      claude: { dir: "/x", ok: true, files: 3, bytes: 99 },
      codex: { dir: "/x/.codex/sessions", ok: false, files: 0, bytes: 0 },
      errors: [],
    }),
  };
  return { deps, indexing, db };
}

describe("environment routes", () => {
  test("save reloads pollers and kicks the enabled environment", async () => {
    const { deps, indexing } = createDeps();
    const response = await handleEnvironmentRequest(...request("POST", "/api/environments", { ...VALID, enabled: true }), deps);
    expect(response!.status).toBe(200);
    const payload = await response!.json() as { saved: string; environments: Array<{ name: string; health: unknown }> };
    expect(payload.saved).toBe("feibo2");
    expect(payload.environments[0]).toMatchObject({ name: "feibo2", enabled: true });
    expect(indexing.reloads).toBe(1);
    expect(indexing.kicks).toEqual(["feibo2"]);
  });

  test("delete purges the environment's indexed rows", async () => {
    const { deps, db } = createDeps();
    db.upsertSession({
      agent: "claude", env: "feibo2", sid: "aaaaaaaa-1111-2222-3333-444444444444",
      projectKey: "feibo2:/x", cwd: "/x", worktreeRoot: null, branch: null, title: null, firstPrompt: null,
      lastPrompt: "残留", lastInputAt: 1, promptCount: 1, filePath: "/x/a.jsonl", fileSize: 1, fileMtime: 1, parsedOffset: 1,
    });
    db.upsertProject({ key: "feibo2:/x", name: "x @feibo2", root: "", color: null });
    await handleEnvironmentRequest(...request("POST", "/api/environments", VALID), deps);
    const response = await handleEnvironmentRequest(...request("POST", "/api/environments/delete", { name: "feibo2" }), deps);
    expect((await response!.json() as { removed: boolean }).removed).toBe(true);
    expect(db.countSessionsByEnv("feibo2")).toBe(0);
    expect(db.listProjectRecords().some((project) => project.key.startsWith("feibo2:"))).toBe(false);
  });

  test("probe answers without saving anything", async () => {
    const { deps } = createDeps();
    const response = await handleEnvironmentRequest(...request("POST", "/api/environments/probe", VALID), deps);
    const payload = await response!.json() as { probe: { python: string } };
    expect(payload.probe.python).toBe("3.9.6");
    expect(deps.store.list()).toHaveLength(0);
  });

  test("candidates come from orca environment list minus saved names", async () => {
    const { deps } = createDeps();
    const before = await handleEnvironmentRequest(...request("GET", "/api/environments/candidates"), deps);
    expect(await before!.json()).toEqual({ candidates: [{ name: "feibo2", host: "192.168.24.117" }] });
    await handleEnvironmentRequest(...request("POST", "/api/environments", VALID), deps);
    const after = await handleEnvironmentRequest(...request("GET", "/api/environments/candidates"), deps);
    expect(await after!.json()).toEqual({ candidates: [] });
  });

  test("rejects cross-site writes", async () => {
    const { deps } = createDeps();
    const url = new URL("http://127.0.0.1/api/environments");
    const crossSite = new Request(url, {
      method: "POST", headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      body: JSON.stringify(VALID),
    });
    await expect(handleEnvironmentRequest(crossSite, url, deps)).rejects.toThrow("cross-site");
  });
});
