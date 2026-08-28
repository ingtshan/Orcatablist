import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type OrcaTabServer } from "../src/server";
import type { DiscoveryReaders } from "../src/discovery";
import { createIndexer } from "../src/indexer";
import type { FocusDeps } from "../src/focus";
import type { OrcaWorktreeAuditReader } from "../src/orca-worktree-audit";
import type { SessionLiveReader } from "../src/session-live";
import type { LiveInfo } from "../src/types";

const SID = "44444444-4444-4444-4444-444444444444";
const CODEX_SID = "55555555-5555-5555-5555-555555555555";
const HERMES_SID = "20260811_031044_76b3bb";
const LIVE_ONLY_SID = "66666666-6666-6666-6666-666666666666";
const openTabs = new Map<string, LiveInfo>([
  [`claude/${LIVE_ONLY_SID}`, {
    pid: 666, status: "idle", waitingFor: null, name: "Claude process without transcript",
  }],
  [`codex/${CODEX_SID}`, {
    pid: null, status: "working", updatedAt: 30, waitingFor: null, name: "Codex fixture tab",
    handle: "term_codex", tabId: "tab_codex", leafId: "leaf_codex",
  }],
  [`hermes/${HERMES_SID}`, {
    pid: null, status: "done", updatedAt: 20, waitingFor: null, name: "Hermes fixture tab",
    handle: "term_hermes", tabId: "tab_hermes", leafId: "leaf_hermes",
  }],
]);
let liveRefreshes = 0;
const sessionLiveReader: SessionLiveReader = {
  refresh: async () => { liveRefreshes += 1; return openTabs; },
  getLiveMap: () => openTabs,
  getLiveVersion: () => 1,
  findLive: async (agent, sid) => openTabs.get(`${agent}/${sid}`) ?? null,
};
const orcaAuditReader: OrcaWorktreeAuditReader = {
  getVersion: () => 1,
  refresh: async () => ({
    auditedAt: 1,
    summary: {
      totalWorktrees: 42, completedWorktrees: 12, archivedWorktrees: 0,
      ready: 10, review: 1, hold: 1,
      lumina: { total: 42, completed: 11, inProgress: 29, inReview: 2, archived: 0 },
    },
    items: [{
      id: "lumina::kg-core", name: "kg-core", projectId: "github:feibo-ai/lumina", path: "/fixture/kg-core",
      branch: "refs/heads/kg-core", head: "abc", isMainWorktree: false, pathExists: true,
      dirtyFileCount: 0, connectedTerminals: 0, mergeTarget: "integration/main", headInMergeTarget: true,
      recommendation: "ready", reasons: ["HEAD 已包含在 integration/main"], comment: "merged into integration/main",
    }],
    warnings: [],
  }),
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
let resourceRoots: string[] = [];
const unavailablePaths = new Set<string>();

const discovery: DiscoveryReaders = {
  gateway: {
    getVersion: () => 1,
    refresh: async () => ({
      scannedAt: 1, cacheTtlMs: 30_000, sources: ["fixture-nginx"], warnings: [],
      files: [{
        source: "fixture-nginx", path: "/etc/nginx/routes/fixture.conf",
        sourcePath: "/tmp/fixture.conf", content: "server { listen 80; }",
      }],
      routes: [{
        source: "fixture-nginx", file: "/etc/nginx/routes/fixture.conf",
        serverNames: ["fixture.localhost"], listen: ["80"], location: "/",
        proxyPass: "http://host.docker.internal:4321", upstreamPort: 4321,
        urls: ["http://fixture.localhost"],
      }],
    }),
  },
  resources: {
    getVersion: () => 1,
    refresh: async (roots) => {
      resourceRoots = roots;
      return {
        scannedAt: 1, cacheTtlMs: 15_000, warnings: [],
        resources: fixtureCwd ? { [fixtureCwd]: [{
          worktreeRoot: fixtureCwd, appName: "fixture-web", pid: 123, port: 4321,
          links: [{ kind: "gateway", url: "http://fixture.localhost/", status: 200 }],
        }] } : {},
      };
    },
  },
};

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
  mkdirSync(projectDir, { recursive: true });
  const codexSessionDir = join(codexDir, "sessions", "2026", "08", "25");
  mkdirSync(codexSessionDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const gitInit = Bun.spawnSync(["git", "init", cwd], { stdout: "pipe", stderr: "pipe" });
  if (gitInit.exitCode !== 0) throw new Error(new TextDecoder().decode(gitInit.stderr));
  fixtureCwd = realpathSync(cwd);
  const sessionCwd = join(cwd, "packages", "app");
  mkdirSync(sessionCwd, { recursive: true });
  const lines = [
    JSON.stringify({ type: "ai-title", aiTitle: "课堂树会话" }),
    JSON.stringify({ type: "user", message: { content: "请解释课堂树结构" }, timestamp: "2026-08-25T08:00:00.000Z", cwd: sessionCwd, gitBranch: "main" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "课堂树用于组织内容" }] }, timestamp: "2026-08-25T08:00:01.000Z" }),
  ];
  sessionPath = join(projectDir, `${SID}.jsonl`);
  writeFileSync(sessionPath, `${lines.join("\n")}\n`);
  writeFileSync(join(codexSessionDir, `rollout-2026-08-25T09-00-00-${CODEX_SID}.jsonl`), [
    JSON.stringify({ type: "session_meta", timestamp: "2026-08-25T09:00:00.000Z", payload: { session_id: CODEX_SID, cwd: sessionCwd, git: { branch: "codex-test" } } }),
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
    .run(HERMES_SID, "Hermes 服务测试", sessionCwd, "hermes-test", 1_777_777_000, 1);
  hermes.query(`INSERT INTO messages
    (id, session_id, role, content, timestamp, active) VALUES (1, ?, 'user', ?, ?, 1)`)
    .run(HERMES_SID, "Hermes 页面测试", 1_777_777_001);
  hermes.close();
  app = await createServer({
    port: 0, claudeDir, codexDir, hermesDb, dataDir: join(root, "data"),
    orcaBin: join(root, "missing-orca"), focusDeps, sessionLiveReader, discovery, orcaAuditReader,
    startTimers: false, quiet: true,
    directoryPathExists: (path) => !unavailablePaths.has(path) && existsSync(path),
  });
  baseUrl = `http://127.0.0.1:${app.server.port}`;
});

