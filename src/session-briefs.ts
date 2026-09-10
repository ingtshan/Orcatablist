import type { Database } from "bun:sqlite";
import type { StoredSession } from "./db";
import { normalizeEnv, sessionIdentityKey } from "./session-identity";
import { BRIEF_INPUT_MAX_CHARS, BRIEF_RESPONSE_MAX_CHARS, briefHash, inputPreview, responseTail, type BriefEvent } from "./session-brief-events";
import type { Agent, LiveInfo } from "./types";
import { ensureGroupBriefSchema } from "./orchestration-briefs";

const RECENT_READ_LIMIT = 100;

export function ensureBriefSchema(database: Database): void {
  ensureGroupBriefSchema(database);
  database.exec(`CREATE TABLE IF NOT EXISTS brief_sessions (
    env TEXT NOT NULL, agent TEXT NOT NULL, sid TEXT NOT NULL,
    input_text TEXT NOT NULL, input_key TEXT NOT NULL, input_at INTEGER,
    response_text TEXT, response_key TEXT, response_at INTEGER,
    PRIMARY KEY(env, agent, sid)
  );
  CREATE TABLE IF NOT EXISTS session_briefs (
    id TEXT PRIMARY KEY, env TEXT NOT NULL, agent TEXT NOT NULL, sid TEXT NOT NULL,
    input_text TEXT NOT NULL, input_at INTEGER,
    response_text TEXT NOT NULL, completed_at INTEGER NOT NULL, read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS session_briefs_read ON session_briefs(read_at, completed_at DESC);
  CREATE INDEX IF NOT EXISTS session_briefs_owner ON session_briefs(env, agent, sid);
  INSERT OR IGNORE INTO meta(key, value) VALUES ('briefs_enabled_at', '${Date.now()}');`);
}

interface BriefState {
  env: string; agent: Agent; sid: string;
  input_text: string; input_key: string; input_at: number | null;
  response_text: string | null; response_key: string | null; response_at: number | null;
}

export interface SessionBrief {
  id: string; env?: string; agent: Agent; sid: string;
  input: string; inputAt: number | null; response: string; completedAt: number; readAt: number | null;
}

