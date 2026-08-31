/**
 * TBP — Task Board Protocol v1. The seam between OrcaTab and any task board.
 * Contract and rationale: `docs/TBP.md`. Adapters live beside this file.
 */
export type BoardKind = "local" | "kansession";
export type TaskStatusKind = "open" | "done";

export interface BoardFeatures {
  projects: boolean;
  capture: boolean;
  lookup: boolean;
  backlink: boolean;
}

export interface BoardProject {
  id: string;
  name: string;
  url: string | null;
}

export interface BoardTask {
  boardId: string;
  taskId: string;
  projectId: string;
  title: string;
  status: string;
  statusKind: TaskStatusKind;
  /** The board's human-readable identifier, e.g. `KAN-12`. Null when the board has none. */
  number: string | null;
  url: string | null;
}

export interface CaptureInput {
  projectId: string;
  title: string;
  description?: string;
}

export interface SessionRef {
  providerId: string;
  sessionId: string;
  agent: string;
}

export interface TaskBoard {
  readonly id: string;
  readonly name: string;
  readonly kind: BoardKind;
  /** Synchronous on purpose: what the adapter can do is static, not a network probe. */
  capabilities(): BoardFeatures;
  listProjects(): Promise<BoardProject[]>;
  capture(input: CaptureInput): Promise<BoardTask>;
  lookup(taskIds: string[]): Promise<Map<string, BoardTask>>;
  backlink?(taskId: string, ref: SessionRef): Promise<void>;
}

/** The board could not be reached at all. Callers degrade to the stored snapshot. */
export class BoardOfflineError extends Error {
  override name = "BoardOfflineError";
  constructor(readonly boardId: string, message: string) {
    super(message);
  }
}

/** The board answered, but not with what TBP expects. */
export class BoardRequestError extends Error {
  override name = "BoardRequestError";
  constructor(readonly boardId: string, message: string, readonly status: number | null) {
    super(message);
  }
}

export class UnknownBoardError extends Error {
  override name = "UnknownBoardError";
}

export const MAX_TASK_TITLE_CHARS = 500;

/**
 * A captured title is one line of intent, not a document: the board renders it in a list and
 * OrcaTab shows it on a session card. Newlines would silently break both.
 */
export function normalizeTaskTitle(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("title must be a string");
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new TypeError("title is required");
  if (normalized.length > MAX_TASK_TITLE_CHARS) {
    throw new TypeError(`title must be at most ${MAX_TASK_TITLE_CHARS} characters`);
  }
  return normalized;
}

export class BoardRegistry {
  private readonly boards: Map<string, TaskBoard>;

  constructor(boards: TaskBoard[]) {
    this.boards = new Map(boards.map((board) => [board.id, board]));
  }

  list(): TaskBoard[] {
    return [...this.boards.values()];
  }

  get(id: string): TaskBoard | null {
    return this.boards.get(id) ?? null;
  }

  require(id: string): TaskBoard {
    const board = this.boards.get(id);
    if (board === null || board === undefined) throw new UnknownBoardError(`unknown board "${id}"`);
    return board;
  }

  /** The board a capture lands on when neither the request nor a project binding names one. */
  get defaultBoardId(): string {
    const remote = this.list().find((board) => board.kind !== "local");
    return remote?.id ?? this.list()[0]?.id ?? "";
  }
}
