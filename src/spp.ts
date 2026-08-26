import { AGENTS } from "./config";
import type { OrcaDatabase } from "./db";
import { resolveFocus, ValidationError, type FocusDeps } from "./focus";
import { sessionIdentityKey } from "./goals";
import { suggestSessions } from "./suggest";
import type { Agent, Goal, LiveInfo, LiveStatus, SessionRow, SuggestionReason } from "./types";

const PROVIDER_ID = "orcatab" as const;
const DEFAULT_SESSIONS_LIMIT = 50;
const MAX_SESSIONS_LIMIT = 200;
const DEFAULT_SUGGESTIONS_LIMIT = 8;
const MAX_SUGGESTIONS_LIMIT = 200;
const SUGGESTION_POOL_LIMIT = 5_000;
const ACTION_ROUTE = /^\/spp\/v1\/sessions\/([^/]+)\/([^/]+)\/action$/;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};

export interface SppSession {
  providerId: typeof PROVIDER_ID;
  sessionId: string;
  agent: Agent;
  title: string | null;
  contextPath: string | null;
  branch: string | null;
  lastActivityAt: number | null;
  messageCount: number;
  webUrl: string | null;
  actionUrl: string;
}

interface SppDependencies {
  db: OrcaDatabase;
  getLiveMap(): Map<string, LiveInfo>;
  focusDeps: FocusDeps;
}

interface SppTask {
  title: string;
  projectName?: string;
  contextPath?: string;
}

interface SppRef { providerId: string; sessionId: string; }
type SppState = "live" | "idle" | "waiting" | "offline" | "done";

class SppNotFoundError extends Error { override name = "SppNotFoundError"; }

function sppJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: CORS_HEADERS });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); }
  catch { throw new ValidationError("invalid JSON body"); }
  if (!isObject(value)) throw new ValidationError("JSON body must be an object");
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  return value.trim() || undefined;
}

function parseTask(value: unknown): SppTask {
  if (!isObject(value)) throw new ValidationError("task must be an object");
  const title = optionalText(value.title, "task.title");
  if (!title) throw new ValidationError("task.title is required");
  const projectName = optionalText(value.projectName, "task.projectName");
  const contextPath = optionalText(value.contextPath, "task.contextPath");
  return { title, ...(projectName ? { projectName } : {}), ...(contextPath ? { contextPath } : {}) };
}

function boundedQueryLimit(value: string | null): number {
  if (value === null) return DEFAULT_SESSIONS_LIMIT;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_SESSIONS_LIMIT) : DEFAULT_SESSIONS_LIMIT;
}

function boundedSuggestionLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_SUGGESTIONS_LIMIT) : DEFAULT_SUGGESTIONS_LIMIT;
}

function parseExcludedSids(value: unknown): Set<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) throw new ValidationError("exclude must be an array");
  const excluded = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || typeof item.sessionId !== "string") throw new ValidationError("invalid exclude ref");
    excluded.add(item.sessionId);
  }
  return excluded;
}

function parseRefs(value: unknown): SppRef[] {
  if (!Array.isArray(value)) throw new ValidationError("refs must be an array");
  return value.map((item) => {
    if (!isObject(item) || typeof item.providerId !== "string" || typeof item.sessionId !== "string") {
      throw new ValidationError("invalid session ref");
    }
    return { providerId: item.providerId, sessionId: item.sessionId };
  });
}

function parseSince(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError("since must be a number");
  return value;
}

function matchesContext(row: SessionRow, context: string): boolean {
  return row.cwd === context || row.projectKey.includes(context);
}

function syntheticGoal(task: SppTask): Goal {
  return {
    id: "spp-task", name: [task.title, task.projectName].filter(Boolean).join(" "), status: "active",
    externalRef: null, color: null, createdAt: 0, updatedAt: 0,
  };
}

export function toSppSession(row: SessionRow): SppSession {
  return {
    providerId: PROVIDER_ID,
    sessionId: row.sid,
    agent: row.agent,
    title: row.displayTitle || null,
    contextPath: row.cwd,
    branch: row.branch,
    lastActivityAt: row.lastInputAt,
    messageCount: row.promptCount,
    webUrl: null,
    actionUrl: `orcatab://${row.agent}/${row.sid}`,
  };
}

export function toSppState(status: LiveStatus | null | undefined): SppState {
  if (status === "busy") return "live";
  if (status === "waiting") return "waiting";
  if (status === "idle" || status === "shell") return "idle";
  return "offline";
}

