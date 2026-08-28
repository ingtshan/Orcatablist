import { existsSync } from "node:fs";
import { createCachedSnapshot } from "./cached-snapshot";

const ORCA_AUDIT_CACHE_MS = 30_000;
const COMMAND_TIMEOUT_MS = 5_000;
const LUMINA_PROJECT_ID = "github:feibo-ai/lumina";
const MERGE_TARGET_PATTERN = /merged into ([A-Za-z0-9._\/-]+)/;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface OrcaWorktree {
  id: string;
  path: string;
  projectId: string;
  displayName: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  isArchived: boolean;
  workspaceStatus: string;
  comment: string;
  linkedPR: number | null;
}

interface OrcaTerminal {
  worktreePath?: unknown;
  connected?: unknown;
  orphaned?: unknown;
}

export type ArchiveRecommendation = "ready" | "review" | "hold";

export interface OrcaWorktreeAuditItem {
  id: string;
  name: string;
  projectId: string;
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  pathExists: boolean;
  dirtyFileCount: number | null;
  connectedTerminals: number;
  mergeTarget: string | null;
  headInMergeTarget: boolean | null;
  recommendation: ArchiveRecommendation;
  reasons: string[];
  comment: string;
}

export interface OrcaWorktreeAuditSnapshot {
  auditedAt: number;
  summary: {
    totalWorktrees: number;
    completedWorktrees: number;
    archivedWorktrees: number;
    ready: number;
    review: number;
    hold: number;
    lumina: { total: number; completed: number; inProgress: number; inReview: number; archived: number };
  };
  items: OrcaWorktreeAuditItem[];
  warnings: string[];
}

export interface OrcaWorktreeAuditReader {
  refresh(): Promise<OrcaWorktreeAuditSnapshot>;
  getVersion(): number;
}

export interface OrcaWorktreeAuditOptions {
  orcaBin?: string;
  run?(argv: string[]): Promise<CommandResult>;
  pathExists?(path: string): boolean;
  now?(): number;
  cacheMs?: number;
}

