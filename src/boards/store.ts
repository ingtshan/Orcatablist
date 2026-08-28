import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sessionIdentityKey } from "../session-identity";
import type { Agent } from "../types";
import type { BoardTask, TaskStatusKind } from "./board";

const BOARDS_SCHEMA_VERSION = "1";

/**
 * `session_tasks` holds links and snapshots only — the board owns the task. `local_tasks` is the
 * exception: the local adapter *is* a board, so this file is its authoritative storage.
 */
const BOARDS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_tasks (
  agent TEXT NOT NULL, sid TEXT NOT NULL, board_id TEXT NOT NULL, task_id TEXT NOT NULL,
  project_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  status_kind TEXT NOT NULL CHECK (status_kind IN ('open', 'done')),
  number TEXT, url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent, sid, board_id, task_id)
);
CREATE INDEX IF NOT EXISTS session_tasks_session ON session_tasks(agent, sid);
CREATE INDEX IF NOT EXISTS session_tasks_board ON session_tasks(board_id, status_kind);
CREATE TABLE IF NOT EXISTS project_boards (
  project_key TEXT PRIMARY KEY, board_id TEXT NOT NULL, board_project_id TEXT NOT NULL,
  board_project_name TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);`;

export interface SessionTaskLink extends BoardTask {
  agent: Agent;
  sid: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectBoardBinding {
  projectKey: string;
  boardId: string;
  boardProjectId: string;
  boardProjectName: string;
}

export function openBoardDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  database.exec("PRAGMA busy_timeout=5000;");
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  database.exec(BOARDS_SCHEMA_SQL);
  const version = database.query("SELECT value FROM meta WHERE key = 'boards_schema_version'")
    .get() as { value: string } | null;
  if (version === null) {
    database.query("INSERT INTO meta(key, value) VALUES ('boards_schema_version', ?)").run(BOARDS_SCHEMA_VERSION);
  } else if (version.value !== BOARDS_SCHEMA_VERSION) {
    // Every migration step above is additive. Never remove or recreate this durable database.
    database.query("UPDATE meta SET value = ? WHERE key = 'boards_schema_version'").run(BOARDS_SCHEMA_VERSION);
  }
  database.exec(`INSERT INTO meta(key, value) SELECT 'session_tasks_version', '0'
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'session_tasks_version');`);
  return database;
}

function statusKind(value: unknown): TaskStatusKind {
  return value === "done" ? "done" : "open";
}

function linkFromRow(row: Record<string, unknown>): SessionTaskLink {
  return {
    agent: String(row.agent) as Agent,
    sid: String(row.sid),
    boardId: String(row.board_id),
    taskId: String(row.task_id),
    projectId: String(row.project_id),
    title: String(row.title),
    status: String(row.status),
    statusKind: statusKind(row.status_kind),
    number: typeof row.number === "string" ? row.number : null,
    url: typeof row.url === "string" ? row.url : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const SELECT_COLUMNS = `agent, sid, board_id, task_id, project_id, title, status, status_kind,
  number, url, created_at, updated_at`;

export class SessionTaskStore {
  constructor(private readonly database: Database) {}

  get version(): number {
    const row = this.database.query("SELECT value FROM meta WHERE key = 'session_tasks_version'")
      .get() as { value: string } | null;
    const parsed = Number.parseInt(row?.value ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  listAll(): SessionTaskLink[] {
    const rows = this.database.query(`SELECT ${SELECT_COLUMNS} FROM session_tasks
      ORDER BY created_at DESC`).all();
    return (rows as Record<string, unknown>[]).map(linkFromRow);
  }

  /** Keyed by `sessionIdentityKey(agent, sid)` so the frontend can index by card. */
  bySession(): Map<string, SessionTaskLink[]> {
    const grouped = new Map<string, SessionTaskLink[]>();
    for (const link of this.listAll()) {
      const key = sessionIdentityKey(link.agent, link.sid);
      grouped.set(key, [...(grouped.get(key) ?? []), link]);
    }
    return grouped;
  }

  listForSession(agent: Agent, sid: string): SessionTaskLink[] {
    const rows = this.database.query(`SELECT ${SELECT_COLUMNS} FROM session_tasks
      WHERE agent = ? AND sid = ? ORDER BY created_at DESC`).all(agent, sid);
    return (rows as Record<string, unknown>[]).map(linkFromRow);
  }

  link(agent: Agent, sid: string, task: BoardTask): SessionTaskLink {
    const now = Date.now();
    this.write(() => {
      this.database.query(`INSERT INTO session_tasks
        (agent, sid, board_id, task_id, project_id, title, status, status_kind, number, url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent, sid, board_id, task_id) DO UPDATE SET
          project_id = excluded.project_id, title = excluded.title, status = excluded.status,
          status_kind = excluded.status_kind, number = excluded.number, url = excluded.url,
          updated_at = excluded.updated_at`)
        .run(agent, sid, task.boardId, task.taskId, task.projectId, task.title, task.status,
          task.statusKind, task.number, task.url, now, now);
    });
    return { ...task, agent, sid, createdAt: now, updatedAt: now };
  }

  unlink(agent: Agent, sid: string, boardId: string, taskId: string): boolean {
    let changes = 0;
    this.write(() => {
      changes = this.database.query(`DELETE FROM session_tasks
        WHERE agent = ? AND sid = ? AND board_id = ? AND task_id = ?`)
        .run(agent, sid, boardId, taskId).changes;
    });
    return changes > 0;
  }

  /** Refresh cached snapshots after a board read. Absent ids mean the board forgot the task. */
  applySnapshots(boardId: string, tasks: Map<string, BoardTask>, missingTaskIds: string[]): number {
    if (tasks.size === 0 && missingTaskIds.length === 0) return 0;
    let changes = 0;
    this.write(() => {
      const update = this.database.query(`UPDATE session_tasks
        SET title = ?, status = ?, status_kind = ?, number = ?, url = ?, project_id = ?, updated_at = ?
        WHERE board_id = ? AND task_id = ?`);
      const drop = this.database.query("DELETE FROM session_tasks WHERE board_id = ? AND task_id = ?");
      const now = Date.now();
      for (const task of tasks.values()) {
        changes += update.run(task.title, task.status, task.statusKind, task.number, task.url,
          task.projectId, now, boardId, task.taskId).changes;
      }
      for (const taskId of missingTaskIds) changes += drop.run(boardId, taskId).changes;
    });
    return changes;
  }

  openTaskIds(boardId: string): string[] {
    const rows = this.database.query(`SELECT DISTINCT task_id FROM session_tasks
      WHERE board_id = ? AND status_kind = 'open'`).all(boardId) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  private write(mutate: () => void): void {
    this.database.transaction(() => {
      mutate();
      this.database.query(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'session_tasks_version'`).run();
    })();
  }
}

