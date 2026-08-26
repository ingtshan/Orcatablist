import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

export interface WorktreeResolverDeps {
  hasGitMarker(directory: string): boolean;
}

const defaultDeps: WorktreeResolverDeps = {
  hasGitMarker: (directory) => existsSync(join(directory, ".git")),
};

export function resolveWorktreeRoot(
  cwd: string | null,
  deps: WorktreeResolverDeps = defaultDeps,
): string | null {
  if (cwd === null || !isAbsolute(cwd)) return null;
  let directory = normalize(cwd);
  while (true) {
    if (deps.hasGitMarker(directory)) return realpathSync(directory);
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
