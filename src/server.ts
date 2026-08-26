import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTS, FALLBACK_RESCAN_INTERVAL_MS, ORCATAB_CLAUDE_DIR, ORCATAB_CODEX_DIR, ORCATAB_DATA_DIR,
  ORCATAB_HERMES_DB, ORCATAB_HOST, ORCATAB_ORCA_BIN, ORCATAB_PORT, RESCAN_INTERVAL_MS,
} from "./config";
import { OrcaDatabase } from "./db";
import { createFocusDeps, resolveFocus, SID_PATTERN, ValidationError, type FocusDeps } from "./focus";
import { GoalsStore, openGoalsDatabase, sessionIdentityKey, type GoalLinkKind } from "./goals";
import { createIndexer, type IndexSummary, type WatchHandle } from "./indexer";
import { createLiveReader } from "./live";
import { refreshProjectMetadata, startProjectMetadataTimer } from "./projects";
import { handleSppRequest } from "./spp";
import { suggestSessions } from "./suggest";
import type { Agent, FocusResult, GoalStatus, LiveInfo, SearchResult, SessionRow } from "./types";
import { resolveWorktreeFocus } from "./worktree-focus";

const DEFAULT_SESSIONS_LIMIT = 500;
const MAX_SESSIONS_LIMIT = 5_000;
const SUGGESTION_POOL_LIMIT = 5_000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const FOCUS_URI_PATTERN = /^orcatab:\/\/(claude|codex|hermes)\/([A-Za-z0-9_-]{1,128})$/;
const GOAL_STATUSES = new Set<GoalStatus>(["active", "done", "archived"]);
const GOAL_LINK_KINDS = new Set<GoalLinkKind>(["confirmed", "dismissed"]);

export interface ServerOptions {
  port?: number; claudeDir?: string; codexDir?: string; hermesDb?: string; dataDir?: string; orcaBin?: string;
  db?: OrcaDatabase; goalsStore?: GoalsStore; focusDeps?: FocusDeps; startTimers?: boolean; quiet?: boolean;
}

export interface OrcaTabServer {
  server: ReturnType<typeof Bun.serve>; db: OrcaDatabase; goalsStore: GoalsStore; indexed: IndexSummary;
  stop(): void;
}

class NotFoundError extends Error { override name = "NotFoundError"; }

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(value, { status, headers: responseHeaders });
}

function conditionalJson(request: Request, etag: string, value: () => unknown): Response {
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return json(value(), 200, { ETag: etag });
}

function boundedLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function mergeLive<T extends SessionRow>(rows: T[], live: Map<string, LiveInfo>): T[] {
  return rows.map((row) => ({ ...row, live: row.agent === "claude" ? live.get(row.sid) ?? null : null }));
}

function attachGoals<T extends SessionRow>(rows: T[], store: GoalsStore): T[] {
  const goals = store.goalsForSessions(rows.map(({ agent, sid }) => ({ agent, sid })));
  return rows.map((row) => ({ ...row, goals: goals.get(sessionIdentityKey(row.agent, row.sid)) ?? [] }));
}

function enabledAgent(value: string): value is Agent {
  return AGENTS.some((agent) => agent === value);
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); }
  catch { throw new ValidationError("invalid JSON body"); }
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new ValidationError("JSON body must be an object");
  return value as Record<string, unknown>;
}

function requiredName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("name is required");
  return value.trim();
}

function requiredProjectKey(value: unknown): string {
  if (typeof value !== "string" || !value) throw new ValidationError("projectKey is required");
  return value;
}

