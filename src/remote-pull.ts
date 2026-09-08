import { join } from "node:path";
import { ORCATAB_DATA_DIR } from "./config";
import { sshDestination, type EnvironmentConfig } from "./remote-environments";
import { COLLECTOR_SCRIPT, remoteCollectorCommand } from "./remote-collector";
import type { RemoteReadCursor } from "./remote-read-state";
import { executionSettings, type SessionExecution } from "./session-execution";

export { COLLECTOR_SCRIPT, remoteCollectorCommand };

/**
 * Option B of docs/REMOTE.md: one ssh exec per round, zero remote footprint. The collector
 * script travels inside argv (base64 so quoting never depends on the remote shell), stdin
 * carries the cursor request, stdout streams NDJSON back.
 */

export const DEFAULT_MAX_PULL_BYTES = 8 * 1024 * 1024;
/** How much of the round budget one file may take per cyclic pass before others get a turn. */
export const DEFAULT_PULL_QUANTUM_BYTES = 1024 * 1024;
export const PULL_TIMEOUT_MS = 120_000;
export const PROBE_TIMEOUT_MS = 20_000;
const SSH_CONNECT_TIMEOUT_S = 5;
const STDERR_TAIL_CHARS = 2_000;
/** A well-behaved collector never exceeds the byte budget by more than one chunk of base64. */
const OUTPUT_SLACK_BYTES = 4 * 1024 * 1024;

export const CLAUDE_REMOTE_DIR = "~/.claude/projects";
export const CODEX_REMOTE_DIR = "~/.codex";
export const DEFAULT_CODEX_SINCE_DAYS = 90;

export interface RemoteFileStat { path: string; size: number; mtime: number; }
export interface RemoteAuxFile { data: Uint8Array; size: number; mtime: number; }
export interface PullResult {
  executionMetadata?: Map<string, SessionExecution>;
  files: RemoteFileStat[];
  codexFiles: RemoteFileStat[];
  /** Assembled contiguous bytes per path, starting at `offset`. */
  chunks: Map<string, { offset: number; bytes: Uint8Array }>;
  rebuilds: Set<string>;
  /** Fresh full content of the codex session_index, when its stat moved past the applied one. */
  codexIndex: RemoteAuxFile | null;
  truncated: boolean;
  done: boolean;
  /** Last file this round actually shipped bytes for; the next round resumes after it. */
  lastPath: string | null;
  errors: string[];
  /** Agents whose session directory does not exist remotely — a normal empty state, not an error. */
  missing: string[];
}
export interface ProbeDirStat { dir: string; ok: boolean; files: number; bytes: number; }
export interface ProbeResult {
  python: string | null;
  home: string | null;
  claude: ProbeDirStat | null;
  codex: ProbeDirStat | null;
  errors: string[];
}
export interface PullAgentsRequest {
  claude: boolean;
  codex: { sinceDays: number | null; index: { size: number; mtime: number } | null } | null;
}
export interface PullRequest {
  claude?: { dir: string };
  codex?: { dir: string; sinceDays: number | null; index: { size: number; mtime: number } | null };
  /** Historical numeric cursors stay valid; the typed record adds the observed file stat. */
  cursors: Record<string, RemoteReadCursor | number>;
  maxBytes: number;
  quantum: number;
  /** Fairness continuation point from the last completed round. */
  lastPath: string | null;
}

export interface ExecResult { exitCode: number; stdout: string; stderrTail: string; timedOut: boolean; }
export type Exec = (argv: string[], stdin: string, timeoutMs: number, maxStdoutBytes: number) => Promise<ExecResult>;

