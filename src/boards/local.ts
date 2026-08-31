import type { Database } from "bun:sqlite";
import {
  type BoardFeatures, type BoardProject, type BoardTask, type CaptureInput, normalizeTaskTitle,
  type TaskBoard,
} from "./board";

export const LOCAL_BOARD_ID = "local";
const LOCAL_BOARD_NAME = "OrcaTab 本地";
const OPEN_STATUS = "todo";
const DONE_STATUS = "done";

const LOCAL_FEATURES: BoardFeatures = { projects: true, capture: true, lookup: true, backlink: false };

export interface LocalBoardDeps {
  database: Database;
  /** OrcaTab's own projects double as the local board's projects — nothing else to file under. */
  listProjects(): BoardProject[];
}

function taskFromRow(row: Record<string, unknown>): BoardTask {
  const status = String(row.status);
  return {
    boardId: LOCAL_BOARD_ID,
    taskId: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    status,
    statusKind: status === DONE_STATUS ? "done" : "open",
    number: null,
    url: null,
  };
}

/**
 * The second adapter. It exists so the seam is real rather than hypothetical, and so capture keeps
 * working with zero configuration: no kansession, no API key, tasks land in OrcaTab's own SQLite.
 */
export function createLocalBoard(deps: LocalBoardDeps): TaskBoard {
  const { database } = deps;
  return {
    id: LOCAL_BOARD_ID,
    name: LOCAL_BOARD_NAME,
    kind: "local",
    capabilities: () => LOCAL_FEATURES,

    listProjects: async () => deps.listProjects(),

    capture: async (input: CaptureInput) => {
      const title = normalizeTaskTitle(input.title);
      const id = crypto.randomUUID();
      const now = Date.now();
      database.query(`INSERT INTO local_tasks (id, project_id, title, description, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.projectId, title, input.description ?? null, OPEN_STATUS, now, now);
      return {
        boardId: LOCAL_BOARD_ID, taskId: id, projectId: input.projectId, title,
        status: OPEN_STATUS, statusKind: "open", number: null, url: null,
      };
    },

    lookup: async (taskIds: string[]) => {
      if (taskIds.length === 0) return new Map();
      const placeholders = taskIds.map(() => "?").join(", ");
      const rows = database.query(`SELECT id, project_id, title, status FROM local_tasks
        WHERE id IN (${placeholders})`).all(...taskIds) as Record<string, unknown>[];
      return new Map(rows.map((row) => {
        const task = taskFromRow(row);
        return [task.taskId, task];
      }));
    },
  };
}