function nullableText(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string or null`);
  return value.trim() || null;
}

function decodeParts(pathname: string, prefix: string): string[] {
  try { return pathname.slice(prefix.length).split("/").map(decodeURIComponent); }
  catch { throw new ValidationError("invalid path encoding"); }
}

function focusText(result: FocusResult): string {
  if (result.action === "switched") return `switched ${result.handle}`;
  if (result.action === "resumed") return `resumed ${result.handle}`;
  return `manual ${result.reason}${result.command ? ` ${result.command}` : ""}`;
}

function errorResponse(error: unknown, request: Request): Response {
  const status = error instanceof ValidationError ? 400 : error instanceof NotFoundError ? 404 : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 500) console.error(`orcatab ${request.method} ${new URL(request.url).pathname}`, error instanceof Error ? error.stack : error);
  return json({ error: message }, status);
}

export async function createServer(options: ServerOptions = {}): Promise<OrcaTabServer> {
  const dataDir = options.dataDir ?? ORCATAB_DATA_DIR;
  const claudeDir = options.claudeDir ?? ORCATAB_CLAUDE_DIR;
  const codexDir = options.codexDir ?? ORCATAB_CODEX_DIR;
  const hermesDb = options.hermesDb ?? ORCATAB_HERMES_DB;
  const orcaBin = options.orcaBin ?? ORCATAB_ORCA_BIN;
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  const db = options.db ?? new OrcaDatabase(join(dataDir, "index.db"));
  const goalsStore = options.goalsStore ?? new GoalsStore(openGoalsDatabase(join(dataDir, "goals.db")));
  const indexer = createIndexer({ claudeDir, codexDir, hermesDb, db });
  const indexed = await indexer.indexAll();
  if (!options.quiet) console.log(`indexed ${indexed.files} sessions in ${indexed.ms} ms`);
  await refreshProjectMetadata(db, orcaBin);
  const liveReader = createLiveReader({ claudeDir });
  const focusDeps = options.focusDeps ?? createFocusDeps(db, {
    claudeDir, codexDir, hermesDb, orcaBin, liveFinder: liveReader.findLive,
  });
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let watcher: WatchHandle = { mode: "timer", close: () => {} };
  let rescanTimer: ReturnType<typeof setInterval> | null = null;
  if (options.startTimers !== false) {
    watcher = indexer.startWatcher(() => {
      if (rescanTimer !== null) clearInterval(rescanTimer);
      rescanTimer = indexer.startRescanTimer(FALLBACK_RESCAN_INTERVAL_MS);
      timers.push(rescanTimer);
    });
    rescanTimer = indexer.startRescanTimer(watcher.mode === "fs.watch" ? RESCAN_INTERVAL_MS : FALLBACK_RESCAN_INTERVAL_MS);
    timers.push(rescanTimer, startProjectMetadataTimer(db, orcaBin));
  }

  const versionedLive = () => {
    const live = liveReader.getLiveMap();
    return { live, etag: `"${db.getDataVersion()}-${liveReader.getLiveVersion()}-${goalsStore.goalsVersion}"` };
  };

  const goalSummaries = () => goalsStore.listGoals().map((goal) => {
    const links = goalsStore.confirmedLinks(goal.id);
    const timestamps = links.map(({ agent, sid }) => db.getSession(agent, sid)?.lastInputAt ?? null)
      .filter((value): value is number => value !== null);
    return { ...goal, sessionCount: links.length, lastActivityAt: timestamps.length ? Math.max(...timestamps) : null };
  }).sort((left, right) => Number(right.lastActivityAt !== null) - Number(left.lastActivityAt !== null)
    || (right.lastActivityAt ?? -1) - (left.lastActivityAt ?? -1));

  const handler = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/spp/")) return handleSppRequest(request, { db, getLiveMap: liveReader.getLiveMap, focusDeps });
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(Bun.file(join(import.meta.dir, "..", "public", "index.html")), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        const rawIndexedAt = db.getMeta("indexed_at");
        return json({
          ok: true, sessions: db.countSessions(), goals: goalsStore.countGoals(),
          indexedAt: rawIndexedAt === null ? null : Number(rawIndexedAt), dataVersion: db.getDataVersion(),
          watch: watcher.mode, agents: [...AGENTS], version: "p7",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        const { etag } = versionedLive();
        return conditionalJson(request, etag, () => db.listProjects());
      }
      if (request.method === "POST" && url.pathname === "/api/projects/focus") {
        const body = await jsonObject(request);
        const projectKey = requiredProjectKey(body.projectKey);
        const project = db.listProjectRecords().find((candidate) => candidate.key === projectKey);
        if (!project) throw new NotFoundError("project not found");
        const cwd = db.listSessions({ projectKey, limit: MAX_SESSIONS_LIMIT })
          .find((row) => Boolean(row.cwd))?.cwd || project.root;
        if (!cwd) throw new NotFoundError("project has no indexed worktree");
        return json(await resolveWorktreeFocus(cwd, focusDeps));
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const limit = boundedLimit(url.searchParams.get("limit"), DEFAULT_SESSIONS_LIMIT, MAX_SESSIONS_LIMIT);
        const projectKey = url.searchParams.get("project") || undefined;
        const liveOnly = url.searchParams.get("live") === "1";
        const { live, etag } = versionedLive();
        return conditionalJson(request, etag, () => {
          const base = db.listSessions({ ...(projectKey ? { projectKey } : {}), limit: liveOnly ? MAX_SESSIONS_LIMIT : limit });
          const rows = attachGoals(mergeLive(base, live), goalsStore);
          return liveOnly ? rows.filter((row) => row.live !== null).slice(0, limit) : rows;
        });
      }
      if (request.method === "GET" && url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = boundedLimit(url.searchParams.get("limit"), DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        const { live, etag } = versionedLive();
        return conditionalJson(request, etag, () => {
          const rows: SearchResult[] = q.trim() ? mergeLive(db.search(q, limit), live) : [];
          return attachGoals(rows, goalsStore);
        });
      }
      if (url.pathname === "/api/goals" && request.method === "GET") return json(goalSummaries());
      if (url.pathname === "/api/goals" && request.method === "POST") {
        const body = await jsonObject(request);
        const goal = goalsStore.createGoal({
          name: requiredName(body.name), externalRef: nullableText(body.externalRef, "externalRef"),
          color: nullableText(body.color, "color"),
        });
        return json(goal, 201);
      }
      if (url.pathname.startsWith("/api/goals/")) {
        const parts = decodeParts(url.pathname, "/api/goals/");
        const goalId = parts[0] ?? "";
        const goal = goalsStore.getGoal(goalId);
        if (goal === null) throw new NotFoundError("goal not found");
        if (parts.length === 1 && request.method === "GET") {
          const links = goalsStore.confirmedLinks(goalId);
          const base = links.map(({ agent, sid }) => db.getSession(agent, sid)).filter((row): row is SessionRow => row !== null);
          const live = liveReader.getLiveMap();
          const sessions = attachGoals(mergeLive(base, live), goalsStore)
            .sort((left, right) => (right.lastInputAt ?? -1) - (left.lastInputAt ?? -1));
          const excluded = new Set(goalsStore.excludedLinks(goalId).map(({ agent, sid }) => sessionIdentityKey(agent, sid)));
          const pool = attachGoals(mergeLive(db.listSessions({ limit: SUGGESTION_POOL_LIMIT }), live), goalsStore);
          return json({ goal, sessions, suggestions: suggestSessions(goal, sessions, excluded, pool) });
        }
        if (parts.length === 1 && request.method === "PATCH") {
          const body = await jsonObject(request);
          const name = body.name === undefined ? undefined : requiredName(body.name);
          const status = body.status;
          if (status !== undefined && (typeof status !== "string" || !GOAL_STATUSES.has(status as GoalStatus))) {
            throw new ValidationError("invalid goal status");
          }
          return json(goalsStore.updateGoal(goalId, {
            name, status: status as GoalStatus | undefined,
            externalRef: nullableText(body.externalRef, "externalRef"), color: nullableText(body.color, "color"),
          })!);
        }
        if (parts.length === 1 && request.method === "DELETE") {
          goalsStore.deleteGoal(goalId);
          return json({ ok: true });
        }
        if (parts.length === 2 && parts[1] === "links" && request.method === "POST") {
          const body = await jsonObject(request);
          if (typeof body.agent !== "string" || !enabledAgent(body.agent)) throw new ValidationError("invalid agent");
          if (typeof body.sid !== "string" || !SID_PATTERN.test(body.sid)) throw new ValidationError("invalid session id");
          if (typeof body.kind !== "string" || !GOAL_LINK_KINDS.has(body.kind as GoalLinkKind)) throw new ValidationError("invalid link kind");
          goalsStore.setLink(goalId, body.agent, body.sid, body.kind as GoalLinkKind);
          return json({ ok: true });
        }
        if (parts.length === 4 && parts[1] === "links" && request.method === "DELETE") {
          const agent = parts[2]!;
          const sid = parts[3]!;
          if (!enabledAgent(agent)) throw new ValidationError("invalid agent");
          if (!SID_PATTERN.test(sid)) throw new ValidationError("invalid session id");
          goalsStore.removeLink(goalId, agent, sid);
          return json({ ok: true });
        }
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/focus/")) {
        let parts: string[];
        try { parts = url.pathname.slice("/api/focus/".length).split("/").map(decodeURIComponent); }
        catch { throw new ValidationError("invalid session id encoding"); }
        const agent = parts.length === 1 ? "claude" : parts[0]!;
        const sid = parts.length === 1 ? parts[0]! : parts[1]!;
        if (parts.length < 1 || parts.length > 2 || !enabledAgent(agent)) throw new ValidationError("invalid agent");
        return json(await resolveFocus(agent, sid, focusDeps, { dryRun: false }));
      }
      if (request.method === "GET" && url.pathname === "/focus") {
        const candidate = url.searchParams.get("uri") ?? "";
        const match = FOCUS_URI_PATTERN.exec(candidate);
        if (!match) throw new ValidationError("invalid orcatab uri");
        const agent = match[1]!;
        if (!enabledAgent(agent)) throw new ValidationError("invalid agent");
        const result = await resolveFocus(agent, match[2]!, focusDeps, { dryRun: false });
        return new Response(`${focusText(result)}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return errorResponse(error, request);
    }
  };

  const server = Bun.serve({ hostname: ORCATAB_HOST, port: options.port ?? ORCATAB_PORT, fetch: handler });
  if (!options.quiet) console.log(`orcatab listening on http://${ORCATAB_HOST}:${server.port}`);
  return {
    server, db, goalsStore, indexed,
    stop: () => {
      watcher.close();
      for (const timer of timers) clearInterval(timer);
      server.stop(true);
      goalsStore.close();
      db.close();
    },
  };
}
