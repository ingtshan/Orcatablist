import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionOutboxRequest, type SessionOutboxRouteDeps } from "../src/session-outbox-routes";
import { openSessionOutboxDatabase, SessionOutboxStore } from "../src/session-outbox";
import { createSentInputStore } from "../src/session-send";
import type { LiveInfo } from "../src/types";

const SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";
const ORIGIN = "http://127.0.0.1:47831";
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "orcatab-outbox-"));
  temporaryDirectories.push(directory);
  return join(directory, "outbox.db");
}

function live(status = "done"): LiveInfo {
  return {
    pid: 42, status, updatedAt: 1_000, waitingFor: null,
    name: "Claude", handle: "term_outbox", tabId: "tab_outbox", leafId: "leaf_outbox",
  };
}

function routeDeps(outbox: SessionOutboxStore, status = "done") {
  const calls: string[][] = [];
  const deps: SessionOutboxRouteDeps = {
    outbox,
    store: createSentInputStore(),
    findLive: () => live(status),
    psEnv: async () => "",
    orcaJson: async (args) => { calls.push(args); return { ok: true, result: {} }; },
    now: () => 2_000,
  };
  return { deps, calls };
}

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(path: string, method = "GET", body?: unknown, deps?: SessionOutboxRouteDeps) {
  const req = request(path, method, body);
  const response = await handleSessionOutboxRequest(req, new URL(req.url), deps!);
  expect(response).not.toBeNull();
  return { response: response!, body: await response!.json() as Record<string, any> };
}

describe("SessionOutboxStore", () => {
  test("persists local and remote queued inputs across a database reopen", () => {
    const path = temporaryPath();
    const ids = ["queued-local", "queued-remote"];
    const store = new SessionOutboxStore(openSessionOutboxDatabase(path), () => 1_234, () => ids.shift()!);
    store.add({ agent: "claude", sid: SID, text: "先记下这个想法" });
    store.add({ agent: "codex", env: "n1", sid: "remote-session", text: "远程待发送" });
    expect(store.version).toBe(2);
    store.close();

    const reopened = new SessionOutboxStore(openSessionOutboxDatabase(path));
    expect(reopened.list()).toEqual([
      { id: "queued-local", agent: "claude", sid: SID, text: "先记下这个想法", createdAt: 1_234 },
      { id: "queued-remote", agent: "codex", env: "n1", sid: "remote-session", text: "远程待发送", createdAt: 1_234 },
    ]);
    expect(reopened.version).toBe(2);
    reopened.close();
  });
});

describe("session outbox routes", () => {
  test("order and automatic mode are explicit persisted same-origin writes", async () => {
    const outbox = new SessionOutboxStore(openSessionOutboxDatabase(":memory:"));
    try {
      const { deps, calls } = routeDeps(outbox);
      const first = outbox.add({ agent: "claude", sid: SID, text: "first" });
      const second = outbox.add({ agent: "claude", sid: SID, text: "second" });
      const sorted = await call("/api/session-outbox/order", "PATCH", {
        agent: "claude", sid: SID, ids: [second.id, first.id], version: outbox.version,
      }, deps);
      expect(sorted.response.status).toBe(200);
      const mode = await call("/api/session-outbox/settings", "PATCH", { agent: "claude", sid: SID, autoSend: true }, deps);
      expect(mode.response.status).toBe(200); expect(calls).toEqual([]);
      const listed = await call("/api/session-outbox", "GET", undefined, deps);
      expect(listed.body.items.map((item: { text: string }) => item.text)).toEqual(["second", "first"]);
      expect(listed.body.settings[0].autoSend).toBeTrue();
      const crossSite = new Request(`${ORIGIN}/api/session-outbox/settings`, { method: "PATCH",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ agent: "claude", sid: SID, autoSend: false }) });
      const denied = await handleSessionOutboxRequest(crossSite, new URL(crossSite.url), deps);
      expect(denied?.status).toBe(400); expect(outbox.setting({ agent: "claude", sid: SID }).autoSend).toBeTrue();
    } finally { outbox.close(); }
  });

  test("queues without sending, lists with an ETag, and deletes explicitly", async () => {
    const outbox = new SessionOutboxStore(openSessionOutboxDatabase(":memory:"), () => 1_000, () => "queued-1");
    const { deps, calls } = routeDeps(outbox, "working");
    const queued = await call("/api/session-outbox", "POST", {
      agent: "claude", sid: SID, text: "  后面继续检查这个想法  ",
    }, deps);
    expect(queued.response.status).toBe(201);
    expect(queued.body.item).toMatchObject({ id: "queued-1", text: "后面继续检查这个想法" });
    expect(calls).toEqual([]);

    const listed = await call("/api/session-outbox", "GET", undefined, deps);
    expect(listed.response.headers.get("ETag")).toBe('"outbox-1"');
    expect(listed.body.items).toHaveLength(1);

    const deleted = await call("/api/session-outbox/queued-1", "DELETE", undefined, deps);
    expect(deleted.body).toEqual({ ok: true, version: 2 });
    expect(outbox.list()).toEqual([]);
    outbox.close();
  });

  test("sends one queued input only on request and removes it after Orca succeeds", async () => {
    const outbox = new SessionOutboxStore(openSessionOutboxDatabase(":memory:"), () => 1_000, () => "queued-2");
    const item = outbox.add({ agent: "claude", env: "n1", sid: SID, text: "现在发送" });
    const { deps, calls } = routeDeps(outbox);
    const sent = await call(`/api/session-outbox/${item.id}/send`, "POST", {
      expectedHandle: "term_outbox", expectedStatus: "done",
    }, deps);
    expect(sent.body.record).toMatchObject({ agent: "claude", env: "n1", sid: SID, text: "现在发送" });
    expect(calls).toEqual([[
      "terminal", "send", "--terminal", "term_outbox", "--text", "现在发送", "--enter",
      "--environment", "n1", "--json",
    ]]);
    expect(outbox.get(item.id)).toBeNull();
    expect(deps.store.get("claude", SID, "n1")).toMatchObject({ text: "现在发送" });
    outbox.close();
  });

  test("keeps a queued input when the session is not ready or Orca rejects the send", async () => {
    const outbox = new SessionOutboxStore(openSessionOutboxDatabase(":memory:"), () => 1_000, () => "queued-3");
    const item = outbox.add({ agent: "claude", sid: SID, text: "不要丢" });
    const { deps, calls } = routeDeps(outbox, "working");
    const sent = await call(`/api/session-outbox/${item.id}/send`, "POST", {}, deps);
    expect(sent.response.status).toBe(409);
    expect(sent.body.code).toBe("not-waiting");
    expect(calls).toEqual([]);
    expect(outbox.get(item.id)?.text).toBe("不要丢");
    outbox.close();
  });
});
