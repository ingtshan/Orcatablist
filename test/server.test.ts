import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type OrcaTabServer } from "../src/server";
import { createIndexer } from "../src/indexer";
import type { FocusDeps } from "../src/focus";

const SID = "44444444-4444-4444-4444-444444444444";
const CODEX_SID = "55555555-5555-5555-5555-555555555555";
const HERMES_SID = "20260811_031044_76b3bb";
let root = "";
let baseUrl = "";
let app: OrcaTabServer;
let claudeDir = "";
let codexDir = "";
let hermesDb = "";
let sessionPath = "";

const focusDeps: FocusDeps = {
  findLive: () => null,
  getSessionCwd: () => null,
  psEnv: async () => "",
  orcaJson: async () => ({ ok: false }),
  openOrca: async () => {},
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orcatab-server-"));
  claudeDir = join(root, "claude");
  codexDir = join(root, "codex");
  const projectDir = join(claudeDir, "projects", "fixture");
  const cwd = join(root, "workspace", "fixture-project");
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
    orcaBin: join(root, "missing-orca"), focusDeps, startTimers: false, quiet: true,
  });
  baseUrl = `http://127.0.0.1:${app.server.port}`;
});

afterAll(() => { app.stop(); rmSync(root, { recursive: true, force: true }); });

describe("HTTP server", () => {
  test("reports health and indexed session count", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true, sessions: 3, agents: ["claude", "codex", "hermes"], version: "p6", dataVersion: 1, watch: "timer",
    });
  });

  test("serves projects and sessions", async () => {
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "fixture-project", sessionCount: 3 });
    const sessions = await (await fetch(`${baseUrl}/api/sessions?limit=99999`)).json();
    expect(sessions).toHaveLength(3);
    expect(sessions.find((row: { agent: string }) => row.agent === "claude"))
      .toMatchObject({ agent: "claude", sid: SID, displayTitle: "课堂树会话", live: null });
    expect(sessions.find((row: { agent: string }) => row.agent === "codex"))
      .toMatchObject({ agent: "codex", sid: CODEX_SID, displayTitle: "Codex 测试会话", live: null });
    expect(sessions.find((row: { agent: string }) => row.agent === "hermes"))
      .toMatchObject({ agent: "hermes", sid: HERMES_SID, displayTitle: "Hermes 服务测试", live: null });
    expect(await (await fetch(`${baseUrl}/api/sessions?live=1`)).json()).toEqual([]);
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
    expect(etag).toMatch(/^"\d+-\d+"$/);
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
