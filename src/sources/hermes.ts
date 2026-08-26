import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { FTS_TEXT_MAX_CHARS } from "../config";
import type { FtsRow, StoredSession } from "../db";
import type { DerivedSession, SessionFileInfo, SessionSource } from "../indexer";
import { cleanPromptForDisplay } from "../parse";

const BUSY_TIMEOUT_MS = 5_000;
const INJECTED_USER_PREFIXES = ["[System:", "[System ", "[CONTEXT COMPACTION", "<system-reminder"];

interface HermesMeta {
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
}

interface HermesMessageRow {
  role: string;
  content: string;
  timestamp: number | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function metaFromRow(row: Pick<HermesSessionRow, "title" | "display_name" | "cwd" | "git_branch">): HermesMeta {
  return { title: row.title, displayName: row.display_name, cwd: row.cwd, gitBranch: row.git_branch };
}

function deriveFromRows(
  info: SessionFileInfo,
  meta: HermesMeta,
  rows: HermesMessageRow[],
): DerivedSession {
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let lastInputAt: number | null = null;
  let promptCount = 0;
  const fts: FtsRow[] = [];

  for (const row of rows) {
    const ts = milliseconds(row.timestamp);
    if (row.role === "user") {
      if (isInjectedUserMessage(row.content)) continue;
      const cleaned = cleanPromptForDisplay(row.content);
      promptCount += 1;
      firstPrompt ??= cleaned || null;
      if (cleaned) lastPrompt = cleaned;
      if (ts !== null) lastInputAt = Math.max(lastInputAt ?? ts, ts);
      fts.push({ text: row.content.slice(0, FTS_TEXT_MAX_CHARS), agent: "hermes", sid: info.sid, role: "user", ts });
      continue;
    }
    if (row.role === "assistant") {
      fts.push({ text: row.content.slice(0, FTS_TEXT_MAX_CHARS), agent: "hermes", sid: info.sid, role: "assistant", ts });
    }
  }

  const session: StoredSession = {
    agent: "hermes", sid: info.sid, projectKey: "unknown", cwd: meta.cwd || null,
    branch: meta.gitBranch || null, title: titleFromMeta(meta), firstPrompt, lastPrompt,
    lastInputAt, promptCount, filePath: info.path, fileSize: info.size,
    fileMtime: info.mtime, parsedOffset: 0,
  };
  return { session, fts };
}

export function createHermesSource(dbPath: string): SessionSource {
  let database: Database | null = null;
  const metadata = new Map<string, HermesMeta>();

  const getDatabase = (): Database | null => {
    if (database !== null) return database;
    if (!existsSync(dbPath)) return null;
    database = openReadOnly(dbPath);
    return database;
  };

  return {
    agent: "hermes",
    discover: () => {
      const db = getDatabase();
      if (db === null) return [];
      let rows: HermesSessionRow[];
      try {
        rows = db.query(`SELECT s.id, s.title, s.display_name, s.cwd, s.git_branch, s.started_at,
          s.message_count, COALESCE(MAX(m.timestamp), s.started_at) AS max_ts,
          SUM(CASE WHEN m.role='user' AND m.active=1 AND m.content IS NOT NULL AND m.content!='' THEN 1 ELSE 0 END) AS user_msgs
          FROM sessions s LEFT JOIN messages m ON m.session_id=s.id
          GROUP BY s.id`).all() as HermesSessionRow[];
      } catch (error) {
        throw new Error(`failed to discover Hermes sessions from ${dbPath}: ${errorText(error)}`);
      }
      metadata.clear();
      return rows.flatMap((row) => {
        const meta = metaFromRow(row);
        if (Number(row.user_msgs ?? 0) <= 0 && titleFromMeta(meta) === null) return [];
        metadata.set(row.id, meta);
        const maxTimestamp = milliseconds(row.max_ts) ?? 0;
        return [{
          agent: "hermes" as const, sid: row.id, path: dbPath,
          size: Math.max(0, Math.trunc(Number(row.message_count ?? 0))), mtime: maxTimestamp,
        }];
      });
    },
    parseLine: () => { throw new Error("Hermes source derives sessions from SQLite, not lines"); },
    deriveSession: (info) => {
      const db = getDatabase();
      if (db === null) throw new Error(`Hermes database disappeared before deriving ${info.sid}: ${dbPath}`);
      let meta = metadata.get(info.sid);
      try {
        if (meta === undefined) {
          const row = db.query("SELECT title, display_name, cwd, git_branch FROM sessions WHERE id=?").get(info.sid) as
            Pick<HermesSessionRow, "title" | "display_name" | "cwd" | "git_branch"> | null;
          if (row === null) throw new Error("session metadata not found");
          meta = metaFromRow(row);
        }
        const rows = db.query(`SELECT role, content, timestamp FROM messages
          WHERE session_id=? AND active=1 AND content IS NOT NULL AND content!=''
          ORDER BY timestamp`).all(info.sid) as HermesMessageRow[];
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
