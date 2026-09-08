import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BoardOfflineError, BoardRequestError, createKansessionBoard, type TaskBoard } from "../src/boards";

const WORKSPACE = "ws-1";
const PROJECT_ID = "p-1";
const ARCHIVED_PROJECT_ID = "p-2";
const WEB_URL = "http://board.test";
const API_KEY = "secret-key";
const WORKSPACE_ID = "ws-1";

interface RecordedRequest { method: string; path: string; apiKey: string | null; body: unknown; }

const requests: RecordedRequest[] = [];
let server: ReturnType<typeof Bun.serve>;
let board: TaskBoard;
let taskNumber = 0;
let failNextWith: number | null = null;
let workspaces: Array<{ id: string; name: string }> = [{ id: WORKSPACE_ID, name: "orca" }];

const PROJECTS = [
  { id: PROJECT_ID, name: "orcatab", slug: "orc", workspaceId: WORKSPACE, archivedAt: null },
  { id: ARCHIVED_PROJECT_ID, name: "old", slug: "old", workspaceId: WORKSPACE, archivedAt: "2026-01-01T00:00:00Z" },
];
const COLUMNS = [
  { id: "c2", slug: "done", position: 2, isFinal: true },
  { id: "c1", slug: "to-do", position: 1, isFinal: false },
];
const TASKS = new Map<string, Record<string, unknown>>([
  ["t-open", { id: "t-open", projectId: PROJECT_ID, title: "开着的", status: "to-do", number: 7 }],
  ["t-done", { id: "t-done", projectId: PROJECT_ID, title: "做完的", status: "done", number: 8 }],
]);

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({
        method: request.method, path: url.pathname,
        apiKey: request.headers.get("x-api-key"), body,
      });
      if (failNextWith !== null) {
        const status = failNextWith;
        failNextWith = null;
        return new Response("nope", { status });
      }
      if (url.pathname === "/api/auth/organization/list") return Response.json(workspaces);
      if (url.pathname === "/api/project") {
        return url.searchParams.get("workspaceId") === WORKSPACE_ID
          ? Response.json(PROJECTS)
          : new Response("Workspace ID could not be determined", { status: 400 });
      }
      if (url.pathname === `/api/column/${PROJECT_ID}`) return Response.json(COLUMNS);
      if (url.pathname === `/api/task/${PROJECT_ID}` && request.method === "POST") {
        taskNumber += 1;
        const record = body as Record<string, unknown>;
        return Response.json({
          id: `new-${taskNumber}`, projectId: PROJECT_ID, title: record.title,
          status: record.status, number: taskNumber,
        });
      }
      if (url.pathname === "/api/agent-session/link") return Response.json({ ok: true });
      const task = TASKS.get(url.pathname.replace("/api/task/", ""));
      return task === undefined ? new Response("not found", { status: 404 }) : Response.json(task);
    },
  });
  board = createKansessionBoard({
    id: "kan", name: "kansession", baseUrl: `http://127.0.0.1:${server.port}`,
    webUrl: WEB_URL, apiKey: API_KEY, workspaceId: WORKSPACE_ID,
  });
});

afterAll(() => { server.stop(true); });

