import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase } from "../src/db";
import { createOrchestrationReader } from "../src/orchestration";
import { createServer, type OrcaTabServer } from "../src/server";
import type { Agent, LiveInfo } from "../src/types";

const COORDINATOR_SID = "11111111-1111-1111-1111-111111111111";
const RESUMED_COORDINATOR_SID = "22222222-2222-2222-2222-222222222222";
const WORKER_SID = "33333333-3333-3333-3333-333333333333";
const OTHER_WORKER_SID = "44444444-4444-4444-4444-444444444444";
const RUN_ID = "run_aaaabbbbcccc";
const TASK_ID = "task_ddddeeeeffff";
const DISPATCH_ID = "ctx_111122223333";
const IDLE_RUN_ID = "run_999988887777";

let root = "";

function sqlNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

interface RunFixture {
  id: string; objective: string; coordinatorHandle: string | null; coordinatorPaneKey: string | null;
  tasks: Array<{ dispatchId: string; taskId: string; taskTitle?: string }>;
}

function writeOrchestrationDb(path: string, runs: RunFixture[]): void {
  const database = new Database(path, { create: true });
  database.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, objective TEXT NOT NULL, coordinator_handle TEXT, coordinator_pane_key TEXT,
    legacy INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE dispatch_contexts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, task_title TEXT);`);
  for (const run of runs) {
    database.query(`INSERT INTO runs
      (id, objective, coordinator_handle, coordinator_pane_key, legacy, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)`)
      .run(run.id, run.objective, run.coordinatorHandle, run.coordinatorPaneKey, sqlNow(-60_000), sqlNow());
    for (const task of run.tasks) {
      database.query("INSERT INTO dispatch_contexts (id, task_id, run_id) VALUES (?, ?, ?)")
        .run(task.dispatchId, task.taskId, run.id);
      database.query("INSERT OR REPLACE INTO tasks (id, task_title) VALUES (?, ?)")
        .run(task.taskId, task.taskTitle ?? null);
    }
  }
  database.close();
}

function indexWith(entries: Array<{ agent: Agent; sid: string; texts: string[] }>): OrcaDatabase {
  const db = new OrcaDatabase(":memory:");
  entries.forEach((entry, position) => {
    db.upsertSession({
      agent: entry.agent, sid: entry.sid, projectKey: "/fixture", cwd: "/fixture", worktreeRoot: "/fixture",
      branch: "main", title: null, firstPrompt: entry.texts[0] ?? null, lastPrompt: entry.texts.at(-1) ?? null,
      lastInputAt: 1_000 + position, promptCount: entry.texts.length,
      filePath: `/fixture/${entry.sid}.jsonl`, fileSize: 1, fileMtime: 1, parsedOffset: 1,
    });
    db.appendSessionFts(entry.texts.map((text) => ({
      text, agent: entry.agent, sid: entry.sid, role: "user" as const, ts: 1_000,
    })));
  });
  return db;
}

const noLive = () => new Map<string, LiveInfo>();

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orcatab-orchestration-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("orchestration reader", () => {
  test("groups dispatched workers under the coordinator that owns the run", () => {
    const path = join(root, "grouped.db");
    writeOrchestrationDb(path, [{
      id: RUN_ID, objective: "知识图落地", coordinatorHandle: null, coordinatorPaneKey: null,
      tasks: [{ dispatchId: DISPATCH_ID, taskId: TASK_ID, taskTitle: "W3 图读模型接真实数据" }],
    }]);
    const db = indexWith([
      { agent: "claude", sid: COORDINATOR_SID, texts: [`You have 1 orchestration message. Run \`orca orchestration check --run ${RUN_ID}\`.`, `派发 ${TASK_ID}`] },
      { agent: "codex", sid: WORKER_SID, texts: [`work order ${TASK_ID} dispatch ${DISPATCH_ID}`] },
    ]);
    const snapshot = createOrchestrationReader({ db, getLiveMap: noLive, path }).refresh();
    expect(snapshot.available).toBe(true);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]!.coordinator).toEqual({ agent: "claude", sid: COORDINATOR_SID });
    expect(snapshot.runs[0]!.workers).toEqual([
      { agent: "codex", sid: WORKER_SID, taskTitle: "W3 图读模型接真实数据" },
    ]);
    expect(snapshot.runs[0]!.objective).toBe("知识图落地");
    db.close();
  });

  test("prefers the session Orca still points the coordinator handle at", () => {
    const path = join(root, "handle.db");
    writeOrchestrationDb(path, [{
      id: RUN_ID, objective: "handle wins", coordinatorHandle: "term_live", coordinatorPaneKey: null,
      tasks: [{ dispatchId: DISPATCH_ID, taskId: TASK_ID }],
    }]);
    const db = indexWith([
      { agent: "claude", sid: RESUMED_COORDINATOR_SID, texts: [`${RUN_ID} 早期会话`, `${RUN_ID} 又一次`, `${RUN_ID} 再一次`] },
      { agent: "claude", sid: COORDINATOR_SID, texts: [`${RUN_ID} 当前会话`] },
      { agent: "codex", sid: WORKER_SID, texts: [`work order ${TASK_ID}`] },
    ]);
    const live = new Map<string, LiveInfo>([[`claude/${COORDINATOR_SID}`, {
      pid: null, status: "working", waitingFor: null, name: "coordinator", handle: "term_live",
      tabId: "tab", leafId: "leaf",
    }]]);
    const snapshot = createOrchestrationReader({ db, getLiveMap: () => live, path }).refresh();
    expect(snapshot.runs[0]!.coordinator).toEqual({ agent: "claude", sid: COORDINATOR_SID });
    expect(snapshot.runs[0]!.workers).toEqual([{ agent: "codex", sid: WORKER_SID, taskTitle: null }]);
    db.close();
  });

  test("falls back to the pane key when the handle moved", () => {
    const path = join(root, "pane.db");
    writeOrchestrationDb(path, [{
      id: RUN_ID, objective: "pane wins", coordinatorHandle: "term_gone", coordinatorPaneKey: "tab:leaf",
      tasks: [{ dispatchId: DISPATCH_ID, taskId: TASK_ID }],
    }]);
    const db = indexWith([
      { agent: "claude", sid: COORDINATOR_SID, texts: ["无关内容"] },
      { agent: "codex", sid: WORKER_SID, texts: [`work order ${TASK_ID}`] },
    ]);
    const live = new Map<string, LiveInfo>([[`claude/${COORDINATOR_SID}`, {
      pid: null, status: "done", waitingFor: null, name: "coordinator", handle: "term_other",
      tabId: "tab", leafId: "leaf",
    }]]);
    const snapshot = createOrchestrationReader({ db, getLiveMap: () => live, path }).refresh();
    expect(snapshot.runs[0]!.coordinator).toEqual({ agent: "claude", sid: COORDINATOR_SID });
    db.close();
  });

  test("keeps a coordinator that also quoted a task id out of its own worker list", () => {
    const path = join(root, "self.db");
    writeOrchestrationDb(path, [{
      id: RUN_ID, objective: "self mention", coordinatorHandle: null, coordinatorPaneKey: null,
      tasks: [{ dispatchId: DISPATCH_ID, taskId: TASK_ID }],
    }]);
    const db = indexWith([
      { agent: "claude", sid: COORDINATOR_SID, texts: [`check --run ${RUN_ID}`, `created ${TASK_ID}`] },
      { agent: "codex", sid: WORKER_SID, texts: [`work order ${TASK_ID}`] },
      { agent: "codex", sid: OTHER_WORKER_SID, texts: [`dispatch ${DISPATCH_ID}`] },
    ]);
    const snapshot = createOrchestrationReader({ db, getLiveMap: noLive, path }).refresh();
    expect(snapshot.runs[0]!.workers).toEqual([
      { agent: "codex", sid: WORKER_SID, taskTitle: null },
      { agent: "codex", sid: OTHER_WORKER_SID, taskTitle: null },
    ]);
    db.close();
  });

  test("labels a worker with the task headline, without the work-order path", () => {
    const path = join(root, "titles.db");
    writeOrchestrationDb(path, [{
      id: RUN_ID, objective: "titles", coordinatorHandle: null, coordinatorPaneKey: null,
      tasks: [
        { dispatchId: DISPATCH_ID, taskId: TASK_ID, taskTitle: "W3 图读模型接真实数据 — order at /private/tmp/w3.md" },
        { dispatchId: "ctx_555566667777", taskId: "task_888899990000", taskTitle: "W21 Fix 1 — pino mixin/OTLP 桥" },
      ],
    }]);
    const db = indexWith([
      { agent: "claude", sid: COORDINATOR_SID, texts: [`check --run ${RUN_ID}`] },
      { agent: "codex", sid: WORKER_SID, texts: [`work order ${TASK_ID}`] },
      { agent: "codex", sid: OTHER_WORKER_SID, texts: ["work order task_888899990000"] },
    ]);
    const workers = createOrchestrationReader({ db, getLiveMap: noLive, path }).refresh().runs[0]!.workers;
    expect(workers).toEqual([
      { agent: "codex", sid: WORKER_SID, taskTitle: "W3 图读模型接真实数据" },
      { agent: "codex", sid: OTHER_WORKER_SID, taskTitle: "W21 Fix 1 — pino mixin/OTLP 桥" },
    ]);
    db.close();
  });

  test("drops runs whose dispatches never reached a session", () => {
    const path = join(root, "idle.db");
    writeOrchestrationDb(path, [{
      id: IDLE_RUN_ID, objective: "nothing started", coordinatorHandle: null, coordinatorPaneKey: null,
      tasks: [{ dispatchId: "ctx_444455556666", taskId: "task_777788889999" }],
    }]);
    const db = indexWith([{ agent: "claude", sid: COORDINATOR_SID, texts: [`check --run ${IDLE_RUN_ID}`] }]);
    expect(createOrchestrationReader({ db, getLiveMap: noLive, path }).refresh().runs).toEqual([]);
    db.close();
  });

  test("reports an unavailable snapshot when Orca has no orchestration state", () => {
    const db = indexWith([]);
    const snapshot = createOrchestrationReader({ db, getLiveMap: noLive, path: join(root, "missing.db") }).refresh();
    expect(snapshot).toMatchObject({ available: false, runs: [], warnings: [] });
    db.close();
  });

  test("warns instead of throwing when the orchestration schema is unreadable", () => {
    const path = join(root, "broken.db");
    const broken = new Database(path, { create: true });
    broken.exec("CREATE TABLE unrelated (id TEXT);");
    broken.close();
    const db = indexWith([]);
    const snapshot = createOrchestrationReader({ db, getLiveMap: noLive, path }).refresh();
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.warnings[0]).toContain("failed to read Orca orchestration state");
    db.close();
  });

  test("caches within the ttl and only bumps the version when membership changes", () => {
    const path = join(root, "cache.db");
    writeOrchestrationDb(path, [{
      id: RUN_ID, objective: "cached", coordinatorHandle: null, coordinatorPaneKey: null,
      tasks: [{ dispatchId: DISPATCH_ID, taskId: TASK_ID }],
    }]);
    const db = indexWith([
      { agent: "claude", sid: COORDINATOR_SID, texts: [`check --run ${RUN_ID}`] },
      { agent: "codex", sid: WORKER_SID, texts: [`work order ${TASK_ID}`] },
    ]);
    let clock = 0;
    const reader = createOrchestrationReader({ db, getLiveMap: noLive, path, cacheMs: 1_000, now: () => clock });
    const first = reader.refresh();
    clock = 500;
    expect(reader.refresh()).toBe(first);
    expect(reader.getVersion()).toBe(1);
    clock = 2_000;
    expect(reader.refresh()).not.toBe(first);
    expect(reader.getVersion()).toBe(1);
    db.appendSessionFts([{ text: `work order ${TASK_ID}`, agent: "codex", sid: OTHER_WORKER_SID, role: "user", ts: 1 }]);
    clock = 4_000;
    expect(reader.refresh().runs[0]!.workers).toHaveLength(2);
    expect(reader.getVersion()).toBe(2);
    db.close();
  });
});

