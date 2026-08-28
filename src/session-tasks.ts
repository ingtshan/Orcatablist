import {
  BoardOfflineError, normalizeTaskTitle, type BoardProject, type BoardRegistry,
  type ProjectBoardBinding, type ProjectBoardStore, type SessionTaskLink, type SessionTaskStore,
  type TaskBoard,
} from "./boards";
import type { OrcaDatabase } from "./db";
import { sessionIdentityKey, type SessionIdentity } from "./session-identity";

const PROVIDER_ID = "orcatab";

export interface BoardOverview {
  id: string;
  name: string;
  kind: string;
  online: boolean;
  features: ReturnType<TaskBoard["capabilities"]>;
  projects: BoardProject[];
  error: string | null;
}

export interface CaptureRequest extends SessionIdentity {
  title: string;
  description?: string;
  boardId?: string;
  projectId?: string;
}

export interface CaptureResult {
  task: SessionTaskLink;
  binding: ProjectBoardBinding | null;
  /** Set when the board task was created but the SPP back-link to kansession did not land. */
  backlinkError: string | null;
}

export interface SessionTaskDeps {
  db: OrcaDatabase;
  boards: BoardRegistry;
  store: SessionTaskStore;
  bindings: ProjectBoardStore;
  onError?(message: string, error: unknown): void;
}

/** The capture has no destination yet: the caller must pick a board project once for this repo. */
export class ProjectSelectionRequiredError extends Error {
  override name = "ProjectSelectionRequiredError";
  constructor(readonly boardId: string, readonly projectKey: string | null) {
    super("pick a board project for this repository");
  }
}

function reportError(deps: SessionTaskDeps, message: string, error: unknown): void {
  if (deps.onError) deps.onError(message, error);
  else console.error(`orcatab ${message}`, error instanceof Error ? error.message : error);
}

function projectKeyFor(deps: SessionTaskDeps, identity: SessionIdentity): string | null {
  return deps.db.getSession(identity.agent, identity.sid)?.projectKey ?? null;
}

/**
 * Explicit request wins, then the repository's remembered binding, then the default board.
 * A binding only supplies the project when the request lands on the board it was made against.
 */
function resolveDestination(
  deps: SessionTaskDeps,
  request: CaptureRequest,
  projectKey: string | null,
): { board: TaskBoard; projectId: string; rebind: boolean } {
  const binding = projectKey === null ? null : deps.bindings.get(projectKey);
  const boardId = request.boardId ?? binding?.boardId ?? deps.boards.defaultBoardId;
  const board = deps.boards.require(boardId);
  const bound = binding !== null && binding.boardId === board.id ? binding.boardProjectId : null;
  const projectId = request.projectId ?? bound;
  if (projectId === null || projectId === undefined || !projectId) {
    throw new ProjectSelectionRequiredError(board.id, projectKey);
  }
  return { board, projectId, rebind: projectId !== bound || boardId !== binding?.boardId };
}

async function rememberBinding(
  deps: SessionTaskDeps,
  board: TaskBoard,
  projectKey: string | null,
  projectId: string,
): Promise<ProjectBoardBinding | null> {
  if (projectKey === null) return null;
  const projects = await board.listProjects().catch((error) => {
    reportError(deps, `board ${board.id} project list failed`, error);
    return [] as BoardProject[];
  });
  const name = projects.find((project) => project.id === projectId)?.name ?? projectId;
  return deps.bindings.bind({
    projectKey, boardId: board.id, boardProjectId: projectId, boardProjectName: name,
  });
}

export async function captureSessionTask(
  deps: SessionTaskDeps,
  request: CaptureRequest,
): Promise<CaptureResult> {
  const projectKey = projectKeyFor(deps, request);
  const { board, projectId, rebind } = resolveDestination(deps, request, projectKey);
  // The one-line title rule belongs to TBP, not to each adapter: normalize before the seam so a
  // new adapter cannot forget it. Adapters keep their own guard for direct, non-service callers.
  const created = await board.capture({
    projectId, title: normalizeTaskTitle(request.title),
    ...(request.description === undefined ? {} : { description: request.description }),
  });
  const task = deps.store.link(request.agent, request.sid, created);
  const binding = rebind ? await rememberBinding(deps, board, projectKey, projectId) : null;

  // The task exists either way; a failed back-link costs the kansession-side evidence row, not
  // the capture. Report it so the caller can surface it without treating capture as failed.
  let backlinkError: string | null = null;
  if (board.backlink !== undefined) {
    try {
      await board.backlink(created.taskId, {
        providerId: PROVIDER_ID, sessionId: request.sid, agent: request.agent,
      });
    } catch (error) {
      backlinkError = error instanceof Error ? error.message : String(error);
      reportError(deps, `board ${board.id} backlink failed`, error);
    }
  }
  return { task, binding, backlinkError };
}

export function unlinkSessionTask(
  deps: SessionTaskDeps,
  identity: SessionIdentity,
  boardId: string,
  taskId: string,
): boolean {
  return deps.store.unlink(identity.agent, identity.sid, boardId, taskId);
}

export interface RefreshSummary { boards: number; updated: number; offline: string[]; }

/**
 * Pull current titles and statuses for every still-open task. An unreachable board keeps its
 * snapshots — the queue stays readable offline, which is the whole point of storing them.
 */
export async function refreshSessionTasks(deps: SessionTaskDeps): Promise<RefreshSummary> {
  const summary: RefreshSummary = { boards: 0, updated: 0, offline: [] };
  for (const board of deps.boards.list()) {
    const taskIds = deps.store.openTaskIds(board.id);
    if (taskIds.length === 0) continue;
    summary.boards += 1;
    try {
      const tasks = await board.lookup(taskIds);
      const missing = taskIds.filter((taskId) => !tasks.has(taskId));
      summary.updated += deps.store.applySnapshots(board.id, tasks, missing);
    } catch (error) {
      if (error instanceof BoardOfflineError) summary.offline.push(board.id);
      else reportError(deps, `board ${board.id} refresh failed`, error);
    }
  }
  return summary;
}

export async function boardOverviews(deps: SessionTaskDeps): Promise<BoardOverview[]> {
  return Promise.all(deps.boards.list().map(async (board): Promise<BoardOverview> => {
    const base = {
      id: board.id, name: board.name, kind: board.kind, features: board.capabilities(),
    };
    try {
      return { ...base, online: true, projects: await board.listProjects(), error: null };
    } catch (error) {
      return {
        ...base, online: false, projects: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

/** `{ "<agent>/<sid>": SessionTaskLink[] }` — the shape the board UI indexes cards by. */
export function sessionTaskMap(store: SessionTaskStore): Record<string, SessionTaskLink[]> {
  return Object.fromEntries(store.bySession());
}

export function sessionTaskKey(identity: SessionIdentity): string {
  return sessionIdentityKey(identity.agent, identity.sid);
}
