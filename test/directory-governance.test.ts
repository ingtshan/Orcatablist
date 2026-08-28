import { describe, expect, test } from "bun:test";
import { auditDirectories } from "../src/directory-governance";
import type { ProjectRow, SessionRow } from "../src/types";

function project(key: string, root: string, archived = false): ProjectRow {
  return {
    key, root, archived, name: key, color: null, pinned: false,
    sessionCount: 0, lastInputAt: null,
  };
}

function session(projectKey: string, sid: string, cwd: string | null, worktreeRoot: string | null): SessionRow {
  return {
    agent: "claude", sid, projectKey, cwd, worktreeRoot, branch: null, title: null,
    firstPrompt: null, lastPrompt: null, displayTitle: sid, lastInputAt: 1,
    promptCount: 1, live: null, goals: [],
  };
}

describe("directory governance", () => {
  test("distinguishes Git worktrees from historical working directories and builds a non-destructive archive plan", () => {
    const projects = [project("missing-project", "/gone/project"), project("live-project", "/live/repo")];
    const sessions = [
      session("missing-project", "a", "/gone/project", null),
      session("missing-project", "b", "/gone/wt", "/gone/wt"),
      session("live-project", "c", "/live/wt", "/live/wt"),
      session("live-project", "d", "/gone/history", null),
      session("live-project", "e", null, null),
    ];
    const audit = auditDirectories(projects, sessions, [], (path) => path.startsWith("/live/"));

    expect(audit.summary).toEqual({
      projectRoots: 2, missingProjectRoots: 1, unknownProjectRoots: 0,
      directoryGroups: 5, missingDirectoryGroups: 3,
      gitWorktrees: 2, historicalDirectories: 3, unknownDirectories: 0,
    });
    expect(audit.archivePlan.projectKeys).toEqual(["missing-project"]);
    expect(audit.archivePlan.worktrees).toEqual([
      { projectKey: "live-project", root: "/gone/history" },
    ]);
    expect(audit.directories.find((item) => item.root === "/gone/wt")?.kind).toBe("git-worktree");
    expect(audit.directories.find((item) => item.root === "/gone/history")?.kind).toBe("historical-directory");
    expect(audit.directories.every((item) => item.sessionCount > 0)).toBe(true);
  });

  test("reports unresolved groups but never creates an empty-path worktree archive target", () => {
    const audit = auditDirectories(
      [project("unknown", "")],
      [session("unknown", "orphan", null, null)],
      [],
      () => false,
    );
    expect(audit.summary).toMatchObject({
      missingProjectRoots: 0, unknownProjectRoots: 1, missingDirectoryGroups: 0, unknownDirectories: 1,
    });
    expect(audit.archivePlan).toEqual({ projectKeys: [], worktrees: [] });
    expect(audit.directories[0]).toMatchObject({ root: "", kind: "unknown", exists: false, missing: false });
  });
});
