import type { Database } from "bun:sqlite";
import type { Agent } from "./types";

const FTS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

export interface SessionMention {
  agent: Agent;
  sid: string;
  mentions: number;
}

function storedAgent(value: unknown): Agent {
  return value === "codex" || value === "hermes" ? value : "claude";
}

export function querySessionMentions(database: Database, tokens: readonly string[]): SessionMention[] {
  const safe = [...new Set(tokens)].filter((token) => FTS_TOKEN_PATTERN.test(token));
  if (safe.length === 0) return [];
  const match = safe.map((token) => `"${token}"`).join(" OR ");
  const rows = database.query(`SELECT agent, sid, COUNT(*) AS mentions FROM msg_fts
    WHERE msg_fts MATCH ? GROUP BY agent, sid ORDER BY mentions DESC, agent, sid`)
    .all(match) as Array<{ agent: string; sid: string; mentions: number }>;
  return rows.map((row) => ({
    agent: storedAgent(row.agent), sid: String(row.sid), mentions: Number(row.mentions),
  }));
}
