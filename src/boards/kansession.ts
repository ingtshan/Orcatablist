import {
  BoardOfflineError, BoardRequestError, type BoardFeatures, type BoardProject, type BoardTask,
  type CaptureInput, normalizeTaskTitle, type SessionRef, type TaskBoard,
} from "./board";

const KANSESSION_FEATURES: BoardFeatures = { projects: true, capture: true, lookup: true, backlink: true };
const REQUEST_TIMEOUT_MS = 5_000;
const PROJECT_CACHE_MS = 60_000;
const COLUMN_CACHE_MS = 60_000;
const LOOKUP_CONCURRENCY = 8;
const DEFAULT_PRIORITY = "no-priority";
const FALLBACK_STATUS = "to-do";

export interface KansessionBoardConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** Where the browser reaches the board's UI. Without it, tasks have no "open" link. */
  webUrl: string | null;
  apiKey: string | null;
}

interface KansessionProject { id: string; name: string; slug: string; workspaceId: string; archivedAt: string | null; }
interface KansessionColumn { slug: string; position: number; isFinal: boolean; }
interface KansessionTask { id: string; projectId: string; title: string; status: string; number: number | null; }

interface Cached<T> { value: T; at: number; }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toProject(value: unknown): KansessionProject | null {
  if (!isObject(value) || !text(value.id) || !text(value.workspaceId)) return null;
  return {
    id: text(value.id), name: text(value.name) || text(value.id), slug: text(value.slug),
    workspaceId: text(value.workspaceId),
    archivedAt: typeof value.archivedAt === "string" ? value.archivedAt : null,
  };
}

function toColumn(value: unknown): KansessionColumn | null {
  if (!isObject(value) || !text(value.slug)) return null;
  return {
    slug: text(value.slug),
    position: typeof value.position === "number" ? value.position : 0,
    isFinal: value.isFinal === true,
  };
}

function toTask(value: unknown): KansessionTask | null {
  if (!isObject(value) || !text(value.id)) return null;
  return {
    id: text(value.id), projectId: text(value.projectId), title: text(value.title),
    status: text(value.status), number: typeof value.number === "number" ? value.number : null,
  };
}

async function chunked<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...await Promise.all(items.slice(index, index + size).map(run)));
  }
  return results;
}

/**
 * The reference remote adapter: kansession (a Kaneo fork) reached over its REST API. It is the
 * mirror of OrcaTab's own SPP surface — kansession asks OrcaTab for sessions, OrcaTab asks
 * kansession for a place to put an idea.
 */
