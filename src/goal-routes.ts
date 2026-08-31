import { AGENTS } from "./config";
import type { OrcaDatabase } from "./db";
import { ValidationError } from "./focus";
import { GoalsStore, type GoalLinkKind } from "./goals";
import { decodeParts, json, jsonObject, nullableText, requiredName } from "./http";
import { NotFoundError } from "./project-routes";
import type { SessionLiveReader } from "./session-live";
import { isSessionId, sessionIdentityKey } from "./session-identity";
import { mergeSessionLive } from "./session-live";
import { suggestSessions } from "./suggest";
import type { Agent, GoalStatus, SessionRow } from "./types";

const SUGGESTION_POOL_LIMIT = 5_000;
const GOAL_STATUSES = new Set<GoalStatus>(["active", "done", "archived"]);
const GOAL_LINK_KINDS = new Set<GoalLinkKind>(["confirmed", "dismissed"]);

export interface GoalRouteDeps {
  db: OrcaDatabase;
  goalsStore: GoalsStore;
  liveReader: SessionLiveReader;
}

function enabledAgent(value: string): value is Agent {
  return AGENTS.some((agent) => agent === value);
}

function attachGoals<T extends SessionRow>(rows: T[], store: GoalsStore): T[] {
  const goals = store.goalsForSessions(rows.map(({ agent, sid }) => ({ agent, sid })));
  return rows.map((row) => ({ ...row, goals: goals.get(sessionIdentityKey(row.agent, row.sid)) ?? [] }));
}

function goalSummaries(db: OrcaDatabase, store: GoalsStore) {
  const goals = store.listGoals();
  const linksByGoal = store.confirmedLinksByGoal();
  const sessions = db.getSessionsByIdentity([...linksByGoal.values()].flat());
  return goals.map((goal) => {
    const links = linksByGoal.get(goal.id) ?? [];
    const timestamps = links.map(({ agent, sid }) => sessions.get(sessionIdentityKey(agent, sid))?.lastInputAt ?? null)
      .filter((value): value is number => value !== null);
    return { ...goal, sessionCount: links.length, lastActivityAt: timestamps.length ? Math.max(...timestamps) : null };
  }).sort((left, right) => Number(right.lastActivityAt !== null) - Number(left.lastActivityAt !== null)
    || (right.lastActivityAt ?? -1) - (left.lastActivityAt ?? -1));
}

export async function handleGoalRequest(
  request: Request,
  url: URL,
  deps: GoalRouteDeps,
): Promise<Response | null> {
  if (url.pathname === "/api/goals") {
    if (request.method === "GET") return json(goalSummaries(deps.db, deps.goalsStore));
    if (request.method !== "POST") return null;
    const body = await jsonObject(request);
    const goal = deps.goalsStore.createGoal({
      name: requiredName(body.name), externalRef: nullableText(body.externalRef, "externalRef"),
      color: nullableText(body.color, "color"),
    });
    return json(goal, 201);
  }
  if (!url.pathname.startsWith("/api/goals/")) return null;

  const parts = decodeParts(url.pathname, "/api/goals/");
  const goalId = parts[0] ?? "";
  const goal = deps.goalsStore.getGoal(goalId);
  if (goal === null) throw new NotFoundError("goal not found");
  if (parts.length === 1 && request.method === "GET") {
    const links = deps.goalsStore.confirmedLinks(goalId);
    const sessionsByIdentity = deps.db.getSessionsByIdentity(links);
    const base = links.map(({ agent, sid }) => sessionsByIdentity.get(sessionIdentityKey(agent, sid)))
      .filter((row): row is SessionRow => row !== undefined);
    const live = await deps.liveReader.refresh();
    const sessions = attachGoals(mergeSessionLive(base, live), deps.goalsStore)
      .sort((left, right) => (right.lastInputAt ?? -1) - (left.lastInputAt ?? -1));
    const excluded = new Set(deps.goalsStore.excludedLinks(goalId)
      .map(({ agent, sid }) => sessionIdentityKey(agent, sid)));
    const pool = attachGoals(
      mergeSessionLive(deps.db.listSessions({ limit: SUGGESTION_POOL_LIMIT }), live),
      deps.goalsStore,
    );
    return json({ goal, sessions, suggestions: suggestSessions(goal, sessions, excluded, pool) });
  }
  if (parts.length === 1 && request.method === "PATCH") {
    const body = await jsonObject(request);
    const name = body.name === undefined ? undefined : requiredName(body.name);
    const status = body.status;
    if (status !== undefined && (typeof status !== "string" || !GOAL_STATUSES.has(status as GoalStatus))) {
      throw new ValidationError("invalid goal status");
    }
    return json(deps.goalsStore.updateGoal(goalId, {
      name, status: status as GoalStatus | undefined,
      externalRef: nullableText(body.externalRef, "externalRef"), color: nullableText(body.color, "color"),
    })!);
  }
  if (parts.length === 1 && request.method === "DELETE") {
    deps.goalsStore.deleteGoal(goalId);
    return json({ ok: true });
  }
  if (parts.length === 2 && parts[1] === "links" && request.method === "POST") {
    const body = await jsonObject(request);
    if (typeof body.agent !== "string" || !enabledAgent(body.agent)) throw new ValidationError("invalid agent");
    if (!isSessionId(body.sid)) throw new ValidationError("invalid session id");
    if (typeof body.kind !== "string" || !GOAL_LINK_KINDS.has(body.kind as GoalLinkKind)) {
      throw new ValidationError("invalid link kind");
    }
    deps.goalsStore.setLink(goalId, body.agent, body.sid, body.kind as GoalLinkKind);
    return json({ ok: true });
  }
  if (parts.length === 4 && parts[1] === "links" && request.method === "DELETE") {
    const agent = parts[2]!;
    const sid = parts[3]!;
    if (!enabledAgent(agent)) throw new ValidationError("invalid agent");
    if (!isSessionId(sid)) throw new ValidationError("invalid session id");
    deps.goalsStore.removeLink(goalId, agent, sid);
    return json({ ok: true });
  }
  return null;
}
