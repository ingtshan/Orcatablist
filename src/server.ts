import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ORCATAB_CLAUDE_DIR, ORCATAB_DATA_DIR, ORCATAB_HOST, ORCATAB_ORCA_BIN, ORCATAB_PORT,
} from "./config";
import { OrcaDatabase } from "./db";
import { createFocusDeps, OrcaError, resolveFocus, ValidationError, type FocusDeps } from "./focus";
import { createIndexer, type IndexSummary } from "./indexer";
import { createLiveReader } from "./live";
import { refreshProjectMetadata, startProjectMetadataTimer } from "./projects";
import type { FocusResult, LiveInfo, SearchResult, SessionRow } from "./types";

const DEFAULT_SESSIONS_LIMIT = 500;
const MAX_SESSIONS_LIMIT = 2_000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const URI_PATTERN = /^orcatab:\/\/claude\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface ServerOptions {
  port?: number; claudeDir?: string; dataDir?: string; orcaBin?: string;
  db?: OrcaDatabase; focusDeps?: FocusDeps; startTimers?: boolean; quiet?: boolean;
}

export interface OrcaTabServer {
  server: ReturnType<typeof Bun.serve>; db: OrcaDatabase; indexed: IndexSummary;
  stop(): void;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function boundedLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function mergeLive<T extends SessionRow>(rows: T[], live: Map<string, LiveInfo>): T[] {
  return rows.map((row) => ({ ...row, live: live.get(row.sid) ?? null }));
}

function focusText(result: FocusResult): string {
  if (result.action === "switched") return `switched ${result.handle}`;
  if (result.action === "resumed") return `resumed ${result.handle}`;
  return `manual ${result.reason}${result.command ? ` ${result.command}` : ""}`;
}

function errorResponse(error: unknown, request: Request): Response {
  const status = error instanceof ValidationError ? 400 : error instanceof OrcaError ? 500 : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (status === 500) console.error(`orcatab ${request.method} ${new URL(request.url).pathname}`, error instanceof Error ? error.stack : error);
  return json({ error: message }, status);
}

export async function createServer(options: ServerOptions = {}): Promise<OrcaTabServer> {
  const dataDir = options.dataDir ?? ORCATAB_DATA_DIR;
  const claudeDir = options.claudeDir ?? ORCATAB_CLAUDE_DIR;
  const orcaBin = options.orcaBin ?? ORCATAB_ORCA_BIN;
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  const db = options.db ?? new OrcaDatabase(join(dataDir, "index.db"));
  const indexer = createIndexer({ claudeDir, db });
  const indexed = await indexer.indexAll();
  if (!options.quiet) console.log(`indexed ${indexed.files} sessions in ${indexed.ms} ms`);
  await refreshProjectMetadata(db, orcaBin);
  const liveReader = createLiveReader({ claudeDir });
  const defaultFocusDeps = createFocusDeps(db);
  const focusDeps = options.focusDeps ?? { ...defaultFocusDeps, findLive: liveReader.findLive };
  const timers: Array<ReturnType<typeof setInterval>> = [];
  if (options.startTimers !== false) {
    timers.push(indexer.startRescanTimer(), startProjectMetadataTimer(db, orcaBin));
  }

  const handler = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return new Response(Bun.file(join(import.meta.dir, "..", "public", "index.html")), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        const rawIndexedAt = db.getMeta("indexed_at");
        return json({ ok: true, sessions: db.countSessions(), indexedAt: rawIndexedAt === null ? null : Number(rawIndexedAt), version: "p1" });
      }
      if (request.method === "GET" && url.pathname === "/api/projects") return json(db.listProjects());
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        const limit = boundedLimit(url.searchParams.get("limit"), DEFAULT_SESSIONS_LIMIT, MAX_SESSIONS_LIMIT);
        const projectKey = url.searchParams.get("project") || undefined;
        const liveOnly = url.searchParams.get("live") === "1";
        const rows = mergeLive(db.listSessions({ ...(projectKey ? { projectKey } : {}), limit: liveOnly ? MAX_SESSIONS_LIMIT : limit }), liveReader.getLiveMap());
        return json(liveOnly ? rows.filter((row) => row.live !== null).slice(0, limit) : rows);
      }
      if (request.method === "GET" && url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = boundedLimit(url.searchParams.get("limit"), DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        const rows: SearchResult[] = q.trim() ? mergeLive(db.search(q, limit), liveReader.getLiveMap()) : [];
        return json(rows);
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/focus/")) {
        const sid = decodeURIComponent(url.pathname.slice("/api/focus/".length));
        return json(await resolveFocus(sid, focusDeps, { dryRun: false }));
      }
      if (request.method === "GET" && url.pathname === "/focus") {
        const match = URI_PATTERN.exec(url.searchParams.get("uri") ?? "");
        if (!match) throw new ValidationError("invalid orcatab uri");
        const result = await resolveFocus(match[1]!, focusDeps, { dryRun: false });
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
    server, db, indexed,
    stop: () => { for (const timer of timers) clearInterval(timer); server.stop(true); db.close(); },
  };
}

// Process entry lives in src/main.ts (no top-level await: pm2 loads scripts with require()).
