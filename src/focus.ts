import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ORCATAB_CLAUDE_DIR, ORCATAB_DATA_DIR, ORCATAB_ORCA_BIN } from "./config";
import { getDefaultDatabase, openDatabaseReadOnly, type OrcaDatabase } from "./db";
import { findLive } from "./live";
import type { FocusResult, LiveInfo } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const URI_PREFIX = "orcatab://claude/";
const CLI_SCAN_MAX_BYTES = 256 * 1_024;

export class ValidationError extends Error { override name = "ValidationError"; }
export class OrcaError extends Error { override name = "OrcaError"; }

export interface OrcaJsonResult { ok: boolean; result?: any; error?: any; }
export interface FocusDeps {
  findLive(sid: string): LiveInfo | null;
  getSessionCwd(sid: string): string | null | undefined;
  psEnv(pid: number): Promise<string>;
  orcaJson(args: string[]): Promise<OrcaJsonResult>;
  openOrca(): Promise<void>;
  reportPlan?(plan: string[]): void;
}

export interface FocusDepsOptions {
  claudeDir?: string;
  orcaBin?: string;
  liveFinder?: FocusDeps["findLive"];
  reportPlan?: FocusDeps["reportPlan"];
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); }
  catch { return String(error); }
}

async function runText(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export function findSessionCwdInClaudeDir(sid: string, claudeDir = ORCATAB_CLAUDE_DIR): string | null {
  const projectsDir = join(claudeDir, "projects");
  let entries;
  try { entries = readdirSync(projectsDir, { withFileTypes: true }); }
  catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(projectsDir, entry.name, `${sid}.jsonl`);
    if (!existsSync(path)) continue;
    const buffer = Buffer.allocUnsafe(CLI_SCAN_MAX_BYTES);
    let bytesRead: number;
    try {
      const descriptor = openSync(path, "r");
      try { bytesRead = readSync(descriptor, buffer, 0, CLI_SCAN_MAX_BYTES, 0); }
      finally { closeSync(descriptor); }
    } catch { continue; }
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const value = JSON.parse(line) as { cwd?: unknown };
        if (typeof value.cwd === "string") return value.cwd;
      } catch { continue; }
    }
  }
  return null;
}