afterAll(() => { app.stop(); rmSync(root, { recursive: true, force: true }); });

describe("HTTP server", () => {
  test("reports health and indexed session count", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true, sessions: 3, goals: 0, agents: ["claude", "codex", "hermes"], version: "p7",
      dataVersion: 1, listVersion: 1, watch: "timer",
      capabilities: [
        "worktree-pin", "worktree-resources", "nginx-gateway", "directory-governance", "orca-worktree-audit",
      ],
    });
  });

  test("serves read-only gateway and accessible worktree resources with ETags", async () => {
    const gateway = await fetch(`${baseUrl}/api/gateway`);
    expect(gateway.headers.get("ETag")).toBe('"g-1"');
    expect(await gateway.json()).toMatchObject({
      sources: ["fixture-nginx"], routes: [{ upstreamPort: 4321, urls: ["http://fixture.localhost"] }],
      files: [{ content: "server { listen 80; }" }],
    });
    expect((await fetch(`${baseUrl}/api/gateway`, {
      headers: { "If-None-Match": '"g-1"' },
    })).status).toBe(304);

    const resources = await fetch(`${baseUrl}/api/worktree-resources`);
    expect(resources.headers.get("ETag")).toBe('"r-1"');
    expect(await resources.json()).toMatchObject({
      resources: { [fixtureCwd]: [{ appName: "fixture-web", port: 4321 }] },
    });
    expect(resourceRoots).toContain(fixtureCwd);
    expect((await fetch(`${baseUrl}/api/worktree-resources`, {
      headers: { "If-None-Match": '"r-1"' },
    })).status).toBe(304);

    const audit = await fetch(`${baseUrl}/api/orca-worktree-audit`);
    expect(audit.headers.get("ETag")).toBe('"o-1"');
    expect(await audit.json()).toMatchObject({
      summary: {
        completedWorktrees: 12, ready: 10, review: 1, hold: 1,
        lumina: { total: 42, completed: 11, inProgress: 29, inReview: 2 },
      },
      items: [{ name: "kg-core", recommendation: "ready" }],
    });
    expect((await fetch(`${baseUrl}/api/orca-worktree-audit`, {
      headers: { "If-None-Match": '"o-1"' },
    })).status).toBe(304);
  });

  test("serves projects and sessions", async () => {
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "fixture-project", sessionCount: 3, pinned: false, archived: false,
    });
    const sessions = await (await fetch(`${baseUrl}/api/sessions?limit=99999`)).json();
    expect(sessions).toHaveLength(4);
    expect(sessions[0]).toMatchObject({
      agent: "claude", sid: LIVE_ONLY_SID, displayTitle: "未索引在线会话",
      lastPrompt: "Claude process without transcript", indexed: false,
      live: { pid: 666, status: "idle" },
    });
    expect(sessions.find((row: { sid: string }) => row.sid === SID))
      .toMatchObject({ agent: "claude", sid: SID, displayTitle: "课堂树会话", worktreeRoot: fixtureCwd, live: null, goals: [] });
    expect(sessions.find((row: { agent: string }) => row.agent === "codex"))
      .toMatchObject({
        agent: "codex", sid: CODEX_SID, displayTitle: "Codex 测试会话",
        worktreeRoot: fixtureCwd,
        live: { handle: "term_codex", tabId: "tab_codex", status: "working" },
      });
    expect(sessions.find((row: { agent: string }) => row.agent === "hermes"))
      .toMatchObject({
        agent: "hermes", sid: HERMES_SID, displayTitle: "Hermes 服务测试",
        worktreeRoot: fixtureCwd,
        live: { handle: "term_hermes", tabId: "tab_hermes", status: "done" },
      });
    const liveSessions = await (await fetch(`${baseUrl}/api/sessions?live=1`)).json();
    expect(liveSessions).toHaveLength(3);
    expect(liveSessions.find((row: { agent: string }) => row.agent === "codex")?.live?.updatedAt).toBe(30);
    expect(await (await fetch(`${baseUrl}/api/sessions?project=${encodeURIComponent(projects[0].key)}`)).json())
      .toHaveLength(3);
  });

  test("batch-loads and paginates recent user inputs for focus cards", async () => {
    const response = await fetch(`${baseUrl}/api/session-inputs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: [
        { agent: "claude", sid: SID }, { agent: "codex", sid: CODEX_SID },
        { agent: "hermes", sid: HERMES_SID }, { agent: "claude", sid: SID },
      ] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listVersion: app.db.getListVersion(),
      inputs: {
        [`claude/${SID}`]: ["请解释课堂树结构"],
        [`codex/${CODEX_SID}`]: ["Codex 页面测试"],
        [`hermes/${HERMES_SID}`]: ["Hermes 页面测试"],
      },
      inputTimes: {
        [`claude/${SID}`]: [Date.parse("2026-08-25T08:00:00.000Z")],
        [`codex/${CODEX_SID}`]: [Date.parse("2026-08-25T09:00:01.000Z")],
        [`hermes/${HERMES_SID}`]: [1_777_777_001_000],
      },
      hasMore: {
        [`claude/${SID}`]: false,
        [`codex/${CODEX_SID}`]: false,
        [`hermes/${HERMES_SID}`]: false,
      },
    });

    app.db.appendSessionFts(Array.from({ length: 6 }, (_, index) => ({
      text: `分页输入 ${index + 1}`, agent: "claude" as const, sid: SID, role: "user" as const, ts: index + 101,
    })));
    const firstPage = await (await fetch(`${baseUrl}/api/session-inputs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: [{ agent: "claude", sid: SID }], limit: 2, offset: 0 }),
    })).json();
    expect(firstPage.inputs[`claude/${SID}`]).toEqual(["分页输入 6", "分页输入 5"]);
    expect(firstPage.inputTimes[`claude/${SID}`]).toEqual([106, 105]);
    expect(firstPage.hasMore[`claude/${SID}`]).toBe(true);

    const lastPage = await (await fetch(`${baseUrl}/api/session-inputs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: [{ agent: "claude", sid: SID }], limit: 2, offset: 6 }),
    })).json();
    expect(lastPage.inputs[`claude/${SID}`]).toEqual(["请解释课堂树结构"]);
    expect(lastPage.hasMore[`claude/${SID}`]).toBe(false);

    const invalid = await fetch(`${baseUrl}/api/session-inputs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: [{ agent: "unknown", sid: SID }] }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid session identity" });

    const invalidPage = await fetch(`${baseUrl}/api/session-inputs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: [], offset: -1 }),
    });
    expect(invalidPage.status).toBe(400);
    expect(await invalidPage.json()).toEqual({ error: "offset must be an integer between 0 and 100000" });
  });

  test("serves static lists without live refreshes and versions live state separately", async () => {
    liveRefreshes = 0;
    const projects = await fetch(`${baseUrl}/api/projects`);
    expect(projects.headers.get("ETag")).toMatch(/^"p-\d+-\d+"$/);
    await projects.json();

    const sessions = await fetch(`${baseUrl}/api/sessions?includeLive=0`);
    expect(sessions.headers.get("ETag")).toMatch(/^"s-\d+-\d+"$/);
    expect((await sessions.json()).every((row: { live: unknown }) => row.live === null)).toBeTrue();
    expect(liveRefreshes).toBe(0);

    const live = await fetch(`${baseUrl}/api/live`);
    const liveEtag = live.headers.get("ETag");
    expect(liveEtag).toBe(`"l-1-${app.db.getListVersion()}"`);
    const livePayload = await live.json();
    expect(Object.keys(livePayload).sort()).toEqual([
      `claude/${LIVE_ONLY_SID}`, `codex/${CODEX_SID}`, `hermes/${HERMES_SID}`,
    ]);
    expect(livePayload[`codex/${CODEX_SID}`].status).toBe("working");
    expect(livePayload[`codex/${CODEX_SID}`].updatedAt).toBe(30);
    expect(livePayload[`codex/${CODEX_SID}`].projectKey).toBe(app.db.getSession("codex", CODEX_SID)?.projectKey);
    expect(livePayload[`hermes/${HERMES_SID}`].status).toBe("done");
    expect(livePayload[`claude/${LIVE_ONLY_SID}`].projectKey).toBeNull();
    expect(liveRefreshes).toBe(1);
    expect((await fetch(`${baseUrl}/api/live`, { headers: { "If-None-Match": liveEtag! } })).status).toBe(304);

    const invalid = await fetch(`${baseUrl}/api/sessions?includeLive=0&live=1`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "live=1 requires live session data" });
  });

  test("pins, archives, and restores a project without deleting indexed sessions", async () => {
    const [project] = await (await fetch(`${baseUrl}/api/projects`)).json();
    const initial = await fetch(`${baseUrl}/api/projects`);
    const initialEtag = initial.headers.get("ETag");
    await initial.json();
    const patchProject = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/projects`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const pinned = await patchProject({ projectKey: project.key, pinned: true });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ key: project.key, pinned: true, archived: false });
    const afterPin = await fetch(`${baseUrl}/api/projects`, { headers: { "If-None-Match": initialEtag! } });
    expect(afterPin.status).toBe(200);
    expect(afterPin.headers.get("ETag")).not.toBe(initialEtag);
    await afterPin.json();

    const archived = await patchProject({ projectKey: project.key, archived: true });
    expect(await archived.json()).toMatchObject({ key: project.key, pinned: false, archived: true });
    expect(await (await fetch(`${baseUrl}/api/sessions?includeLive=0`)).json()).toHaveLength(3);
    const restored = await patchProject({ projectKey: project.key, archived: false });
    expect(await restored.json()).toMatchObject({ key: project.key, pinned: false, archived: false });

    for (const body of [
      {}, { projectKey: project.key }, { projectKey: project.key, pinned: "yes" },
      { projectKey: project.key, archived: 1 }, { projectKey: project.key, pinned: true, archived: true },
    ]) expect((await patchProject(body)).status).toBe(400);
    expect((await patchProject({ projectKey: "/missing", pinned: true })).status).toBe(404);
  });

  test("audits missing roots and bulk-archives preferences without deleting indexed sessions or transcripts", async () => {
    const [project] = await (await fetch(`${baseUrl}/api/projects`)).json();
    unavailablePaths.add(fixtureCwd);
    try {
      const response = await fetch(`${baseUrl}/api/directory-audit`);
      const audit = await response.json();
      expect(audit.summary).toMatchObject({
        projectRoots: 1, missingProjectRoots: 1,
        directoryGroups: 1, missingDirectoryGroups: 1,
        gitWorktrees: 1, historicalDirectories: 0,
      });
      expect(audit.archivePlan).toEqual({ projectKeys: [project.key], worktrees: [] });
      const archived = await fetch(`${baseUrl}/api/directory-audit/archive-missing`, { method: "POST" });
      expect(archived.status).toBe(200);
      expect(await archived.json()).toMatchObject({
        applied: { projects: 1, worktrees: 0 }, indexedSessionsPreserved: 3,
        audit: { archivePlan: { projectKeys: [], worktrees: [] } },
      });
      expect(existsSync(sessionPath)).toBeTrue();
      expect(await (await fetch(`${baseUrl}/api/sessions?includeLive=0`)).json()).toHaveLength(3);
    } finally {
      unavailablePaths.delete(fixtureCwd);
      await fetch(`${baseUrl}/api/projects`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectKey: project.key, archived: false }),
      });
    }
  });

  test("pins, archives, and restores one indexed worktree without deleting sessions", async () => {
    const [project] = await (await fetch(`${baseUrl}/api/projects`)).json();
    const initial = await fetch(`${baseUrl}/api/worktrees`);
    const initialEtag = initial.headers.get("ETag");
    expect(initialEtag).toMatch(/^"w-\d+"$/);
    expect(await initial.json()).toEqual([]);
    const patchWorktree = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/worktrees`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

    const pinned = await patchWorktree({ projectKey: project.key, root: fixtureCwd, pinned: true });
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({
      projectKey: project.key, root: fixtureCwd, pinned: true, archived: false,
    });
    expect(await (await fetch(`${baseUrl}/api/sessions?includeLive=0`)).json()).toHaveLength(3);
    const changed = await fetch(`${baseUrl}/api/worktrees`, { headers: { "If-None-Match": initialEtag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(initialEtag);
    expect(await changed.json()).toEqual([{
      projectKey: project.key, root: fixtureCwd, pinned: true, archived: false,
    }]);

    const archived = await patchWorktree({ projectKey: project.key, root: fixtureCwd, archived: true });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({
      projectKey: project.key, root: fixtureCwd, pinned: false, archived: true,
    });

    const restored = await patchWorktree({ projectKey: project.key, root: fixtureCwd, archived: false });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({
      projectKey: project.key, root: fixtureCwd, pinned: false, archived: false,
    });
    expect(await (await fetch(`${baseUrl}/api/worktrees`)).json()).toEqual([]);

    for (const body of [
      {}, { projectKey: project.key, root: fixtureCwd }, { projectKey: project.key, archived: true },
      { projectKey: project.key, root: fixtureCwd, pinned: 1 },
      { projectKey: project.key, root: fixtureCwd, archived: 1 },
      { projectKey: project.key, root: fixtureCwd, pinned: true, archived: true },
    ]) expect((await patchWorktree(body)).status).toBe(400);
    expect((await patchWorktree({ projectKey: "/missing", root: fixtureCwd, archived: true })).status).toBe(404);
    expect((await patchWorktree({ projectKey: project.key, root: "/missing", archived: true })).status).toBe(404);
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
    expect(html).toContain('row.live ? "跳转" : "恢复"');
    expect(html).toContain('action focus-action ${row.live ? "focus-jump" : "focus-resume"}');
    expect(html).toContain('return "working · 进行中"');
    expect(html).toContain('return "done · 等待用户"');
    expect(html).toContain('live.projectKey === projectKey && live.status === "working"');
    expect(html).toContain('make("span", "project-working", String(count))');
    expect(html).toContain('id="focus-view-button" type="button" aria-pressed="false">聚焦</button>');
    expect(html).toContain('updatedAt >= boundaries.today && updatedAt < boundaries.tomorrow');
    expect(html).toContain('groupedWorktrees(projectRows, project, (row) => row.live?.updatedAt || 0)');
    expect(html).toContain('conditionalApi(`/api/sessions?live=1&limit=${LIVE_POOL_LIMIT}`');
    expect(html).toContain('fetch("/api/session-inputs"');
    expect(html).toContain('id="focus-monitor" class="focus-monitor" hidden');
    expect(html).toContain('.focus-monitor.monitor-floating { right: var(--focus-monitor-gap);');
    expect(html).toContain('.focus-monitor.monitor-docked-left');
    expect(html).toContain('.focus-monitor.monitor-docked-right');
    expect(html).toContain('id="focus-monitor-dock-left"');
    expect(html).toContain('id="focus-monitor-dock-right"');
    expect(html).toContain('FOCUS_MONITOR_PLACEMENT_STORAGE_KEY');
    expect(html).toContain('function focusMonitorDockZone(clientX)');
    expect(html).toContain('head.addEventListener("pointerdown", beginFocusMonitorDrag)');
    expect(html).toContain('element.addEventListener("mouseenter", () => showFocusMonitor(row))');
    expect(html).toContain('function focusInputTime(timestamp)');
    expect(html).toContain('.focus-monitor-messages { display: grid; min-height: 0; flex: 1; align-content: start;');
    expect(html).toContain('function loadMoreFocusInputs(row, button)');
    expect(html).toContain('make("button", "focus-monitor-more-button", loading ? "加载中…" : "加载更多")');
    expect(html).toContain('state.recentInputsHasMoreBySession = body.hasMore || {}');
    expect(html).not.toContain('focus-monitor-copy');
    expect(html).not.toContain('focus-workspace.monitor-visible');
    expect(html).not.toContain('.focus-session-inputs {');
    expect(html).not.toContain('inputs.setAttribute("role", "tooltip")');
    expect(html).toContain("state.recentInputsBySession[key]");
    expect(html).toContain('dot.dataset.state = status');
    expect(html).toContain('make("details", `floating-menu ${className}`.trim())');
    expect(html).toContain('.floating-menu-panel { position: absolute;');
    expect(html).toContain('.floating-menu.open-up > .floating-menu-panel');
    expect(html).toContain('"action-drawer", "action drawer-toggle"');
    expect(html).toContain('event.key === "Escape" && closeFloatingMenus()');
    expect(html).toContain("drawerPanel.append(copyButton)");
    expect(html).toContain("if (row.indexed !== false) drawerPanel.append(commandButton)");
    expect(html).toContain('displayTitle: "未索引在线会话"');
    expect(html).toContain('id="directory-audit-summary"');
    expect(html).toContain('id="orca-audit-summary"');
    expect(html).toContain("回到 Orca");
    expect(html).toContain("/api/projects/focus");
    expect(html).toContain('conditionalApi("/api/live"');
    expect(html).toContain('params.set("includeLive", "0")');
    expect(html).toContain("已归档");
    expect(html).toContain("置顶");
    expect(html).toContain('jsonRequest("PATCH", { projectKey: project.key, ...patch })');
    expect(html).toContain('id="projects-view-button"');
    expect(html).toContain("项目管理");
    expect(html).toContain('id="project-search"');
    expect(html).toContain("查看会话");
    expect(html).toContain("groupedWorktrees");
    expect(html).toContain("row.worktreeRoot || row.cwd");
    expect(html).toContain("主 worktree");
    expect(html).toContain('optionalConditionalApi("/api/worktrees", state.worktreeEtag, [])');
    expect(html).toContain("if (response.status === 404)");
    expect(html).toContain("state.worktreesSupported = false");
    expect(html).toContain('health.capabilities.includes("worktree-pin")');
    expect(html).toContain('function pinIndicator(label)');
    expect(html).toContain('if (project.pinned) label.append(pinIndicator("项目已置顶"))');
    expect(html).toContain('if (worktreePinned) worktreeTitle.append(pinIndicator("worktree 已置顶"))');
    expect(html).toContain('const COLLAPSED_WORKTREES_STORAGE_KEY = "orcatab.collapsedWorktrees.v1"');
    expect(html).toContain('const collapsed = !isSearch && state.collapsedWorktrees.has(collapseKey)');
    expect(html).toContain('toggle.setAttribute("aria-expanded", String(!collapsed))');
    expect(html).toContain('list.hidden = collapsed');
    expect(html).toContain('id="gateway-view-button"');
    expect(html).toContain('id="gateway-content"');
    expect(html).toContain('optionalConditionalApi("/api/worktree-resources"');
    expect(html).toContain('optionalConditionalApi("/api/gateway"');
    expect(html).toContain("worktreeResourceDrawer(worktree.root, worktreeName)");
    expect(html).toContain('"resource-drawer", "action compact-menu-toggle"');
    expect(html).toContain("只读展示本机与容器 nginx 配置");
    expect(html).toContain("file.content");
    expect(html).toContain('"button", `action floating-menu-action worktree-archive${worktreeArchived ? " restore" : ""}`');
    expect(html).toContain('"button", `action floating-menu-action worktree-pin${worktreePinned ? " active" : ""}`');
    expect(html).toContain("Number(b.pinned) - Number(a.pinned)");
    expect(html).toContain('"project-item-menu", "project-menu-toggle", "⋯"');
    expect(html).toContain('"managed-project-menu", "action compact-menu-toggle"');
    expect(html).toContain("updateWorktreePreference(");
    expect(html).toContain("focusWorktreeSession(firstSession, worktreeName, focus)");
    expect(html).toContain("focus.dataset.sid = firstSession.sid");
    expect(html).not.toContain('make("h2", "group-title", project.name)');
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
    const getSession = spyOn(app.db, "getSession");
    const confirmedLinks = spyOn(app.goalsStore, "confirmedLinks");
    const getSessionsByIdentity = spyOn(app.db, "getSessionsByIdentity");
    const confirmedLinksByGoal = spyOn(app.goalsStore, "confirmedLinksByGoal");
    goals = await (await fetch(`${baseUrl}/api/goals`)).json();
    expect(goals[0].sessionCount).toBe(1);
    expect(goals[0].lastActivityAt).toBe(Date.parse("2026-08-25T09:00:00.000Z"));
    expect(getSession).not.toHaveBeenCalled();
    expect(confirmedLinks).not.toHaveBeenCalled();
    expect(getSessionsByIdentity).toHaveBeenCalledTimes(1);
    expect(confirmedLinksByGoal).toHaveBeenCalledTimes(1);
    getSession.mockRestore();
    confirmedLinks.mockRestore();
    getSessionsByIdentity.mockRestore();
    confirmedLinksByGoal.mockRestore();

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
