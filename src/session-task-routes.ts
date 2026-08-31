import {
  BoardOfflineError, BoardRequestError, MAX_TASK_TITLE_CHARS, normalizeTaskTitle, UnknownBoardError,
} from "./boards";
import { ValidationError } from "./focus";
import { assertJsonRequest, assertSameOriginWrite, conditionalJson, decodeParts, json, jsonObject } from "./http";
import { toSessionIdentity, type SessionIdentity } from "./session-identity";
import {
  boardOverviews, captureSessionTask, ProjectSelectionRequiredError, refreshSessionTasks,
  sessionTaskMap, unlinkSessionTask, type SessionTaskDeps,
} from "./session-tasks";

const BOARDS_ROUTE = "/api/boards";
const BINDINGS_ROUTE = "/api/boards/bindings";
const BINDING_PREFIX = "/api/boards/bindings/";
const TASKS_ROUTE = "/api/session-tasks";
const TASKS_PREFIX = "/api/session-tasks/";
const REFRESH_MIN_INTERVAL_MS = 15_000;
const BOARD_ERROR_STATUS = 502;
const SELECTION_REQUIRED_STATUS = 409;

export interface RefreshGate { due(): boolean; mark(): void; }

/** Reading the queue must not turn every UI poll into a round trip to the board. */
export function createRefreshGate(intervalMs = REFRESH_MIN_INTERVAL_MS): RefreshGate {
  let lastAt = 0;
  return {
    due: () => Date.now() - lastAt >= intervalMs,
    mark: () => { lastAt = Date.now(); },
  };
}

export interface SessionTaskRouteDeps extends SessionTaskDeps { refreshGate: RefreshGate; }

function requiredIdentity(agent: unknown, sid: unknown): SessionIdentity {
  const identity = toSessionIdentity(agent, sid);
  if (identity === null) throw new ValidationError("invalid session identity");
  return identity;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${field} is required`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  return value.trim() || undefined;
}

function captureTitle(value: unknown): string {
  try { return normalizeTaskTitle(value); }
  catch { throw new ValidationError(`title is required and must be at most ${MAX_TASK_TITLE_CHARS} characters`); }
}

async function readBoards(deps: SessionTaskRouteDeps): Promise<Response> {
  return json({
    boards: await boardOverviews(deps),
    defaultBoardId: deps.boards.defaultBoardId,
    bindings: deps.bindings.list(),
  });
}

async function bindProject(request: Request, deps: SessionTaskRouteDeps): Promise<Response> {
  const body = await jsonObject(request);
  const projectKey = requiredText(body.projectKey, "projectKey");
  const boardId = requiredText(body.boardId, "boardId");
  const projectId = requiredText(body.projectId, "projectId");
  const board = deps.boards.require(boardId);
  const projects = await board.listProjects();
  const project = projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw new ValidationError(`board "${boardId}" has no project "${projectId}"`);
  return json({
    ok: true,
    binding: deps.bindings.bind({
      projectKey, boardId, boardProjectId: projectId, boardProjectName: project.name,
    }),
  });
}

async function readTasks(request: Request, url: URL, deps: SessionTaskRouteDeps): Promise<Response> {
  if (url.searchParams.get("refresh") === "1" && deps.refreshGate.due()) {
    deps.refreshGate.mark();
    await refreshSessionTasks(deps);
  }
  const etag = `"t-${deps.store.version}"`;
  return conditionalJson(request, etag, () => ({
    version: deps.store.version, tasks: sessionTaskMap(deps.store),
  }));
}

async function captureTask(
  request: Request,
  identity: SessionIdentity,
  deps: SessionTaskRouteDeps,
): Promise<Response> {
  assertSameOriginWrite(request);
  assertJsonRequest(request);
  const body = await jsonObject(request);
  const result = await captureSessionTask(deps, {
    ...identity,
    title: captureTitle(body.title),
    ...(optionalText(body.description, "description") === undefined
      ? {} : { description: optionalText(body.description, "description")! }),
    ...(optionalText(body.boardId, "boardId") === undefined
      ? {} : { boardId: optionalText(body.boardId, "boardId")! }),
    ...(optionalText(body.projectId, "projectId") === undefined
      ? {} : { projectId: optionalText(body.projectId, "projectId")! }),
  });
  return json({ ok: true, ...result });
}

function deleteTask(request: Request, parts: string[], deps: SessionTaskRouteDeps): Response {
  assertSameOriginWrite(request);
  const identity = requiredIdentity(parts[0], parts[1]);
  const boardId = requiredText(parts[2], "boardId");
  const taskId = requiredText(parts[3], "taskId");
  return json({ ok: unlinkSessionTask(deps, identity, boardId, taskId) });
}

function errorResponse(error: unknown): Response | null {
  if (error instanceof ProjectSelectionRequiredError) {
    return json({
      error: error.message, code: "project-required",
      boardId: error.boardId, projectKey: error.projectKey,
    }, SELECTION_REQUIRED_STATUS);
  }
  if (error instanceof ValidationError || error instanceof UnknownBoardError) {
    return json({ error: error.message }, 400);
  }
  if (error instanceof BoardOfflineError) return json({ error: error.message, code: "board-offline" }, BOARD_ERROR_STATUS);
  if (error instanceof BoardRequestError) return json({ error: error.message, code: "board-error" }, BOARD_ERROR_STATUS);
  return null;
}

export async function handleSessionTaskRequest(
  request: Request,
  url: URL,
  deps: SessionTaskRouteDeps,
): Promise<Response | null> {
  const isBoards = url.pathname === BOARDS_ROUTE || url.pathname.startsWith(`${BOARDS_ROUTE}/`);
  const isTasks = url.pathname === TASKS_ROUTE || url.pathname.startsWith(TASKS_PREFIX);
  if (!isBoards && !isTasks) return null;
  try {
    if (request.method === "GET" && url.pathname === BOARDS_ROUTE) return await readBoards(deps);
    if (request.method === "POST" && url.pathname === BINDINGS_ROUTE) {
      assertSameOriginWrite(request);
      assertJsonRequest(request);
      return await bindProject(request, deps);
    }
    if (request.method === "DELETE" && url.pathname.startsWith(BINDING_PREFIX)) {
      assertSameOriginWrite(request);
      const projectKey = decodeParts(url.pathname, BINDING_PREFIX)[0] ?? "";
      return json({ ok: deps.bindings.unbind(requiredText(projectKey, "projectKey")) });
    }
    if (request.method === "GET" && url.pathname === TASKS_ROUTE) return await readTasks(request, url, deps);
    if (url.pathname.startsWith(TASKS_PREFIX)) {
      const parts = decodeParts(url.pathname, TASKS_PREFIX);
      if (request.method === "POST" && parts.length === 2) {
        return await captureTask(request, requiredIdentity(parts[0], parts[1]), deps);
      }
      if (request.method === "DELETE" && parts.length === 4) return deleteTask(request, parts, deps);
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    return errorResponse(error) ?? json({
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}