describe("orchestration route", () => {
  let app: OrcaTabServer;
  let baseUrl = "";
  let serverRoot = "";
  const snapshot = {
    scannedAt: 7, cacheTtlMs: 15_000, available: true, warnings: [],
    runs: [{
      runId: RUN_ID, objective: "路由", createdAt: 1, updatedAt: 2,
      coordinator: { agent: "claude" as Agent, sid: COORDINATOR_SID },
      workers: [{ agent: "codex" as Agent, sid: WORKER_SID, taskTitle: "W3" }],
    }],
  };

  beforeAll(async () => {
    serverRoot = mkdtempSync(join(tmpdir(), "orcatab-orchestration-server-"));
    mkdirSync(join(serverRoot, "claude", "projects"), { recursive: true });
    mkdirSync(join(serverRoot, "codex", "sessions"), { recursive: true });
    app = await createServer({
      port: 0, claudeDir: join(serverRoot, "claude"), codexDir: join(serverRoot, "codex"),
      hermesDb: join(serverRoot, "missing-hermes.db"), dataDir: join(serverRoot, "data"),
      orcaBin: join(serverRoot, "missing-orca"), startTimers: false, quiet: true,
      sessionLiveReader: {
        refresh: async () => new Map(), getLiveMap: () => new Map(), getLiveVersion: () => 1,
        findLive: async () => null,
      },
      orchestrationReader: { getVersion: () => 3, refresh: () => snapshot },
    });
    baseUrl = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(() => { app.stop(); rmSync(serverRoot, { recursive: true, force: true }); });

  test("serves resolved runs and revalidates with an ETag", async () => {
    const response = await fetch(`${baseUrl}/api/orchestration`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    const etag = response.headers.get("ETag") ?? "";
    expect(etag).toBe('"c-3"');
    const revalidated = await fetch(`${baseUrl}/api/orchestration`, { headers: { "If-None-Match": etag } });
    expect(revalidated.status).toBe(304);
  });

  test("announces the capability so an older page can degrade", async () => {
    const health = await (await fetch(`${baseUrl}/healthz`)).json();
    expect(health.capabilities).toContain("orchestration-runs");
  });
});
