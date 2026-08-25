import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type OrcaTabServer } from "../src/server";
import { createIndexer } from "../src/indexer";
import type { FocusDeps } from "../src/focus";

const SID = "44444444-4444-4444-4444-444444444444";
let root = "";
let baseUrl = "";
let app: OrcaTabServer;
let claudeDir = "";
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
  const projectDir = join(claudeDir, "projects", "fixture");
  const cwd = join(root, "workspace", "fixture-project");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const lines = [
    JSON.stringify({ type: "ai-title", aiTitle: "课堂树会话" }),
    JSON.stringify({ type: "user", message: { content: "请解释课堂树结构" }, timestamp: "2026-08-25T08:00:00.000Z", cwd, gitBranch: "main" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "课堂树用于组织内容" }] }, timestamp: "2026-08-25T08:00:01.000Z" }),
  ];
  sessionPath = join(projectDir, `${SID}.jsonl`);
  writeFileSync(sessionPath, `${lines.join("\n")}\n`);
  app = await createServer({
    port: 0, claudeDir, dataDir: join(root, "data"),
    orcaBin: join(root, "missing-orca"), focusDeps, startTimers: false, quiet: true,
  });
  baseUrl = `http://127.0.0.1:${app.server.port}`;
});

afterAll(() => { app.stop(); rmSync(root, { recursive: true, force: true }); });

describe("HTTP server", () => {
  test("reports health and indexed session count", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, sessions: 1, version: "p2", dataVersion: 1, watch: "timer" });
  });

  test("serves projects and sessions", async () => {
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "fixture-project", sessionCount: 1 });
    const sessions = await (await fetch(`${baseUrl}/api/sessions?limit=99999`)).json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sid: SID, displayTitle: "课堂树会话", live: null });
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
    await createIndexer({ claudeDir, db: app.db }).indexAll();
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
    expect(html).toContain('copyText(`claude --resume ${row.sid}`, "已复制命令")');
  });

  test("validates focus URIs and returns JSON 404 errors", async () => {
    const invalid = await fetch(`${baseUrl}/focus?uri=bad`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid orcatab uri" });
    const malformed = await fetch(`${baseUrl}/api/focus/%E0%A4%A`, { method: "POST" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid session id encoding" });
    const missing = await fetch(`${baseUrl}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found" });
  });
});
