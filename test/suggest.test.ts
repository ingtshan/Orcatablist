import { describe, expect, test } from "bun:test";
import { sessionIdentityKey } from "../src/session-identity";
import { suggestSessions, tokens } from "../src/suggest";
import type { Goal, SessionRow } from "../src/types";

const goal: Goal = {
  id: "goal", name: "Agent migration", status: "active", externalRef: null,
  color: null, createdAt: 1, updatedAt: 1,
};

function session(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    agent: "claude", sid: id, projectKey: "/workspace/orcatab", cwd: "/workspace/orcatab", worktreeRoot: "/workspace/orcatab",
    branch: "main", title: null, firstPrompt: "Agent migration plan", lastPrompt: null,
    displayTitle: "Agent migration", lastInputAt: 1, promptCount: 1, live: null, goals: [],
    ...overrides,
  };
}

describe("suggestSessions", () => {
  test("scores and labels branch, project, and title evidence", () => {
    // Use a real feature branch: a shared default branch like "main" is deliberately not a signal.
    const confirmed = session("confirmed", { branch: "feature/agent-migration", displayTitle: "Agent migration baseline" });
    const candidate = session("candidate", { branch: "feature/agent-migration", lastInputAt: 10 });
    const results = suggestSessions(goal, [confirmed], new Set(), [confirmed, candidate]);
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(7);
    expect(results[0]?.reasons).toEqual([
      { code: "branch", label: "同分支 feature/agent-migration" },
      { code: "project", label: "同项目 orcatab" },
      { code: "title", label: "标题含 “agent”" },
    ]);
  });

  test("excludes both confirmed and dismissed identities", () => {
    const confirmed = session("confirmed");
    const dismissed = session("dismissed", { branch: "feature/other" });
    const eligible = session("eligible", { branch: "main" });
    const excluded = new Set([sessionIdentityKey(dismissed.agent, dismissed.sid)]);
    expect(suggestSessions(goal, [confirmed], excluded, [confirmed, dismissed, eligible]).map((row) => row.sid))
      .toEqual(["eligible"]);
  });

  test("uses goal name as project, branch, and title seed for a new goal", () => {
    const newGoal = { ...goal, name: "OrcaTab multi agent" };
    const candidate = session("seeded", {
      projectKey: "/workspace/orcatab", branch: "feature/agent-links",
      displayTitle: "OrcaTab agent evidence", firstPrompt: null,
    });
    const result = suggestSessions(newGoal, [], new Set(), [candidate])[0]!;
    expect(result.score).toBe(7);
    expect(result.reasons.map((reason) => reason.code)).toEqual(["project", "branch", "title"]);
    expect(result.reasons.map((reason) => reason.label)).toEqual([
      "项目含 “orcatab”", "分支含 “agent”", "标题含 “orcatab”",
    ]);
  });

  test("finds CJK adjacent bigram intersections", () => {
    const chineseGoal = { ...goal, name: "课堂目标" };
    const result = suggestSessions(chineseGoal, [], new Set(), [
      session("cjk", { projectKey: "/workspace/other", branch: "HEAD", displayTitle: "课堂目标复盘", firstPrompt: null }),
    ])[0]!;
    expect(result.score).toBe(3);
    expect(result.reasons).toEqual([{ code: "title", label: "标题含 “课堂”" }]);
  });

  test("applies threshold, timestamp ordering, and top-N", () => {
    const simpleGoal = { ...goal, name: "alpha beta" };
    const below = session("below", {
      projectKey: "/workspace/none", branch: null, displayTitle: "alpha only", firstPrompt: null, lastInputAt: 99,
    });
    const older = session("older", {
      projectKey: "/workspace/alpha", branch: null, displayTitle: "none", firstPrompt: null, lastInputAt: 1,
    });
    const newer = session("newer", {
      projectKey: "/workspace/beta", branch: null, displayTitle: "none", firstPrompt: null, lastInputAt: 2,
    });
    expect(suggestSessions(simpleGoal, [], new Set(), [below, older, newer], 1).map((row) => row.sid)).toEqual(["newer"]);
    expect(suggestSessions(simpleGoal, [], new Set(), [below])).toEqual([]);
    expect(suggestSessions(simpleGoal, [], new Set(), [older], 0)).toEqual([]);
  });

  test("tokenizes long Latin words and adjacent CJK while dropping short and numeric terms", () => {
    expect([...tokens("AI Agent agent 123 课堂树!")]).toEqual(["agent", "课堂", "堂树"]);
  });
});

test("a shared default branch (main) is not treated as evidence of shared intent", () => {
  const goal = { id: "g", name: "OrcaTab", status: "active" as const, externalRef: null, color: null, createdAt: 0, updatedAt: 0 };
  const row = (over: Partial<SessionRow>): SessionRow => ({
    agent: "codex", sid: "s", projectKey: "/x/other", cwd: "/x/other", worktreeRoot: "/x/other", branch: "main",
    title: null, firstPrompt: null, lastPrompt: null, displayTitle: "unrelated", lastInputAt: 1,
    promptCount: 1, live: null, goals: [], ...over,
  });
  const confirmed = [row({ sid: "c1", projectKey: "/x/orcatab", branch: "main", displayTitle: "P7 goals" })];
  // candidate: different project, but same generic branch "main" and no token overlap → must NOT be suggested
  const noise = row({ sid: "n1", projectKey: "/x/other", branch: "main", displayTitle: "unrelated task" });
  const out = suggestSessions(goal, confirmed, new Set(), [noise]);
  expect(out.find((s) => s.sid === "n1")).toBeUndefined();
  // but a real feature branch shared with a confirmed session still counts
  const confirmed2 = [row({ sid: "c2", projectKey: "/x/orcatab", branch: "feature/goals", displayTitle: "P7" })];
  const same = row({ sid: "n2", projectKey: "/x/other", branch: "feature/goals", displayTitle: "unrelated" });
  const out2 = suggestSessions(goal, confirmed2, new Set(), [same]);
  expect(out2.find((s) => s.sid === "n2")?.reasons.some((r) => r.code === "branch")).toBe(true);
});
