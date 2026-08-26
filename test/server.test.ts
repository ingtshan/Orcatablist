import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type OrcaTabServer } from "../src/server";
import { createIndexer } from "../src/indexer";
import type { FocusDeps } from "../src/focus";
import type { SessionLiveReader } from "../src/session-live";
import type { LiveInfo } from "../src/types";

const SID = "44444444-4444-4444-4444-444444444444";
const CODEX_SID = "55555555-5555-5555-5555-555555555555";
const HERMES_SID = "20260811_031044_76b3bb";
const openTabs = new Map<string, LiveInfo>([
  [`codex/${CODEX_SID}`, {
    pid: null, status: "busy", waitingFor: null, name: "Codex fixture tab",
    handle: "term_codex", tabId: "tab_codex", leafId: "leaf_codex",
  }],
  [`hermes/${HERMES_SID}`, {
    pid: null, status: "idle", waitingFor: null, name: "Hermes fixture tab",
    handle: "term_hermes", tabId: "tab_hermes", leafId: "leaf_hermes",
  }],
]);
const sessionLiveReader: SessionLiveReader = {
  refresh: async () => openTabs,
  getLiveMap: () => openTabs,
  getLiveVersion: () => 1,
  findLive: async (agent, sid) => openTabs.get(`${agent}/${sid}`) ?? null,
};
let root = "";
let baseUrl = "";
let app: OrcaTabServer;
let claudeDir = "";
let codexDir = "";
let hermesDb = "";
let sessionPath = "";
let fixtureCwd = "";
let focusOpens = 0;
const focusCalls: string[][] = [];

const focusDeps: FocusDeps = {
  findLive: () => null,
  getSessionCwd: () => null,
  psEnv: async () => "",
  orcaJson: async (args) => {
    focusCalls.push(args);
    if (args[1] === "list") return { ok: true, result: { terminals: [
      { handle: "term_fixture", tabId: "tab_fixture", connected: true, orphaned: false, lastOutputAt: 10, worktreePath: fixtureCwd },
    ] } };
    if (args[1] === "focus") return { ok: true, result: { focus: { tabId: "tab_switched" } } };
    return { ok: false };
  },
  openOrca: async () => { focusOpens += 1; },
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orcatab-server-"));
  claudeDir = join(root, "claude");
  codexDir = join(root, "codex");
  const projectDir = join(claudeDir, "projects", "fixture");
  const cwd = join(root, "workspace", "fixture-project");
  fixtureCwd = cwd;
  mkdirSync(projectDir, { recursive: true });
  const codexSessionDir = join(codexDir, "sessions", "2026", "08", "25");
  mkdirSync(codexSessionDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const lines = [
    JSON.stringify({ type: "ai-title", aiTitle: "课堂树会话" }),
    JSON.stringify({ type: "user", message: { content: "请解释课堂树结构" }, timestamp: "2026-08-25T08:00:00.000Z", cwd, gitBranch: "main" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "课堂树用于组织内容" }] }, timestamp: "2026-08-25T08:00:01.000Z" }),
  ];
  sessionPath = join(projectDir, `${SID}.jsonl`);
  writeFileSync(sessionPath, `${lines.join("\n")}\n`);
  writeFileSync(join(codexSessionDir, `rollout-2026-08-25T09-00-00-${CODEX_SID}.jsonl`), [
    JSON.stringify({ type: "session_meta", timestamp: "2026-08-25T09:00:00.000Z", payload: { session_id: CODEX_SID, cwd, git: { branch: "codex-test" } } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-08-25T09:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex 页面测试" }] } }),
  ].join("\n") + "\n");
  writeFileSync(join(codexDir, "session_index.jsonl"), `${JSON.stringify({ id: CODEX_SID, thread_name: "Codex 测试会话" })}\n`);
  hermesDb = join(root, "hermes-state.db");
  const hermes = new Database(hermesDb, { create: true });
  hermes.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT, display_name TEXT, cwd TEXT, git_branch TEXT,
      started_at REAL, message_count INTEGER
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER
    );
  `);
  hermes.query(`INSERT INTO sessions
    (id, title, display_name, cwd, git_branch, started_at, message_count) VALUES (?, ?, NULL, ?, ?, ?, ?)`)
    .run(HERMES_SID, "Hermes 服务测试", cwd, "hermes-test", 1_777_777_000, 1);
  hermes.query(`INSERT INTO messages
    (id, session_id, role, content, timestamp, active) VALUES (1, ?, 'user', ?, ?, 1)`)
    .run(HERMES_SID, "Hermes 页面测试", 1_777_777_001);
  hermes.close();
  app = await createServer({
    port: 0, claudeDir, codexDir, hermesDb, dataDir: join(root, "data"),
    orcaBin: join(root, "missing-orca"), focusDeps, sessionLiveReader, startTimers: false, quiet: true,
  });
  baseUrl = `http://127.0.0.1:${app.server.port}`;
});