export function buildSshArgv(
  config: Pick<EnvironmentConfig, "sshUser" | "sshHost" | "sshPort">,
  remoteCommand: string,
  dataDir = ORCATAB_DATA_DIR,
): string[] {
  return [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${join(dataDir, "ssh-%C")}`,
    "-o", "ControlPersist=60",
    ...(config.sshPort === null ? [] : ["-p", String(config.sshPort)]),
    "--", sshDestination(config), remoteCommand,
  ];
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<{ text: string; overflow: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let overflow = false;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) { overflow = true; break; }
    text += decoder.decode(chunk, { stream: true });
  }
  if (!overflow) text += decoder.decode();
  return { text, overflow };
}

export const spawnExec: Exec = async (argv, stdin, timeoutMs, maxStdoutBytes) => {
  const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  child.stdin.write(stdin);
  await child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(child.stdout, maxStdoutBytes),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (stdout.overflow && !timedOut) child.kill();
  return {
    exitCode: stdout.overflow ? -1 : exitCode,
    stdout: stdout.text,
    stderrTail: stderr.slice(-STDERR_TAIL_CHARS),
    timedOut,
  };
};

interface CollectorEvent {
  settings?: unknown;
  type?: unknown; agent?: unknown; name?: unknown; files?: unknown; path?: unknown; offset?: unknown;
  data?: unknown; size?: unknown; mtime?: unknown; truncated?: unknown; message?: unknown;
  python?: unknown; home?: unknown; claude?: unknown; codex?: unknown; lastPath?: unknown;
}

function statFrom(value: unknown): RemoteFileStat | null {
  const raw = value as { path?: unknown; size?: unknown; mtime?: unknown };
  if (typeof raw?.path !== "string" || !raw.path) return null;
  const size = Number(raw.size);
  const mtime = Number(raw.mtime);
  if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtime)) return null;
  return { path: raw.path, size, mtime: Math.trunc(mtime) };
}

/** Pure NDJSON → PullResult assembly; chunk gaps invalidate that file's buffer instead of corrupting it. */
export function assemblePullOutput(stdout: string): PullResult {
  const result: PullResult = {
    files: [], codexFiles: [], chunks: new Map(), rebuilds: new Set(), codexIndex: null,
    truncated: false, done: false, lastPath: null, errors: [], missing: [],
  };
  const broken = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: CollectorEvent;
    try { event = JSON.parse(line) as CollectorEvent; }
    catch { result.errors.push(`unparseable collector line: ${line.slice(0, 120)}`); continue; }
    if (event.type === "list" && event.agent === "claude" && Array.isArray(event.files)) {
      result.files = event.files.map(statFrom).filter((stat): stat is RemoteFileStat => stat !== null);
    } else if (event.type === "list" && event.agent === "codex" && Array.isArray(event.files)) {
      result.codexFiles = event.files.map(statFrom).filter((stat): stat is RemoteFileStat => stat !== null);
    } else if (event.type === "aux" && event.name === "codex-session-index" && typeof event.data === "string") {
      const size = Number(event.size);
      const mtime = Number(event.mtime);
      try {
        result.codexIndex = {
          data: Buffer.from(event.data, "base64"),
          size: Number.isFinite(size) ? size : 0,
          mtime: Number.isFinite(mtime) ? Math.trunc(mtime) : 0,
        };
      } catch { result.errors.push("undecodable codex session index"); }
    } else if (event.type === "execution" && typeof event.path === "string" && event.settings && typeof event.settings === "object") {
      const settings = event.settings as Record<string, unknown>;
      (result.executionMetadata ??= new Map()).set(event.path, {
        model: null, reasoningEffort: null, ...executionSettings(settings.model, settings.reasoningEffort),
      });
    } else if (event.type === "rebuild" && typeof event.path === "string") {
      result.rebuilds.add(event.path);
      result.chunks.delete(event.path);
    } else if (event.type === "chunk" && typeof event.path === "string") {
      if (broken.has(event.path)) continue;
      const offset = Number(event.offset);
      if (!Number.isFinite(offset) || offset < 0 || typeof event.data !== "string") continue;
      let bytes: Buffer;
      try { bytes = Buffer.from(event.data, "base64"); }
      catch { broken.add(event.path); result.chunks.delete(event.path); continue; }
      const current = result.chunks.get(event.path);
      if (current === undefined) {
        result.chunks.set(event.path, { offset, bytes });
      } else if (current.offset + current.bytes.byteLength === offset) {
        result.chunks.set(event.path, { offset: current.offset, bytes: Buffer.concat([current.bytes, bytes]) });
      } else {
        broken.add(event.path);
        result.chunks.delete(event.path);
        result.errors.push(`non-contiguous chunk for ${event.path}`);
      }
    } else if (event.type === "missing" && typeof event.agent === "string") {
      result.missing.push(event.agent);
    } else if (event.type === "error") {
      result.errors.push(typeof event.message === "string" ? event.message : "unknown collector error");
    } else if (event.type === "done") {
      result.truncated = event.truncated === true;
      result.lastPath = typeof event.lastPath === "string" && event.lastPath ? event.lastPath : null;
      result.done = true;
    }
  }
  return result;
}

function execFailure(result: ExecResult): string | null {
  if (result.timedOut) return "ssh timed out";
  if (result.exitCode === -1) return "collector output exceeded the local buffer cap";
  if (result.exitCode === 255) return `ssh connection failed: ${result.stderrTail.trim() || "unknown error"}`;
  if (result.exitCode === 127) return "python3 not found on the remote machine";
  if (result.exitCode !== 0) return `collector exited ${result.exitCode}: ${result.stderrTail.trim()}`;
  return null;
}

export interface RemotePullerOptions {
  exec?: Exec;
  dataDir?: string;
  maxBytes?: number;
  /** Per-file share of one cyclic pass; keeps a single busy file from consuming the round. */
  quantum?: number;
  timeoutMs?: number;
}

/** Which agents this round should collect, from the environment's saved config. */
export function pullAgents(config: EnvironmentConfig): PullAgentsRequest {
  const codex = config.agents.codex;
  return {
    claude: config.agents.claude !== false,
    codex: codex === undefined || codex === false ? null : {
      sinceDays: codex === true ? DEFAULT_CODEX_SINCE_DAYS
        : codex.sinceDays ?? DEFAULT_CODEX_SINCE_DAYS,
      index: null,
    },
  };
}

export async function runPull(
  config: EnvironmentConfig,
  cursors: Record<string, RemoteReadCursor>,
  options: RemotePullerOptions = {},
  agents: PullAgentsRequest = pullAgents(config),
  /** Where the last completed round stopped, so this one continues instead of restarting. */
  lastPath: string | null = null,
): Promise<PullResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PULL_BYTES;
  const request: PullRequest = {
    ...(agents.claude ? { claude: { dir: CLAUDE_REMOTE_DIR } } : {}),
    ...(agents.codex === null ? {} : {
      codex: { dir: CODEX_REMOTE_DIR, sinceDays: agents.codex.sinceDays, index: agents.codex.index },
    }),
    cursors, maxBytes,
    quantum: options.quantum ?? DEFAULT_PULL_QUANTUM_BYTES,
    lastPath,
  };
  const exec = options.exec ?? spawnExec;
  const argv = buildSshArgv(config, remoteCollectorCommand(), options.dataDir);
  // base64 inflates 4/3 and every payload byte rides inside JSON framing; leave generous slack.
  const stdoutCap = Math.ceil(maxBytes * 1.5) + OUTPUT_SLACK_BYTES;
  const result = await exec(argv, JSON.stringify(request), options.timeoutMs ?? PULL_TIMEOUT_MS, stdoutCap);
  const failure = execFailure(result);
  const assembled = assemblePullOutput(result.stdout);
  if (failure !== null) assembled.errors.push(failure);
  if (failure === null && !assembled.done) assembled.errors.push("collector stream ended without done marker");
  return assembled;
}

export async function runProbe(
  config: Pick<EnvironmentConfig, "sshUser" | "sshHost" | "sshPort">,
  options: RemotePullerOptions = {},
): Promise<ProbeResult> {
  const exec = options.exec ?? spawnExec;
  const argv = buildSshArgv(config, remoteCollectorCommand(), options.dataDir);
  const request = {
    probe: true,
    claude: { dir: CLAUDE_REMOTE_DIR },
    codex: { dir: CODEX_REMOTE_DIR, sinceDays: DEFAULT_CODEX_SINCE_DAYS, index: null },
  };
  const result = await exec(argv, JSON.stringify(request), options.timeoutMs ?? PROBE_TIMEOUT_MS, 1024 * 1024);
  const probe: ProbeResult = { python: null, home: null, claude: null, codex: null, errors: [] };
  const failure = execFailure(result);
  if (failure !== null) probe.errors.push(failure);
  const dirStat = (value: unknown): ProbeDirStat | null => {
    const raw = value as { dir?: unknown; ok?: unknown; files?: unknown; bytes?: unknown } | undefined;
    if (!raw || typeof raw.dir !== "string") return null;
    return {
      dir: raw.dir, ok: raw.ok === true,
      files: Number.isFinite(Number(raw.files)) ? Number(raw.files) : 0,
      bytes: Number.isFinite(Number(raw.bytes)) ? Number(raw.bytes) : 0,
    };
  };
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: CollectorEvent;
    try { event = JSON.parse(line) as CollectorEvent; }
    catch { continue; }
    if (event.type === "probe") {
      probe.python = typeof event.python === "string" ? event.python : null;
      probe.home = typeof event.home === "string" ? event.home : null;
      probe.claude = dirStat(event.claude);
      probe.codex = dirStat(event.codex);
    } else if (event.type === "error" && typeof event.message === "string") {
      probe.errors.push(event.message);
    }
  }
  return probe;
}
