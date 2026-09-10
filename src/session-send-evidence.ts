import type { OrcaDatabase } from "./db";
import { LOCAL_ENV, sessionIdentityKey } from "./session-identity";
import type { SentInput, SentUserInputEvidence } from "./session-send";

interface EvidenceRow {
  env: string;
  agent: SentInput["agent"];
  sid: string;
  text: string;
  ts: number | null;
  input_count: number;
}

export function sentInputEvidenceCount(db: OrcaDatabase, agent: SentInput["agent"], sid: string, env?: string): number {
  return Number((db.raw.query(`SELECT COUNT(*) AS count FROM msg_fts
    WHERE env = ? AND agent = ? AND sid = ? AND role = 'user' AND length(trim(text)) > 0`)
    .get(env ?? LOCAL_ENV, agent, sid) as { count: number }).count);
}

export function findLatestSentInputEvidence(
  db: OrcaDatabase,
  entries: readonly SentInput[],
): Map<string, SentUserInputEvidence[]> {
  const unique = [...new Map(entries.map((entry) => [
    sessionIdentityKey(entry.agent, entry.sid, entry.env), entry,
  ])).values()];
  const grouped = new Map<string, SentUserInputEvidence[]>(
    unique.map((entry) => [sessionIdentityKey(entry.agent, entry.sid, entry.env), []]),
  );
  if (unique.length === 0) return grouped;
  const requested = unique.map(({ agent, sid, env }) => ({ agent, sid, env: env ?? LOCAL_ENV }));
  const rows = db.raw.query(`WITH requested(env, agent, sid) AS (
    SELECT json_extract(value, '$.env'), json_extract(value, '$.agent'), json_extract(value, '$.sid') FROM json_each(?)
  ), ranked AS (
    SELECT msg_fts.env, msg_fts.agent, msg_fts.sid, msg_fts.text, msg_fts.ts,
      COUNT(*) OVER (PARTITION BY msg_fts.env, msg_fts.agent, msg_fts.sid) AS input_count,
      ROW_NUMBER() OVER (PARTITION BY msg_fts.env, msg_fts.agent, msg_fts.sid ORDER BY msg_fts.rowid DESC) AS input_rank
    FROM msg_fts JOIN requested
      ON requested.env = msg_fts.env AND requested.agent = msg_fts.agent AND requested.sid = msg_fts.sid
    WHERE msg_fts.role = 'user' AND length(trim(msg_fts.text)) > 0
  )
  SELECT env, agent, sid, text, ts, input_count FROM ranked WHERE input_rank = 1 ORDER BY agent, sid`)
    .all(JSON.stringify(requested)) as EvidenceRow[];
  for (const row of rows) {
    const timestamp = row.ts === null ? null : Number(row.ts);
    const key = sessionIdentityKey(row.agent, row.sid, row.env);
    grouped.get(key)?.push({
      text: row.text, ts: Number.isFinite(timestamp) ? timestamp : null,
      ...(unique.find((entry) => sessionIdentityKey(entry.agent, entry.sid, entry.env) === key)?.previousInputCount === undefined
        ? {} : { inputCount: Number(row.input_count) }),
    });
  }
  return grouped;
}