describe("kansession adapter", () => {
  test("discovers the only workspace the key can see, then scopes the project list to it", async () => {
    requests.length = 0;
    const scoped = createKansessionBoard({
      id: "scoped", name: "kansession", baseUrl: `http://127.0.0.1:${server.port}`,
      webUrl: null, apiKey: API_KEY,
    });
    expect(await scoped.listProjects()).toHaveLength(1);
    expect(requests.map((entry) => entry.path))
      .toEqual(["/api/auth/organization/list", "/api/project"]);
  });

  test("refuses to guess when the key sees several workspaces", async () => {
    workspaces = [{ id: "ws-1", name: "orca" }, { id: "ws-2", name: "other" }];
    try {
      const ambiguous = createKansessionBoard({
        id: "ambiguous", name: "kansession", baseUrl: `http://127.0.0.1:${server.port}`,
        webUrl: null, apiKey: API_KEY,
      });
      const error = await ambiguous.listProjects().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BoardRequestError);
      expect((error as Error).message).toContain("set workspaceId in ORCATAB_BOARDS");
      expect((error as Error).message).toContain("ws-2 (other)");
    } finally { workspaces = [{ id: WORKSPACE_ID, name: "orca" }]; }
  });

  test("skips discovery when the workspace is configured", async () => {
    requests.length = 0;
    const pinned = createKansessionBoard({
      id: "pinned", name: "kansession", baseUrl: `http://127.0.0.1:${server.port}`,
      webUrl: null, apiKey: API_KEY, workspaceId: WORKSPACE_ID,
    });
    expect(await pinned.listProjects()).toHaveLength(1);
    expect(requests.map((entry) => entry.path)).toEqual(["/api/project"]);
  });

  test("lists live projects with a web url, hiding archived ones", async () => {
    expect(await board.listProjects()).toEqual([
      { id: PROJECT_ID, name: "orcatab", url: `${WEB_URL}/dashboard/workspace/${WORKSPACE}/project/${PROJECT_ID}` },
    ]);
  });

  test("captures into the first non-final column and returns a linkable task", async () => {
    requests.length = 0;
    const task = await board.capture({ projectId: PROJECT_ID, title: "捕捉一个想法" });
    const created = requests.find((entry) => entry.method === "POST");
    expect(created?.path).toBe(`/api/task/${PROJECT_ID}`);
    expect(created?.apiKey).toBe(API_KEY);
    expect(created?.body).toEqual({
      title: "捕捉一个想法", description: "", status: "to-do", priority: "no-priority",
    });
    expect(task).toEqual({
      boardId: "kan", taskId: "new-1", projectId: PROJECT_ID, title: "捕捉一个想法",
      status: "to-do", statusKind: "open", number: "ORC-1",
      url: `${WEB_URL}/dashboard/workspace/${WORKSPACE}/project/${PROJECT_ID}/task/new-1`,
    });
  });

  test("reads a final column as done, so a landed task leaves the queue", async () => {
    const found = await board.lookup(["t-open", "t-done"]);
    expect(found.tasks.get("t-open")?.statusKind).toBe("open");
    expect(found.tasks.get("t-done")?.statusKind).toBe("done");
    expect(found.tasks.get("t-open")?.number).toBe("ORC-7");
    expect(found.gone).toEqual([]);
  });

  test("reports a deleted task as gone without failing the rest of the batch", async () => {
    const found = await board.lookup(["t-open", "missing-404"]);
    expect([...found.tasks.keys()]).toEqual(["t-open"]);
    expect(found.gone).toEqual(["missing-404"]);
  });

  test("reads kansession's 400 for an unknown task as gone, since it resolves workspace from the task", async () => {
    failNextWith = 400;
    const found = await board.lookup(["deleted-task"]);
    expect(found.tasks.size).toBe(0);
    expect(found.gone).toEqual(["deleted-task"]);
  });

  test("keeps a link whose lookup merely failed, so a blip cannot erase a captured idea", async () => {
    failNextWith = 500;
    const found = await board.lookup(["t-open"]);
    expect(found.tasks.size).toBe(0);
    expect(found.gone).toEqual([]);
  });

  test("back-links the session without a snapshot, letting kansession resolve it over SPP", async () => {
    requests.length = 0;
    await board.backlink?.("new-1", { providerId: "orcatab", sessionId: "sid-1", agent: "claude" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST", path: "/api/agent-session/link", apiKey: API_KEY,
      body: { taskId: "new-1", providerId: "orcatab", sessionId: "sid-1", kind: "confirmed" },
    });
  });

  test("reports a non-2xx as a board error carrying the status", async () => {
    failNextWith = 500;
    const offline = createKansessionBoard({
      id: "kan2", name: "kansession", baseUrl: `http://127.0.0.1:${server.port}`,
      webUrl: null, apiKey: null, workspaceId: WORKSPACE_ID,
    });
    const error = await offline.listProjects().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BoardRequestError);
    expect((error as BoardRequestError).status).toBe(500);
  });

  test("reports an unreachable board as offline, not as a request failure", async () => {
    const unreachable = createKansessionBoard({
      id: "gone", name: "kansession", baseUrl: "http://127.0.0.1:1", webUrl: null, apiKey: null,
      workspaceId: WORKSPACE_ID,
    });
    const error = await unreachable.listProjects().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BoardOfflineError);
    expect((error as BoardOfflineError).boardId).toBe("gone");
  });

  test("omits the task url when the board has no web address", async () => {
    const headless = createKansessionBoard({
      id: "headless", name: "kansession", baseUrl: `http://127.0.0.1:${server.port}`,
      webUrl: null, apiKey: null, workspaceId: WORKSPACE_ID,
    });
    expect((await headless.lookup(["t-open"])).tasks.get("t-open")?.url).toBeNull();
  });
});
