import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ValidationError } from "./focus";
import { isEnvName, LOCAL_ENV } from "./session-identity";

const ENVIRONMENTS_SCHEMA_VERSION = "1";

/**
 * GUI-writable connection config lives apart from the rebuildable index database, following the
 * project-preferences discipline: dropping index.db must never lose a saved machine.
 */
const ENVIRONMENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS environments (
  name TEXT PRIMARY KEY,
  ssh_user TEXT NOT NULL,
  ssh_host TEXT NOT NULL,
  ssh_port INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  agents TEXT NOT NULL DEFAULT '{"claude":true}',
  poll_ms INTEGER NOT NULL DEFAULT 15000,
  updated_at INTEGER NOT NULL
);`;

export const DEFAULT_POLL_MS = 15_000;
export const MIN_POLL_MS = 5_000;
export const MAX_POLL_MS = 10 * 60_000;

/**
 * ssh runs with a fixed option set and the destination after `--`, so the only injection surface
 * left is the destination itself. Users, hosts and aliases never legitimately start with `-` or
 * contain whitespace/shell metacharacters; anything fancier belongs in an ~/.ssh/config alias.
 */
const SSH_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,253}$/;

export interface EnvironmentAgents { claude?: boolean; codex?: { sinceDays?: number } | boolean; }
export interface EnvironmentConfig {
  name: string;
  sshUser: string;
  sshHost: string;
  sshPort: number | null;
  enabled: boolean;
  agents: EnvironmentAgents;
  pollMs: number;
  updatedAt: number;
}
export interface EnvironmentPatch {
  name: unknown; sshUser: unknown; sshHost: unknown; sshPort?: unknown;
  enabled?: unknown; agents?: unknown; pollMs?: unknown;
}

export function validateEnvironmentName(value: unknown): string {
  if (!isEnvName(value)) throw new ValidationError("environment name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}");
  if (value === LOCAL_ENV) throw new ValidationError(`"${LOCAL_ENV}" is reserved for this machine`);
  return value;
}

function validateSshUser(value: unknown): string {
  if (typeof value !== "string" || !SSH_USER_PATTERN.test(value)) {
    throw new ValidationError("sshUser must be a plain user name (letters, digits, . _ -)");
  }
  return value;
}

function validateSshHost(value: unknown): string {
  if (typeof value !== "string" || !SSH_HOST_PATTERN.test(value)) {
    throw new ValidationError("sshHost must be a host name, IP, or ~/.ssh/config alias (letters, digits, . _ -)");
  }
  return value;
}

function validateSshPort(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const port = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ValidationError("sshPort must be an integer between 1 and 65535");
  }
  return port;
}

function validatePollMs(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_POLL_MS;
  const pollMs = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (typeof pollMs !== "number" || !Number.isInteger(pollMs) || pollMs < MIN_POLL_MS || pollMs > MAX_POLL_MS) {
    throw new ValidationError(`pollMs must be an integer between ${MIN_POLL_MS} and ${MAX_POLL_MS}`);
  }
  return pollMs;
}

function validateAgents(value: unknown): EnvironmentAgents {
  if (value === undefined || value === null) return { claude: true };
  if (typeof value !== "object" || Array.isArray(value)) throw new ValidationError("agents must be an object");
  const raw = value as Record<string, unknown>;
  const agents: EnvironmentAgents = {};
  if (raw.claude !== undefined) {
    if (typeof raw.claude !== "boolean") throw new ValidationError("agents.claude must be a boolean");
    agents.claude = raw.claude;
  }
  if (raw.codex !== undefined) {
    // Accepted and stored for M3; the M1 poller only reads agents.claude.
    if (typeof raw.codex === "boolean") agents.codex = raw.codex;
    else if (typeof raw.codex === "object" && raw.codex !== null && !Array.isArray(raw.codex)) {
      const sinceDays = (raw.codex as Record<string, unknown>).sinceDays;
      if (sinceDays !== undefined && (typeof sinceDays !== "number" || !Number.isInteger(sinceDays) || sinceDays < 1)) {
        throw new ValidationError("agents.codex.sinceDays must be a positive integer");
      }
      agents.codex = sinceDays === undefined ? {} : { sinceDays: sinceDays as number };
    } else throw new ValidationError("agents.codex must be a boolean or { sinceDays }");
  }
  return agents.claude === undefined && agents.codex === undefined ? { claude: true } : agents;
}

export function validateEnvironmentPatch(body: EnvironmentPatch): Omit<EnvironmentConfig, "updatedAt"> {
  return {
    name: validateEnvironmentName(body.name),
    sshUser: validateSshUser(body.sshUser),
    sshHost: validateSshHost(body.sshHost),
    sshPort: validateSshPort(body.sshPort),
    enabled: body.enabled === undefined ? false : Boolean(body.enabled),
    agents: validateAgents(body.agents),
    pollMs: validatePollMs(body.pollMs),
  };
}

export function sshDestination(config: Pick<EnvironmentConfig, "sshUser" | "sshHost">): string {
  return `${config.sshUser}@${config.sshHost}`;
}

export function openEnvironmentsDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  database.exec("PRAGMA busy_timeout=5000;");
  database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  database.exec(ENVIRONMENTS_SCHEMA_SQL);
  database.query(`INSERT INTO meta(key, value) SELECT 'environments_schema_version', ?
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'environments_schema_version')`).run(ENVIRONMENTS_SCHEMA_VERSION);
  database.exec(`INSERT INTO meta(key, value) SELECT 'environments_version', '0'
    WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key = 'environments_version');`);
  return database;
}

function configFromRow(row: Record<string, unknown>): EnvironmentConfig {
  let agents: EnvironmentAgents = { claude: true };
  try {
    const parsed = JSON.parse(String(row.agents)) as unknown;
    agents = validateAgents(parsed);
  } catch { /* keep the safe default when a hand-edited row is malformed */ }
  return {
    name: String(row.name),
    sshUser: String(row.ssh_user),
    sshHost: String(row.ssh_host),
    sshPort: row.ssh_port === null || row.ssh_port === undefined ? null : Number(row.ssh_port),
    enabled: Number(row.enabled) === 1,
    agents,
    pollMs: Number(row.poll_ms),
    updatedAt: Number(row.updated_at),
  };
}

export class EnvironmentStore {
  constructor(private readonly database: Database, private readonly now: () => number = Date.now) {}

  close(): void { this.database.close(); }

  get version(): number {
    const row = this.database.query("SELECT value FROM meta WHERE key = 'environments_version'")
      .get() as { value: string } | null;
    const parsed = Number.parseInt(row?.value ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private bumpVersion(): void {
    this.database.query(`INSERT INTO meta(key, value) VALUES ('environments_version', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)`).run();
  }

  list(): EnvironmentConfig[] {
    const rows = this.database.query("SELECT * FROM environments ORDER BY name").all() as Record<string, unknown>[];
    return rows.map(configFromRow);
  }

  listEnabled(): EnvironmentConfig[] {
    return this.list().filter((config) => config.enabled);
  }

  get(name: string): EnvironmentConfig | null {
    const row = this.database.query("SELECT * FROM environments WHERE name = ?").get(name) as Record<string, unknown> | null;
    return row === null ? null : configFromRow(row);
  }

  upsert(config: Omit<EnvironmentConfig, "updatedAt">): EnvironmentConfig {
    const updatedAt = this.now();
    this.database.query(`INSERT INTO environments(name, ssh_user, ssh_host, ssh_port, enabled, agents, poll_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET ssh_user=excluded.ssh_user, ssh_host=excluded.ssh_host,
      ssh_port=excluded.ssh_port, enabled=excluded.enabled, agents=excluded.agents,
      poll_ms=excluded.poll_ms, updated_at=excluded.updated_at`)
      .run(config.name, config.sshUser, config.sshHost, config.sshPort, config.enabled ? 1 : 0,
        JSON.stringify(config.agents), config.pollMs, updatedAt);
    this.bumpVersion();
    return { ...config, updatedAt };
  }

  remove(name: string): boolean {
    const result = this.database.query("DELETE FROM environments WHERE name = ?").run(name);
    if (result.changes > 0) this.bumpVersion();
    return result.changes > 0;
  }
}