export class ProjectBoardStore {
  constructor(private readonly database: Database) {}

  get(projectKey: string): ProjectBoardBinding | null {
    const row = this.database.query(`SELECT project_key, board_id, board_project_id, board_project_name
      FROM project_boards WHERE project_key = ?`).get(projectKey) as Record<string, unknown> | null;
    if (row === null) return null;
    return {
      projectKey: String(row.project_key),
      boardId: String(row.board_id),
      boardProjectId: String(row.board_project_id),
      boardProjectName: String(row.board_project_name),
    };
  }

  list(): ProjectBoardBinding[] {
    const rows = this.database.query(`SELECT project_key, board_id, board_project_id, board_project_name
      FROM project_boards ORDER BY updated_at DESC`).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      projectKey: String(row.project_key),
      boardId: String(row.board_id),
      boardProjectId: String(row.board_project_id),
      boardProjectName: String(row.board_project_name),
    }));
  }

  bind(binding: ProjectBoardBinding): ProjectBoardBinding {
    this.database.query(`INSERT INTO project_boards
      (project_key, board_id, board_project_id, board_project_name, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_key) DO UPDATE SET
        board_id = excluded.board_id, board_project_id = excluded.board_project_id,
        board_project_name = excluded.board_project_name, updated_at = excluded.updated_at`)
      .run(binding.projectKey, binding.boardId, binding.boardProjectId, binding.boardProjectName, Date.now());
    return binding;
  }

  unbind(projectKey: string): boolean {
    return this.database.query("DELETE FROM project_boards WHERE project_key = ?").run(projectKey).changes > 0;
  }
}
