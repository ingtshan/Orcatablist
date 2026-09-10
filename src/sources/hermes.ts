import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { FTS_TEXT_MAX_CHARS } from "../config";
import type { FtsRow, StoredSession } from "../db";
import { cleanPromptForDisplay } from "../parse";
import { briefHash, type BriefEvent } from "../session-brief-events";
import { EXECUTION_METADATA_VERSION, hermesExecutionSettings, type SessionExecution } from "../session-execution";
import {
  errorText, sourceIssue,
  type DiscoveryResult, type SessionFileInfo, type SessionSource, type SessionUpdate,
} from "../session-source";

const BUSY_TIMEOUT_MS = 5_000;
const INJECTED_USER_PREFIXES = ["[System:", "[System ", "[CONTEXT COMPACTION", "<system-reminder"];

interface HermesMeta extends SessionExecution {
  title: string | null;
  displayName: string | null;
  cwd: string | null;
  gitBranch: string | null;
}

interface HermesSessionRow {
  id: string;
  title: string | null;
  display_name: string | null;
  cwd: string | null;
  git_branch: string | null;
  started_at: number | null;
  message_count: number | null;
  max_ts: number | null;
  user_msgs: number | null;
  model: string | null;
  model_config: string | null;
}

interface HermesMessageRow {
  id: number;
  role: string;
  content: string;
  timestamp: number | null;
}

function openReadOnly(dbPath: string): Database {
  let database: Database | null = null;
  try {
    database = new Database(dbPath, { readonly: true });
    database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
    return database;
  } catch (error) {
    database?.close();
    throw new Error(`failed to open Hermes database ${dbPath}: ${errorText(error)}`);
  }
}

function cleanTitle(value: string | null): string | null {
  const title = value?.trim() ?? "";
  return title || null;
}

function titleFromMeta(meta: HermesMeta): string | null {
  return cleanTitle(meta.title) ?? cleanTitle(meta.displayName);
}

function isInjectedUserMessage(content: string): boolean {
  const trimmed = content.trim();
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function milliseconds(seconds: number | null): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? Math.round(seconds * 1_000) : null;
}

function metaFromRow(row: Pick<HermesSessionRow, "title" | "display_name" | "cwd" | "git_branch" | "model" | "model_config">): HermesMeta {
  return { title: row.title, displayName: row.display_name, cwd: row.cwd, gitBranch: row.git_branch,
    model: null, reasoningEffort: null, ...hermesExecutionSettings(row.model, row.model_config) };
}

/** The whole ledger is re-derived on every change, so its transcript is always replaced wholesale. */
function deriveFromRows(
  info: SessionFileInfo,
  meta: HermesMeta,
  rows: HermesMessageRow[],
): SessionUpdate {
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let lastInputAt: number | null = null;
  let promptCount = 0;
  const fts: FtsRow[] = [];
  const briefEvents: BriefEvent[] = [];

  for (const row of rows) {
    const ts = milliseconds(row.timestamp);
    if (row.role === "user") {
      if (isInjectedUserMessage(row.content)) continue;
      briefEvents.push({ kind: "user", key: briefHash([row.id, row.content]), at: ts, text: row.content });
      const cleaned = cleanPromptForDisplay(row.content);
      promptCount += 1;
      firstPrompt ??= cleaned || null;
      if (cleaned) lastPrompt = cleaned;
      if (ts !== null) lastInputAt = Math.max(lastInputAt ?? ts, ts);
      fts.push({ text: row.content, agent: "hermes", sid: info.sid, role: "user", ts });
      continue;
    }
    if (row.role === "assistant") {
      briefEvents.push({ kind: "assistant", key: briefHash([row.id, row.content]), at: ts, text: row.content });
      fts.push({ text: row.content.slice(0, FTS_TEXT_MAX_CHARS), agent: "hermes", sid: info.sid, role: "assistant", ts });
    }
  }

  const session: StoredSession = {
    agent: "hermes", sid: info.sid, projectKey: "unknown", cwd: meta.cwd || null, worktreeRoot: null,
    branch: meta.gitBranch || null, title: titleFromMeta(meta), firstPrompt, lastPrompt,
    lastInputAt, promptCount, filePath: info.path, fileSize: info.size,
    fileMtime: info.mtime, parsedOffset: 0,
    model: meta.model ?? null, reasoningEffort: meta.reasoningEffort ?? null, executionMetadataVersion: EXECUTION_METADATA_VERSION,
  };
  return { session, fts, briefEvents, replaceFts: true };
}