function suggestions(body: Record<string, unknown>, db: OrcaDatabase) {
  const task = parseTask(body.task);
  const limit = boundedSuggestionLimit(body.limit);
  const pool = db.listSessions({ limit: SUGGESTION_POOL_LIMIT });
  const excludedSids = parseExcludedSids(body.exclude);
  const excluded = new Set(pool.filter((row) => excludedSids.has(row.sid))
    .map((row) => sessionIdentityKey(row.agent, row.sid)));
  return suggestSessions(syntheticGoal(task), [], excluded, pool, limit, { contextPath: task.contextPath })
    .map((row) => {
      const reasons: SuggestionReason[] = row.reasons;
      return { ...toSppSession(row), score: row.score, reasons };
    });
}

function statuses(body: Record<string, unknown>, deps: SppDependencies) {
  const refs = parseRefs(body.refs).filter((ref) => ref.providerId === PROVIDER_ID);
  const since = parseSince(body.since);
  const live = deps.getLiveMap();
  return refs.map((ref) => {
    const session = deps.db.getSessionBySid(ref.sessionId);
    const liveInfo = session ? live.get(sessionIdentityKey(session.agent, session.sid)) : undefined;
    return {
      providerId: PROVIDER_ID,
      sessionId: ref.sessionId,
      state: toSppState(liveInfo?.status),
      lastActivityAt: session?.lastInputAt ?? null,
      ...(since === undefined ? {} : { newActivityCount: deps.db.countUserActivitySince(ref.sessionId, since) }),
      waitingFor: liveInfo?.waitingFor ?? null,
    };
  });
}

async function action(providerId: string, sessionId: string, deps: SppDependencies) {
  if (providerId !== PROVIDER_ID) throw new SppNotFoundError("provider not found");
  const session = deps.db.getSessionBySid(sessionId);
  if (session === null) throw new SppNotFoundError("session not found");
  const result = await resolveFocus(session.agent, session.sid, deps.focusDeps, { dryRun: true });
  const url = `orcatab://${session.agent}/${session.sid}`;
  if (result.action === "switched") {
    return { kind: "switch", url, command: null, label: "回到 Orca tab" };
  }
  if (result.action === "resumed") {
    return { kind: "resume", url, command: null, label: "在 Orca 恢复会话" };
  }
  return { kind: "manual", url: null, command: result.command, label: "手动恢复" };
}

function decodeActionRoute(pathname: string): [string, string] | null {
  const match = ACTION_ROUTE.exec(pathname);
  if (!match) return null;
  try { return [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)]; }
  catch { throw new ValidationError("invalid action path encoding"); }
}

function errorResponse(error: unknown, request: Request): Response {
  const status = error instanceof ValidationError ? 400 : error instanceof SppNotFoundError ? 404 : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 500) console.error(`orcatab SPP ${request.method} ${new URL(request.url).pathname}`, error);
  return sppJson({ error: message }, status);
}

export async function handleSppRequest(request: Request, deps: SppDependencies): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return noContent();
    if (request.method === "GET" && url.pathname === "/spp/v1/capabilities") {
      return sppJson({
        protocol: "spp/1.0",
        provider: { id: PROVIDER_ID, name: "OrcaTab", version: "1.0.0" },
        agents: [...AGENTS],
        features: { search: true, suggest: true, status: true, action: true, progressDelta: true },
      });
    }
    if (request.method === "GET" && url.pathname === "/spp/v1/sessions") {
      const limit = boundedQueryLimit(url.searchParams.get("limit"));
      const query = (url.searchParams.get("q") ?? "").trim();
      const context = (url.searchParams.get("context") ?? "").trim();
      const rows = query ? deps.db.search(query, limit) : deps.db.listSessions({ limit });
      const filtered = context ? rows.filter((row) => matchesContext(row, context)) : rows;
      return sppJson({ sessions: filtered.map(toSppSession), nextCursor: null });
    }
    if (request.method === "POST" && url.pathname === "/spp/v1/suggest") {
      return sppJson({ suggestions: suggestions(await jsonObject(request), deps.db) });
    }
    if (request.method === "POST" && url.pathname === "/spp/v1/status") {
      return sppJson({ statuses: statuses(await jsonObject(request), deps) });
    }
    const actionParts = request.method === "GET" ? decodeActionRoute(url.pathname) : null;
    if (actionParts) return sppJson(await action(actionParts[0], actionParts[1], deps));
    return sppJson({ error: "not found" }, 404);
  } catch (error) {
    return errorResponse(error, request);
  }
}
