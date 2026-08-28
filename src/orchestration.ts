import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  DISPLAY_TITLE_MAX_CHARS, ORCATAB_ORCHESTRATION_DB, ORCHESTRATION_CACHE_MS, ORCHESTRATION_RUN_LIMIT,
  ORCHESTRATION_RUN_MAX_AGE_MS,
} from "./config";
import type { OrcaDatabase, SessionMention } from "./db";
import { sessionIdentityKey } from "./session-identity";
import type { Agent, LiveInfo } from "./types";

const BUSY_TIMEOUT_MS = 5_000;
const WORK_ORDER_PATH = /\s\/\S/u;
const TRAILING_CLAUSE = /\s*[—–-][^—–-]*$/u;

/** One agent session taking part in an Orca orchestration run. */
export interface OrchestrationMember { agent: Agent; sid: string; }
/** A dispatched session, labelled with the last Orca task it was handed. */
export interface OrchestrationWorker extends OrchestrationMember { taskTitle: string | null; }
export interface OrchestrationRun {
  runId: string; objective: string; createdAt: number | null; updatedAt: number | null;
  coordinator: OrchestrationMember | null; workers: OrchestrationWorker[];
}
export interface OrchestrationSnapshot {
  scannedAt: number; cacheTtlMs: number; available: boolean; runs: OrchestrationRun[]; warnings: string[];
}
export interface OrchestrationReader {
  getVersion(): number;
  refresh(): OrchestrationSnapshot;
}
export interface OrchestrationReaderOptions {
  db: OrcaDatabase;
  getLiveMap(): Map<string, LiveInfo>;
  path?: string;
  cacheMs?: number;
  now?(): number;
}

