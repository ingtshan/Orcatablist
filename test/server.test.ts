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
import type { LiveSnapshot } from "../src/live-source";
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
const openTabsSnapshot: LiveSnapshot = {
  at: 1, live: openTabs,
  sources: [{ name: "orca-tab", ok: true, readAt: 1, stale: false, sessions: openTabs.size, error: null }],
};
const sessionLiveReader: SessionLiveReader = {
  refresh: async () => { liveRefreshes += 1; return openTabs; },
  refreshSnapshot: async () => { liveRefreshes += 1; return openTabsSnapshot; },
  getLiveMap: () => openTabs,
  getSnapshot: () => openTabsSnapshot,
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
        "session-send", "session-outbox", "focus-board", "session-tasks", "orchestration-runs", "remote-environments",
      ],
    });
  });

  test("healthz reports how indexing itself is doing, alongside the unchanged keys", async () => {
    const payload = await (await fetch(`${baseUrl}/healthz`)).json() as {
      indexedAt: number | null;
      indexing: { running: boolean; lastAttemptAt: number | null; lastSuccessAt: number | null; errors: unknown[] };
    };
    expect(payload.indexing.running).toBeFalse();
    expect(payload.indexing.errors).toEqual([]);
    // The startup pass was clean, so both the freshness stamp and the success stamp are set.
    expect(payload.indexing.lastAttemptAt).not.toBeNull();
    expect(payload.indexing.lastSuccessAt).not.toBeNull();
    expect(payload.indexedAt).not.toBeNull();
    expect(payload.indexing.lastSuccessAt).toBeGreaterThanOrEqual(payload.indexing.lastAttemptAt!);
  });

  test("serves read-only gateway and accessible worktree resources with ETags", async () => {
    const gateway = await fetch(`${baseUrl}/api/gateway`);
    expect(gateway.headers.get("ETag")).toBe('"gateway:1"');
    expect(await gateway.json()).toMatchObject({
      sources: ["fixture-nginx"], routes: [{ upstreamPort: 4321, urls: ["http://fixture.localhost"] }],
      files: [{ content: "server { listen 80; }" }],
    });
    expect((await fetch(`${baseUrl}/api/gateway`, {
      headers: { "If-None-Match": '"gateway:1"' },
    })).status).toBe(304);

    const resources = await fetch(`${baseUrl}/api/worktree-resources`);
    expect(resources.headers.get("ETag")).toBe('"resources:1"');
    expect(await resources.json()).toMatchObject({
      resources: { [fixtureCwd]: [{ appName: "fixture-web", port: 4321 }] },
    });
    expect(resourceRoots).toContain(fixtureCwd);
    expect((await fetch(`${baseUrl}/api/worktree-resources`, {
      headers: { "If-None-Match": '"resources:1"' },
    })).status).toBe(304);

    const audit = await fetch(`${baseUrl}/api/orca-worktree-audit`);
    expect(audit.headers.get("ETag")).toBe('"orca-audit:1"');
    expect(await audit.json()).toMatchObject({
      summary: {
        completedWorktrees: 12, ready: 10, review: 1, hold: 1,
        lumina: { total: 42, completed: 11, inProgress: 29, inReview: 2 },
      },
      items: [{ name: "kg-core", recommendation: "ready" }],
    });
    expect((await fetch(`${baseUrl}/api/orca-worktree-audit`, {
      headers: { "If-None-Match": '"orca-audit:1"' },
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
    expect(projects.headers.get("ETag")).toMatch(/^"projects:\d+\.\d+"$/);
    await projects.json();

    const sessions = await fetch(`${baseUrl}/api/sessions?includeLive=0`);
    expect(sessions.headers.get("ETag")).toMatch(/^"sessions:\d+\.\d+"$/);
    expect((await sessions.json()).every((row: { live: unknown }) => row.live === null)).toBeTrue();
    expect(liveRefreshes).toBe(0);

    const live = await fetch(`${baseUrl}/api/live`);
    const liveEtag = live.headers.get("ETag");
    expect(liveEtag).toBe(`"live:1.${app.db.getListVersion()}.${app.goalsStore.goalsVersion}"`);
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
    expect(initialEtag).toMatch(/^"worktrees:\d+"$/);
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

  test("persists a queued input without sending it through Orca", async () => {
    const callsBefore = focusCalls.length;
    const queued = await fetch(`${baseUrl}/api/session-outbox`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ agent: "codex", sid: CODEX_SID, text: "稍后再检查这个想法" }),
    });
    expect(queued.status).toBe(201);
    const item = (await queued.json()).item;
    expect(item).toMatchObject({ agent: "codex", sid: CODEX_SID, text: "稍后再检查这个想法" });
    expect(focusCalls).toHaveLength(callsBefore);

    const listed = await fetch(`${baseUrl}/api/session-outbox`);
    expect((await listed.json()).items).toContainEqual(item);
    const removed = await fetch(`${baseUrl}/api/session-outbox/${encodeURIComponent(item.id)}`, {
      method: "DELETE", headers: { origin: baseUrl, "sec-fetch-site": "same-origin" },
    });
    expect(await removed.json()).toMatchObject({ ok: true });
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
    expect(etag).toMatch(/^"sessions-live:\d+\.\d+\.\d+"$/);
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
    expect(html).toContain("function sessionUri(row) { return `orcatab://${sessionKey(row)}`; }");
    expect(html).toContain('await copyText(sessionUri(row), "已复制链接")');
    expect(html).toContain("codex resume ${row.sid}");
    expect(html).toContain("hermes --resume ${row.sid}");
    expect(html).toContain("agent-hermes");
    expect(html).toContain('row.live ? "跳转" : "恢复"');
    expect(html).toContain('action focus-action ${row.live ? "focus-jump" : "focus-resume"}');
    expect(html).toContain('if (status === "working") return "进行中"');
    expect(html).toContain('if (status === "done") return "已就绪"');
    expect(html).toContain('if (status === "waiting") return "需操作"');
    expect(html).toContain('if (status === "blocked") return "已受阻"');
    expect(html).toContain('if (status === "idle") return "空闲"');
    expect(html).toContain('const label = live ? liveStateText(live) : "离线"');
    expect(html).not.toContain('working · 进行中');
    expect(html).not.toContain('done · 已就绪');
    expect(html).toContain('live.projectKey === projectKey && live.status === "working"');
    expect(html).toContain('make("span", "project-working", String(count))');
    expect(html).toContain('id="focus-view-button" type="button" aria-pressed="false">聚焦</button>');
    expect(html).toContain('<div class="search-wrap session-search"><input id="search"');
    expect(html).toContain('const searchActive = focusActive || sessionsActive');
    expect(html).toContain('element.hidden = !searchActive');
    expect(html).toContain('focusActive ? "搜索全部会话内容… 按 / 聚焦"');
    expect(html).toContain('function runFocusSearch(query)');
    expect(html).toContain('state.focusSearchMatches = new Map(rows.map((row) => [sessionKey(row), row]))');
    // Group-level scope and child search behavior is exercised in focus-orchestration-ui.test.ts.
    expect(html).toContain('function focusPresentation()');
    expect(html).toContain('function allFocusRows()');
    expect(html).toContain('function focusInputRows()');
    expect(html).toContain('new Map(focusInputRows()');
    expect(html).toContain('make("div", "focus-search-hit")');
    expect(html).toContain('appendHighlighted(hit, row.hits[0].snippet)');
    expect(html).toContain('if (state.focusSearchPending) return "正在搜索…"');
    expect(html).toContain('(state.view === "sessions" || state.view === "focus")');
    expect(html).toContain('const projectCollapsed = !state.query && state.focusCollapsedProjects.has(projectCollapseKey)');
    expect(html).toContain('const worktreeCollapsed = !state.query && isFocusWorktreeCollapsed(laneKey, worktree)');
    expect(html).toContain('worktreeHead.classList.toggle("search-result", Boolean(state.query))');
    expect(html).toContain('id="focus-project-filter" class="focus-project-filter-toggle"');
    expect(html).toContain('id="focus-project-filter-search" class="focus-project-filter-search" type="search"');
    expect(html).toContain('placeholder="搜索项目名称或路径…" aria-label="搜索项目选项"');
    expect(html).toContain('id="focus-project-filter-options" class="focus-project-filter-options" role="listbox"');
    expect(html).toContain('focusProjectFilters: new Set()');
    expect(html).toContain('function focusSelectableProjects()');
    expect(html).toContain('const latestByProject = new Map([...projectsByKey.values()].map((project) => [');
    expect(html).toContain('(latestByProject.get(right.key) || 0) - (latestByProject.get(left.key) || 0)');
    expect(html).toContain('function renderFocusProjectFilter()');
    expect(html).toContain('function renderFocusProjectFilterOptions(projects = focusSelectableProjects())');
    expect(html).toContain('function focusProjectChoiceMatches(project, query)');
    expect(html).toContain('function openFocusProjectPicker()');
    expect(html).toContain('function closeFocusProjectPicker(restoreFocus = false)');
    expect(html).toContain('function moveFocusProjectOption(current, delta)');
    expect(html).toContain('function toggleFocusProjectFilter(value)');
    expect(html).toContain('focusProjectFilterSearch.addEventListener("input", () => renderFocusProjectFilterOptions())');
    expect(html).toContain('moveFocusProjectOption(null, event.key === "ArrowDown" ? 1 : -1)');
    expect(html).toContain('!event.target.closest(".focus-project-picker")');
    expect(html).toContain('.focus-project-filter-panel { position: absolute; z-index: 45;');
    expect(html).toContain('id="focus-worktree-filter" class="focus-project-filter-toggle"');
    expect(html).toContain('placeholder="搜索 worktree 名称或路径…" aria-label="搜索 worktree 选项"');
    expect(html).toContain('focusWorktreeFilters: new Set()');
    expect(html).toContain('function focusWorktreeFilterKey(row)');
    expect(html).toContain('function focusSelectableWorktrees()');
    expect(html).toContain('function renderFocusWorktreeFilterOptions(choices = focusSelectableWorktrees())');
    expect(html).toContain('function toggleFocusWorktreeFilter(value)');
    expect(html).toContain('focusWorktreeFilterSearch.addEventListener("input", () => renderFocusWorktreeFilterOptions())');
    expect(html).toContain('{ key: "working", title: "进行中", range: ""');
    expect(html).toContain('{ key: "non-working-today", title: "操作/就绪", range: "今天"');
    expect(html).toContain('{ key: "non-working-recent", title: "操作/就绪", range: "三天内"');
    expect(html).toContain('key: "history", title: "历史", range: "", note: "全文命中但不在前三列"');
    expect(html).toContain('function allFocusHistoryRows()');
    expect(html).toContain('!boardKeys.has(sessionKey(row)) && focusSearchRowVisible(row)');
    expect(html).toContain('function focusHistoryActive()');
    expect(html).toContain('const definitions = focusHistoryActive() ? [...FOCUS_LANES, FOCUS_HISTORY_LANE] : FOCUS_LANES');
    expect(html).toContain('focusBoard.classList.toggle("with-history", focusHistoryActive())');
    expect(html).toContain('function loadFocusFilterHistory(force = false)');
    expect(html).toContain('function focusFilterHistoryProjectKeys()');
    expect(html).toContain('api(`/api/sessions?project=${encodeURIComponent(projectKey)}&includeLive=0&limit=${LIVE_POOL_LIMIT}`)');
    expect(html).toContain('state.query ? [...state.focusSearchMatches.values()] : state.focusFilterHistoryRows');
    expect(html).toContain('await loadFocusFilterHistory()');
    expect(html).toContain('void refreshFocusFilterHistory(true)');
    expect(html).toContain('.focus-board.with-history { grid-template-columns: repeat(4, minmax(0, 1fr)); }');
    expect(html).toContain('dot.dataset.state = status');
    // Lane assignment moved behind /api/board/focus; the page reads lanes rather than computing them.
    expect(html).toContain('function focusLaneRows(key)');
    expect(html).toContain('optionalConditionalApi("/api/board/focus"');
    expect(html).not.toContain("function focusBucket");
    expect(html).not.toContain("function focusDayBoundaries");
    expect(html).not.toContain('status !== "done"');
    expect(html).not.toContain('key: "done-today"');
    expect(html).not.toContain('key: "done-recent"');
    expect(html).not.toContain('return "idle-today"');
    expect(html).not.toContain('return "idle-recent"');
    expect(html).toContain('id="focus-project-sort"');
    expect(html).toContain('<option value="az">A–Z</option>');
    expect(html).toContain('<option value="za">Z–A</option>');
    expect(html).toContain('<option value="recent">最近活动</option>');
    expect(html).toContain('const FOCUS_PROJECT_SORT_STORAGE_KEY = "orcatab.focusProjectSort.v1"');
    expect(html).toContain('focusProjectSort: loadFocusProjectSort()');
    expect(html).toContain('function orderedFocusProjectKeys(groups)');
    expect(html).toContain('if (state.focusProjectSort === "recent")');
    expect(html).toContain('state.focusProjectSort === "za" ? -1 : 1');
    expect(html).toContain('focusProjectSort.addEventListener("change", () => setFocusProjectSort(focusProjectSort.value))');
    expect(html).toContain('make("small", "focus-lane-range", definition.range)');
    expect(html).toContain('const FOCUS_COLLAPSED_PROJECTS_STORAGE_KEY = "orcatab.focusCollapsedProjects.v2"');
    expect(html).toContain('const FOCUS_COLLAPSED_WORKTREES_STORAGE_KEY = "orcatab.focusCollapsedWorktrees.v2"');
    expect(html).toContain('function focusProjectCollapseKey(laneKey, projectKey)');
    expect(html).toContain('function focusWorktreeCollapseKey(laneKey, group)');
    expect(html).toContain(`return JSON.stringify([laneKey, group.env, group.projectKey, group.root]);`);
    expect(html).toContain('function setFocusProjectCollapsed(collapseKey, collapsed)');
    expect(html).toContain('function setFocusWorktreeCollapsed(laneKey, group, collapsed)');
    expect(html).toContain('function renderFocusGroups(parent, laneKey, rows, runs)');
    expect(html).toContain('renderFocusGroups(body, definition.key, rows, presentation)');
    expect(html).toContain('projectToggle.setAttribute("aria-expanded", String(!projectCollapsed))');
    expect(html).toContain('projectBody.hidden = projectCollapsed');
    expect(html).toContain('worktreeToggle.setAttribute("aria-expanded", String(!worktreeCollapsed))');
    expect(html).toContain('list.hidden = worktreeCollapsed');
    expect(html).toContain('.focus-project-body[hidden], .focus-session-list[hidden] { display: none; }');
    expect(html).toContain('groupedWorktrees(projectRows, project, focusRowActivity)');
    expect(html).toContain('row.live ? "跳转" : "恢复"');
    expect(html).toContain('sessions: [{ agent: row.agent, sid: row.sid, ...(row.env ? { env: row.env } : {}) }]');
    expect(html).toContain('fetch("/api/session-inputs"');
    expect(html).toContain('rawLiveState(row.live) === "done"');
    expect(html).toContain('text, expectedHandle: row.live?.handle, expectedStatus: rawLiveState(row.live)');
    expect(html).toContain('fetch("/api/session-send")');
    expect(html).toContain('function iconButton(className, label, iconName)');
    expect(html).toContain('iconButton("session-send-copy", "复制上次输入", "copy")');
    expect(html).toContain('iconButton("session-send-dismiss", "忽略", "x")');
    expect(html).toContain('sending: { state: "pending", label: "发送中", icon: "clock" }');
    expect(html).toContain('working: { state: "verifying", label: "进行中", icon: "spinner" }');
    expect(html).toContain('failed: { state: "failed", label: "传达失败", icon: "alert" }');
    expect(html).toContain('complete: { state: "confirmed", label: "已处理", icon: "check" }');
    expect(html).toContain('alert: "M12 3L2.5 20h19L12 3M12 9v5M12 17h.01"');
    expect(html).not.toContain('SEND_CONFIRMATION_FEEDBACK_MS');
    expect(html).toContain('function registerSendConfirmation(entry)');
    expect(html).toContain('state.localSendRecords[key] = { ...entry, state: "confirmed" }');
    expect(html).toContain('(Array.isArray(body.confirmed) ? body.confirmed : []).forEach(registerSendConfirmation)');
    expect(html).toContain('.session-send-icon-button { width: 24px; height: 24px;');
    expect(html).not.toContain('make("button", "action session-send-copy", "复制上次输入")');
    expect(html).toContain('showToast("已发送，已加入自动确认队列")');
    expect(html).toContain('function latestUserInputText(row)');
    expect(html).toContain('function confirmedInputText(row, record)');
    expect(html).toContain('function sessionInputPresentation(row, record)');
    expect(html).toContain('function sessionInputNote(row)');
    expect(html).toContain('record && record.state !== "confirmed"');
    expect(html).toContain('liveStatus === "working" || liveStatus === "busy"');
    expect(html).toContain('record?.state === "pending"');
    expect(html).toContain('label.append(lineIcon(presentation.icon))');
    expect(html).toContain('state.localSendRecords[key] = failed');
    expect(html).not.toContain('row-last-input');
    expect(html).toContain('.session-send { --session-send-height: 36px;');
    expect(html).toContain('mode === "send" ? "发送" : "暂存"');
    expect(html).toContain('function canQueueInput(row)');
    expect(html).toContain('return status === "working" || status === "busy"');
    expect(html).toContain('async function queueSessionInput(row, input, button)');
    expect(html).toContain('fetch("/api/session-outbox", jsonRequest("POST"');
    expect(html).toContain('showToast("已加入待发送，可继续输入")');
    expect(html).toContain('async function loadSessionOutbox()');
    expect(html).toContain('function sessionOutboxList(row)');
    expect(html).toContain('function sendOutboxItem(row, item, button)');
    expect(html).toContain('function deleteOutboxItem(row, item, button)');
    expect(html).toContain('window.confirm(`确定删除这条待发送消息？');
    expect(html).toContain('iconButton("session-outbox-send", "发送这条待发送消息", "send")');
    expect(html).toContain('iconButton("session-outbox-delete", "删除这条待发送消息", "x")');
    expect(html).toContain('showToast(`发送失败，消息仍在队列：${error.message}`)');
    expect(html).toContain('input.addEventListener("compositionstart"');
    expect(html).toContain('input.addEventListener("compositionend"');
    expect(html).toContain('event.isComposing || composing || event.keyCode === 229');
    expect(html).toContain('if (state.sendCompositionKey) { state.sendRenderPending = true; return; }');
    expect(html).toContain('function appendSendStatus(element, row)');
    expect(html).not.toContain('function appendSendControls(element, row)');
    expect(html.match(/appendSendStatus\(element, row\);/g) || []).toHaveLength(2);
    expect(html).toContain('const sendForm = sessionSendForm(row)');
    expect(html).toContain('const outbox = sessionOutboxList(row)');
    expect(html).toContain('make("div", "focus-monitor-compose")');
    expect(html).toContain('focusMonitor.replaceChildren(head, messages, ...(composer ? [composer] : []))');
    expect(html).toContain('.focus-monitor-compose { display: grid; flex: 0 0 auto; gap: 8px;');
    expect(html).not.toContain('.focus-session-card .session-send');
    expect(html).toContain('id="focus-monitor" class="focus-monitor" hidden');
    expect(html.indexOf('<aside id="focus-monitor"')).toBeLessThan(html.indexOf('<div id="focus-view"'));
    expect(html).toContain('.focus-monitor.monitor-floating { right: var(--focus-monitor-gap);');
    expect(html).toContain('.focus-monitor.monitor-docked-left');
    expect(html).toContain('.focus-monitor.monitor-docked-right');
    expect(html).toContain('.focus-workspace { --focus-monitor-scroll-start: 0px; --focus-monitor-scroll-end: 0px; display: flex;');
    expect(html).toContain('.focus-workspace.monitor-overlap { overflow-x: auto; scrollbar-width: none; }');
    expect(html).toContain('.focus-workspace.monitor-overlap::-webkit-scrollbar { width: 0; height: 0; }');
    expect(html).toContain('.focus-workspace.monitor-overlap::before');
    expect(html).toContain('.focus-workspace.monitor-overlap::after');
    expect(html).toContain('.focus-board { display: grid; min-width: 0; flex: 0 0 100%;');
    expect(html).toContain('const FOCUS_MONITOR_SCROLL_GAP_PX = 16');
    expect(html).toContain('function updateFocusMonitorOverlap()');
    expect(html).toContain('overlapWidth > 0 && overlapHeight > 0');
    expect(html).toContain('monitorRect.right - workspaceRect.left + FOCUS_MONITOR_SCROLL_GAP_PX');
    expect(html).toContain('workspaceRect.right - monitorRect.left + FOCUS_MONITOR_SCROLL_GAP_PX');
    expect(html).toContain('focusWorkspace.classList.toggle("monitor-overlap", overlaps)');
    expect(html).toContain('previousScrollLeft + startReserve - previousStart');
    expect(html).toContain('id="focus-horizontal-scrollbar" class="focus-horizontal-scrollbar" role="scrollbar"');
    expect(html).toContain('.focus-horizontal-scrollbar { position: fixed; z-index: 10; bottom: 0;');
    expect(html).toContain('function updateFocusHorizontalScrollbar()');
    expect(html).toContain('function syncFocusHorizontalScroll(source, target)');
    expect(html).toContain('syncFocusHorizontalScroll(focusWorkspace, focusHorizontalScrollbar)');
    expect(html).toContain('syncFocusHorizontalScroll(focusHorizontalScrollbar, focusWorkspace)');
    expect(html).toContain('.session-row.monitor-source { background: var(--accent-soft); }');
    expect(html).toContain('body.monitor-dragging .focus-monitor-dock-target');
    expect(html).not.toContain('.focus-view.monitor-dragging .focus-monitor-dock-target');
    expect(html).toContain('id="focus-monitor-dock-left"');
    expect(html).toContain('id="focus-monitor-dock-right"');
    expect(html).toContain('FOCUS_MONITOR_PLACEMENT_STORAGE_KEY');
    expect(html).toContain('function focusMonitorDockZone(clientX)');
    expect(html).toContain('head.addEventListener("pointerdown", beginFocusMonitorDrag)');
    expect(html).toContain('element.addEventListener("mouseenter", () => showFocusMonitor(row))');
    expect(html).toContain('focusMonitorSessionKey: "", focusMonitorLocked: false');
    expect(html).toContain('function setFocusMonitorLocked(locked)');
    expect(html).toContain('function toggleFocusMonitorRow(row)');
    expect(html).toContain('state.focusMonitorLocked && state.focusMonitorSessionKey === key');
    expect(html).toContain('toggleFocusMonitorRow(row)');
    expect(html).toContain('function focusSessionSendInput(key)');
    expect(html).toContain('input.setSelectionRange(end, end)');
    expect(html).toContain('focusSessionSendInput(key)');
    expect(html).toContain('const pin = make("button", "focus-monitor-pin")');
    expect(html).toContain('pin.setAttribute("aria-pressed", String(state.focusMonitorLocked))');
    expect(html).toContain('pin.addEventListener("click", () => setFocusMonitorLocked(!state.focusMonitorLocked))');
    expect(html).toContain('focusMonitor.addEventListener("pointerdown", lockFocusMonitorFromInteraction)');
    expect(html).toContain('pin: "M9 3h6l-.75 5.25L18 12v2H6v-2l3.75-3.75L9 3M12 14v7"');
    expect(html).not.toContain('Monitor · 已锁定');
    expect(html).not.toContain('Monitor · 预览');
    expect(html.match(/bindFocusMonitorSource\(element, row\);/g) || []).toHaveLength(2);
    expect(html).toContain('return state.sessions.find((row) => sessionKey(row) === state.focusMonitorSessionKey) || null;');
    expect(html).toContain('async function loadFocusMonitorInputs(row, force = false)');
    expect(html).toContain('void loadFocusMonitorInputs(monitorRow, true)');
    expect(html).toContain('state.recentInputsLoadingBySession[key] ? "正在加载输入…"');
    expect(html).toContain('function focusInputTime(timestamp)');
    expect(html).toContain('.focus-monitor-messages { display: grid; min-height: 0; flex: 1; align-content: start; gap: 12px; overflow-y: auto; overflow-anchor: none;');
    expect(html).toContain('const FOCUS_HISTORY_LOAD_THRESHOLD_PX = 48');
    expect(html).toContain('const FOCUS_SCROLL_BOTTOM_TOLERANCE_PX = 2');
    expect(html).toContain('}).filter(({ text }) => text).reverse()');
    expect(html).toContain('async function loadOlderFocusInputs(row, messages)');
    expect(html).toContain('function maybeLoadOlderFocusInputs(row, messages)');
    expect(html).toContain('messages.scrollTop > FOCUS_HISTORY_LOAD_THRESHOLD_PX');
    expect(html).toContain('renderFocusMonitor({ historyAnchor: activeAnchor })');
    expect(html).toContain('messages.scrollHeight - options.historyAnchor.scrollHeight');
    expect(html).toContain('messages.setAttribute("aria-label", "用户输入历史，向上滚动加载更早记录")');
    expect(html).not.toContain('focus-monitor-more-button');
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
    // A database miss is not evidence about a transcript, so the coverage copy no longer claims
    // one. The behaviour behind these strings is covered by test/session-coverage-ui.test.ts.
    expect(html).toContain("索引尚不可用");
    expect(html).toContain("在线来源已报告会话，索引尚不可用");
    expect(html).not.toContain("无 transcript");
    expect(html).not.toContain("尚无 transcript");
    expect(html).not.toContain("没有可读取的 transcript");
    expect(html).not.toContain("transcript 尚未建立或不可见");
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
    expect(html).toContain("row.worktreeRoot || liveWorktreeRootFor(row) || row.cwd || project.root");
    expect(html).toContain("主 worktree");
    expect(html).toContain('optionalConditionalApi("/api/worktrees", state.worktreeEtag, [])');
    expect(html).toContain("if (response.status === 404)");
    expect(html).toContain("state.worktreesSupported = false");
    expect(html).toContain('health.capabilities.includes("worktree-pin")');
    expect(html).toContain('function pinIndicator(label)');
    expect(html).toContain('if (project.pinned) label.append(pinIndicator("项目已置顶"))');
    expect(html).toContain('if (worktreePinned) worktreeTitle.append(pinIndicator("worktree 已置顶"))');
    expect(html).toContain('const COLLAPSED_WORKTREES_STORAGE_KEY = "orcatab.collapsedWorktrees.v1"');
    expect(html).toContain('const collapsed = !isSearch && isWorktreeCollapsed(worktree)');
    expect(html).toContain('toggle.setAttribute("aria-expanded", String(!collapsed))');
    expect(html).toContain('list.hidden = collapsed');
    expect(html).toContain('id="gateway-view-button"');
    expect(html).toContain('id="gateway-content"');
    expect(html).toContain('optionalConditionalApi("/api/worktree-resources"');
    expect(html).toContain('optionalConditionalApi("/api/gateway"');
    expect(html).toContain("worktreeResourceDrawer(worktree, worktreeName)");
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

/**
 * A dedicated server whose index is far larger than any page it will serve, so "is this session
 * indexed?" can only be answered correctly from the database — never from the rows a request
 * happened to return.
 */
describe("live session index coverage", () => {
  const OLD_LIVE_SID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const UNKNOWN_SID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const REMOTE_ENV = "feibo-n2";
  const PROJECT_KEY = "/coverage";
  const FILLER_ROWS = 5_100;
  const NEWEST_FILLER = `filler-${FILLER_ROWS - 1}`;

  const coverageLive = new Map<string, LiveInfo>([
    [`claude/${OLD_LIVE_SID}`, { pid: 1, status: "working", waitingFor: null, name: "old indexed live" }],
    [`claude/${UNKNOWN_SID}`, { pid: 2, status: "idle", waitingFor: null, name: "local unknown" }],
    [`${REMOTE_ENV}:claude/${UNKNOWN_SID}`, {
      pid: null, status: "working", waitingFor: null, name: "remote unknown", env: REMOTE_ENV,
    }],
    ["malformed", { pid: null, status: "idle", waitingFor: null, name: "not an identity" }],
  ]);
  const coverageSnapshot: LiveSnapshot = { at: 1, live: coverageLive, sources: [] };
  const coverageReader: SessionLiveReader = {
    refresh: async () => coverageLive,
    refreshSnapshot: async () => coverageSnapshot,
    getLiveMap: () => coverageLive,
    getSnapshot: () => coverageSnapshot,
    getLiveVersion: () => 1,
    findLive: async (agent, sid, env) =>
      coverageLive.get(env === undefined ? `${agent}/${sid}` : `${env}:${agent}/${sid}`) ?? null,
  };
  const inertDiscovery: DiscoveryReaders = {
    gateway: {
      getVersion: () => 1,
      refresh: async () => ({ scannedAt: 1, cacheTtlMs: 1, sources: [], warnings: [], files: [], routes: [] }),
    },
    resources: {
      getVersion: () => 1,
      refresh: async () => ({ scannedAt: 1, cacheTtlMs: 1, warnings: [], resources: {} }),
    },
  };

  function indexedSession(sid: string, lastInputAt: number) {
    return {
      agent: "claude" as const, sid, projectKey: PROJECT_KEY, cwd: "/coverage",
      worktreeRoot: "/coverage", branch: "main", title: null, firstPrompt: "hi", lastPrompt: "hi",
      lastInputAt, promptCount: 1, filePath: `/tmp/${sid}.jsonl`, fileSize: 1, fileMtime: 1, parsedOffset: 1,
    };
  }

  let coverageRoot = "";
  let coverageUrl = "";
  let coverage: OrcaTabServer;

  beforeAll(async () => {
    coverageRoot = mkdtempSync(join(tmpdir(), "orcatab-coverage-"));
    mkdirSync(join(coverageRoot, "claude", "projects"), { recursive: true });
    mkdirSync(join(coverageRoot, "codex", "sessions"), { recursive: true });
    coverage = await createServer({
      port: 0,
      claudeDir: join(coverageRoot, "claude"), codexDir: join(coverageRoot, "codex"),
      hermesDb: join(coverageRoot, "missing-hermes.db"), dataDir: join(coverageRoot, "data"),
      orcaBin: join(coverageRoot, "missing-orca"),
      focusDeps, sessionLiveReader: coverageReader, discovery: inertDiscovery, orcaAuditReader,
      startTimers: false, quiet: true,
    });
    coverageUrl = `http://127.0.0.1:${coverage.server.port}`;
    coverage.db.upsertProject({ key: PROJECT_KEY, name: "coverage", root: "/coverage", color: null });
    coverage.db.transaction(() => {
      coverage.db.upsertSession(indexedSession(OLD_LIVE_SID, 1));
      for (let index = 0; index < FILLER_ROWS; index += 1) {
        coverage.db.upsertSession(indexedSession(`filler-${index}`, 1_000 + index));
      }
    });
    coverage.db.bumpListVersion();
  });

  afterAll(() => { coverage.stop(); rmSync(coverageRoot, { recursive: true, force: true }); });

  test("/api/live carries the index's answer for every valid identity and drops the rest", async () => {
    const payload = await (await fetch(`${coverageUrl}/api/live`)).json();
    // "malformed" is not an identity this codebase produces, so it is dropped, not echoed back.
    expect(Object.keys(payload)).toEqual([
      `claude/${OLD_LIVE_SID}`, `claude/${UNKNOWN_SID}`, `${REMOTE_ENV}:claude/${UNKNOWN_SID}`,
    ]);
    expect(payload[`claude/${OLD_LIVE_SID}`]).toMatchObject({
      pid: 1, status: "working", name: "old indexed live", projectKey: PROJECT_KEY, indexed: true,
    });
    expect(payload[`claude/${OLD_LIVE_SID}`].session).toMatchObject({
      agent: "claude", sid: OLD_LIVE_SID, projectKey: PROJECT_KEY, indexed: true,
      live: { pid: 1, status: "working" }, goals: [],
    });
    // A database miss leaves the project unknown; it never claims anything about a transcript.
    expect(payload[`claude/${UNKNOWN_SID}`]).toMatchObject({ projectKey: null, indexed: false });
    expect(payload[`claude/${UNKNOWN_SID}`].session.env).toBeUndefined();
    expect(payload[`${REMOTE_ENV}:claude/${UNKNOWN_SID}`].session).toMatchObject({
      agent: "claude", env: REMOTE_ENV, sid: UNKNOWN_SID, indexed: false,
    });
    // Every returned entry carries the index's answer; none is left for the GUI to guess at.
    expect(Object.values(payload).every((entry) => {
      const resolved = entry as { indexed?: unknown; session?: unknown };
      return typeof resolved.indexed === "boolean" && resolved.session !== undefined;
    })).toBeTrue();
  });

  test("a page too small to hold an indexed live row never reports it as unindexed", async () => {
    const page = await (await fetch(`${coverageUrl}/api/sessions?limit=3`)).json();
    expect(page.map((row: { sid: string; env?: string; indexed?: boolean }) =>
      [row.sid, row.env ?? null, row.indexed ?? null])).toEqual([
      [UNKNOWN_SID, null, false], [UNKNOWN_SID, REMOTE_ENV, false], [NEWEST_FILLER, null, null],
    ]);
    expect(page.some((row: { sid: string }) => row.sid === OLD_LIVE_SID)).toBeFalse();
  });

  test("live=1 resolves by identity, so newer indexed rows cannot hide an old live session", async () => {
    expect(coverage.db.listSessions({ limit: 5_000 })
      .some((row) => row.sid === OLD_LIVE_SID)).toBeFalse();
    const rows = await (await fetch(`${coverageUrl}/api/sessions?live=1`)).json();
    expect(rows.map((row: { sid: string; env?: string }) => [row.sid, row.env ?? null])).toEqual([
      [UNKNOWN_SID, null], [UNKNOWN_SID, REMOTE_ENV], [OLD_LIVE_SID, null],
    ]);
    expect(rows[2]).toMatchObject({
      sid: OLD_LIVE_SID, projectKey: PROJECT_KEY, indexed: true, live: { pid: 1 },
    });
  });

  test("live=1 applies the project filter after resolution and never duplicates a row", async () => {
    const rows = await (await fetch(
      `${coverageUrl}/api/sessions?live=1&project=${encodeURIComponent(PROJECT_KEY)}`,
    )).json();
    expect(rows.map((row: { sid: string }) => row.sid)).toEqual([OLD_LIVE_SID]);
    const all = await (await fetch(`${coverageUrl}/api/sessions?live=1&limit=5000`)).json();
    const keys = all.map((row: { agent: string; sid: string; env?: string }) =>
      row.env ? `${row.env}:${row.agent}/${row.sid}` : `${row.agent}/${row.sid}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("linking a goal moves the /api/live ETag, because the payload carries goals", async () => {
    const before = await fetch(`${coverageUrl}/api/live`);
    const beforeEtag = before.headers.get("ETag")!;
    expect((await before.json())[`claude/${OLD_LIVE_SID}`].session.goals).toEqual([]);
    const goal = coverage.goalsStore.createGoal({ name: "coverage goal" });
    coverage.goalsStore.setLink(goal.id, "claude", OLD_LIVE_SID, "confirmed");
    const after = await fetch(`${coverageUrl}/api/live`, { headers: { "If-None-Match": beforeEtag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(beforeEtag);
    expect((await after.json())[`claude/${OLD_LIVE_SID}`].session.goals)
      .toEqual([{ id: goal.id, name: "coverage goal" }]);
  });

  test("indexing a previously unknown session updates the projection and the ETag, live unchanged", async () => {
    const before = await fetch(`${coverageUrl}/api/live`);
    const beforeEtag = before.headers.get("ETag")!;
    expect((await before.json())[`claude/${UNKNOWN_SID}`].indexed).toBeFalse();
    coverage.db.upsertSession(indexedSession(UNKNOWN_SID, 9_000));
    coverage.db.bumpListVersion();
    const after = await fetch(`${coverageUrl}/api/live`, { headers: { "If-None-Match": beforeEtag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(beforeEtag);
    const payload = await after.json();
    expect(payload[`claude/${UNKNOWN_SID}`]).toMatchObject({ indexed: true, projectKey: PROJECT_KEY });
    // The remote identity is a different session that happens to share an agent and sid.
    expect(payload[`${REMOTE_ENV}:claude/${UNKNOWN_SID}`]).toMatchObject({ indexed: false, projectKey: null });
    const rows = await (await fetch(`${coverageUrl}/api/sessions?live=1`)).json();
    expect(rows.map((row: { sid: string; env?: string; indexed?: boolean }) =>
      [row.sid, row.env ?? null, row.indexed])).toEqual([
      [UNKNOWN_SID, REMOTE_ENV, false], [UNKNOWN_SID, null, true], [OLD_LIVE_SID, null, true],
    ]);
  });
});

/**
 * Focus targets that name their machine. A path, an agent and a sid all repeat across
 * environments, so every focus route states which environment it means — and the legacy no-`env`
 * caller keeps its old auto-detection, which the GUI no longer relies on.
 */
describe("environment-scoped focus routing", () => {
  const REMOTE_ENV = "feibo1";
  const routingDiscovery: DiscoveryReaders = {
    gateway: { getVersion: () => 1, refresh: async () => ({
      scannedAt: 1, cacheTtlMs: 1, sources: [], warnings: [], files: [], routes: [],
    }) },
    resources: { getVersion: () => 1, refresh: async () => ({
      scannedAt: 1, cacheTtlMs: 1, warnings: [], resources: {},
    }) },
  };
  const LOCAL_PROJECT_KEY = "/routing/local";
  const REMOTE_PROJECT_KEY = `${REMOTE_ENV}:/routing/remote`;
  const LOCAL_ONLY_SID = "aaaaaaaa-1111-1111-1111-111111111111";
  const REMOTE_ONLY_SID = "bbbbbbbb-2222-2222-2222-222222222222";
  /** Indexed only on the remote machine, but the GUI is showing a local unindexed live row. */
  const SHARED_SID = "cccccccc-3333-3333-3333-333333333333";

  const liveLookups: Array<{ sid: string; env: string | undefined }> = [];
  const orcaCalls: string[][] = [];
  const routingFocusDeps: FocusDeps = {
    findLive: (_agent, sid, env) => { liveLookups.push({ sid, env }); return null; },
    getSessionCwd: () => null,
    psEnv: async () => "",
    orcaJson: async (args) => {
      orcaCalls.push(args);
      if (args[1] === "list") return { ok: true, result: { terminals: [] } };
      return { ok: false };
    },
    openOrca: async () => {},
    remoteSshPrefix: (env) => `ssh ${env}`,
  };

  function routingSession(sid: string, projectKey: string, env?: string) {
    return {
      agent: "codex" as const, ...(env === undefined ? {} : { env }), sid, projectKey,
      cwd: "/routing/shared", worktreeRoot: "/routing/shared", branch: "main", title: null,
      firstPrompt: "hi", lastPrompt: "hi", lastInputAt: 1, promptCount: 1,
      filePath: `/tmp/${sid}.jsonl`, fileSize: 1, fileMtime: 1, parsedOffset: 1,
    };
  }

  let routingRoot = "";
  let routingUrl = "";
  let routing: OrcaTabServer;

  beforeAll(async () => {
    routingRoot = mkdtempSync(join(tmpdir(), "orcatab-routing-"));
    mkdirSync(join(routingRoot, "claude", "projects"), { recursive: true });
    mkdirSync(join(routingRoot, "codex", "sessions"), { recursive: true });
    routing = await createServer({
      port: 0,
      claudeDir: join(routingRoot, "claude"), codexDir: join(routingRoot, "codex"),
      hermesDb: join(routingRoot, "missing-hermes.db"), dataDir: join(routingRoot, "data"),
      orcaBin: join(routingRoot, "missing-orca"),
      focusDeps: routingFocusDeps, discovery: routingDiscovery, orcaAuditReader,
      startTimers: false, quiet: true,
    });
    routingUrl = `http://127.0.0.1:${routing.server.port}`;
    routing.db.upsertProject({ key: LOCAL_PROJECT_KEY, name: "local", root: "/routing/local", color: null });
    routing.db.upsertProject({ key: REMOTE_PROJECT_KEY, name: `remote @${REMOTE_ENV}`, root: "", color: null });
    routing.db.transaction(() => {
      routing.db.upsertSession(routingSession(LOCAL_ONLY_SID, LOCAL_PROJECT_KEY));
      routing.db.upsertSession(routingSession(REMOTE_ONLY_SID, REMOTE_PROJECT_KEY, REMOTE_ENV));
      routing.db.upsertSession(routingSession(SHARED_SID, REMOTE_PROJECT_KEY, REMOTE_ENV));
    });
    routing.db.bumpListVersion();
  });

  afterAll(() => { routing.stop(); rmSync(routingRoot, { recursive: true, force: true }); });

  test("a uri naming an environment focuses that machine, not this one", async () => {
    liveLookups.length = 0;
    const uri = `orcatab://${REMOTE_ENV}:codex/${REMOTE_ONLY_SID}`;
    const response = await fetch(`${routingUrl}/focus?uri=${encodeURIComponent(uri)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`manual remote-environment ssh ${REMOTE_ENV} -t`);
    expect(liveLookups).toEqual([{ sid: REMOTE_ONLY_SID, env: REMOTE_ENV }]);
  });

  test("a uri without an environment stays local even when the sid is indexed remotely", async () => {
    liveLookups.length = 0;
    const uri = `orcatab://codex/${SHARED_SID}`;
    const response = await fetch(`${routingUrl}/focus?uri=${encodeURIComponent(uri)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("manual unknown-session");
    expect(liveLookups).toEqual([{ sid: SHARED_SID, env: undefined }]);
  });

  test("an explicit env=local pins the local machine; a legacy no-env caller still auto-detects", async () => {
    liveLookups.length = 0;
    const explicit = await fetch(`${routingUrl}/api/focus/codex/${SHARED_SID}?env=local`, { method: "POST" });
    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toEqual({ action: "manual", reason: "unknown-session", command: null });

    // Unchanged compatibility: a caller from before the parameter existed still reaches the only
    // environment that has the session indexed.
    const legacy = await fetch(`${routingUrl}/api/focus/codex/${SHARED_SID}`, { method: "POST" });
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ action: "manual", reason: "remote-environment" });
    expect(liveLookups).toEqual([
      { sid: SHARED_SID, env: undefined }, { sid: SHARED_SID, env: REMOTE_ENV },
    ]);
  });

  test("a remote-only project focuses through its own environment, never this machine's terminals", async () => {
    liveLookups.length = 0;
    orcaCalls.length = 0;
    const response = await fetch(`${routingUrl}/api/projects/focus`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: REMOTE_PROJECT_KEY }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "manual", reason: "remote-environment" });
    expect(liveLookups.map((lookup) => lookup.env)).toEqual([REMOTE_ENV]);
    expect(orcaCalls.some((args) => args[0] === "terminal" && args[1] === "list")).toBeFalse();
  });

  test("a local project still resolves through its worktree path", async () => {
    liveLookups.length = 0;
    orcaCalls.length = 0;
    const response = await fetch(`${routingUrl}/api/projects/focus`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectKey: LOCAL_PROJECT_KEY }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ action: "manual", reason: "no-active-terminal", cwd: "/routing/shared" });
    expect(orcaCalls).toEqual([["terminal", "list", "--worktree", "path:/routing/shared", "--json"]]);
    expect(liveLookups).toEqual([]);
  });
});