afterAll(() => { app.stop(); rmSync(root, { recursive: true, force: true }); });

describe("HTTP server", () => {
  test("reports health and indexed session count", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true, sessions: 3, goals: 0, agents: ["claude", "codex", "hermes"], version: "p7", dataVersion: 1, watch: "timer",
    });
  });

  test("serves projects and sessions", async () => {
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "fixture-project", sessionCount: 3 });
    const sessions = await (await fetch(`${baseUrl}/api/sessions?limit=99999`)).json();
    expect(sessions).toHaveLength(3);
    expect(sessions.find((row: { agent: string }) => row.agent === "claude"))
      .toMatchObject({ agent: "claude", sid: SID, displayTitle: "课堂树会话", live: null, goals: [] });
    expect(sessions.find((row: { agent: string }) => row.agent === "codex"))
      .toMatchObject({
        agent: "codex", sid: CODEX_SID, displayTitle: "Codex 测试会话",
        live: { handle: "term_codex", tabId: "tab_codex", status: "busy" },
      });
    expect(sessions.find((row: { agent: string }) => row.agent === "hermes"))
      .toMatchObject({
        agent: "hermes", sid: HERMES_SID, displayTitle: "Hermes 服务测试",
        live: { handle: "term_hermes", tabId: "tab_hermes", status: "idle" },
      });
    expect(await (await fetch(`${baseUrl}/api/sessions?live=1`)).json()).toHaveLength(2);
  });

  test("focuses the latest indexed worktree for a known project", async () => {
    focusCalls.length = 0;
    focusOpens = 0;
    const [project] = await (await fetch(`${baseUrl}/api/projects`)).json();
    const response = await fetch(`${baseUrl}/api/projects/focus`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: project.key }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      action: "switched", handle: "term_fixture", tabId: "tab_switched", cwd: fixtureCwd,
    });
    expect(focusOpens).toBe(1);
    expect(focusCalls).toEqual([
      ["terminal", "list", "--worktree", `path:${fixtureCwd}`, "--json"],
      ["terminal", "focus", "--terminal", "term_fixture", "--json"],
    ]);

    const missingKey = await fetch(`${baseUrl}/api/projects/focus`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toEqual({ error: "projectKey is required" });
    const unknown = await fetch(`${baseUrl}/api/projects/focus`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectKey: "/unknown" }),
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "project not found" });
  });

  test("search returns grouped highlighted hits", async () => {
    const results = await (await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("课堂树")}`)).json();
    expect(results).toHaveLength(1);
    expect(results[0].hits.length).toBeGreaterThan(0);
    expect(results[0].hits[0].snippet).toContain("‹");
    expect(await (await fetch(`${baseUrl}/api/search?q=%20%20`)).json()).toEqual([]);
  });

  test("returns 304 for a matching ETag and changes it after indexing", async () => {
    const firstProjects = await fetch(`${baseUrl}/api/projects`);
    const projectEtag = firstProjects.headers.get("ETag");
    await firstProjects.json();
    const unchangedProjects = await fetch(`${baseUrl}/api/projects`, { headers: { "If-None-Match": projectEtag! } });
    expect(unchangedProjects.status).toBe(304);
    expect(unchangedProjects.headers.get("ETag")).toBe(projectEtag);

    const first = await fetch(`${baseUrl}/api/sessions`);
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^"\d+-\d+-\d+"$/);
    await first.json();
    const unchanged = await fetch(`${baseUrl}/api/sessions`, { headers: { "If-None-Match": etag! } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("ETag")).toBe(etag);
    expect(await unchanged.text()).toBe("");

    appendFileSync(sessionPath, `${JSON.stringify({
      type: "user", message: { content: "ETag 更新" }, timestamp: "2026-08-25T09:00:00.000Z",
    })}\n`);
    await createIndexer({ claudeDir, codexDir, hermesDb, db: app.db }).indexAll();
    const changed = await fetch(`${baseUrl}/api/sessions`, { headers: { "If-None-Match": etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
  });

  test("serves the single page with an HTML content type and title", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>");
    expect(html).toContain("orcatab://${row.agent}/${row.sid}");
    expect(html).toContain("codex resume ${row.sid}");
    expect(html).toContain("hermes --resume ${row.sid}");
    expect(html).toContain("agent-hermes");
    expect(html).toContain('row.live ? "定位" : "恢复"');
    expect(html).toContain("回到 Orca");
    expect(html).toContain("/api/projects/focus");
    expect(html).toContain("新建目标");
    expect(html).toContain("证据");
  });

  test("serves goal CRUD, links, suggestions, goal refs, validation, and versioned ETags", async () => {
    const initialSessions = await fetch(`${baseUrl}/api/sessions`);
    const initialEtag = initialSessions.headers.get("ETag");
    await initialSessions.json();

    const invalidCreate = await fetch(`${baseUrl}/api/goals`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "  " }),
    });
    expect(invalidCreate.status).toBe(400);
    expect(await invalidCreate.json()).toEqual({ error: "name is required" });

    const create = await fetch(`${baseUrl}/api/goals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "课堂树目标", externalRef: "gtd:5", color: "#123456" }),
    });
    expect(create.status).toBe(201);
    const goal = await create.json();
    expect(goal).toMatchObject({ name: "课堂树目标", status: "active", externalRef: "gtd:5", color: "#123456" });

    const afterCreate = await fetch(`${baseUrl}/api/sessions`, { headers: { "If-None-Match": initialEtag! } });
    expect(afterCreate.status).toBe(200);
    expect(afterCreate.headers.get("ETag")).not.toBe(initialEtag);
    await afterCreate.json();
    expect(await (await fetch(`${baseUrl}/healthz`)).json()).toMatchObject({ goals: 1, version: "p7" });

    let goals = await (await fetch(`${baseUrl}/api/goals`)).json();
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ id: goal.id, sessionCount: 0, lastActivityAt: null });
    let detail = await (await fetch(`${baseUrl}/api/goals/${goal.id}`)).json();
    expect(detail.goal.id).toBe(goal.id);
    expect(detail.sessions).toEqual([]);
    expect(detail.suggestions.some((row: { sid: string }) => row.sid === SID)).toBeTrue();

    const patch = await fetch(`${baseUrl}/api/goals/${goal.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "课堂树完成", status: "done", externalRef: null }),
    });
    expect(await patch.json()).toMatchObject({ name: "课堂树完成", status: "done", externalRef: null });
    const badStatus = await fetch(`${baseUrl}/api/goals/${goal.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "blocked" }),
    });
    expect(badStatus.status).toBe(400);

    for (const badBody of [
      { agent: "other", sid: SID, kind: "confirmed" },
      { agent: "claude", sid: SID, kind: "maybe" },
      { agent: "claude", sid: "bad/id", kind: "confirmed" },
    ]) {
      const response = await fetch(`${baseUrl}/api/goals/${goal.id}/links`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(badBody),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }

    const setLink = async (kind: "confirmed" | "dismissed") => {
      const response = await fetch(`${baseUrl}/api/goals/${goal.id}/links`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "claude", sid: SID, kind }),
      });
      expect(await response.json()).toEqual({ ok: true });
    };
    await setLink("confirmed");
    let sessions = await (await fetch(`${baseUrl}/api/sessions?limit=3000`)).json();
    expect(sessions.find((row: { sid: string }) => row.sid === SID).goals).toEqual([{ id: goal.id, name: "课堂树完成" }]);
    const search = await (await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("课堂树")}`)).json();
    expect(search[0].goals).toEqual([{ id: goal.id, name: "课堂树完成" }]);
    detail = await (await fetch(`${baseUrl}/api/goals/${goal.id}`)).json();
    expect(detail.sessions.map((row: { sid: string }) => row.sid)).toEqual([SID]);
    expect(detail.suggestions.some((row: { sid: string }) => row.sid === SID)).toBeFalse();
    goals = await (await fetch(`${baseUrl}/api/goals`)).json();
    expect(goals[0].sessionCount).toBe(1);
    expect(goals[0].lastActivityAt).toBe(Date.parse("2026-08-25T09:00:00.000Z"));

    await setLink("dismissed");
    detail = await (await fetch(`${baseUrl}/api/goals/${goal.id}`)).json();
    expect(detail.sessions).toEqual([]);
    expect(detail.suggestions.some((row: { sid: string }) => row.sid === SID)).toBeFalse();
    await setLink("confirmed");

    const unlink = await fetch(`${baseUrl}/api/goals/${goal.id}/links/claude/${SID}`, { method: "DELETE" });
    expect(await unlink.json()).toEqual({ ok: true });
    sessions = await (await fetch(`${baseUrl}/api/sessions`)).json();
    expect(sessions.find((row: { sid: string }) => row.sid === SID).goals).toEqual([]);
    await setLink("confirmed");

    const remove = await fetch(`${baseUrl}/api/goals/${goal.id}`, { method: "DELETE" });
    expect(await remove.json()).toEqual({ ok: true });
    expect(await (await fetch(`${baseUrl}/api/goals`)).json()).toEqual([]);
    expect((await fetch(`${baseUrl}/api/goals/${goal.id}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/goals/missing`, { method: "DELETE" })).status).toBe(404);
  });

  test("validates focus URIs and returns JSON 404 errors", async () => {
    const invalid = await fetch(`${baseUrl}/focus?uri=bad`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid orcatab uri" });
    const malformed = await fetch(`${baseUrl}/api/focus/%E0%A4%A`, { method: "POST" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid session id encoding" });
    const codexPost = await fetch(`${baseUrl}/api/focus/codex/${CODEX_SID}`, { method: "POST" });
    expect(codexPost.status).toBe(200);
    expect(await codexPost.json()).toEqual({ action: "manual", reason: "unknown-session", command: null });
    const codexUri = await fetch(`${baseUrl}/focus?uri=${encodeURIComponent(`orcatab://codex/${CODEX_SID}`)}`);
    expect(codexUri.status).toBe(200);
    expect(await codexUri.text()).toContain("manual unknown-session");
    const claudeUri = await fetch(`${baseUrl}/focus?uri=${encodeURIComponent(`orcatab://claude/${SID}`)}`);
    expect(claudeUri.status).toBe(200);
    const legacyPost = await fetch(`${baseUrl}/api/focus/${SID}`, { method: "POST" });
    expect(legacyPost.status).toBe(200);
    const hermesPost = await fetch(`${baseUrl}/api/focus/hermes/${HERMES_SID}`, { method: "POST" });
    expect(hermesPost.status).toBe(200);
    expect(await hermesPost.json()).toEqual({ action: "manual", reason: "unknown-session", command: null });
    const hermesUri = await fetch(`${baseUrl}/focus?uri=${encodeURIComponent(`orcatab://hermes/${HERMES_SID}`)}`);
    expect(hermesUri.status).toBe(200);
    expect(await hermesUri.text()).toContain("manual unknown-session");
    const missing = await fetch(`${baseUrl}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found" });
  });
});
