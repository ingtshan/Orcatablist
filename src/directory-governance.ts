import { existsSync } from "node:fs";
import type { WorktreePreference } from "./project-preferences";
import { LOCAL_ENV, normalizeEnv } from "./session-identity";
import type { ProjectRow, SessionRow } from "./types";
import { resolveWorktreeRoot, worktreePreferenceKey } from "./worktree-identity";

export type DirectoryKind = "git-worktree" | "historical-directory" | "unknown";

export interface ProjectRootAudit {
  projectKey: string;
  name: string;
  root: string;
  exists: boolean;
  missing: boolean;
  archived: boolean;
  sessionCount: number;
}

export interface DirectoryGroupAudit {
  projectKey: string;
  projectName: string;
  root: string;
  kind: DirectoryKind;
  exists: boolean;
  missing: boolean;
  archived: boolean;
  sessionCount: number;
  lastInputAt: number | null;
}

export interface DirectoryAudit {
  auditedAt: number;
  summary: {
    projectRoots: number;
    missingProjectRoots: number;
    unknownProjectRoots: number;
    directoryGroups: number;
    missingDirectoryGroups: number;
    gitWorktrees: number;
    historicalDirectories: number;
    unknownDirectories: number;
  };
  projects: ProjectRootAudit[];
  directories: DirectoryGroupAudit[];
  archivePlan: {
    projectKeys: string[];
    worktrees: Array<{ projectKey: string; root: string }>;
  };
}

interface DirectoryBuilder {
  projectKey: string;
  projectName: string;
  root: string;
  detected: boolean;
  sessionCount: number;
  lastInputAt: number | null;
}

function pathExists(path: string, check: (path: string) => boolean): boolean {
  if (!path) return false;
  try { return check(path); }
  catch { return false; }
}

function directoryKind(root: string, detected: boolean): DirectoryKind {
  if (!root) return "unknown";
  return detected ? "git-worktree" : "historical-directory";
}

function isLocal(session: SessionRow): boolean {
  return normalizeEnv(session.env) === LOCAL_ENV;
}

/**
 * Projects every one of whose sessions was indexed from another machine. Their roots name
 * directories on that machine's disk, so asking this filesystem whether they exist can only
 * produce a false "missing" — and, from there, an archive target for a directory that is fine.
 */
function remoteOnlyProjectKeys(sessions: readonly SessionRow[]): Set<string> {
  const local = new Set<string>();
  const remote = new Set<string>();
  for (const session of sessions) {
    (isLocal(session) ? local : remote).add(session.projectKey);
  }
  return new Set([...remote].filter((key) => !local.has(key)));
}

export function auditDirectories(
  projects: ProjectRow[],
  sessions: SessionRow[],
  worktreePreferences: WorktreePreference[],
  checkPath: (path: string) => boolean = existsSync,
  now = Date.now,
): DirectoryAudit {
  const projectByKey = new Map(projects.map((project) => [project.key, project]));
  // Existence is a question about this disk, so only this machine's rows are ever asked it.
  const localSessions = sessions.filter(isLocal);
  const remoteOnly = remoteOnlyProjectKeys(sessions);
  const localProjects = projects.filter((project) => !remoteOnly.has(project.key));
  const preferenceByWorktree = new Map(worktreePreferences.map((preference) => [
    worktreePreferenceKey(preference.projectKey, preference.root), preference,
  ]));
  const projectAudits = localProjects.map((project): ProjectRootAudit => {
    const exists = pathExists(project.root, checkPath);
    return {
      projectKey: project.key,
      name: project.name,
      root: project.root,
      exists,
      missing: Boolean(project.root) && !exists,
      archived: project.archived,
      sessionCount: project.sessionCount,
    };
  }).sort((left, right) => Number(left.exists) - Number(right.exists)
    || left.name.localeCompare(right.name, "zh-CN"));

  const builders = new Map<string, DirectoryBuilder>();
  for (const session of localSessions) {
    const project = projectByKey.get(session.projectKey);
    const root = resolveWorktreeRoot(session, project?.root ?? "");
    const key = `${session.projectKey}\0${root}`;
    const current = builders.get(key);
    builders.set(key, {
      projectKey: session.projectKey,
      projectName: project?.name ?? session.projectKey,
      root,
      detected: Boolean(session.worktreeRoot) || current?.detected === true,
      sessionCount: (current?.sessionCount ?? 0) + 1,
      lastInputAt: Math.max(current?.lastInputAt ?? -1, session.lastInputAt ?? -1) < 0
        ? null : Math.max(current?.lastInputAt ?? -1, session.lastInputAt ?? -1),
    });
  }

  const directories = [...builders.values()].map((group): DirectoryGroupAudit => {
    const project = projectByKey.get(group.projectKey);
    const exists = pathExists(group.root, checkPath);
    return {
      projectKey: group.projectKey,
      projectName: group.projectName,
      root: group.root,
      kind: directoryKind(group.root, group.detected),
      exists,
      missing: Boolean(group.root) && !exists,
      archived: Boolean(project?.archived
        || preferenceByWorktree.get(worktreePreferenceKey(group.projectKey, group.root))?.archived),
      sessionCount: group.sessionCount,
      lastInputAt: group.lastInputAt,
    };
  }).sort((left, right) => Number(left.exists) - Number(right.exists)
    || left.projectName.localeCompare(right.projectName, "zh-CN")
    || left.root.localeCompare(right.root));

  const projectKeys = projectAudits
    .filter((project) => project.missing && !project.archived)
    .map((project) => project.projectKey).sort();
  const coveredProjects = new Set(projectKeys);
  const worktrees = directories
    .filter((directory) => directory.missing && !directory.archived
      && !coveredProjects.has(directory.projectKey))
    .map(({ projectKey, root }) => ({ projectKey, root }))
    .sort((left, right) => left.projectKey.localeCompare(right.projectKey) || left.root.localeCompare(right.root));

  return {
    auditedAt: now(),
    summary: {
      projectRoots: projectAudits.length,
      missingProjectRoots: projectAudits.filter((project) => project.missing).length,
      unknownProjectRoots: projectAudits.filter((project) => !project.root).length,
      directoryGroups: directories.length,
      missingDirectoryGroups: directories.filter((directory) => directory.missing).length,
      gitWorktrees: directories.filter((directory) => directory.kind === "git-worktree").length,
      historicalDirectories: directories.filter((directory) => directory.kind === "historical-directory").length,
      unknownDirectories: directories.filter((directory) => directory.kind === "unknown").length,
    },
    projects: projectAudits,
    directories,
    archivePlan: { projectKeys, worktrees },
  };
}
