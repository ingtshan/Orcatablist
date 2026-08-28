import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTS, FALLBACK_RESCAN_INTERVAL_MS, ORCATAB_CLAUDE_DIR, ORCATAB_CODEX_DIR, ORCATAB_DATA_DIR,
  ORCATAB_HERMES_DB, ORCATAB_HOST, ORCATAB_ORCA_BIN, ORCATAB_PORT, RESCAN_INTERVAL_MS,
} from "./config";
import { OrcaDatabase } from "./db";
import { createDiscoveryReaders, handleDiscoveryRequest, type DiscoveryReaders } from "./discovery";
import { handleFocusBoardRequest } from "./focus-board-routes";
import { createFocusDeps, resolveFocus, ValidationError, type FocusDeps } from "./focus";
import { GoalsStore, openGoalsDatabase, type GoalLinkKind } from "./goals";
import { isSessionId, parseSessionUri, sessionIdentityKey } from "./session-identity";
import { handleGovernanceRequest } from "./governance";
import {
  assertSameOriginWrite, boundedLimit, decodeParts, focusText, json, jsonObject, nullableText,
  requiredName, requiredString,
} from "./http";
import { serveFresh, versionSource, type VersionSource } from "./freshness";
import { createIndexer, type IndexSummary, type WatchHandle } from "./indexer";
import { createLiveReader } from "./live";
import { handleOrcaAuditRequest } from "./orca-audit-route";
import { createOrcaWorktreeAuditReader, type OrcaWorktreeAuditReader } from "./orca-worktree-audit";
import { openProjectPreferencesDatabase, ProjectPreferencesStore } from "./project-preferences";
import { handleProjectRequest, NotFoundError } from "./project-routes";
import { refreshProjectMetadata, startProjectMetadataTimer } from "./projects";
import { handleSessionInputsRequest } from "./session-input-routes";
import { handleSessionSendRequest } from "./session-send-routes";
import { createSessionSendRuntime, type SentInputStore } from "./session-send-runtime";
import { createSessionLiveReader, mergeSessionLive, type SessionLiveReader } from "./session-live";
import { handleSppRequest } from "./spp";
import { suggestSessions } from "./suggest";
import type { Agent, GoalStatus, SearchResult, SessionRow } from "./types";
import { appendUnindexedLiveSessions, liveSessionsWithProjectKeys } from "./unindexed-live";
import { resolveWorktreeFocus } from "./worktree-focus";
const DEFAULT_SESSIONS_LIMIT = 500;
const MAX_SESSIONS_LIMIT = 5_000;
const SUGGESTION_POOL_LIMIT = 5_000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const GOAL_STATUSES = new Set<GoalStatus>(["active", "done", "archived"]);
const GOAL_LINK_KINDS = new Set<GoalLinkKind>(["confirmed", "dismissed"]);
export interface ServerOptions {
  port?: number; claudeDir?: string; codexDir?: string; hermesDb?: string; dataDir?: string; orcaBin?: string;
  db?: OrcaDatabase; goalsStore?: GoalsStore; focusDeps?: FocusDeps; sessionLiveReader?: SessionLiveReader; discovery?: DiscoveryReaders; startTimers?: boolean; quiet?: boolean;
  directoryPathExists?(path: string): boolean; orcaAuditReader?: OrcaWorktreeAuditReader; sentInputStore?: SentInputStore;
}
export interface OrcaTabServer { server: ReturnType<typeof Bun.serve>; db: OrcaDatabase; goalsStore: GoalsStore; indexed: IndexSummary; stop(): void; }
function attachGoals<T extends SessionRow>(rows: T[], store: GoalsStore): T[] {
  const goals = store.goalsForSessions(rows.map(({ agent, sid }) => ({ agent, sid })));
  return rows.map((row) => ({ ...row, goals: goals.get(sessionIdentityKey(row.agent, row.sid)) ?? [] }));
}
function enabledAgent(value: string): value is Agent {
  return AGENTS.some((agent) => agent === value);
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
  const projectPreferences = new ProjectPreferencesStore(openProjectPreferencesDatabase(join(dataDir, "project-preferences.db")));
  const discovery = options.discovery ?? createDiscoveryReaders();
  const orcaAuditReader = options.orcaAuditReader ?? createOrcaWorktreeAuditReader({ orcaBin });
  const indexer = createIndexer({ claudeDir, codexDir, hermesDb, db });
  const indexed = await indexer.indexAll();
  if (!options.quiet) console.log(`indexed ${indexed.files} sessions in ${indexed.ms} ms`);
  await refreshProjectMetadata(db, orcaBin);
  const sessionLiveReader = options.sessionLiveReader ?? createSessionLiveReader({
    orcaBin, getClaudeLiveMap: createLiveReader({ claudeDir }).getLiveMap,
    onError: options.quiet ? () => {} : undefined,
  });
  const focusDeps = options.focusDeps ?? createFocusDeps(db, {
    claudeDir, codexDir, hermesDb, orcaBin, liveFinder: sessionLiveReader.findLive,
  });
  const sentInputRuntime = createSessionSendRuntime({ db, liveReader: sessionLiveReader,
    startPolling: options.startTimers !== false,
    ...(options.sentInputStore === undefined ? {} : { store: options.sentInputStore }), ...(options.quiet ? { onError: () => {} } : {}) });
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
  // Named once, next to the stores they track, so a route declares what it reads rather than
  // remembering which of two database counters belongs in which ETag.
  const versions = {
    list: versionSource("list", () => db.getListVersion()),
    data: versionSource("data", () => db.getDataVersion()),
    goals: versionSource("goals", () => goalsStore.goalsVersion),
    live: versionSource("live", () => sessionLiveReader.getLiveVersion()),
    projects: versionSource("projects", () => projectPreferences.preferencesVersion),
    worktrees: versionSource("worktrees", () => projectPreferences.worktreePreferencesVersion),
  } satisfies Record<string, VersionSource>;
  const goalSummaries = () => {
    const goals = goalsStore.listGoals();
    const linksByGoal = goalsStore.confirmedLinksByGoal();
    const sessions = db.getSessionsByIdentity([...linksByGoal.values()].flat());
    return goals.map((goal) => {
      const links = linksByGoal.get(goal.id) ?? [];
      const timestamps = links.map(({ agent, sid }) => sessions.get(sessionIdentityKey(agent, sid))?.lastInputAt ?? null)
        .filter((value): value is number => value !== null);
      return { ...goal, sessionCount: links.length, lastActivityAt: timestamps.length ? Math.max(...timestamps) : null };
    }).sort((left, right) => Number(right.lastActivityAt !== null) - Number(left.lastActivityAt !== null)
      || (right.lastActivityAt ?? -1) - (left.lastActivityAt ?? -1));
  };
  const handler = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const discoveryResponse = await handleDiscoveryRequest(request, url, db, discovery);
      if (discoveryResponse !== null) return discoveryResponse;
      const governanceResponse = await handleGovernanceRequest(request, url, db, projectPreferences, {
        pathExists: options.directoryPathExists,
      });
      if (governanceResponse !== null) return governanceResponse;
      const orcaAuditResponse = await handleOrcaAuditRequest(request, url, orcaAuditReader);
      if (orcaAuditResponse !== null) return orcaAuditResponse;
      const projectResponse = await handleProjectRequest(request, url, db, projectPreferences);
      if (projectResponse !== null) return projectResponse;
      if (url.pathname.startsWith("/spp/")) {
        await sessionLiveReader.refresh();
        return handleSppRequest(request, { db, getLiveMap: sessionLiveReader.getLiveMap, focusDeps });
      }
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
          listVersion: db.getListVersion(),
          watch: watcher.mode, agents: [...AGENTS], version: "p7",
          capabilities: [
            "worktree-pin", "worktree-resources", "nginx-gateway", "directory-governance", "orca-worktree-audit",
            "session-send", "focus-board",
          ],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/live") {
        const live = await sessionLiveReader.refresh();
        // The payload joins live status to each session's project, so it reads the list too.
        return serveFresh(request, "live", [versions.live, versions.list],
          () => liveSessionsWithProjectKeys(db, live));
      }
      const focusBoardResponse = await handleFocusBoardRequest(request, url, {
        db, goalsStore, preferences: projectPreferences, liveReader: sessionLiveReader,
      });
      if (focusBoardResponse !== null) return focusBoardResponse;
      const sessionInputsResponse = await handleSessionInputsRequest(request, url, db);
      if (sessionInputsResponse !== null) return sessionInputsResponse;
      const sessionSendResponse = await handleSessionSendRequest(request, url, {
        findLive: sessionLiveReader.findLive, psEnv: focusDeps.psEnv, orcaJson: focusDeps.orcaJson,
        store: sentInputRuntime.store, confirmationQueue: sentInputRuntime.confirmationQueue,
      });
      if (sessionSendResponse !== null) return sessionSendResponse;
      if (request.method === "POST" && url.pathname === "/api/projects/focus") {
        const body = await jsonObject(request);
        const projectKey = requiredString(body.projectKey, "projectKey");
        const project = db.listProjectRecords().find((candidate) => candidate.key === projectKey);
        if (!project) throw new NotFoundError("project not found");
        const cwd = db.listSessions({ projectKey, limit: MAX_SESSIONS_LIMIT }).map((row) => row.worktreeRoot || row.cwd)
          .find((path): path is string => Boolean(path)) || project.root;
        if (!cwd) throw new NotFoundError("project has no indexed worktree");
        return json(await resolveWorktreeFocus(cwd, focusDeps));
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const limit = boundedLimit(url.searchParams.get("limit"), DEFAULT_SESSIONS_LIMIT, MAX_SESSIONS_LIMIT);
        const projectKey = url.searchParams.get("project") || undefined;
        const liveOnly = url.searchParams.get("live") === "1";
        const includeLive = url.searchParams.get("includeLive") !== "0";
        if (liveOnly && !includeLive) throw new ValidationError("live=1 requires live session data");
        if (!includeLive) {
          return serveFresh(request, "sessions", [versions.list, versions.goals], () => attachGoals(
            db.listSessions({ ...(projectKey ? { projectKey } : {}), limit }), goalsStore,
          ));
        }
        const live = await sessionLiveReader.refresh();
        return serveFresh(request, "sessions-live", [versions.list, versions.live, versions.goals], () => {
          const base = db.listSessions({ ...(projectKey ? { projectKey } : {}), limit: liveOnly ? MAX_SESSIONS_LIMIT : limit });
          const indexedRows = attachGoals(mergeSessionLive(base, live), goalsStore);
          const rows = projectKey ? indexedRows : appendUnindexedLiveSessions(indexedRows, live);
          return liveOnly ? rows.filter((row) => row.live !== null).slice(0, limit) : rows.slice(0, limit);
        });
      }
      if (request.method === "GET" && url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = boundedLimit(url.searchParams.get("limit"), DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        if (url.searchParams.get("includeLive") === "0") {
          const rows: SearchResult[] = q.trim() ? db.search(q, limit) : [];
          return json(attachGoals(rows, goalsStore));
        }
        const live = await sessionLiveReader.refresh();
        return serveFresh(request, "search", [versions.data, versions.live, versions.goals], () => {
          const rows: SearchResult[] = q.trim() ? mergeSessionLive(db.search(q, limit), live) : [];
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
          const sessionsByIdentity = db.getSessionsByIdentity(links);
          const base = links.map(({ agent, sid }) => sessionsByIdentity.get(sessionIdentityKey(agent, sid)))
            .filter((row): row is SessionRow => row !== undefined);
          const live = await sessionLiveReader.refresh();
          const sessions = attachGoals(mergeSessionLive(base, live), goalsStore)
            .sort((left, right) => (right.lastInputAt ?? -1) - (left.lastInputAt ?? -1));
          const excluded = new Set(goalsStore.excludedLinks(goalId).map(({ agent, sid }) => sessionIdentityKey(agent, sid)));
          const pool = attachGoals(mergeSessionLive(db.listSessions({ limit: SUGGESTION_POOL_LIMIT }), live), goalsStore);
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
          if (!isSessionId(body.sid)) throw new ValidationError("invalid session id");
          if (typeof body.kind !== "string" || !GOAL_LINK_KINDS.has(body.kind as GoalLinkKind)) throw new ValidationError("invalid link kind");
          goalsStore.setLink(goalId, body.agent, body.sid, body.kind as GoalLinkKind);
          return json({ ok: true });
        }
        if (parts.length === 4 && parts[1] === "links" && request.method === "DELETE") {
          const agent = parts[2]!;
          const sid = parts[3]!;
          if (!enabledAgent(agent)) throw new ValidationError("invalid agent");
          if (!isSessionId(sid)) throw new ValidationError("invalid session id");
          goalsStore.removeLink(goalId, agent, sid);
          return json({ ok: true });
        }
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/focus/")) {
        assertSameOriginWrite(request);
        let parts: string[];
        try { parts = url.pathname.slice("/api/focus/".length).split("/").map(decodeURIComponent); }
        catch { throw new ValidationError("invalid session id encoding"); }
        const agent = parts.length === 1 ? "claude" : parts[0]!;
        const sid = parts.length === 1 ? parts[0]! : parts[1]!;
        if (parts.length < 1 || parts.length > 2 || !enabledAgent(agent)) throw new ValidationError("invalid agent");
        return json(await resolveFocus(agent, sid, focusDeps, { dryRun: false }));
      }
      if (request.method === "GET" && url.pathname === "/focus") {
        const identity = parseSessionUri(url.searchParams.get("uri") ?? "");
        if (identity === null) throw new ValidationError("invalid orcatab uri");
        const result = await resolveFocus(identity.agent, identity.sid, focusDeps, { dryRun: false });
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
      sentInputRuntime.close();
      server.stop(true);
      projectPreferences.close();
      goalsStore.close();
      db.close();
    },
  };
}
