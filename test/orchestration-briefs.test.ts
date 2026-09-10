import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildOrchestrationBriefs, ensureGroupBriefSchema, applyGroupBriefReceipts, markGroupBriefRead, rememberGroupBriefMemberships,
  type BriefWithSession } from "../src/orchestration-briefs";
import type { OrchestrationRun } from "../src/orchestration";
import { emptySession } from "../src/sources/transcript";
import type { SessionRow } from "../src/types";

function row(sid: string, status = "done", env?: string): SessionRow {
  return { ...emptySession({ agent: "codex", sid, path: "/fixture", size: 0, mtime: 0 }),
    ...(env ? { env } : {}), projectKey: "project", displayTitle: sid, goals: [], lastPrompt: "协调者最新用户输入", lastInputAt: 11,
    live: { status, updatedAt: 20, pid: null, waitingFor: null, name: null, handle: `terminal-${sid}` } };
}
function brief(session: SessionRow, at = 30): BriefWithSession {
  return { id: `${session.env || "local"}-${session.sid}-${at}`, agent: session.agent, sid: session.sid,
    ...(session.env ? { env: session.env } : {}), input: "任务输入", inputAt: 11,
    response: `完成结果 ${session.sid}`, completedAt: at, readAt: null, session };
}
function run(coordinator: SessionRow, workers: SessionRow[], runId = "run-one", createdAt = 10): OrchestrationRun {
  return { runId, objective: "整组目标", createdAt, updatedAt: 40, coordinator,
    workers: workers.map((worker) => ({ ...worker, taskTitle: worker.sid })) };
}

describe("run-level completion briefs", () => {
  test("a child does not become a standalone unread item when its run leaves the source window", () => {
    const db = new Database(":memory:"); ensureGroupBriefSchema(db);
    try {
      const parent = row("parent"), child = row("child"), item = brief(child);
      const grouped = buildOrchestrationBriefs([run(parent, [child])], [item], [parent, child]);
      rememberGroupBriefMemberships(db, grouped.memberships, grouped.briefs);
      expect(rememberGroupBriefMemberships(db, [], [item])).toEqual([]);
    } finally { db.close(); }
  });
  test("child completions only update progress while the coordinator is working", () => {
    const parent = row("parent", "working"), child = row("child"), other = row("ordinary");
    const result = buildOrchestrationBriefs([run(parent, [child])], [brief(child), brief(other)], [parent, child]);
    expect(result.briefs.map((item) => item.sid)).toEqual(["ordinary"]);
    expect(result.groups[0]).toMatchObject({ status: "working", requiresReview: false, notificationKey: null,
      coordinatorStatus: "working", input: "协调者最新用户输入", counts: { total: 1, completed: 1 } });
  });

  test("all workers done requires a later coordinator summary before group completion", () => {
    const parent = row("parent"), child = row("child"), runs = [run(parent, [child])];
    const early = buildOrchestrationBriefs(runs, [brief(parent, 20), brief(child, 30)], [parent, child]);
    expect(early.groups[0]?.status).toBe("summarizing"); expect(early.groups[0]?.requiresReview).toBeFalse();
    const final = buildOrchestrationBriefs(runs, [brief(parent, 40), brief(child, 30)], [parent, child]);
    expect(final.briefs).toHaveLength(0);
    expect(final.groups[0]).toMatchObject({ status: "completed", requiresReview: true, response: "完成结果 parent" });
  });

  test("a blocked member generates one group alert; unrelated worker progress does not re-alert", () => {
    const parent = row("parent", "working"), blocked = row("blocked", "waiting"), done = row("done");
    const runs = [run(parent, [blocked, done])], rows = [parent, blocked, done];
    const first = buildOrchestrationBriefs(runs, [], rows).groups[0]!;
    const second = buildOrchestrationBriefs(runs, [brief(done)], rows).groups[0]!;
    expect(first.status).toBe("attention"); expect(first.notificationKey).toBe(second.notificationKey);
  });

  test("separate runs of one coordinator have separate summaries and receipts", () => {
    const parent = row("parent"), child = row("child");
    const runs = [run(parent, [child], "old", 10), run(parent, [child], "new", 100)];
    const groups = buildOrchestrationBriefs(runs, [brief(child, 20), brief(parent, 30), brief(child, 110), brief(parent, 120)], [parent, child]).groups;
    expect(groups).toHaveLength(2); expect(new Set(groups.map((group) => group.id)).size).toBe(2);
    expect(groups.find((group) => group.runId === "old")?.summary?.completedAt).toBe(30);
    expect(groups.find((group) => group.runId === "new")?.summary?.completedAt).toBe(120);
  });

  test("a same-sid local session is not absorbed into a remote group", () => {
    const parent = row("parent", "done", "n1"), child = row("shared", "done", "n1"), local = row("shared");
    const result = buildOrchestrationBriefs([run(parent, [child])], [brief(child), brief(local)], [parent, child, local]);
    expect(result.briefs.map((item) => item.id)).toEqual([brief(local).id]);
    expect(result.groups[0]?.members[0]?.session?.env).toBe("n1");
  });

  test("read receipts persist per notification, so a later final summary becomes unread", () => {
    const db = new Database(":memory:"); ensureGroupBriefSchema(db);
    try {
      const parent = row("parent"), child = row("child"), runs = [run(parent, [child])], rows = [parent, child];
      const first = buildOrchestrationBriefs(runs, [brief(child, 20), brief(parent, 30)], rows).groups[0]!;
      markGroupBriefRead(db, first.id, first.notificationKey!, true, 100);
      expect(applyGroupBriefReceipts(db, [first])[0]?.readAt).toBe(100);
      const next = buildOrchestrationBriefs(runs, [brief(child, 20), brief(parent, 50)], rows).groups[0]!;
      expect(next.id).toBe(first.id); expect(applyGroupBriefReceipts(db, [next])[0]?.readAt).toBeNull();
    } finally { db.close(); }
  });

  test("stale live evidence cannot promote an old summary to group completion", () => {
    const parent = row("parent"), child = row("child");
    const result = buildOrchestrationBriefs([run(parent, [child])], [brief(child, 20), brief(parent, 30)], [parent, child], false);
    expect(result.groups[0]).toMatchObject({ status: "unknown", requiresReview: false });
  });
});