export function createFocusDeps(
  db: OrcaDatabase | null = getDefaultDatabase(),
  options: FocusDepsOptions = {},
): FocusDeps {
  const claudeDir = options.claudeDir ?? ORCATAB_CLAUDE_DIR;
  const orcaBin = options.orcaBin ?? ORCATAB_ORCA_BIN;
  return {
    findLive: options.liveFinder ?? findLive,
    getSessionCwd: (sid) => {
      try {
        const cwd = db?.getSession(sid)?.cwd;
        if (cwd) return cwd;
      } catch { /* A missing or incompatible cache falls back to the source JSONL. */ }
      return findSessionCwdInClaudeDir(sid, claudeDir);
    },
    psEnv: async (pid) => (await runText(["ps", "-Eww", "-o", "command=", "-p", String(pid)])).stdout,
    orcaJson: async (args) => {
      try {
        const output = await runText([orcaBin, ...args]);
        const text = output.stdout.trim() || output.stderr.trim();
        const parsed: OrcaJsonResult = text ? JSON.parse(text) as OrcaJsonResult : { ok: output.exitCode === 0 };
        return { ...parsed, ok: output.exitCode === 0 && parsed.ok !== false };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    openOrca: async () => {
      try { await runText(["open", "-a", "Orca"]); }
      catch { /* Focus can still succeed when Orca is already running. */ }
    },
    ...(options.reportPlan ? { reportPlan: options.reportPlan } : {}),
  };
}

function envValue(command: string, name: string): string | null {
  const prefix = `${name}=`;
  return command.split(/\s+/).find((part) => part.startsWith(prefix))?.slice(prefix.length) || null;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function resolveFocus(
  sid: string,
  deps: FocusDeps = createFocusDeps(),
  options: { dryRun: boolean } = { dryRun: false },
): Promise<FocusResult> {
  if (!UUID_PATTERN.test(sid)) throw new ValidationError("invalid session id");
  const live = deps.findLive(sid);
  if (live !== null) {
    const environment = await deps.psEnv(live.pid);
    const handle = envValue(environment, "ORCA_TERMINAL_HANDLE");
    const envTabId = envValue(environment, "ORCA_TAB_ID");
    if (handle === null) return { action: "manual", reason: "running-outside-orca", command: null };
    if (options.dryRun) {
      deps.reportPlan?.(["orca", "terminal", "switch", "--terminal", handle, "--json"]);
      return { action: "switched", handle, tabId: envTabId };
    }
    await deps.openOrca();
    const switched = await deps.orcaJson(["terminal", "switch", "--terminal", handle, "--json"]);
    if (!switched.ok) throw new OrcaError(`orca terminal switch failed: ${errorText(switched.error)}`);
    const tabId = switched.result?.focus?.tabId ?? envTabId ?? null;
    return { action: "switched", handle, tabId };
  }

  const cwd = deps.getSessionCwd(sid);
  if (!cwd) return { action: "manual", reason: "unknown-session", command: null };
  const worktree = await deps.orcaJson(["worktree", "show", "--worktree", `path:${cwd}`, "--json"]);
  if (!worktree.ok) {
    if (options.dryRun) deps.reportPlan?.(["claude", "--resume", sid]);
    return { action: "manual", reason: "not-orca-worktree", command: `cd ${shellQuote(cwd)} && claude --resume ${sid}` };
  }
  if (options.dryRun) {
    deps.reportPlan?.([
      "orca", "terminal", "create", "--worktree", `path:${cwd}`, "--title", "claude --resume",
      "--command", `claude --resume ${sid}`, "--json",
    ]);
    return { action: "resumed", handle: "(dry-run)" };
  }
  const created = await deps.orcaJson([
    "terminal", "create", "--worktree", `path:${cwd}`, "--title", "claude --resume",
    "--command", `claude --resume ${sid}`, "--json",
  ]);
  if (!created.ok) throw new OrcaError(`orca terminal create failed: ${errorText(created.error)}`);
  const handle = created.result?.terminal?.handle ?? created.result?.handle ?? created.result?.startupTerminal?.handle;
  if (typeof handle !== "string" || !handle) throw new OrcaError("orca terminal create returned no handle");
  const switched = await deps.orcaJson(["terminal", "switch", "--terminal", handle, "--json"]);
  if (!switched.ok) throw new OrcaError(`orca terminal switch failed: ${errorText(switched.error)}`);
  return { action: "resumed", handle };
}

function parseCliArgs(args: string[]): { sid: string; dryRun: boolean } {
  const dryRun = args.includes("--dry-run");
  const input = args.find((arg) => arg !== "--dry-run");
  if (!input) throw new ValidationError("usage: bun src/focus.ts [--dry-run] <sid | orcatab://claude/<sid>>");
  return { sid: input.startsWith(URI_PREFIX) ? input.slice(URI_PREFIX.length) : input, dryRun };
}

async function runCli(args: string[]): Promise<void> {
  let database: OrcaDatabase | null = null;
  try {
    const { sid, dryRun } = parseCliArgs(args);
    database = openDatabaseReadOnly(join(ORCATAB_DATA_DIR, "index.db"));
    const deps = createFocusDeps(database, {
      claudeDir: ORCATAB_CLAUDE_DIR,
      reportPlan: (plan) => console.error(JSON.stringify({ plan })),
    });
    console.log(JSON.stringify(await resolveFocus(sid, deps, { dryRun })));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}

// No top-level await: this module is imported by server.ts, which pm2 loads with require().
if (import.meta.main) void runCli(process.argv.slice(2));