export function createHermesSource(dbPath: string): SessionSource {
  let database: Database | null = null;
  let executionColumns = "NULL AS model, NULL AS model_config";
  const metadata = new Map<string, HermesMeta>();

  const getDatabase = (): Database | null => {
    if (database !== null) return database;
    if (!existsSync(dbPath)) return null;
    database = openReadOnly(dbPath);
    const columns = new Set((database.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name));
    executionColumns = ["model", "model_config"].map((name) => `${columns.has(name) ? `s.${name}` : "NULL"} AS ${name}`).join(", ");
    return database;
  };

  return {
    agent: "hermes",
    discover: (): DiscoveryResult => {
      let db: Database | null;
      try {
        db = getDatabase();
      } catch (error) {
        return { files: [], errors: [sourceIssue("discover", "hermes", errorText(error), { path: dbPath })] };
      }
      // No ledger at all is the normal state on a machine that never ran Hermes.
      if (db === null) return { files: [], errors: [] };
      let rows: HermesSessionRow[];
      try {
        rows = db.query(`SELECT s.id, s.title, s.display_name, s.cwd, s.git_branch, s.started_at, ${executionColumns},
          s.message_count, COALESCE(MAX(m.timestamp), s.started_at) AS max_ts,
          SUM(CASE WHEN m.role='user' AND m.active=1 AND m.content IS NOT NULL AND m.content!='' THEN 1 ELSE 0 END) AS user_msgs
          FROM sessions s LEFT JOIN messages m ON m.session_id=s.id
          GROUP BY s.id`).all() as HermesSessionRow[];
      } catch (error) {
        return {
          files: [],
          errors: [sourceIssue("discover", "hermes",
            `failed to discover Hermes sessions from ${dbPath}: ${errorText(error)}`, { path: dbPath })],
        };
      }
      metadata.clear();
      const files = rows.flatMap((row): SessionFileInfo[] => {
        const meta = metaFromRow(row);
        if (Number(row.user_msgs ?? 0) <= 0 && titleFromMeta(meta) === null) return [];
        metadata.set(row.id, meta);
        const maxTimestamp = milliseconds(row.max_ts) ?? 0;
        return [{
          agent: "hermes" as const, sid: row.id, path: dbPath,
          size: Math.max(0, Math.trunc(Number(row.message_count ?? 0))), mtime: maxTimestamp,
        }];
      });
      return { files, errors: [] };
    },
    index: (info, stored) => {
      const cachedMeta = metadata.get(info.sid);
      if (stored !== null && stored.filePath === info.path
        && stored.fileSize === info.size && stored.fileMtime === info.mtime && stored.executionMetadataVersion !== 0
        && cachedMeta !== undefined && (stored.model ?? null) === cachedMeta.model
        && (stored.reasoningEffort ?? null) === cachedMeta.reasoningEffort) return null;
      const db = getDatabase();
      if (db === null) throw new Error(`Hermes database disappeared before deriving ${info.sid}: ${dbPath}`);
      let meta = metadata.get(info.sid);
      try {
        if (meta === undefined) {
          const row = db.query(`SELECT title, display_name, cwd, git_branch, ${executionColumns} FROM sessions s WHERE id=?`).get(info.sid) as
            Pick<HermesSessionRow, "title" | "display_name" | "cwd" | "git_branch" | "model" | "model_config"> | null;
          if (row === null) throw new Error("session metadata not found");
          meta = metaFromRow(row);
        }
        const rows = db.query(`SELECT id, role, content, timestamp FROM messages
          WHERE session_id=? AND active=1 AND content IS NOT NULL AND content!=''
          ORDER BY timestamp, id`).all(info.sid) as HermesMessageRow[];
        return deriveFromRows(info, meta, rows);
      } catch (error) {
        throw new Error(`failed to derive Hermes session ${info.sid} from ${dbPath}: ${errorText(error)}`);
      }
    },
  };
}

export function findHermesSessionCwd(sid: string, dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const database = openReadOnly(dbPath);
  try {
    const row = database.query("SELECT cwd FROM sessions WHERE id=?").get(sid) as { cwd: string | null } | null;
    return typeof row?.cwd === "string" && row.cwd ? row.cwd : null;
  } catch (error) {
    throw new Error(`failed to find Hermes session ${sid} in ${dbPath}: ${errorText(error)}`);
  } finally {
    database.close();
  }
}
