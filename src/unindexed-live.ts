import type { OrcaDatabase } from "./db";
import { identityKey, parseSessionIdentity } from "./session-identity";
import type { SessionIdentity, SessionIdentityKey } from "./session-identity";
import type { Agent, LiveInfo, SessionRow } from "./types";
import { liveWorktreeRootFor } from "./worktree-identity";

export const UNINDEXED_LIVE_PROJECT_KEY = "__unindexed_live__";

/**
 * A live session the indexer has not seen yet — a brand new tab, or one outside the watched dirs.
 *
 * The tab knows where it is even when the index does not, so the placeholder carries the live
 * workspace path as its worktree root. That is a location, nothing more: the row keeps the unknown
 * project key and `indexed: false`, and `cwd` stays null because no transcript recorded one.
 */
export function unindexedLiveRow(agent: Agent, sid: string, live: LiveInfo, env?: string): SessionRow {
  return {
    agent,
    ...(env === undefined ? {} : { env }),
    sid,
    projectKey: UNINDEXED_LIVE_PROJECT_KEY,
    cwd: null,
    worktreeRoot: liveWorktreeRootFor({ env, live }),
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

/**
 * One live identity joined to the index.
 *
 * `indexed` answers exactly one question: does the database hold a row for this precise
 * `(env, agent, sid)`? A miss is not evidence that a transcript is absent, unreadable or
 * disabled — only that the indexer has not stored this identity yet.
 */
export interface LiveSessionRow {
  key: SessionIdentityKey;
  identity: SessionIdentity;
  live: LiveInfo;
  indexed: boolean;
  /** The authoritative indexed row carrying its live info, or the placeholder standing in for it. */
  session: SessionRow;
}

export interface LiveSessionRowOptions {
  /** The list routes' own goal attachment, so a live row and a list row never disagree. Must
   *  return one row per input row, in order. */
  attachGoals?(rows: SessionRow[]): SessionRow[];
}

/**
 * The single live-to-index join. Every projection below, and every route, reads this — so
 * "is this session indexed?" is answered once, by the database, for the exact identity, and never
 * by whichever page of the session list a caller happened to load. Keys this codebase did not
 * produce carry no identity and are ignored.
 */
export function resolveLiveSessionRows(
  db: OrcaDatabase,
  live: Map<string, LiveInfo>,
  options: LiveSessionRowOptions = {},
): LiveSessionRow[] {
  const entries = [...live].flatMap(([key, info]) => {
    const identity = parseSessionIdentity(key);
    return identity === null ? [] : [{ key: identityKey(identity), identity, live: info }];
  });
  const stored = db.getSessionsByIdentity(entries.map((entry) => entry.identity));
  const rows = entries.map((entry): LiveSessionRow => {
    const indexed = stored.get(entry.key);
    return {
      ...entry,
      indexed: indexed !== undefined,
      session: indexed === undefined
        ? unindexedLiveRow(entry.identity.agent, entry.identity.sid, entry.live, entry.identity.env)
        : { ...indexed, live: entry.live, indexed: true },
    };
  });
  if (options.attachGoals === undefined) return rows;
  const withGoals = options.attachGoals(rows.map((row) => row.session));
  return rows.map((row, index) => ({ ...row, session: withGoals[index] ?? row.session }));
}

/**
 * Prefixes a page of indexed rows with the live identities the database has no row for. The page
 * itself is only a window: a row missing from it says nothing about the index, so membership is
 * used to avoid duplicates and never to decide that a session is unindexed.
 */
export function appendUnindexedLiveSessions(
  rows: SessionRow[],
  resolved: readonly LiveSessionRow[],
): SessionRow[] {
  const present = new Set<string>(rows.map((row) => identityKey(row)));
  const unknown = resolved
    .filter((entry) => !entry.indexed && !present.has(entry.key))
    .map((entry) => entry.session);
  return [...unknown, ...rows];
}

/** `db.listSessions`'s order, reproduced for rows resolved by identity: nulls last, newest first. */
function compareLastInput(left: SessionRow, right: SessionRow): number {
  if (left.lastInputAt === null || right.lastInputAt === null) {
    return Number(left.lastInputAt === null) - Number(right.lastInputAt === null);
  }
  return right.lastInputAt - left.lastInputAt;
}

/**
 * `/api/sessions?live=1`: every live identity, genuine unknowns first and indexed rows in the
 * session list's own order. Resolved by identity rather than filtered out of a bounded page, so an
 * indexed session older than the newest N rows is still returned.
 */
export function liveSessionRowsForList(resolved: readonly LiveSessionRow[]): SessionRow[] {
  const unknown = resolved.filter((entry) => !entry.indexed).map((entry) => entry.session);
  const indexed = resolved.filter((entry) => entry.indexed).map((entry) => entry.session)
    .sort(compareLastInput);
  return [...unknown, ...indexed];
}

/** One `/api/live` entry: the live info the providers reported, plus the index's answer for it. */
export interface LiveSessionEntry extends LiveInfo {
  /** The indexed project's key; null when the database holds no row for this identity. */
  projectKey: string | null;
  indexed: boolean;
  session: SessionRow;
}

/**
 * `/api/live`: the historical map — keyed by `agent/sid` locally and `env:agent/sid` remotely —
 * with each entry's authoritative row attached, so the GUI never has to infer index state from a
 * key or from the page it happens to be showing. A key this codebase did not produce has no
 * identity to look up, so it is dropped rather than echoed back without an answer.
 */
export function liveSessionsPayload(
  db: OrcaDatabase,
  live: Map<string, LiveInfo>,
  options: LiveSessionRowOptions = {},
): Record<string, LiveSessionEntry> {
  return Object.fromEntries(resolveLiveSessionRows(db, live, options).map((entry) => [entry.key, {
    ...entry.live,
    projectKey: entry.indexed ? entry.session.projectKey : null,
    indexed: entry.indexed,
    session: entry.session,
  }]));
}
