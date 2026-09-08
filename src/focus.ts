import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  AGENTS, ORCATAB_CLAUDE_DIR, ORCATAB_CODEX_DIR, ORCATAB_DATA_DIR, ORCATAB_HERMES_DB, ORCATAB_ORCA_BIN,
} from "./config";
import { getDefaultDatabase, openDatabaseReadOnly, type OrcaDatabase } from "./db";
import { createLiveReader } from "./live";
import { activateRuntimeTab } from "./orca-tabs";
import { createSessionLiveReader } from "./session-live";
import { findCodexSessionCwd } from "./sources/codex";
import { findHermesSessionCwd } from "./sources/hermes";
import { isAgent, isSessionId, isSessionUri, LOCAL_ENV, parseSessionUri } from "./session-identity";
import type { Agent, FocusResult, LiveInfo } from "./types";

const CLI_SCAN_MAX_BYTES = 256 * 1_024;

export class ValidationError extends Error { override name = "ValidationError"; }
export class OrcaError extends Error { override name = "OrcaError"; }

export interface OrcaJsonResult { ok: boolean; result?: any; error?: any; }
export interface FocusDeps {
  findLive(agent: Agent, sid: string, env?: string): LiveInfo | null | Promise<LiveInfo | null>;
  getSessionCwd(agent: Agent, sid: string, env?: string): string | null | undefined;
  psEnv(pid: number): Promise<string>;
  orcaJson(args: string[]): Promise<OrcaJsonResult>;
  openOrca(): Promise<void>;
  /** `ssh [-p port] user@host` for a configured environment, or null when it is unknown. */
  remoteSshPrefix?(env: string): string | null;
  /** Notifies remote renderers to activate the workspace and follow its target tab. */
  activateRemoteTab?(env: string, worktree: string, tabId: string): Promise<void>;
  reportPlan?(plan: string[]): void;
}

export interface FocusDepsOptions {
  claudeDir?: string;
  codexDir?: string;
  hermesDb?: string;
  orcaBin?: string;
  liveFinder?: FocusDeps["findLive"];
  remoteSshPrefix?: FocusDeps["remoteSshPrefix"];
  activateRemoteTab?: FocusDeps["activateRemoteTab"];
  reportPlan?: FocusDeps["reportPlan"];
}

