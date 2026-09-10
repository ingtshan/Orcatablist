import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LOCAL_ENV, normalizeEnv, type SessionIdentity } from "./session-identity";
import { ValidationError } from "./focus";
import type { SentInput } from "./session-send";
import type { Agent } from "./types";

const SESSION_OUTBOX_SCHEMA_VERSION = "2";
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
  ON session_outbox(env, agent, sid, created_at);
CREATE TABLE IF NOT EXISTS session_outbox_settings (
  env TEXT NOT NULL, agent TEXT NOT NULL, sid TEXT NOT NULL,
  auto_send INTEGER NOT NULL DEFAULT 0, error TEXT, pending TEXT,
  PRIMARY KEY(env, agent, sid)
);`;

export interface OutboxDelivery extends SentInput { itemId: string; phase: "sending" | "sent"; }
export interface SessionOutboxSettings extends SessionIdentity {
  autoSend: boolean; error: string | null; pending: OutboxDelivery | null;
}

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
  const columns = database.query("PRAGMA table_info(session_outbox)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "position")) {
    database.exec("ALTER TABLE session_outbox ADD COLUMN position INTEGER NOT NULL DEFAULT 0;");
    database.exec(`WITH ranked AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS ordinal FROM session_outbox)
      UPDATE session_outbox SET position = (SELECT ordinal FROM ranked WHERE ranked.id = session_outbox.id);`);
  }
  database.query(`INSERT INTO meta(key, value) SELECT 'session_outbox_schema_version', ?
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'session_outbox_schema_version')`)
    .run(SESSION_OUTBOX_SCHEMA_VERSION);
  database.query("UPDATE meta SET value = ? WHERE key = 'session_outbox_schema_version'").run(SESSION_OUTBOX_SCHEMA_VERSION);
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
      ORDER BY position, created_at, id`).all() as Record<string, unknown>[];
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
      this.database.query(`INSERT INTO session_outbox(id, env, agent, sid, text, created_at, position)
        VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM session_outbox))`)
        .run(id, env, input.agent, input.sid, input.text, createdAt);
    });
    return { id, agent: input.agent, ...(env === LOCAL_ENV ? {} : { env }), sid: input.sid, text: input.text, createdAt };
  }

  remove(id: string): boolean {
    if (this.get(id) === null) return false;
    if (this.settings().some((settings) => settings.pending?.itemId === id && settings.pending.phase === "sending")) {
      throw new ValidationError("message is being sent");
    }
    this.write(() => { this.database.query("DELETE FROM session_outbox WHERE id = ?").run(id); });
    return true;
  }

  settings(): SessionOutboxSettings[] {
    const rows = this.database.query("SELECT * FROM session_outbox_settings").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ agent: row.agent as Agent, sid: String(row.sid),
      ...(row.env === LOCAL_ENV ? {} : { env: String(row.env) }), autoSend: Boolean(row.auto_send),
      error: row.error === null ? null : String(row.error), pending: row.pending === null ? null : JSON.parse(String(row.pending)) }));
  }

  setting(identity: SessionIdentity): SessionOutboxSettings {
    return this.settings().find((item) => item.agent === identity.agent && item.sid === identity.sid
      && normalizeEnv(item.env) === normalizeEnv(identity.env)) ?? { ...identity, autoSend: false, error: null, pending: null };
  }

  updateSetting(identity: SessionIdentity, changes: Partial<Pick<SessionOutboxSettings, "autoSend" | "error" | "pending">>): void {
    const next = { ...this.setting(identity), ...changes };
    this.write(() => this.saveSetting(next));
  }

  completeDelivery(identity: SessionIdentity, pending: OutboxDelivery): void {
    this.write(() => {
      this.database.query("DELETE FROM session_outbox WHERE id = ?").run(pending.itemId);
      this.saveSetting({ ...this.setting(identity), pending, error: null });
    });
  }

  reorder(identity: SessionIdentity, ids: string[], expectedVersion: number): void {
    this.write(() => {
      if (expectedVersion !== this.version) throw new ValidationError("queue changed; refresh and reorder again");
      if (this.setting(identity).pending?.phase === "sending") throw new ValidationError("message is being sent");
      const current = this.list().filter((item) => item.agent === identity.agent && item.sid === identity.sid
        && normalizeEnv(item.env) === normalizeEnv(identity.env));
      const wanted = new Set(ids);
      if (wanted.size !== ids.length || current.length !== ids.length || current.some((item) => !wanted.has(item.id))) {
        throw new ValidationError("order must contain exactly this session's queued messages");
      }
      ids.forEach((id, index) => this.database.query("UPDATE session_outbox SET position = ? WHERE id = ?").run(index, id));
    });
  }

  private saveSetting(next: SessionOutboxSettings): void {
    this.database.query(`INSERT INTO session_outbox_settings(env, agent, sid, auto_send, error, pending)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(env, agent, sid) DO UPDATE SET
      auto_send=excluded.auto_send, error=excluded.error, pending=excluded.pending`)
      .run(normalizeEnv(next.env), next.agent, next.sid, Number(next.autoSend), next.error, next.pending ? JSON.stringify(next.pending) : null);
  }

  private write(mutate: () => void): void {
    this.database.transaction(() => {
      mutate();
      this.database.query(`UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'session_outbox_version'`).run();
    })();
  }
}
