import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LOCAL_ENV, normalizeEnv } from "./session-identity";
import type { Agent } from "./types";

const SESSION_OUTBOX_SCHEMA_VERSION = "1";
const SESSION_OUTBOX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_outbox (
  id TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  agent TEXT NOT NULL,
  sid TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_outbox_session
  ON session_outbox(env, agent, sid, created_at);`;

export interface SessionOutboxItem {
  id: string;
  agent: Agent;
  env?: string;
  sid: string;
  text: string;
  createdAt: number;
}

export interface CreateSessionOutboxItem {
  agent: Agent;
  env?: string;
  sid: string;
  text: string;
}

export function openSessionOutboxDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  database.exec("PRAGMA busy_timeout=5000;");
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  database.exec(SESSION_OUTBOX_SCHEMA_SQL);
  database.query(`INSERT INTO meta(key, value) SELECT 'session_outbox_schema_version', ?
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'session_outbox_schema_version')`)
    .run(SESSION_OUTBOX_SCHEMA_VERSION);
  database.exec(`INSERT INTO meta(key, value) SELECT 'session_outbox_version', '0'
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'session_outbox_version');`);
  return database;
}

function itemFromRow(row: Record<string, unknown>): SessionOutboxItem {
  const env = String(row.env);
  return {
    id: String(row.id),
    agent: String(row.agent) as Agent,
    ...(env === LOCAL_ENV ? {} : { env }),
    sid: String(row.sid),
    text: String(row.text),
    createdAt: Number(row.created_at),
  };
}

const SELECT_COLUMNS = "id, env, agent, sid, text, created_at";

export class SessionOutboxStore {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  close(): void { this.database.close(); }

  get version(): number {
    const row = this.database.query("SELECT value FROM meta WHERE key = 'session_outbox_version'")
      .get() as { value: string } | null;
    const parsed = Number.parseInt(row?.value ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  list(): SessionOutboxItem[] {
    const rows = this.database.query(`SELECT ${SELECT_COLUMNS} FROM session_outbox
      ORDER BY created_at, id`).all() as Record<string, unknown>[];
    return rows.map(itemFromRow);
  }

  get(id: string): SessionOutboxItem | null {
    const row = this.database.query(`SELECT ${SELECT_COLUMNS} FROM session_outbox WHERE id = ?`)
      .get(id) as Record<string, unknown> | null;
    return row === null ? null : itemFromRow(row);
  }

  add(input: CreateSessionOutboxItem): SessionOutboxItem {
    const id = this.createId();
    const createdAt = this.now();
    const env = normalizeEnv(input.env);
    this.write(() => {
      this.database.query(`INSERT INTO session_outbox(id, env, agent, sid, text, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, env, input.agent, input.sid, input.text, createdAt);
    });
    return { id, agent: input.agent, ...(env === LOCAL_ENV ? {} : { env }), sid: input.sid, text: input.text, createdAt };
  }

  remove(id: string): boolean {
    if (this.get(id) === null) return false;
    this.write(() => { this.database.query("DELETE FROM session_outbox WHERE id = ?").run(id); });
    return true;
  }

  private write(mutate: () => void): void {
    this.database.transaction(() => {
      mutate();
      this.database.query(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'session_outbox_version'`).run();
    })();
  }
}