async function runCommand(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

function listResult<T>(result: CommandResult, field: string, context: string): T[] {
  if (result.exitCode !== 0) throw new Error(`${context} exited ${result.exitCode}: ${result.stderr.trim()}`);
  let value: { ok?: unknown; result?: Record<string, unknown> };
  try { value = JSON.parse(result.stdout); }
  catch (cause) { throw new Error(`${context} returned invalid JSON: ${String(cause)}`); }
  const rows = value.ok === true ? value.result?.[field] : null;
  if (!Array.isArray(rows)) throw new Error(`${context} returned no ${field}`);
  return rows as T[];
}

function dirtyLineCount(result: CommandResult): number | null {
  if (result.exitCode !== 0) return null;
  return result.stdout.split("\n").filter((line) => line.length > 0).length;
}

function recommendation(
  worktree: OrcaWorktree,
  present: boolean,
  dirtyFiles: number | null,
  mergeTarget: string | null,
  headInMergeTarget: boolean | null,
  connectedTerminals: number,
): { value: ArchiveRecommendation; reasons: string[] } {
  const reasons: string[] = [];
  let value: ArchiveRecommendation = "review";
  if (worktree.isMainWorktree) {
    value = "hold";
    reasons.push("主 worktree 不应随完成任务一起隐藏");
  }
  if (dirtyFiles !== null && dirtyFiles > 0) {
    value = "hold";
    reasons.push(`仍有 ${dirtyFiles} 个未提交改动`);
  }
  if (!present) reasons.push("本机路径不存在，需确认是否为远端或已迁移目录");
  else if (dirtyFiles === null) reasons.push("无法读取 Git 状态");
  else if (value !== "hold" && mergeTarget !== null && headInMergeTarget === true) {
    value = "ready";
    reasons.push(`HEAD 已包含在 ${mergeTarget}`);
  } else if (value !== "hold" && mergeTarget !== null) {
    reasons.push(`未能确认 HEAD 已包含在 ${mergeTarget}`);
  } else if (value !== "hold") reasons.push("缺少可验证的合并目标");
  if (connectedTerminals > 0) reasons.push(`仍有 ${connectedTerminals} 个连接终端`);
  return { value, reasons };
}

async function auditCompleted(
  worktree: OrcaWorktree,
  connectedTerminals: number,
  run: (argv: string[]) => Promise<CommandResult>,
  pathExists: (path: string) => boolean,
): Promise<OrcaWorktreeAuditItem> {
  const present = pathExists(worktree.path);
  const mergeTarget = MERGE_TARGET_PATTERN.exec(worktree.comment)?.[1] ?? null;
  const [status, ancestor] = await Promise.all([
    present ? run(["git", "-C", worktree.path, "status", "--porcelain=v1", "--untracked-files=all"])
      : Promise.resolve<CommandResult>({ exitCode: 1, stdout: "", stderr: "path missing" }),
    present && mergeTarget !== null
      ? run(["git", "-C", worktree.path, "merge-base", "--is-ancestor", "HEAD", mergeTarget])
      : Promise.resolve<CommandResult>({ exitCode: 1, stdout: "", stderr: "no merge target" }),
  ]);
  const dirtyFiles = present ? dirtyLineCount(status) : null;
  const headInMergeTarget = mergeTarget === null || !present ? null : ancestor.exitCode === 0;
  const result = recommendation(
    worktree, present, dirtyFiles, mergeTarget, headInMergeTarget, connectedTerminals,
  );
  return {
    id: worktree.id,
    name: worktree.displayName,
    projectId: worktree.projectId,
    path: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    isMainWorktree: worktree.isMainWorktree,
    pathExists: present,
    dirtyFileCount: dirtyFiles,
    connectedTerminals,
    mergeTarget,
    headInMergeTarget,
    recommendation: result.value,
    reasons: result.reasons,
    comment: worktree.comment,
  };
}

function luminaSummary(worktrees: OrcaWorktree[]) {
  const rows = worktrees.filter((worktree) => worktree.projectId === LUMINA_PROJECT_ID);
  return {
    total: rows.length,
    completed: rows.filter((worktree) => worktree.workspaceStatus === "completed").length,
    inProgress: rows.filter((worktree) => worktree.workspaceStatus === "in-progress").length,
    inReview: rows.filter((worktree) => worktree.workspaceStatus === "in-review").length,
    archived: rows.filter((worktree) => worktree.isArchived).length,
  };
}

export function createOrcaWorktreeAuditReader(options: OrcaWorktreeAuditOptions = {}): OrcaWorktreeAuditReader {
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const pathExists = options.pathExists ?? existsSync;
  const cacheMs = options.cacheMs ?? ORCA_AUDIT_CACHE_MS;
  const orcaBin = options.orcaBin ?? "orca";

  async function load(): Promise<OrcaWorktreeAuditSnapshot> {
    const warnings: string[] = [];
    const worktreeResult = await run([orcaBin, "worktree", "list", "--json"]);
    const worktrees = listResult<OrcaWorktree>(worktreeResult, "worktrees", "orca worktree list");
    let terminals: OrcaTerminal[] = [];
    try {
      terminals = listResult<OrcaTerminal>(
        await run([orcaBin, "terminal", "list", "--json"]), "terminals", "orca terminal list",
      );
    } catch (cause) { warnings.push(cause instanceof Error ? cause.message : String(cause)); }
    const connectedByPath = new Map<string, number>();
    for (const terminal of terminals) {
      if (terminal.connected !== true || terminal.orphaned === true || typeof terminal.worktreePath !== "string") continue;
      connectedByPath.set(terminal.worktreePath, (connectedByPath.get(terminal.worktreePath) ?? 0) + 1);
    }
    const completed = worktrees.filter((worktree) => worktree.workspaceStatus === "completed" && !worktree.isArchived);
    const items = await Promise.all(completed.map((worktree) => auditCompleted(
      worktree, connectedByPath.get(worktree.path) ?? 0, run, pathExists,
    )));
    return {
      auditedAt: now(),
      summary: {
        totalWorktrees: worktrees.length,
        completedWorktrees: completed.length,
        archivedWorktrees: worktrees.filter((worktree) => worktree.isArchived).length,
        ready: items.filter((item) => item.recommendation === "ready").length,
        review: items.filter((item) => item.recommendation === "review").length,
        hold: items.filter((item) => item.recommendation === "hold").length,
        lumina: luminaSummary(worktrees),
      },
      items,
      warnings,
    };
  }

  const snapshot = createCachedSnapshot<void, OrcaWorktreeAuditSnapshot>({
    ttlMs: cacheMs, now, load: () => load(),
    // auditedAt moves on every load; the version must track content only.
    signature: ({ summary, items, warnings }) => JSON.stringify({ summary, items, warnings }),
  });
  return { refresh: () => snapshot.refresh(), getVersion: snapshot.getVersion };
}