function saveCompletion(database: Database, state: BriefState, at: number | null): void {
  if (!state.response_text || !state.response_key || at === null) return;
  const enabledAt = Number((database.query("SELECT value FROM meta WHERE key = 'briefs_enabled_at'")
    .get() as { value: string }).value);
  if (at < enabledAt || (state.input_at !== null && at < state.input_at)) return;
  const id = briefHash([state.env, state.agent, state.sid, state.input_key, state.response_key]);
  database.query(`INSERT OR IGNORE INTO session_briefs
    (id, env, agent, sid, input_text, input_at, response_text, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, state.env, state.agent, state.sid,
    state.input_text, state.input_at, state.response_text, at);
}

/** Called inside the transcript commit: a failed remote ACK cannot consume or create a brief. */
export function applyBriefEvents(database: Database, session: StoredSession, events: readonly BriefEvent[]): void {
  if (!events.length) return;
  const env = normalizeEnv(session.env);
  let state = database.query("SELECT * FROM brief_sessions WHERE env = ? AND agent = ? AND sid = ?")
    .get(env, session.agent, session.sid) as BriefState | null;
  if (state === null) {
    const previous = database.query(`SELECT text, ts FROM msg_fts
      WHERE env = ? AND agent = ? AND sid = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1`)
      .get(env, session.agent, session.sid) as { text: string; ts: number | null } | null;
    state = { env, agent: session.agent, sid: session.sid,
      input_text: previous?.text ?? session.lastPrompt ?? "", input_at: previous?.ts ?? session.lastInputAt,
      input_key: briefHash([previous?.ts ?? session.lastInputAt, previous?.text ?? session.lastPrompt]),
      response_text: null, response_key: null, response_at: null };
  }
  for (const event of events) {
    if (event.kind === "user") {
      state = { ...state, input_text: event.text ?? "", input_key: event.key, input_at: event.at,
        response_text: null, response_key: null, response_at: null };
    } else if (event.kind === "assistant") {
      state = { ...state, response_text: event.text ?? "", response_key: event.key, response_at: event.at };
      if (event.complete) saveCompletion(database, state, event.at);
    } else {
      if (event.text?.trim() && event.text !== state.response_text) {
        state = { ...state, response_text: event.text, response_key: event.key, response_at: event.at };
      }
      saveCompletion(database, state, event.at);
    }
  }
  database.query(`INSERT INTO brief_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(env, agent, sid) DO UPDATE SET input_text=excluded.input_text, input_key=excluded.input_key,
    input_at=excluded.input_at, response_text=excluded.response_text, response_key=excluded.response_key,
    response_at=excluded.response_at`).run(env, session.agent, session.sid,
    state.input_text, state.input_key, state.input_at, state.response_text, state.response_key, state.response_at);
}

/** For providers without final markers, accept only a fresh explicit `done` after this reply. */
export function completeLiveBriefs(database: Database, live: Map<string, LiveInfo>): void {
  const candidates = database.query("SELECT env, agent, sid, response_at FROM brief_sessions WHERE response_at IS NOT NULL")
    .all() as Array<Pick<BriefState, "env" | "agent" | "sid" | "response_at">>;
  database.transaction(() => {
    for (const candidate of candidates) {
      const status = live.get(sessionIdentityKey(candidate.agent, candidate.sid, candidate.env));
      if (status?.status !== "done" || status.waitingFor || !Number.isFinite(status.updatedAt)) continue;
      if (candidate.response_at === null || status.updatedAt! < candidate.response_at) continue;
      const state = database.query("SELECT * FROM brief_sessions WHERE env = ? AND agent = ? AND sid = ?")
        .get(candidate.env, candidate.agent, candidate.sid) as BriefState | null;
      if (state !== null) saveCompletion(database, state, state.response_at);
    }
  })();
}

function briefFromRow(row: Record<string, unknown>, full: boolean): SessionBrief {
  const env = String(row.env);
  const input = String(row.input_text);
  const response = String(row.response_text);
  return { id: String(row.id), ...(env === "local" ? {} : { env }), agent: row.agent as Agent, sid: String(row.sid),
    input: full ? input : inputPreview(input), response: full ? response : responseTail(response),
    inputAt: row.input_at === null ? null : Number(row.input_at), completedAt: Number(row.completed_at),
    readAt: row.read_at === null ? null : Number(row.read_at) };
}

export function listBriefs(database: Database): SessionBrief[] {
  // Poll only bounded previews. The original large reply is read solely by the detail endpoint.
  const rows = database.query(`SELECT id, env, agent, sid,
    substr(input_text, 1, ?) AS input_text, input_at,
    substr(response_text, -?) AS response_text, completed_at, read_at FROM (
      SELECT * FROM session_briefs WHERE read_at IS NULL
      UNION ALL SELECT * FROM (SELECT * FROM session_briefs WHERE read_at IS NOT NULL ORDER BY read_at DESC LIMIT ?)
    ) ORDER BY completed_at DESC, id DESC`)
    .all(BRIEF_INPUT_MAX_CHARS + 1, BRIEF_RESPONSE_MAX_CHARS + 1, RECENT_READ_LIMIT) as Record<string, unknown>[];
  return rows.map((row) => briefFromRow(row, false));
}

export function getBrief(database: Database, id: string): SessionBrief | null {
  const row = database.query("SELECT * FROM session_briefs WHERE id = ?").get(id) as Record<string, unknown> | null;
  return row === null ? null : briefFromRow(row, true);
}

export function markBriefsRead(database: Database, ids: readonly string[], read: boolean, now = Date.now()): void {
  database.transaction(() => {
    for (const id of ids) database.query("UPDATE session_briefs SET read_at = ? WHERE id = ?")
      .run(read ? now : null, id);
  })();
}
