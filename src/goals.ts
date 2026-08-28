import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Agent, Goal, GoalRef, GoalStatus } from "./types";

const GOALS_SCHEMA_VERSION = "1";

const GOALS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  external_ref TEXT, color TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS goal_links (
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  agent TEXT NOT NULL, sid TEXT NOT NULL, kind TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (goal_id, agent, sid)
);
CREATE INDEX IF NOT EXISTS goal_links_session ON goal_links(agent, sid);`;

export type GoalLinkKind = "confirmed" | "dismissed";
export interface SessionIdentity { agent: Agent; sid: string; }
export interface CreateGoalInput { name: string; externalRef?: string | null; color?: string | null; }
export interface UpdateGoalInput {
  name?: string; status?: GoalStatus; externalRef?: string | null; color?: string | null;
}

export function sessionIdentityKey(agent: string, sid: string): `${string}/${string}` {
  return `${agent}/${sid}`;
}

export function openGoalsDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  database.exec(GOALS_SCHEMA_SQL);

  const version = database.query("SELECT value FROM meta WHERE key = 'goals_schema_version'").get() as { value: string } | null;
  if (version === null) {
    database.query("INSERT INTO meta(key, value) VALUES ('goals_schema_version', ?)").run(GOALS_SCHEMA_VERSION);
  } else if (version.value !== GOALS_SCHEMA_VERSION) {
    // Every migration step above is additive. Never remove or recreate this durable database.
    database.query("UPDATE meta SET value = ? WHERE key = 'goals_schema_version'").run(GOALS_SCHEMA_VERSION);
  }
  return database;
}

function goalFromRow(row: Record<string, unknown>): Goal {
  const status = row.status === "done" || row.status === "archived" ? row.status : "active";
  return {
    id: String(row.id),
    name: String(row.name),
    status,
    externalRef: typeof row.external_ref === "string" ? row.external_ref : null,
    color: typeof row.color === "string" ? row.color : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class GoalsStore {
  private readonly database: Database;
  private version = 0;

  constructor(database: Database) { this.database = database; }

  get goalsVersion(): number { return this.version; }
  close(): void { this.database.close(); }

  createGoal(input: CreateGoalInput): Goal {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.database.query(`INSERT INTO goals
      (id, name, status, external_ref, color, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?)`)
      .run(id, input.name, input.externalRef ?? null, input.color ?? null, now, now);
    this.version += 1;
    return this.getGoal(id)!;
  }

  updateGoal(id: string, input: UpdateGoalInput): Goal | null {
    const current = this.getGoal(id);
    if (current === null) return null;
    const next = {
      name: input.name ?? current.name,
      status: input.status ?? current.status,
      externalRef: input.externalRef === undefined ? current.externalRef : input.externalRef,
      color: input.color === undefined ? current.color : input.color,
    };
    this.database.query(`UPDATE goals SET name = ?, status = ?, external_ref = ?, color = ?, updated_at = ?
      WHERE id = ?`).run(next.name, next.status, next.externalRef, next.color, Date.now(), id);
    this.version += 1;
    return this.getGoal(id);
  }

  deleteGoal(id: string): boolean {
    const result = this.database.query("DELETE FROM goals WHERE id = ?").run(id);
    if (result.changes > 0) this.version += 1;
    return result.changes > 0;
  }

  getGoal(id: string): Goal | null {
    const row = this.database.query("SELECT * FROM goals WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row === null ? null : goalFromRow(row);
  }

  listGoals(): Goal[] {
    const rows = this.database.query("SELECT * FROM goals ORDER BY updated_at DESC, created_at DESC, name").all();
    return (rows as Record<string, unknown>[]).map(goalFromRow);
  }

  countGoals(): number {
    const row = this.database.query("SELECT COUNT(*) AS count FROM goals").get() as { count: number };
    return Number(row.count);
  }

  setLink(goalId: string, agent: Agent, sid: string, kind: GoalLinkKind): void {
    this.database.query(`INSERT INTO goal_links (goal_id, agent, sid, kind, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(goal_id, agent, sid) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at`)
      .run(goalId, agent, sid, kind, Date.now());
    this.version += 1;
  }

  removeLink(goalId: string, agent: Agent, sid: string): void {
    this.database.query("DELETE FROM goal_links WHERE goal_id = ? AND agent = ? AND sid = ?")
      .run(goalId, agent, sid);
    this.version += 1;
  }

  confirmedLinks(goalId: string): SessionIdentity[] {
    return this.links(goalId, "WHERE goal_id = ? AND kind = 'confirmed'");
  }

  confirmedLinksByGoal(): Map<string, SessionIdentity[]> {
    const rows = this.database.query(`SELECT goal_id, agent, sid FROM goal_links
      WHERE kind = 'confirmed' ORDER BY created_at DESC`)
      .all() as Array<{ goal_id: string; agent: Agent; sid: string }>;
    const result = new Map<string, SessionIdentity[]>();
    for (const row of rows) {
      const links = result.get(row.goal_id) ?? [];
      links.push({ agent: row.agent, sid: row.sid });
      result.set(row.goal_id, links);
    }
    return result;
  }

  excludedLinks(goalId: string): SessionIdentity[] {
    return this.links(goalId, "WHERE goal_id = ?");
  }

  goalsForSession(agent: Agent, sid: string): GoalRef[] {
    return this.goalsForSessions([{ agent, sid }]).get(sessionIdentityKey(agent, sid)) ?? [];
  }

  goalsForSessions(pairs: SessionIdentity[]): Map<`${string}/${string}`, GoalRef[]> {
    const result = new Map<`${string}/${string}`, GoalRef[]>();
    const unique = [...new Map(pairs.map((pair) => [sessionIdentityKey(pair.agent, pair.sid), pair])).values()];
    for (const pair of unique) result.set(sessionIdentityKey(pair.agent, pair.sid), []);
    if (unique.length === 0) return result;

    const placeholders = unique.map(() => "(?, ?)").join(", ");
    const values = unique.flatMap((pair) => [pair.agent, pair.sid]);
    const rows = this.database.query(`SELECT gl.agent, gl.sid, g.id, g.name
      FROM goal_links gl JOIN goals g ON g.id = gl.goal_id
      WHERE gl.kind = 'confirmed' AND (gl.agent, gl.sid) IN (${placeholders})
      ORDER BY g.updated_at DESC, g.name`).all(...values) as Array<{ agent: string; sid: string; id: string; name: string }>;
    for (const row of rows) {
      result.get(sessionIdentityKey(row.agent, row.sid))?.push({ id: row.id, name: row.name });
    }
    return result;
  }

  private links(goalId: string, clause: string): SessionIdentity[] {
    const rows = this.database.query(`SELECT agent, sid FROM goal_links ${clause} ORDER BY created_at DESC`).all(goalId);
    return (rows as Array<{ agent: Agent; sid: string }>).map((row) => ({ agent: row.agent, sid: row.sid }));
  }
}