export function errorText(error: unknown): string {
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
  const codexDir = options.codexDir ?? ORCATAB_CODEX_DIR;
  const hermesDb = options.hermesDb ?? ORCATAB_HERMES_DB;
  const orcaBin = options.orcaBin ?? ORCATAB_ORCA_BIN;
  const sessionLiveReader = options.liveFinder ? null : createSessionLiveReader({
    orcaBin, getClaudeLiveMap: createLiveReader({ claudeDir }).getLiveMap,
  });
  return {
    findLive: options.liveFinder ?? sessionLiveReader!.findLive,
    getSessionCwd: (agent, sid, env) => {
      try {
        const session = db?.getSession(agent, sid, env);
        const cwd = session?.worktreeRoot || session?.cwd;
        if (cwd) return cwd;
      } catch { /* A missing or incompatible cache falls back to the source JSONL. */ }
      // The JSONL fallbacks scan this machine's directories; a remote session's files are not here.
      if (env !== undefined && env !== LOCAL_ENV) return null;
      if (agent === "hermes") return findHermesSessionCwd(sid, hermesDb);
      return agent === "codex" ? findCodexSessionCwd(sid, codexDir) : findSessionCwdInClaudeDir(sid, claudeDir);
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
    ...(options.remoteSshPrefix ? { remoteSshPrefix: options.remoteSshPrefix } : {}),
    activateRemoteTab: options.activateRemoteTab
      ?? ((env, worktree, tabId) => activateRuntimeTab(env, worktree, tabId, orcaBin)),
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

/** Orca terminal a live session is attached to. `handle` is null when it runs outside Orca. */
export interface TerminalTarget { handle: string | null; tabId: string | null; }

export async function resolveTerminalTarget(
  live: LiveInfo,
  deps: Pick<FocusDeps, "psEnv">,
): Promise<TerminalTarget> {
  const tabId = live.tabId ?? null;
  if (live.handle) return { handle: live.handle, tabId };
  if (live.pid === null) return { handle: null, tabId };
  const environment = await deps.psEnv(live.pid);
  return {
    handle: envValue(environment, "ORCA_TERMINAL_HANDLE"),
    tabId: envValue(environment, "ORCA_TAB_ID") ?? tabId,
  };
}

function remoteResumeCommand(agent: Agent, sid: string, cwd: string | null | undefined): string {
  const resume = agent === "codex" ? `codex resume ${sid}`
    : agent === "hermes" ? `hermes --resume ${sid}` : `claude --resume ${sid}`;
  return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

export async function resolveFocus(
  agent: Agent,
  sid: string,
  deps: FocusDeps = createFocusDeps(),
  options: { dryRun: boolean; env?: string } = { dryRun: false },
): Promise<FocusResult> {
  if (!AGENTS.some((candidate) => candidate === agent)) throw new ValidationError("invalid agent");
  if (!isSessionId(sid)) throw new ValidationError("invalid session id");
  const env = options.env !== undefined && options.env !== LOCAL_ENV ? options.env : undefined;
  const envArgs = env === undefined ? [] : ["--environment", env];
  const live = await deps.findLive(agent, sid, env);
  if (live !== null) {
    const target = await resolveTerminalTarget(live, deps);
    const handle = target.handle;
    let tabId = target.tabId;
    if (handle === null) return { action: "manual", reason: "running-outside-orca", command: null };
    if (options.dryRun) {
      deps.reportPlan?.(["orca", "terminal", "switch", "--terminal", handle, ...envArgs, "--json"]);
      return { action: "switched", handle, tabId };
    }
    await deps.openOrca();
    if (env !== undefined && live.worktree && tabId && deps.activateRemoteTab) {
      // The remote renderer owns both workspace and tab selection. The activator broadcasts the
      // matching client events; a caller-only session-tabs mutation changes state without moving UI.
      await deps.activateRemoteTab(env, live.worktree, tabId);
      return { action: "switched", handle, tabId };
    }
    const switched = await deps.orcaJson(["terminal", "switch", "--terminal", handle, ...envArgs, "--json"]);
    if (!switched.ok) throw new OrcaError(`orca terminal switch failed: ${errorText(switched.error)}`);
    tabId = switched.result?.focus?.tabId ?? tabId;
    return { action: "switched", handle, tabId };
  }
  if (env !== undefined) {
    // Resuming a dead session would spawn a process on the remote machine from a dashboard
    // click; hand back the ssh command instead and let the user run it deliberately.
    const cwd = deps.getSessionCwd(agent, sid, env);
    const prefix = deps.remoteSshPrefix?.(env) ?? null;
    return {
      action: "manual", reason: "remote-environment",
      message: `会话在远程环境 ${env} 上且当前不在线，可以用命令通过 ssh 恢复：`,
      command: prefix === null ? null : `${prefix} -t ${shellQuote(remoteResumeCommand(agent, sid, cwd))}`,
    };
  }
  if (agent === "hermes") {
    const cwd = deps.getSessionCwd(agent, sid);
    if (!cwd) return { action: "manual", reason: "unknown-session", command: null };
    const worktree = await deps.orcaJson(["worktree", "show", "--worktree", `path:${cwd}`, "--json"]);
    if (!worktree.ok) {
      return {
        action: "manual", reason: "not-orca-worktree",
        command: `cd ${shellQuote(cwd)} && hermes --resume ${sid}`,
      };
    }
    if (options.dryRun) {
      deps.reportPlan?.(["hermes", "--resume", sid]);
      return { action: "resumed", handle: "(dry-run)" };
    }
    const created = await deps.orcaJson([
      "terminal", "create", "--worktree", `path:${cwd}`, "--title", "hermes resume",
      "--command", `hermes --resume ${sid}`, "--json",
    ]);
    if (!created.ok) throw new OrcaError(`orca terminal create failed: ${errorText(created.error)}`);
    const handle = created.result?.terminal?.handle ?? created.result?.handle ?? created.result?.startupTerminal?.handle;
    if (typeof handle !== "string" || !handle) throw new OrcaError("orca terminal create returned no handle");
    const switched = await deps.orcaJson(["terminal", "switch", "--terminal", handle, "--json"]);
    if (!switched.ok) throw new OrcaError(`orca terminal switch failed: ${errorText(switched.error)}`);
    return { action: "resumed", handle };
  }
  if (agent === "codex") {
    const cwd = deps.getSessionCwd(agent, sid);
    if (!cwd) return { action: "manual", reason: "unknown-session", command: null };
    const worktree = await deps.orcaJson(["worktree", "show", "--worktree", `path:${cwd}`, "--json"]);
    if (!worktree.ok) {
      return {
        action: "manual", reason: "not-orca-worktree",
        command: `cd ${shellQuote(cwd)} && codex resume ${sid}`,
      };
    }
    if (options.dryRun) {
      deps.reportPlan?.(["codex", "resume", sid]);
      return { action: "resumed", handle: "(dry-run)" };
    }
    const created = await deps.orcaJson([
      "terminal", "create", "--worktree", `path:${cwd}`, "--title", "codex resume",
      "--command", `codex resume ${sid}`, "--json",
    ]);
    if (!created.ok) throw new OrcaError(`orca terminal create failed: ${errorText(created.error)}`);
    const handle = created.result?.terminal?.handle ?? created.result?.handle ?? created.result?.startupTerminal?.handle;
    if (typeof handle !== "string" || !handle) throw new OrcaError("orca terminal create returned no handle");
    const switched = await deps.orcaJson(["terminal", "switch", "--terminal", handle, "--json"]);
    if (!switched.ok) throw new OrcaError(`orca terminal switch failed: ${errorText(switched.error)}`);
    return { action: "resumed", handle };
  }
  const cwd = deps.getSessionCwd(agent, sid);
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

function parseCliArgs(args: string[]): { agent: Agent; sid: string; env?: string; dryRun: boolean } {
  const dryRun = args.includes("--dry-run");
  const input = args.find((arg) => arg !== "--dry-run");
  if (!input) throw new ValidationError("usage: bun src/focus.ts [--dry-run] <sid | orcatab://<agent>/<sid>>");
  if (!isSessionUri(input)) return { agent: "claude", sid: input, dryRun };
  const identity = parseSessionUri(input);
  if (identity === null) throw new ValidationError("invalid orcatab uri");
  return { ...identity, dryRun };
}

async function runCli(args: string[]): Promise<void> {
  let database: OrcaDatabase | null = null;
  try {
    const { agent, sid, env, dryRun } = parseCliArgs(args);
    database = openDatabaseReadOnly(join(ORCATAB_DATA_DIR, "index.db"));
    const deps = createFocusDeps(database, {
      claudeDir: ORCATAB_CLAUDE_DIR,
      codexDir: ORCATAB_CODEX_DIR,
      hermesDb: ORCATAB_HERMES_DB,
      reportPlan: (plan) => console.error(JSON.stringify({ plan })),
    });
    // The uri may name a remote environment; dropping it here would resume the wrong machine.
    console.log(JSON.stringify(await resolveFocus(agent, sid, deps, {
      dryRun, ...(env === undefined ? {} : { env }),
    })));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}

// No top-level await: this module is imported by server.ts, which pm2 loads with require().
if (import.meta.main) void runCli(process.argv.slice(2));
