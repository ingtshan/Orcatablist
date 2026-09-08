import { normalizeEnv } from "./session-identity";
import type { LiveInfo, SessionRow } from "./types";

/**
 * Where a session's worktree is, and which machine that path belongs to.
 *
 * A path is not an identity: `/Users/x/orca/workspaces/lumina/class-plan-practice-v01` exists on
 * this machine and on every remote environment OrcaTab polls, and the two are different
 * directories on different disks. Everything that groups, keys or archives a worktree therefore
 * carries the environment as well as the path.
 */

/** The separator Orca puts between a workspace's opaque repo id and its absolute path. */
const WORKSPACE_KEY_SEPARATOR = "::";

export interface WorktreeLocationRow {
  env?: string;
  cwd?: string | null;
  worktreeRoot?: string | null;
  live?: LiveInfo | null;
}

/**
 * The path half of an Orca workspace key (`<repoId>::<absolute path>`). Only the first separator
 * counts, because a path may legitimately contain another one. Anything that is not a nonempty
 * opaque id followed by an absolute path carries no location and is rejected outright — this is a
 * string parse, never a filesystem or Git question.
 */
export function parseWorkspacePath(worktree: string | null | undefined): string | null {
  if (typeof worktree !== "string") return null;
  const separator = worktree.indexOf(WORKSPACE_KEY_SEPARATOR);
  if (separator < 1) return null;
  const path = worktree.slice(separator + WORKSPACE_KEY_SEPARATOR.length);
  return path.startsWith("/") ? path : null;
}

/**
 * The live tab's workspace path, but only when the tab and the row are on the same machine. A
 * remote row must not borrow a local tab's path, and vice versa: the two would name unrelated
 * directories that happen to share a spelling.
 */
export function liveWorktreeRootFor(row: WorktreeLocationRow): string | null {
  const live = row.live;
  if (live === null || live === undefined) return null;
  if (normalizeEnv(live.env) !== normalizeEnv(row.env)) return null;
  return parseWorkspacePath(live.worktree);
}

/**
 * Where the GUI will draw this row: the indexer's own answer first, then the live tab's workspace,
 * then the directory the transcript recorded, then the project's root. `cwd` is never inferred
 * from the live workspace — an indexed cwd is evidence, a live root is only a location.
 */
export function resolveWorktreeRoot(row: WorktreeLocationRow, projectRoot = ""): string {
  return row.worktreeRoot || liveWorktreeRootFor(row) || row.cwd || projectRoot || "";
}

/**
 * The identity a stored preference and the archive filter agree on. Project keys are already
 * namespaced per environment, so `(project, root)` is enough to keep a local pin and a `feibo1`
 * pin of the same path apart.
 */
export function worktreePreferenceKey(projectKey: string, root: string): string {
  return JSON.stringify([projectKey, root]);
}

/**
 * The identity a *group* is drawn under. Grouping needs the environment spelled out as well:
 * every environment's unindexed live sessions share one placeholder project key, so two machines'
 * unknown roots — including two empty ones — would otherwise collapse into a single group.
 */
export function worktreeGroupKey(env: string | null | undefined, projectKey: string, root: string): string {
  return JSON.stringify([normalizeEnv(env), projectKey, root]);
}

/** {@link worktreeGroupKey} for a row the board or the session list is about to place. */
export function rowWorktreeGroupKey(row: SessionRow, projectRoot = ""): string {
  return worktreeGroupKey(row.env, row.projectKey, resolveWorktreeRoot(row, projectRoot));
}
