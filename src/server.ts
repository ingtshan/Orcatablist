import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTS, FALLBACK_RESCAN_INTERVAL_MS, ORCATAB_CLAUDE_DIR, ORCATAB_CODEX_DIR, ORCATAB_DATA_DIR,
  ORCATAB_HERMES_DB, ORCATAB_HOST, ORCATAB_ORCA_BIN, ORCATAB_PORT, RESCAN_INTERVAL_MS,
} from "./config";
import {
  createBoardRegistry, openBoardDatabase, ProjectBoardStore, SessionTaskStore,
  type BoardRegistry, type RemoteBoardConfig,
} from "./boards";
import { OrcaDatabase } from "./db";
import { createDiscoveryReaders, handleDiscoveryRequest, type DiscoveryReaders } from "./discovery";
import { handleFocusBoardRequest } from "./focus-board-routes";
import { createFocusDeps, resolveFocus, ValidationError, type FocusDeps } from "./focus";
import { handleGoalRequest } from "./goal-routes";
import { GoalsStore, openGoalsDatabase } from "./goals";
import { isEnvName, LOCAL_ENV, normalizeEnv, parseSessionUri, sessionIdentityKey } from "./session-identity";
import { handleGovernanceRequest } from "./governance";
import {
  assertSameOriginWrite, boundedLimit, focusText, json, jsonObject, requiredString,
} from "./http";
import { serveFresh, versionSource, type VersionSource } from "./freshness";
import { createIndexer, type IndexSummary, type WatchHandle } from "./indexer";
import { createLiveReader } from "./live";
import { handleOrcaAuditRequest } from "./orca-audit-route";
import { createOrchestrationReader, type OrchestrationReader } from "./orchestration";
import { orchestrationSessionRows } from "./orchestration-sessions";
import { createOrcaWorktreeAuditReader, type OrcaWorktreeAuditReader } from "./orca-worktree-audit";
import { openProjectPreferencesDatabase, ProjectPreferencesStore } from "./project-preferences";
import { handleProjectRequest, NotFoundError } from "./project-routes";
import { refreshProjectMetadata, startProjectMetadataTimer } from "./projects";
import { EnvironmentStore, openEnvironmentsDatabase } from "./remote-environments";
import { createRemoteTabLiveSources } from "./remote-live";
import { createRemoteIndexing, type RemoteIndexing } from "./remote-poller";
import { handleEnvironmentRequest } from "./remote-routes";
import { handleSessionInputsRequest } from "./session-input-routes";
import { handleSessionOutboxRequest } from "./session-outbox-routes";
import { openSessionOutboxDatabase, SessionOutboxStore } from "./session-outbox";
import { createRefreshGate, handleSessionTaskRequest } from "./session-task-routes";
import { handleSessionSendRequest, logSentInput } from "./session-send-routes";
import { createSessionSendRuntime, type SentInputStore } from "./session-send-runtime";
import { createSessionLiveReader, mergeSessionLive, type SessionLiveReader } from "./session-live";
import { handleSppRequest } from "./spp";
import type { Agent, SearchResult, SessionRow } from "./types";
import {
  appendUnindexedLiveSessions, liveSessionRowsForList, liveSessionsPayload, resolveLiveSessionRows,
} from "./unindexed-live";
import { resolveWorktreeFocus } from "./worktree-focus";
const DEFAULT_SESSIONS_LIMIT = 500;
const MAX_SESSIONS_LIMIT = 5_000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
export interface ServerOptions {
  port?: number; claudeDir?: string; codexDir?: string; hermesDb?: string; dataDir?: string; orcaBin?: string;
  db?: OrcaDatabase; goalsStore?: GoalsStore; focusDeps?: FocusDeps; sessionLiveReader?: SessionLiveReader; discovery?: DiscoveryReaders; startTimers?: boolean; quiet?: boolean;
  directoryPathExists?(path: string): boolean; orcaAuditReader?: OrcaWorktreeAuditReader; sentInputStore?: SentInputStore;
  boardConfigs?: RemoteBoardConfig[]; boards?: BoardRegistry; orchestrationReader?: OrchestrationReader;
  environmentStore?: EnvironmentStore; remoteIndexing?: RemoteIndexing; sessionOutboxStore?: SessionOutboxStore;
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
  const sessionOutboxStore = options.sessionOutboxStore
    ?? new SessionOutboxStore(openSessionOutboxDatabase(join(dataDir, "session-outbox.db")));
  const projectPreferences = new ProjectPreferencesStore(openProjectPreferencesDatabase(join(dataDir, "project-preferences.db")));
  const boardDatabase = openBoardDatabase(join(dataDir, "boards.db"));
  const sessionTaskStore = new SessionTaskStore(boardDatabase);
  const projectBoardStore = new ProjectBoardStore(boardDatabase);
  const boards = options.boards ?? createBoardRegistry({
    database: boardDatabase,
    listLocalProjects: () => db.listProjects().map((project) => ({
      id: project.key, name: project.name, url: null,
    })),
    ...(options.boardConfigs === undefined ? {} : { configs: options.boardConfigs }),
  });
  const refreshGate = createRefreshGate();
  const discovery = options.discovery ?? createDiscoveryReaders();
  const orcaAuditReader = options.orcaAuditReader ?? createOrcaWorktreeAuditReader({ orcaBin });
  const indexer = createIndexer({ claudeDir, codexDir, hermesDb, db });
  const indexed = await indexer.indexAll();
  if (!options.quiet) console.log(`indexed ${indexed.files} sessions in ${indexed.ms} ms`);
  await refreshProjectMetadata(db, orcaBin);
  const environmentStore = options.environmentStore
    ?? new EnvironmentStore(openEnvironmentsDatabase(join(dataDir, "environments.db")));
  const sessionLiveReader = options.sessionLiveReader ?? createSessionLiveReader({
    orcaBin, getClaudeLiveMap: createLiveReader({ claudeDir }).getLiveMap,
    onError: options.quiet ? () => {} : undefined,
    dynamicSources: createRemoteTabLiveSources({ store: environmentStore, orcaBin }),
  });
  const orchestrationReader = options.orchestrationReader
    ?? createOrchestrationReader({ db, getLiveMap: sessionLiveReader.getLiveMap });
  const remoteSshPrefix = (env: string): string | null => {
    const config = environmentStore.get(env);
    if (config === null) return null;
    return `ssh ${config.sshPort === null ? "" : `-p ${config.sshPort} `}${config.sshUser}@${config.sshHost}`;
  };
  const focusDeps = options.focusDeps ?? createFocusDeps(db, {
    claudeDir, codexDir, hermesDb, orcaBin, liveFinder: sessionLiveReader.findLive, remoteSshPrefix,
  });
  const sentInputRuntime = createSessionSendRuntime({ db,
    startPolling: options.startTimers !== false,
    ...(options.sentInputStore === undefined ? {} : { store: options.sentInputStore }), ...(options.quiet ? { onError: () => {} } : {}) });
  const remoteIndexing = options.remoteIndexing ?? createRemoteIndexing({
    db, store: environmentStore, ...(options.quiet ? { onError: () => {} } : {}),
  });
  if (options.startTimers !== false) remoteIndexing.reload();
  const onSent = (entry: Parameters<typeof logSentInput>[0]) => {
    logSentInput(entry);
    if (entry.env !== undefined) remoteIndexing.kick(entry.env);
  };
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
  /**
   * Which environment a focus targets: the explicit `?env=` wins; without one, a session indexed
   * only from a remote environment routes there (an open GUI page from before the parameter
   * existed keeps working), and everything else stays local.
   */
  const focusEnv = (agent: Agent, sid: string, requested: string | null): string | undefined => {
    if (requested !== null && requested !== "" && requested !== LOCAL_ENV) {
      if (!isEnvName(requested)) throw new ValidationError("invalid environment name");
      return requested;
    }
    if (requested !== null) return undefined;
    const envs = db.sessionEnvs(agent, sid);
    if (envs.length === 0 || envs.includes(LOCAL_ENV)) return undefined;
    return envs[0];
  };
  // Named once, next to the stores they track, so a route declares what it reads rather than
  // remembering which of two database counters belongs in which ETag.
  const versions = {
    list: versionSource("list", () => db.getListVersion()),
    data: versionSource("data", () => db.getDataVersion()),
    goals: versionSource("goals", () => goalsStore.goalsVersion),
    live: versionSource("live", () => sessionLiveReader.getLiveVersion()),
    projects: versionSource("projects", () => projectPreferences.preferencesVersion),
    worktrees: versionSource("worktrees", () => projectPreferences.worktreePreferencesVersion),
    orchestration: versionSource("orchestration", () => orchestrationReader.getVersion()),
  } satisfies Record<string, VersionSource>;
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
      const projectResponse = await handleProjectRequest(request, url, db, projectPreferences, sessionLiveReader);
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
          indexing: indexer.getHealth(),
          capabilities: [
            "worktree-pin", "worktree-resources", "nginx-gateway", "directory-governance", "orca-worktree-audit",
            "session-send", "session-outbox", "focus-board", "session-tasks", "orchestration-runs", "remote-environments",
          ],
        });
      }
      if (request.method === "GET" && url.pathname === "/api/orchestration") {
        const live = await sessionLiveReader.refresh();
        const snapshot = orchestrationReader.refresh();
        if (url.searchParams.get("includeSessions") === "1") {
          return serveFresh(request, "orchestration-sessions", [versions.orchestration, versions.list, versions.live, versions.goals], () => ({
            ...snapshot, sessions: attachGoals(orchestrationSessionRows(db, snapshot.runs, live), goalsStore),
          }));
        }
        return serveFresh(request, "orchestration", [versions.orchestration], () => snapshot);
      }
      if (request.method === "GET" && url.pathname === "/api/live") {
        const live = await sessionLiveReader.refresh();
        // The payload carries each live session's authoritative indexed row, so it reads the
        // session list and the goals attached to it as well as liveness.
        return serveFresh(request, "live", [versions.live, versions.list, versions.goals],
          () => liveSessionsPayload(db, live, { attachGoals: (rows) => attachGoals(rows, goalsStore) }));
      }
      const focusBoardResponse = await handleFocusBoardRequest(request, url, {
        db, goalsStore, preferences: projectPreferences, liveReader: sessionLiveReader,
      });
      if (focusBoardResponse !== null) return focusBoardResponse;
      const sessionInputsResponse = await handleSessionInputsRequest(request, url, db);
      if (sessionInputsResponse !== null) return sessionInputsResponse;
      const sessionTaskResponse = await handleSessionTaskRequest(request, url, {
        db, boards, store: sessionTaskStore, bindings: projectBoardStore, refreshGate,
        ...(options.quiet ? { onError: () => {} } : {}),
      });
      if (sessionTaskResponse !== null) return sessionTaskResponse;
      const sessionOutboxResponse = await handleSessionOutboxRequest(request, url, {
        findLive: sessionLiveReader.findLive, psEnv: focusDeps.psEnv, orcaJson: focusDeps.orcaJson,
        store: sentInputRuntime.store, outbox: sessionOutboxStore, onSent,
      });
      if (sessionOutboxResponse !== null) return sessionOutboxResponse;
      const sessionSendResponse = await handleSessionSendRequest(request, url, {
        findLive: sessionLiveReader.findLive, psEnv: focusDeps.psEnv, orcaJson: focusDeps.orcaJson,
        store: sentInputRuntime.store, confirmationQueue: sentInputRuntime.confirmationQueue,
        // A remote send's delivery evidence arrives with the environment's next pull round;
        // kicking it right away turns "up to poll_ms" into "a couple of seconds".
        onSent,
      });
      if (sessionSendResponse !== null) return sessionSendResponse;
      const environmentResponse = await handleEnvironmentRequest(request, url, {
        db, store: environmentStore, indexing: remoteIndexing, orcaJson: focusDeps.orcaJson,
      });
      if (environmentResponse !== null) return environmentResponse;
      if (request.method === "POST" && url.pathname === "/api/projects/focus") {
        const body = await jsonObject(request);
        const projectKey = requiredString(body.projectKey, "projectKey");
        const project = db.listProjectRecords().find((candidate) => candidate.key === projectKey);
        if (!project) throw new NotFoundError("project not found");
        const rows = db.listSessions({ projectKey, limit: MAX_SESSIONS_LIMIT });
        const local = rows.filter((row) => normalizeEnv(row.env) === LOCAL_ENV);
        // A project whose every session lives on another machine has no local path to look up, so
        // it focuses through that session's own environment rather than this machine's terminals.
        const remote = local.length === 0 ? rows[0] : undefined;
        if (remote !== undefined) {
          return json(await resolveFocus(remote.agent, remote.sid, focusDeps, {
            dryRun: false, env: normalizeEnv(remote.env),
          }));
        }
        const cwd = local.map((row) => row.worktreeRoot || row.cwd)
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
          const withGoals = (rows: SessionRow[]): SessionRow[] => attachGoals(rows, goalsStore);
          // Whether a live session is indexed is a question for the database, never for the page
          // of rows this request happened to ask for.
          const resolved = () => resolveLiveSessionRows(db, live, { attachGoals: withGoals });
          if (liveOnly) {
            const liveRows = liveSessionRowsForList(resolved());
            return (projectKey ? liveRows.filter((row) => row.projectKey === projectKey) : liveRows).slice(0, limit);
          }
          const base = withGoals(mergeSessionLive(db.listSessions({ ...(projectKey ? { projectKey } : {}), limit }), live));
          return (projectKey ? base : appendUnindexedLiveSessions(base, resolved())).slice(0, limit);
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
      const goalResponse = await handleGoalRequest(request, url, { db, goalsStore, liveReader: sessionLiveReader });
      if (goalResponse !== null) return goalResponse;
      if (request.method === "POST" && url.pathname.startsWith("/api/focus/")) {
        assertSameOriginWrite(request);
        let parts: string[];
        try { parts = url.pathname.slice("/api/focus/".length).split("/").map(decodeURIComponent); }
        catch { throw new ValidationError("invalid session id encoding"); }
        const agent = parts.length === 1 ? "claude" : parts[0]!;
        const sid = parts.length === 1 ? parts[0]! : parts[1]!;
        if (parts.length < 1 || parts.length > 2 || !enabledAgent(agent)) throw new ValidationError("invalid agent");
        const env = focusEnv(agent, sid, url.searchParams.get("env"));
        return json(await resolveFocus(agent, sid, focusDeps, { dryRun: false, ...(env === undefined ? {} : { env }) }));
      }
      if (request.method === "GET" && url.pathname === "/focus") {
        const identity = parseSessionUri(url.searchParams.get("uri") ?? "");
        if (identity === null) throw new ValidationError("invalid orcatab uri");
        // A parsed uri states its environment: no env means local, never the legacy auto-detect.
        const env = focusEnv(identity.agent, identity.sid, identity.env ?? LOCAL_ENV);
        const result = await resolveFocus(identity.agent, identity.sid, focusDeps, {
          dryRun: false, ...(env === undefined ? {} : { env }),
        });
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
      // Before the database closes, so an awaiting pass cannot touch it and committed work stays versioned.
      indexer.close();
      for (const timer of timers) clearInterval(timer);
      remoteIndexing.close();
      sentInputRuntime.close();
      server.stop(true);
      if (options.environmentStore === undefined) environmentStore.close();
      if (options.sessionOutboxStore === undefined) sessionOutboxStore.close();
      projectPreferences.close();
      boardDatabase.close();
      goalsStore.close();
      db.close();
    },
  };
}
