import { describe, expect, test } from "bun:test";
import {
  BoardRegistry, openBoardDatabase, ProjectBoardStore, SessionTaskStore,
  type BoardTask, type TaskBoard,
} from "../src/boards";
import { OrcaDatabase, type StoredSession } from "../src/db";
import { createRefreshGate, handleSessionTaskRequest, type SessionTaskRouteDeps } from "../src/session-task-routes";

const SID = "11111111-1111-1111-1111-111111111111";
const PROJECT_KEY = "/work/orcatab";
const BOARD_PROJECT = "kan-project";
const JSON_HEADERS = { "content-type": "application/json" };

function storedSession(sid: string): StoredSession {
  return {
    agent: "claude", sid, projectKey: PROJECT_KEY, cwd: PROJECT_KEY, worktreeRoot: PROJECT_KEY,
    branch: "main", title: "t", firstPrompt: "p", lastPrompt: "p", lastInputAt: 1, promptCount: 1,
    filePath: `/tmp/${sid}.jsonl`, fileSize: 1, fileMtime: 1, parsedOffset: 1,
  };
}

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  let counter = 0;
  const tasks = new Map<string, BoardTask>();
  return {
    id: "kan", name: "kansession", kind: "kansession",
    capabilities: () => ({ projects: true, capture: true, lookup: true, backlink: false }),
    listProjects: async () => [{ id: BOARD_PROJECT, name: "kansession 板", url: "http://board/p" }],
    capture: async (input) => {
      counter += 1;
      const task: BoardTask = {
        boardId: "kan", taskId: `task-${counter}`, projectId: input.projectId, title: input.title,
        status: "to-do", statusKind: "open", number: `KAN-${counter}`, url: `http://board/task-${counter}`,
      };
      tasks.set(task.taskId, task);
      return task;
    },
    lookup: async (ids) => new Map(ids.flatMap((id) => {
      const task = tasks.get(id);
      return task === undefined ? [] : [[id, task] as const];
    })),
    ...overrides,
  };
}

function harness(boards: TaskBoard[] = [board()]) {
  const db = new OrcaDatabase(":memory:");
  db.upsertProject({ key: PROJECT_KEY, name: "orcatab", root: PROJECT_KEY, color: null });
  db.upsertSession(storedSession(SID));
  const database = openBoardDatabase(":memory:");
  const deps: SessionTaskRouteDeps = {
    db, boards: new BoardRegistry(boards), store: new SessionTaskStore(database),
    bindings: new ProjectBoardStore(database), refreshGate: createRefreshGate(), onError: () => {},
  };
  return {
    deps,
    async call(method: string, path: string, body?: unknown, headers: HeadersInit = {}): Promise<Response> {
      const url = new URL(`http://127.0.0.1${path}`);
      const init: RequestInit = {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { ...JSON_HEADERS, ...headers } }),
        ...(body === undefined && Object.keys(headers).length > 0 ? { headers } : {}),
      };
      const response = await handleSessionTaskRequest(new Request(url, init), url, deps);
      if (response === null) throw new Error(`route did not match: ${method} ${path}`);
      return response;
    },
    close() { database.close(); db.close(); },
  };
}

describe("board routes", () => {
  test("lists boards with their projects, default and bindings", async () => {
    const app = harness();
    try {
      const body = await (await app.call("GET", "/api/boards")).json() as Record<string, unknown>;
      expect(body.defaultBoardId).toBe("kan");
      expect(body.bindings).toEqual([]);
      const boards = body.boards as Array<Record<string, unknown>>;
      expect(boards[0]).toMatchObject({ id: "kan", online: true, error: null });
      expect(boards[0]?.projects).toEqual([{ id: BOARD_PROJECT, name: "kansession 板", url: "http://board/p" }]);
    } finally { app.close(); }
  });

  test("binds a repository to a board project and rejects an unknown one", async () => {
    const app = harness();
    try {
      const ok = await app.call("POST", "/api/boards/bindings", {
        projectKey: PROJECT_KEY, boardId: "kan", projectId: BOARD_PROJECT,
      });
      expect(ok.status).toBe(200);
      expect(app.deps.bindings.get(PROJECT_KEY)?.boardProjectName).toBe("kansession 板");

      const bad = await app.call("POST", "/api/boards/bindings", {
        projectKey: PROJECT_KEY, boardId: "kan", projectId: "nope",
      });
      expect(bad.status).toBe(400);
      expect((await bad.json() as { error: string }).error).toContain('has no project "nope"');

      const unknownBoard = await app.call("POST", "/api/boards/bindings", {
        projectKey: PROJECT_KEY, boardId: "ghost", projectId: BOARD_PROJECT,
      });
      expect(unknownBoard.status).toBe(400);

      const removed = await app.call("DELETE", `/api/boards/bindings/${encodeURIComponent(PROJECT_KEY)}`);
      expect(await removed.json()).toEqual({ ok: true });
      expect(app.deps.bindings.get(PROJECT_KEY)).toBeNull();
    } finally { app.close(); }
  });
});

