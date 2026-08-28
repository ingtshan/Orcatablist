import { describe, expect, test } from "bun:test";
import { createOrcaWorktreeAuditReader, type CommandResult } from "../src/orca-worktree-audit";

const worktrees = [
  {
    id: "repo::/ready", path: "/ready", projectId: "github:feibo-ai/lumina", displayName: "ready",
    branch: "refs/heads/ready", head: "aaa", isMainWorktree: false, isArchived: false,
    workspaceStatus: "completed", comment: "merged into integration/main", linkedPR: null,
  },
  {
    id: "repo::/review", path: "/review", projectId: "github:feibo-ai/lumina", displayName: "review",
    branch: "refs/heads/review", head: "bbb", isMainWorktree: false, isArchived: false,
    workspaceStatus: "completed", comment: "browser QA passed", linkedPR: null,
  },
  {
    id: "repo::/main", path: "/main", projectId: "github:usekaneo/kaneo", displayName: "main",
    branch: "refs/heads/main", head: "ccc", isMainWorktree: true, isArchived: false,
    workspaceStatus: "completed", comment: "done", linkedPR: null,
  },
  {
    id: "repo::/active", path: "/active", projectId: "github:feibo-ai/lumina", displayName: "active",
    branch: "refs/heads/active", head: "ddd", isMainWorktree: false, isArchived: false,
    workspaceStatus: "in-progress", comment: "", linkedPR: null,
  },
];

describe("Orca completed-worktree audit", () => {
  test("uses only read-only Orca commands and classifies merge evidence, review, and dirty main worktrees", async () => {
    const commands: string[][] = [];
    let now = 1;
    const run = async (argv: string[]): Promise<CommandResult> => {
      commands.push(argv);
      if (argv[0] === "orca" && argv[1] === "worktree") {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { worktrees, totalCount: 4 } }), stderr: "" };
      }
      if (argv[0] === "orca" && argv[1] === "terminal") {
        return { exitCode: 0, stdout: JSON.stringify({
          ok: true, result: { terminals: [{ worktreePath: "/ready", connected: true, orphaned: false }] },
        }), stderr: "" };
      }
      if (argv.includes("status")) {
        return { exitCode: 0, stdout: argv.includes("/main") ? " M README.md\n?? local.txt\n" : "", stderr: "" };
      }
      if (argv.includes("merge-base")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    };
    const reader = createOrcaWorktreeAuditReader({
      run, pathExists: () => true, now: () => now, cacheMs: 100,
    });

    const audit = await reader.refresh();
    expect(audit.summary).toEqual({
      totalWorktrees: 4, completedWorktrees: 3, archivedWorktrees: 0,
      ready: 1, review: 1, hold: 1,
      lumina: { total: 3, completed: 2, inProgress: 1, inReview: 0, archived: 0 },
    });
    expect(audit.items.map((item) => [item.name, item.recommendation])).toEqual([
      ["ready", "ready"], ["review", "review"], ["main", "hold"],
    ]);
    expect(audit.items[0]).toMatchObject({
      mergeTarget: "integration/main", headInMergeTarget: true, dirtyFileCount: 0, connectedTerminals: 1,
    });
    expect(audit.items[2]?.reasons).toContain("主 worktree 不应随完成任务一起隐藏");
    expect(audit.items[2]?.dirtyFileCount).toBe(2);
    expect(commands.filter((argv) => argv[0] === "orca")).toEqual([
      ["orca", "worktree", "list", "--json"],
      ["orca", "terminal", "list", "--json"],
    ]);

    const commandCount = commands.length;
    expect(await reader.refresh()).toBe(audit);
    expect(commands).toHaveLength(commandCount);
    now = 200;
    await reader.refresh();
    expect(reader.getVersion()).toBe(1);
  });
});
