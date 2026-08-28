import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 47_831;

function readPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : DEFAULT_PORT;
}

export const ORCATAB_PORT = readPort(process.env.ORCATAB_PORT);
export const ORCATAB_CLAUDE_DIR = process.env.ORCATAB_CLAUDE_DIR ?? join(homedir(), ".claude");
export const ORCATAB_CODEX_DIR = process.env.ORCATAB_CODEX_DIR ?? join(homedir(), ".codex");
export const ORCATAB_HERMES_DB = process.env.ORCATAB_HERMES_DB ?? join(homedir(), ".hermes", "state.db");
export const ORCATAB_DATA_DIR = process.env.ORCATAB_DATA_DIR ?? join(homedir(), ".orcatab");
export const ORCATAB_ORCA_BIN = process.env.ORCATAB_ORCA_BIN ?? "orca";
export const ORCATAB_PM2_DUMP = process.env.ORCATAB_PM2_DUMP ?? join(homedir(), ".pm2", "dump.pm2");
export const ORCATAB_NGINX_CONFIG = process.env.ORCATAB_NGINX_CONFIG ?? "";
export const ORCATAB_HOST = "127.0.0.1";
export const AGENTS = ["claude", "codex", "hermes"] as const;

export const RESCAN_INTERVAL_MS = 60_000;
export const FALLBACK_RESCAN_INTERVAL_MS = 10_000;
export const WATCH_DEBOUNCE_MS = 500;
export const LIVE_CACHE_MS = 3_000;
// How long a failed live source keeps serving its last good read before the board drops it.
export const STALE_LIVE_BUDGET_MS = 30_000;
export const HERMES_PROCESS_CACHE_MS = 30_000;
export const RESOURCE_DISCOVERY_CACHE_MS = 15_000;
export const GATEWAY_DISCOVERY_CACHE_MS = 30_000;
export const FTS_TEXT_MAX_CHARS = 8_000;
export const FIRST_PROMPT_MAX_CHARS = 200;
export const DISPLAY_TITLE_MAX_CHARS = 80;
export const SEARCH_MIN_FTS_CHARS = 3;
