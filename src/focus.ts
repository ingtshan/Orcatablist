import { ORCATAB_ORCA_BIN } from "./config";
import { getDefaultDatabase, type OrcaDatabase } from "./db";
import { findLive } from "./live";
import type { FocusResult, LiveInfo } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const URI_PREFIX = "orcatab://claude/";

export class ValidationError extends Error { override name = "ValidationError"; }
export class OrcaError extends Error { override name = "OrcaError"; }

export interface OrcaJsonResult { ok: boolean; result?: any; error?: any; }
export interface FocusDeps {
  findLive(sid: string): LiveInfo | null;
  getSessionCwd(sid: string): string | null | undefined;
  psEnv(pid: number): Promise<string>;
  orcaJson(args: string[]): Promise<OrcaJsonResult>;
  openOrca(): Promise<void>;
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

export function createFocusDeps(db: OrcaDatabase = getDefaultDatabase()): FocusDeps {
  return {
    findLive,
    getSessionCwd: (sid) => db.getSession(sid)?.cwd,
    psEnv: async (pid) => (await runText(["ps", "-Eww", "-o", "command=", "-p", String(pid)])).stdout,
    orcaJson: async (args) => {
      try {
        const output = await runText([ORCATAB_ORCA_BIN, ...args]);
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
    if (options.dryRun) return { action: "switched", handle, tabId: envTabId };
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
    return { action: "manual", reason: "not-orca-worktree", command: `cd ${shellQuote(cwd)} && claude --resume ${sid}` };
  }
  if (options.dryRun) return { action: "resumed", handle: "(dry-run)" };
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

if (import.meta.main) {
  try {
    const { sid, dryRun } = parseCliArgs(process.argv.slice(2));
    console.log(JSON.stringify(await resolveFocus(sid, createFocusDeps(), { dryRun })));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