export function createKansessionBoard(config: KansessionBoardConfig): TaskBoard {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const webUrl = config.webUrl === null ? null : config.webUrl.replace(/\/$/, "");
  let projectCache: Cached<Map<string, KansessionProject>> | null = null;
  const columnCache = new Map<string, Cached<KansessionColumn[]>>();

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/json");
    if (config.apiKey !== null) headers.set("x-api-key", config.apiKey);
    if (init?.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new BoardOfflineError(config.id, `board "${config.id}" is unreachable: ${
        error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404) throw new BoardRequestError(config.id, "not found", 404);
    if (!response.ok) {
      throw new BoardRequestError(config.id, `board "${config.id}" returned HTTP ${response.status}`, response.status);
    }
    try { return await response.json() as T; }
    catch { throw new BoardRequestError(config.id, `board "${config.id}" returned invalid JSON`, response.status); }
  }

  async function projectsById(): Promise<Map<string, KansessionProject>> {
    if (projectCache !== null && Date.now() - projectCache.at < PROJECT_CACHE_MS) return projectCache.value;
    const payload = await call<unknown>("/api/project");
    const projects = (Array.isArray(payload) ? payload : [])
      .map(toProject)
      .filter((project): project is KansessionProject => project !== null);
    const value = new Map(projects.map((project) => [project.id, project]));
    projectCache = { value, at: Date.now() };
    return value;
  }

  async function columnsFor(projectId: string): Promise<KansessionColumn[]> {
    const cached = columnCache.get(projectId);
    if (cached !== undefined && Date.now() - cached.at < COLUMN_CACHE_MS) return cached.value;
    const payload = await call<unknown>(`/api/column/${encodeURIComponent(projectId)}`);
    const columns = (Array.isArray(payload) ? payload : [])
      .map(toColumn)
      .filter((column): column is KansessionColumn => column !== null)
      .sort((left, right) => left.position - right.position);
    columnCache.set(projectId, { value: columns, at: Date.now() });
    return columns;
  }

  function projectUrl(project: KansessionProject): string | null {
    return webUrl === null
      ? null
      : `${webUrl}/dashboard/workspace/${project.workspaceId}/project/${project.id}`;
  }

  async function toBoardTask(task: KansessionTask): Promise<BoardTask> {
    const project = (await projectsById()).get(task.projectId) ?? null;
    // A board that cannot list its columns must not silently mark everything open; but a failed
    // column read is a refresh problem, not a data problem, so fall back to "open" and retry later.
    const columns = await columnsFor(task.projectId).catch(() => [] as KansessionColumn[]);
    const isFinal = columns.some((column) => column.slug === task.status && column.isFinal);
    const base = project === null ? null : projectUrl(project);
    return {
      boardId: config.id,
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      statusKind: isFinal ? "done" : "open",
      number: project !== null && project.slug && task.number !== null
        ? `${project.slug.toUpperCase()}-${task.number}` : null,
      url: base === null ? null : `${base}/task/${task.id}`,
    };
  }

  return {
    id: config.id,
    name: config.name,
    kind: "kansession",
    capabilities: () => KANSESSION_FEATURES,

    listProjects: async (): Promise<BoardProject[]> => [...(await projectsById()).values()]
      .filter((project) => project.archivedAt === null)
      .map((project) => ({ id: project.id, name: project.name, url: projectUrl(project) })),

    capture: async (input: CaptureInput): Promise<BoardTask> => {
      const title = normalizeTaskTitle(input.title);
      const columns = await columnsFor(input.projectId);
      const status = columns.find((column) => !column.isFinal)?.slug ?? columns[0]?.slug ?? FALLBACK_STATUS;
      const created = toTask(await call<unknown>(`/api/task/${encodeURIComponent(input.projectId)}`, {
        method: "POST",
        body: JSON.stringify({
          title, description: input.description ?? "", status, priority: DEFAULT_PRIORITY,
        }),
      }));
      if (created === null) throw new BoardRequestError(config.id, "board returned no task", null);
      return toBoardTask({ ...created, projectId: created.projectId || input.projectId });
    },

    lookup: async (taskIds: string[]): Promise<Map<string, BoardTask>> => {
      const found = await chunked(taskIds, LOOKUP_CONCURRENCY, async (taskId) => {
        try {
          return toTask(await call<unknown>(`/api/task/${encodeURIComponent(taskId)}`));
        } catch (error) {
          // 404 means the task is gone from the board; anything else must not be read as deletion.
          if (error instanceof BoardRequestError && error.status === 404) return null;
          throw error;
        }
      });
      const tasks = await Promise.all(found
        .filter((task): task is KansessionTask => task !== null)
        .map(toBoardTask));
      return new Map(tasks.map((task) => [task.taskId, task]));
    },

    backlink: async (taskId: string, ref: SessionRef): Promise<void> => {
      // No snapshot on purpose: kansession resolves it back through SPP
      // `GET /spp/v1/sessions/{providerId}/{sessionId}`, which is exactly why that endpoint exists.
      await call<unknown>("/api/agent-session/link", {
        method: "POST",
        body: JSON.stringify({
          taskId, providerId: ref.providerId, sessionId: ref.sessionId, kind: "confirmed",
        }),
      });
    },
  };
}
