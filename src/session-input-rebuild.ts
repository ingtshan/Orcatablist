import type { Database } from "bun:sqlite";
import { FTS_TEXT_MAX_CHARS } from "./config";
import { normalizeEnv } from "./session-identity";
import type { Agent } from "./types";

const MIGRATION_KEY = "full_user_inputs_v1";
interface Identity { agent: Agent; sid: string; env?: string; }

/** Retain old transcripts until their source can replace the truncated index successfully. */
export function ensureFullInputSchema(database: Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS session_input_rebuilds (
    env TEXT NOT NULL, agent TEXT NOT NULL, sid TEXT NOT NULL, PRIMARY KEY (env, agent, sid)
  );`);
  if (database.query("SELECT 1 FROM meta WHERE key = ?").get(MIGRATION_KEY)) return;
  database.transaction(() => {
    // UTF-8 byte length is a conservative superset of the former JS UTF-16 limit, including emoji.
    database.query(`INSERT OR IGNORE INTO session_input_rebuilds
      SELECT DISTINCT env, agent, sid FROM msg_fts
      WHERE role = 'user' AND length(CAST(text AS BLOB)) >= ?`).run(FTS_TEXT_MAX_CHARS);
    database.query("INSERT INTO meta(key, value) VALUES (?, '1')").run(MIGRATION_KEY);
  })();
}

export function needsFullInputRebuild(database: Database, identity: Identity): boolean {
  return Boolean(database.query("SELECT 1 FROM session_input_rebuilds WHERE env = ? AND agent = ? AND sid = ?")
    .get(normalizeEnv(identity.env), identity.agent, identity.sid));
}

export function fullInputRebuildPaths(database: Database, env: string): Set<string> {
  const rows = database.query(`SELECT sessions.file_path AS path FROM sessions
    JOIN session_input_rebuilds USING (env, agent, sid) WHERE env = ?`).all(normalizeEnv(env)) as Array<{ path: string }>;
  return new Set(rows.map(({ path }) => path));
}

/** Must run inside the same transaction as the replacement and any remote acknowledgement. */
export function finishFullInputRebuild(database: Database, identity: Identity): void {
  database.query("DELETE FROM session_input_rebuilds WHERE env = ? AND agent = ? AND sid = ?")
    .run(normalizeEnv(identity.env), identity.agent, identity.sid);
}