describe("session task routes", () => {
  test("captures onto a session, then serves it on the queue", async () => {
    const app = harness();
    try {
      const created = await app.call("POST", `/api/session-tasks/claude/${SID}`, {
        title: "  把 IDF 降权做掉 ", projectId: BOARD_PROJECT,
      });
      expect(created.status).toBe(200);
      const payload = await created.json() as { ok: boolean; task: BoardTask; backlinkError: string | null };
      expect(payload.ok).toBe(true);
      expect(payload.task).toMatchObject({ title: "把 IDF 降权做掉", number: "KAN-1", statusKind: "open" });
      expect(payload.backlinkError).toBeNull();

      const queue = await (await app.call("GET", "/api/session-tasks")).json() as {
        version: number; tasks: Record<string, BoardTask[]>;
      };
      expect(queue.version).toBeGreaterThan(0);
      expect(queue.tasks[`claude/${SID}`]).toHaveLength(1);
    } finally { app.close(); }
  });

  test("answers 409 with a code the UI can turn into a project picker", async () => {
    const app = harness();
    try {
      const response = await app.call("POST", `/api/session-tasks/claude/${SID}`, { title: "想法" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "project-required", boardId: "kan", projectKey: PROJECT_KEY,
      });
    } finally { app.close(); }
  });

  test("rejects an empty title and an unknown session identity", async () => {
    const app = harness();
    try {
      const empty = await app.call("POST", `/api/session-tasks/claude/${SID}`, { title: "   " });
      expect(empty.status).toBe(400);
      const badAgent = await app.call("POST", `/api/session-tasks/nope/${SID}`, { title: "x" });
      expect(badAgent.status).toBe(400);
      expect((await badAgent.json() as { error: string }).error).toBe("invalid session identity");
    } finally { app.close(); }
  });

  test("surfaces a board failure as 502 without storing a link", async () => {
    const app = harness([board({
      capture: async () => { throw new (await import("../src/boards")).BoardOfflineError("kan", "board \"kan\" is unreachable"); },
    })]);
    try {
      const response = await app.call("POST", `/api/session-tasks/claude/${SID}`, {
        title: "想法", projectId: BOARD_PROJECT,
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: "board-offline" });
      expect(app.deps.store.listAll()).toEqual([]);
    } finally { app.close(); }
  });

  test("unlinks a queue item without touching the board", async () => {
    const app = harness();
    try {
      await app.call("POST", `/api/session-tasks/claude/${SID}`, { title: "想法", projectId: BOARD_PROJECT });
      const removed = await app.call("DELETE", `/api/session-tasks/claude/${SID}/kan/task-1`);
      expect(await removed.json()).toEqual({ ok: true });
      expect(app.deps.store.listAll()).toEqual([]);
      const again = await app.call("DELETE", `/api/session-tasks/claude/${SID}/kan/task-1`);
      expect(await again.json()).toEqual({ ok: false });
    } finally { app.close(); }
  });

  test("serves a 304 while the queue has not changed", async () => {
    const app = harness();
    try {
      await app.call("POST", `/api/session-tasks/claude/${SID}`, { title: "想法", projectId: BOARD_PROJECT });
      const first = await app.call("GET", "/api/session-tasks");
      const etag = first.headers.get("ETag") ?? "";
      expect(etag).not.toBe("");
      const second = await app.call("GET", "/api/session-tasks", undefined, { "If-None-Match": etag });
      expect(second.status).toBe(304);
    } finally { app.close(); }
  });

  test("refresh=1 drops a task the board no longer has", async () => {
    const app = harness();
    try {
      await app.call("POST", `/api/session-tasks/claude/${SID}`, { title: "想法", projectId: BOARD_PROJECT });
      app.deps.boards = new BoardRegistry([board()]); // a fresh board that never saw task-1
      const refreshed = await (await app.call("GET", "/api/session-tasks?refresh=1")).json() as {
        tasks: Record<string, BoardTask[]>;
      };
      expect(refreshed.tasks).toEqual({});
    } finally { app.close(); }
  });

  test("rejects a cross-site write", async () => {
    const app = harness();
    try {
      const response = await app.call("POST", `/api/session-tasks/claude/${SID}`,
        { title: "想法", projectId: BOARD_PROJECT }, { "Sec-Fetch-Site": "cross-site" });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toContain("cross-site");
    } finally { app.close(); }
  });

  test("ignores paths it does not own", async () => {
    const app = harness();
    try {
      const url = new URL("http://127.0.0.1/api/sessions");
      expect(await handleSessionTaskRequest(new Request(url), url, app.deps)).toBeNull();
    } finally { app.close(); }
  });
});