interface RawDispatch { id: string; taskId: string; taskTitle: string | null; }
interface RawRun {
  id: string; objective: string; coordinatorHandle: string | null; coordinatorPaneKey: string | null;
  createdAt: number | null; updatedAt: number | null; dispatches: RawDispatch[];
}
interface RawState { available: boolean; runs: RawRun[]; warnings: string[] }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Orca writes `datetime('now')`, which is UTC without a zone marker. */
function sqlTimestamp(value: unknown): number | null {
  const raw = text(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Orca task titles usually read `<headline> — order at <absolute path>`; a one-line row only has
 * room for the headline, so drop the clause that introduces the work-order path.
 */
function taskLabel(value: unknown): string | null {
  const title = text(value)?.replace(/\s+/gu, " ").trim() ?? "";
  if (title === "") return null;
  const pathAt = title.search(WORK_ORDER_PATH);
  const headline = pathAt < 0 ? title : title.slice(0, pathAt).replace(TRAILING_CLAUSE, "").trim() || title;
  return headline.length > DISPLAY_TITLE_MAX_CHARS ? `${headline.slice(0, DISPLAY_TITLE_MAX_CHARS - 1)}…` : headline;
}

function rawRun(row: Record<string, unknown>): RawRun | null {
  const id = text(row.id);
  if (id === null) return null;
  return {
    id,
    objective: text(row.objective) ?? "",
    coordinatorHandle: text(row.coordinator_handle),
    coordinatorPaneKey: text(row.coordinator_pane_key),
    createdAt: sqlTimestamp(row.created_at),
    updatedAt: sqlTimestamp(row.updated_at),
    dispatches: [],
  };
}

function readRawState(path: string, now: number): RawState {
  if (!existsSync(path)) return { available: false, runs: [], warnings: [] };
  let database: Database | null = null;
  try {
    database = new Database(path, { readonly: true });
    database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
    const since = now - ORCHESTRATION_RUN_MAX_AGE_MS;
    const runRows = database.query(`SELECT id, objective, coordinator_handle, coordinator_pane_key, created_at, updated_at
      FROM runs WHERE legacy = 0 ORDER BY updated_at DESC LIMIT ?`).all(ORCHESTRATION_RUN_LIMIT) as Record<string, unknown>[];
    const runs = runRows.map(rawRun)
      .filter((run): run is RawRun => run !== null && (run.updatedAt === null || run.updatedAt >= since));
    const byId = new Map(runs.map((run) => [run.id, run]));
    const dispatchRows = database.query(`SELECT dispatch.run_id, dispatch.id, dispatch.task_id, task.task_title
      FROM dispatch_contexts dispatch LEFT JOIN tasks task ON task.id = dispatch.task_id
      WHERE dispatch.run_id IN (SELECT value FROM json_each(?))
      ORDER BY dispatch.rowid`)
      .all(JSON.stringify([...byId.keys()])) as Record<string, unknown>[];
    for (const row of dispatchRows) {
      const run = byId.get(text(row.run_id) ?? "");
      const id = text(row.id);
      const taskId = text(row.task_id);
      if (run === undefined || id === null || taskId === null) continue;
      run.dispatches.push({ id, taskId, taskTitle: taskLabel(row.task_title) });
    }
    return { available: true, runs, warnings: [] };
  } catch (error) {
    return { available: true, runs: [], warnings: [`failed to read Orca orchestration state ${path}: ${errorText(error)}`] };
  } finally {
    database?.close();
  }
}

function memberKey(member: OrchestrationMember): string {
  return sessionIdentityKey(member.agent, member.sid);
}

function member(mention: SessionMention): OrchestrationMember {
  return { agent: mention.agent, sid: mention.sid };
}

interface LiveIdentities {
  byHandle: Map<string, OrchestrationMember>;
  byPane: Map<string, OrchestrationMember>;
}

function liveIdentities(live: Map<string, LiveInfo>): LiveIdentities {
  const byHandle = new Map<string, OrchestrationMember>();
  const byPane = new Map<string, OrchestrationMember>();
  for (const [key, info] of live) {
    const separator = key.indexOf("/");
    const agent = key.slice(0, separator);
    const sid = key.slice(separator + 1);
    if (separator < 1 || !sid) continue;
    const identity: OrchestrationMember = { agent: agent as Agent, sid };
    if (info.handle) byHandle.set(info.handle, identity);
    if (info.tabId && info.leafId) byPane.set(`${info.tabId}:${info.leafId}`, identity);
  }
  return { byHandle, byPane };
}

/**
 * The coordinator is the session Orca still points its handle at; for finished runs the
 * transcript is the only evidence left, and only a coordinator ever sees the run id
 * (workers are addressed by task and dispatch id instead).
 */
function resolveCoordinator(
  run: RawRun, candidates: SessionMention[], live: LiveIdentities,
): OrchestrationMember | null {
  const byHandle = run.coordinatorHandle === null ? undefined : live.byHandle.get(run.coordinatorHandle);
  const byPane = run.coordinatorPaneKey === null ? undefined : live.byPane.get(run.coordinatorPaneKey);
  const firstMention = candidates[0];
  return byHandle ?? byPane ?? (firstMention === undefined ? null : member(firstMention));
}

/** The task each worker session last picked up, so the folded rows say what they were for. */
function workerTaskTitles(run: RawRun, db: OrcaDatabase, excluded: Set<string>): Map<string, string> {
  const titles = new Map<string, string>();
  for (const dispatch of run.dispatches) {
    if (dispatch.taskTitle === null) continue;
    for (const mention of db.findSessionsMentioning([dispatch.taskId])) {
      const key = memberKey(mention);
      if (!excluded.has(key)) titles.set(key, dispatch.taskTitle);
    }
  }
  return titles;
}

function resolveRun(run: RawRun, db: OrcaDatabase, live: LiveIdentities): OrchestrationRun | null {
  const candidates = db.findSessionsMentioning([run.id]);
  const coordinator = resolveCoordinator(run, candidates, live);
  const excluded = new Set(candidates.map((candidate) => memberKey(member(candidate))));
  if (coordinator !== null) excluded.add(memberKey(coordinator));
  const dispatched = db.findSessionsMentioning(run.dispatches.flatMap(({ id, taskId }) => [id, taskId]))
    .map(member)
    .filter((worker) => !excluded.has(memberKey(worker)));
  if (dispatched.length === 0) return null;
  const titles = workerTaskTitles(run, db, excluded);
  return {
    runId: run.id, objective: run.objective, createdAt: run.createdAt, updatedAt: run.updatedAt,
    coordinator,
    workers: dispatched.map((worker) => ({ ...worker, taskTitle: titles.get(memberKey(worker)) ?? null })),
  };
}

export function createOrchestrationReader(options: OrchestrationReaderOptions): OrchestrationReader {
  const path = options.path ?? ORCATAB_ORCHESTRATION_DB;
  const cacheMs = options.cacheMs ?? ORCHESTRATION_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: OrchestrationSnapshot | null = null;
  let cachedAt = Number.NEGATIVE_INFINITY;
  let version = 0;
  let signature = "";

  return {
    getVersion: () => version,
    refresh: () => {
      const startedAt = now();
      if (cached !== null && startedAt - cachedAt < cacheMs) return cached;
      const state = readRawState(path, startedAt);
      const live = liveIdentities(options.getLiveMap());
      const runs = state.runs
        .map((run) => resolveRun(run, options.db, live))
        .filter((run): run is OrchestrationRun => run !== null);
      const snapshot: OrchestrationSnapshot = {
        scannedAt: startedAt, cacheTtlMs: cacheMs, available: state.available, runs, warnings: state.warnings,
      };
      const nextSignature = JSON.stringify({ available: state.available, runs, warnings: state.warnings });
      if (nextSignature !== signature) { signature = nextSignature; version += 1; }
      cached = snapshot;
      cachedAt = startedAt;
      return snapshot;
    },
  };
}
