import {
  BoardOfflineError, BoardRequestError, type BoardFeatures, type BoardProject, type BoardTask,
  type CaptureInput, type LookupResult, normalizeTaskTitle, type SessionRef, type TaskBoard,
} from "./board";

const KANSESSION_FEATURES: BoardFeatures = { projects: true, capture: true, lookup: true, backlink: true };
const REQUEST_TIMEOUT_MS = 5_000;
const PROJECT_CACHE_MS = 60_000;
const COLUMN_CACHE_MS = 60_000;
const LOOKUP_CONCURRENCY = 8;
const MAX_ERROR_DETAIL_CHARS = 200;
const DEFAULT_PRIORITY = "no-priority";
const FALLBACK_STATUS = "to-do";
/**
 * kansession resolves a task's workspace *from the task row*, so a deleted task answers 400
 * ("Workspace ID could not be determined"), not 404. Both mean the board no longer knows the id.
 * Anything else leaves the link alone: dropping a live task would lose the user's captured idea.
 */
const GONE_STATUSES = new Set([400, 404]);

export interface KansessionBoardConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** Where the browser reaches the board's UI. Without it, tasks have no "open" link. */
  webUrl: string | null;
  apiKey: string | null;
  /** Which kansession workspace to file into. Discovered when the key can see exactly one. */
  workspaceId?: string | null;
}

interface KansessionProject { id: string; name: string; slug: string; workspaceId: string; archivedAt: string | null; }
interface KansessionWorkspace { id: string; name: string; }
interface KansessionColumn { slug: string; position: number; isFinal: boolean; }
interface KansessionTask { id: string; projectId: string; title: string; status: string; number: number | null; }

interface Cached<T> { value: T; at: number; }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toWorkspace(value: unknown): KansessionWorkspace | null {
  if (!isObject(value) || !text(value.id)) return null;
  return { id: text(value.id), name: text(value.name) || text(value.id) };
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
  let workspaceId: string | null = config.workspaceId?.trim() || null;
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
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new BoardRequestError(config.id, `board "${config.id}" returned HTTP ${response.status}`
        + (detail ? `: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}` : ""), response.status);
    }
    try { return await response.json() as T; }
    catch { throw new BoardRequestError(config.id, `board "${config.id}" returned invalid JSON`, response.status); }
  }

  /**
   * kansession scopes projects by workspace, so the adapter needs one. Discover it when the key
   * can see exactly one workspace; refuse to guess when it can see several, because filing a
   * captured idea into the wrong workspace is worse than asking for a line of config.
   */
  async function resolveWorkspaceId(): Promise<string> {
    if (workspaceId !== null) return workspaceId;
    const payload = await call<unknown>("/api/auth/organization/list");
    const workspaces = (Array.isArray(payload) ? payload : [])
      .map(toWorkspace)
      .filter((workspace): workspace is KansessionWorkspace => workspace !== null);
    if (workspaces.length === 0) {
      throw new BoardRequestError(config.id, `board "${config.id}" has no workspace for this API key`, null);
    }
    if (workspaces.length > 1) {
      throw new BoardRequestError(config.id, `board "${config.id}" has ${workspaces.length} workspaces; `
        + `set workspaceId in ORCATAB_BOARDS to one of: ${workspaces.map((item) => `${item.id} (${item.name})`).join(", ")}`,
        null);
    }
    workspaceId = workspaces[0]!.id;
    return workspaceId;
  }

  async function projectsById(): Promise<Map<string, KansessionProject>> {
    if (projectCache !== null && Date.now() - projectCache.at < PROJECT_CACHE_MS) return projectCache.value;
    const payload = await call<unknown>(`/api/project?workspaceId=${encodeURIComponent(await resolveWorkspaceId())}`);
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

    lookup: async (taskIds: string[]): Promise<LookupResult> => {
      // Isolated per task: one deleted or broken id must not abort the whole board's refresh.
      const outcomes = await chunked(taskIds, LOOKUP_CONCURRENCY, async (taskId) => {
        try {
          const task = toTask(await call<unknown>(`/api/task/${encodeURIComponent(taskId)}`));
          return task === null ? { taskId, gone: false } : { taskId, task };
        } catch (error) {
          if (error instanceof BoardOfflineError) throw error;
          const gone = error instanceof BoardRequestError && error.status !== null
            && GONE_STATUSES.has(error.status);
          return { taskId, gone };
        }
      });
      const resolved = await Promise.all(outcomes
        .flatMap((outcome) => ("task" in outcome && outcome.task ? [outcome.task] : []))
        .map(toBoardTask));
      return {
        tasks: new Map(resolved.map((task) => [task.taskId, task])),
        gone: outcomes.flatMap((outcome) => ("gone" in outcome && outcome.gone ? [outcome.taskId] : [])),
      };
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
