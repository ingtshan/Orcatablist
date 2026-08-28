import type { OrcaDatabase } from "./db";
import type { Agent, LiveInfo, SessionRow } from "./types";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const UNINDEXED_LIVE_PROJECT_KEY = "__unindexed_live__";

function identity(key: string): { agent: Agent; sid: string } | null {
  const separator = key.indexOf("/");
  if (separator < 1) return null;
  const agent = key.slice(0, separator);
  const sid = key.slice(separator + 1);
  if ((agent !== "claude" && agent !== "codex" && agent !== "hermes") || !SESSION_ID_PATTERN.test(sid)) return null;
  return { agent, sid };
}

function identityKey(value: { agent: Agent; sid: string }): `${string}/${string}` {
  return `${value.agent}/${value.sid}`;
}

function placeholder(agent: Agent, sid: string, live: LiveInfo): SessionRow {
  return {
    agent,
    sid,
    projectKey: UNINDEXED_LIVE_PROJECT_KEY,
    cwd: null,
    worktreeRoot: null,
    branch: null,
    title: null,
    firstPrompt: null,
    lastPrompt: live.name,
    displayTitle: "未索引在线会话",
    lastInputAt: null,
    promptCount: 0,
    live,
    goals: [],
    indexed: false,
  };
}

export function appendUnindexedLiveSessions(rows: SessionRow[], live: Map<string, LiveInfo>): SessionRow[] {
  const indexed = new Set(rows.map((row) => `${row.agent}/${row.sid}`));
  const unindexed = [...live].flatMap(([key, info]) => {
    const parsed = identity(key);
    return parsed === null || indexed.has(key) ? [] : [placeholder(parsed.agent, parsed.sid, info)];
  });
  return [...unindexed, ...rows];
}

export function liveSessionsWithProjectKeys(
  db: OrcaDatabase,
  live: Map<string, LiveInfo>,
): Record<string, LiveInfo & { projectKey: string | null }> {
  const identities = [...live.keys()].flatMap((key) => {
    const parsed = identity(key);
    return parsed === null ? [] : [parsed];
  });
  const sessions = db.getSessionsByIdentity(identities);
  return Object.fromEntries([...live].map(([key, info]) => {
    const parsed = identity(key);
    const projectKey = parsed === null ? null : sessions.get(identityKey(parsed))?.projectKey ?? null;
    return [key, { ...info, projectKey }];
  }));
}
