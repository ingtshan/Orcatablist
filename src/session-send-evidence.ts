import type { OrcaDatabase } from "./db";
import { sessionIdentityKey } from "./session-identity";
import {
  CONFIRMATION_INPUT_TOLERANCE_MS, type SentInput, type SentUserInputEvidence,
} from "./session-send";

interface EvidenceRow {
  agent: SentInput["agent"];
  sid: string;
  text: string;
  ts: number;
}

export function findSentInputEvidence(
  db: OrcaDatabase,
  entries: readonly SentInput[],
): Map<string, SentUserInputEvidence[]> {
  const unique = [...new Map(entries.map((entry) => [
    sessionIdentityKey(entry.agent, entry.sid), entry,
  ])).values()];
  const grouped = new Map<string, SentUserInputEvidence[]>(
    unique.map((entry) => [sessionIdentityKey(entry.agent, entry.sid), []]),
  );
  if (unique.length === 0) return grouped;
  const requested = unique.map(({ agent, sid, sentAt }) => ({ agent, sid, sentAt }));
  const rows = db.raw.query(`WITH requested(agent, sid, sent_at) AS (
    SELECT json_extract(value, '$.agent'), json_extract(value, '$.sid'), json_extract(value, '$.sentAt')
      FROM json_each(?)
  )
  SELECT msg_fts.agent, msg_fts.sid, msg_fts.text, msg_fts.ts
    FROM msg_fts JOIN requested
      ON requested.agent = msg_fts.agent AND requested.sid = msg_fts.sid
    WHERE msg_fts.role = 'user' AND msg_fts.ts IS NOT NULL
      AND msg_fts.ts >= requested.sent_at - ? AND msg_fts.ts <= requested.sent_at + ?
    ORDER BY msg_fts.rowid DESC`)
    .all(JSON.stringify(requested), CONFIRMATION_INPUT_TOLERANCE_MS,
      CONFIRMATION_INPUT_TOLERANCE_MS) as EvidenceRow[];
  for (const row of rows) {
    grouped.get(sessionIdentityKey(row.agent, row.sid))?.push({ text: row.text, ts: Number(row.ts) });
  }
  return grouped;
}
