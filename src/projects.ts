import { basename, isAbsolute } from "node:path";
import { ORCATAB_ORCA_BIN } from "./config";
import type { OrcaDatabase, ProjectRecord } from "./db";

const GIT_TIMEOUT_MS = 3_000;
const PROJECT_REFRESH_MS = 10 * 60 * 1_000;
const ORCA_WORKSPACE_PATTERN = /^(.*\/orca\/workspaces\/([^/]+))\//;

export interface CommandResult { ok: boolean; stdout: string; stderr?: string; }
export interface ProjectDeps {
  runGit(cwd: string): Promise<CommandResult>;
  getCached(cwd: string): string | null;
  getProject(key: string): ProjectRecord | null;
  setCached(cwd: string, project: ProjectRecord): void;
}

async function runCommand(argv: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<CommandResult> {
  try {
    const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => process.kill(), timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    clearTimeout(timer);
    return { ok: exitCode === 0, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function projectFromCommonDir(output: string): ProjectRecord {
  const commonDir = output.trim().replace(/\/$/, "");
  const root = commonDir.endsWith("/.git") ? commonDir.slice(0, -5) : commonDir;
  return { key: root, name: basename(root), root, color: null };
}

function fallbackProject(cwd: string): ProjectRecord {
  const match = ORCA_WORKSPACE_PATTERN.exec(cwd);
  if (match) return { key: `orca-workspaces:${match[2]}`, name: match[2]!, root: "", color: null };
  return { key: cwd, name: basename(cwd), root: cwd, color: null };
}

export async function resolveProjectKey(cwd: string | null, deps: ProjectDeps): Promise<ProjectRecord> {
  if (cwd === null || !isAbsolute(cwd)) return { key: "unknown", name: "未知", root: "", color: null };
  const cachedKey = deps.getCached(cwd);
  if (cachedKey !== null) {
    const cached = deps.getProject(cachedKey);
    if (cached !== null) return cached;
  }
  const git = await deps.runGit(cwd);
  const project = git.ok && git.stdout.trim() ? projectFromCommonDir(git.stdout) : fallbackProject(cwd);
  deps.setCached(cwd, project);
  return project;
}

export function createProjectDeps(db: OrcaDatabase): ProjectDeps {
  return {
    runGit: (cwd) => runCommand(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    getCached: (cwd) => db.getCachedProjectKey(cwd),
    getProject: (key) => db.listProjectRecords().find((project) => project.key === key) ?? null,
    setCached: (cwd, project) => {
      db.upsertProject(project);
      db.setCachedProjectKey(cwd, project.key);
    },
  };
}

export function mergeOrcaWorkspaceProjects(db: OrcaDatabase): number {
  const projects = db.listProjectRecords();
  let merged = 0;
  for (const project of projects) {
    if (!project.key.startsWith("orca-workspaces:")) continue;
    const target = projects.find((candidate) => !candidate.key.startsWith("orca-workspaces:") && candidate.name === project.name);
    if (target) { db.rewriteProjectKey(project.key, target.key); merged += 1; }
  }
  return merged;
}

interface OrcaRepo { path?: unknown; displayName?: unknown; badgeColor?: unknown; }

export async function refreshProjectMetadata(db: OrcaDatabase, orcaBin = ORCATAB_ORCA_BIN): Promise<number> {
  const response = await runCommand([orcaBin, "repo", "list", "--json"]);
  if (!response.ok) return 0;
  try {
    const envelope = JSON.parse(response.stdout) as { result?: { repos?: OrcaRepo[] } };
    const repos = envelope.result?.repos;
    if (!Array.isArray(repos)) return 0;
    let updated = 0;
    for (const project of db.listProjectRecords()) {
      const repo = repos.find((candidate) => candidate.path === project.root);
      if (!repo) continue;
      const name = typeof repo.displayName === "string" && repo.displayName ? repo.displayName : project.name;
      const color = typeof repo.badgeColor === "string" ? repo.badgeColor : null;
      db.updateProjectMetadata(project.key, name, color);
      updated += 1;
    }
    return updated;
  } catch {
    return 0;
  }
}

export function startProjectMetadataTimer(db: OrcaDatabase, orcaBin = ORCATAB_ORCA_BIN): ReturnType<typeof setInterval> {
  const timer = setInterval(() => void refreshProjectMetadata(db, orcaBin), PROJECT_REFRESH_MS);
  timer.unref?.();
  return timer;
}
