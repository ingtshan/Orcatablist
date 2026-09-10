import { afterEach, describe, expect, test } from "bun:test";
import { OrcaDatabase } from "../src/db";
import { handleSessionBriefRequest, type SessionBriefRouteDeps } from "../src/session-brief-routes";
import { applyBriefEvents, getBrief, listBriefs } from "../src/session-briefs";
import { openProjectPreferencesDatabase, ProjectPreferencesStore } from "../src/project-preferences";
import { emptySession } from "../src/sources/transcript";
import type { LiveSnapshot } from "../src/live-source";
import type { SessionBrief } from "../src/session-briefs";
import type { SessionRow } from "../src/types";

const SID = "11111111-2222-3333-4444-555555555555";
const ROOT = "http://127.0.0.1/api/session-briefs";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function harness(final = true) {
  const db = new OrcaDatabase(":memory:"); db.setMeta("briefs_enabled_at", "0");
  const preferences = new ProjectPreferencesStore(openProjectPreferencesDatabase(":memory:"));
  cleanup.push(() => { preferences.close(); db.close(); });
  const row = { ...emptySession({ agent: "codex", sid: SID, path: "/fixture/log.jsonl", size: 0, mtime: 0 }),
    projectKey: "project", cwd: "/fixture", worktreeRoot: "/fixture" };
  db.upsertProject({ key: "project", name: "Project", root: "/fixture", color: null }); db.upsertSession(row);
  applyBriefEvents(db.raw, row, [
    { kind: "user", text: "最新输入\n<script>安全文本</script>", key: "user1", at: 1 },
    { kind: "assistant", text: "1\n2\n3\n4\n5\n6\n重要结尾", key: "response1", at: 2, complete: final },
  ]);
  const snapshot: LiveSnapshot = { at: 10, live: new Map([[`codex/${SID}`,
    { status: "done", updatedAt: 10, waitingFor: null, name: null, pid: null }]]), sources: [] };
  const deps: SessionBriefRouteDeps = { db, preferences, liveReader: {
    refresh: async () => snapshot.live, refreshSnapshot: async () => snapshot,
    getSnapshot: () => snapshot, getLiveMap: () => snapshot.live, getLiveVersion: () => 1, findLive: async () => null,
  } };
  async function request(path = "", init?: RequestInit): Promise<Response> {
    const url = new URL(ROOT + path);
    const response = await handleSessionBriefRequest(new Request(url, init), url, deps);
    if (!response) throw new Error("route missing");
    return response;
  }
  return { db, preferences, snapshot, request };
}

describe("brief API", () => {
  test("briefs carry current live state, including running, offline and stale sources", async () => {
    const app = harness();
    const current = async () => {
      const body = await (await app.request()).json() as { briefs: Array<{ session: SessionRow }> };
      return body.briefs[0]!.session.live;
    };
    expect((await current())?.status).toBe("done");
    app.snapshot.live.set(`codex/${SID}`, { status: "working", updatedAt: 20,
      waitingFor: null, name: null, pid: null, handle: "real-terminal" });
    expect(await current()).toMatchObject({ status: "working", handle: "real-terminal" });
    app.snapshot.sources = [{ name: "orca-tab", ok: false, readAt: 20, stale: true, sessions: 1, error: "offline" }];
    expect(await current()).toBeNull();
    app.snapshot.sources = [];
    app.snapshot.live.clear();
    expect(await current()).toBeNull();
  });

  test("a remote live identity cannot supply the local brief's terminal", async () => {
    const app = harness();
    app.snapshot.live.clear();
    app.snapshot.live.set(`remote:codex/${SID}`, { status: "done", updatedAt: 20,
      waitingFor: null, name: null, pid: null, handle: "remote-terminal" });
    const body = await (await app.request()).json() as { briefs: Array<{ session: SessionRow }> };
    expect(body.briefs[0]!.session.live).toBeNull();
  });

  test("list and full-response GETs never mark a brief read", async () => {
    const app = harness();
    const response = await app.request();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as { briefs: Array<SessionBrief & { session: { sid: string } }> };
    expect(body.briefs).toHaveLength(1);
    expect(body.briefs[0]!.response).toBe("…\n2\n3\n4\n5\n6\n重要结尾");
    expect(body.briefs[0]!.session.sid).toBe(SID);
    const detail = await (await app.request("/" + body.briefs[0]!.id)).json() as SessionBrief;
    expect(detail.input).toBe("最新输入\n<script>安全文本</script>");
    expect(detail.response).toBe("1\n2\n3\n4\n5\n6\n重要结尾");
    expect(getBrief(app.db.raw, detail.id)!.readAt).toBeNull();
  });

  test("explicit read receipt is persistent and reversible", async () => {
    const app = harness(); const id = listBriefs(app.db.raw)[0]!.id;
    const post = (read: boolean) => app.request("/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [id], read }) });
    const receipt = await (await post(true)).json() as { readAt: number };
    expect(getBrief(app.db.raw, id)!.readAt).toBe(receipt.readAt);
    await post(false);
    expect(getBrief(app.db.raw, id)!.readAt).toBeNull();
  });

  test("archived projects are hidden without deleting their briefs", async () => {
    const app = harness();
    app.preferences.update("project", { archived: true });
    expect(await (await app.request()).json()).toEqual({ briefs: [] });
    expect(listBriefs(app.db.raw)).toHaveLength(1);
    app.preferences.update("project", { archived: false });
    expect((await (await app.request()).json() as { briefs: unknown[] }).briefs).toHaveLength(1);
  });

  test("stale source state cannot generate a completion", async () => {
    const app = harness(false);
    app.snapshot.sources = [{ name: "orca-tab", ok: false, readAt: 10, stale: true, sessions: 1, error: "offline" }];
    expect(await (await app.request()).json()).toEqual({ briefs: [] });
    app.snapshot.sources = [{ name: "orca-tab", ok: true, readAt: 10, stale: false, sessions: 1, error: null }];
    expect((await (await app.request()).json() as { briefs: unknown[] }).briefs).toHaveLength(1);
  });

  test("cross-site writes and malformed receipts are rejected without clearing unread", async () => {
    const app = harness(); const id = listBriefs(app.db.raw)[0]!.id;
    await expect(app.request("/read", { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ ids: [id], read: true }) })).rejects.toThrow("cross-site");
    await expect(app.request("/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ["bad"], read: true }) })).rejects.toThrow("invalid brief");
    expect(getBrief(app.db.raw, id)!.readAt).toBeNull();
    expect((await app.request("/" + "a".repeat(64))).status).toBe(404);
  });
});
