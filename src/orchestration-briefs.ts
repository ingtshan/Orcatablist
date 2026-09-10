import type { Database } from "bun:sqlite";
import type { OrchestrationRun } from "./orchestration";
import { identityKey, type SessionIdentity } from "./session-identity";
import { briefHash, inputPreview } from "./session-brief-events";
import type { SessionBrief } from "./session-briefs";
import type { SessionRow } from "./types";

export interface BriefWithSession extends SessionBrief { session: SessionRow; }
export interface GroupBriefMember {
  identity: SessionIdentity; taskTitle: string; session: SessionRow | null;
  status: string; brief: BriefWithSession | null;
}
export interface OrchestrationBrief {
  id: string; kind: "group"; runId: string; objective: string;
  session: SessionRow | null; coordinatorStatus: string; input: string; inputAt: number | null;
  response: string; summary: BriefWithSession | null; members: GroupBriefMember[];
  status: "working" | "attention" | "completed" | "summarizing" | "unknown";
  counts: { total: number; completed: number; working: number; attention: number; unknown: number };
  completedAt: number; notificationKey: string | null; readAt: number | null; requiresReview: boolean;
}

const ACTIVE = new Set(["working", "busy"]);
const ATTENTION = new Set(["waiting", "error", "failed"]);
const key = (member: SessionIdentity) => identityKey(member);
const belongs = (run: OrchestrationRun, member: SessionIdentity) =>
  (run.coordinator && key(run.coordinator) === key(member)) || run.workers.some((worker) => key(worker) === key(member));

function owner(runs: readonly OrchestrationRun[], member: SessionIdentity, at: number) {
  return runs.filter((run) => belongs(run, member) && (run.createdAt ?? 0) <= at)
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.runId.localeCompare(right.runId))[0];
}

/** One notification per run: child completions update progress, never their own review count. */
export function buildOrchestrationBriefs(runs: readonly OrchestrationRun[], briefs: readonly BriefWithSession[], rows: readonly SessionRow[], liveAvailable = true) {
  const bySession = new Map(rows.map((row) => [key(row), row]));
  const assigned = new Map<string, BriefWithSession[]>();
  const absorbed = new Set<string>();
  const memberships: Array<{ briefId: string; runId: string }> = [];
  for (const brief of briefs) {
    const candidates = runs.filter((run) => belongs(run, brief) && (run.createdAt ?? 0) <= brief.completedAt);
    const explicit = candidates.filter((run) => `${brief.input}\n${brief.response}`.includes(run.runId));
    const run = explicit.length === 1 ? explicit[0] : owner(candidates, brief, brief.completedAt);
    if (!run) continue;
    assigned.set(run.runId, [...(assigned.get(run.runId) ?? []), brief]);
    absorbed.add(brief.id);
    memberships.push({ briefId: brief.id, runId: run.runId });
  }
  const groups = runs.map((run): OrchestrationBrief => {
    const runBriefs = [...(assigned.get(run.runId) ?? [])].sort((a, b) => b.completedAt - a.completedAt);
    const latest = (member: SessionIdentity) => runBriefs.find((brief) => key(brief) === key(member)) ?? null;
    const currentStatus = (member: SessionIdentity) => owner(runs, member, Infinity)?.runId === run.runId
      ? bySession.get(key(member))?.live?.status : undefined;
    const members = [...new Map(run.workers.map((member) => [key(member), member])).values()].map((member): GroupBriefMember => {
      const brief = latest(member);
      return { identity: member, taskTitle: member.taskTitle ?? "子任务", session: bySession.get(key(member)) ?? null,
        status: currentStatus(member) ?? (brief ? "done" : "unknown"), brief };
    });
    const session = run.coordinator ? bySession.get(key(run.coordinator)) ?? null : null;
    const summary = run.coordinator ? latest(run.coordinator) : null;
    const coordinatorStatus = !liveAvailable ? "unknown" : session?.live?.status ?? "offline";
    const ownStatus = run.coordinator ? currentStatus(run.coordinator) ?? (summary ? "done" : "unknown") : "unknown";
    const counts = { total: members.length, completed: 0, working: 0, attention: 0, unknown: 0 };
    for (const member of members) {
      if (member.status === "done") counts.completed += 1;
      else if (ACTIVE.has(member.status)) counts.working += 1;
      else if (ATTENTION.has(member.status)) counts.attention += 1;
      else counts.unknown += 1;
    }
    const lastChildCompletion = Math.max(run.createdAt ?? 0, ...members.map((member) => Math.max(member.brief?.completedAt ?? 0,
      owner(runs, member.identity, Infinity)?.runId === run.runId ? member.session?.lastInputAt ?? 0 : 0)));
    const summaryCurrent = summary && summary.completedAt >= lastChildCompletion
      && (owner(runs, run.coordinator!, Infinity)?.runId !== run.runId || (session?.lastInputAt ?? 0) <= summary.completedAt);
    const status = !liveAvailable ? "unknown" : counts.attention || ATTENTION.has(ownStatus) ? "attention"
      : counts.working || ACTIVE.has(ownStatus) ? "working"
      : counts.total > 0 && counts.completed === counts.total && summaryCurrent && ownStatus === "done" ? "completed"
      : counts.total > 0 && counts.completed === counts.total ? "summarizing" : "unknown";
    const notificationKey = status === "completed" ? briefHash([run.runId, "completed", summary!.id])
      : status === "attention" ? briefHash([run.runId, "attention",
        ATTENTION.has(ownStatus) ? [ownStatus, session?.live?.updatedAt] : null,
        members.filter((member) => ATTENTION.has(member.status)).map((member) => [key(member.identity), member.status, member.session?.live?.updatedAt])]) : null;
    return { id: briefHash(["group", run.runId, run.coordinator ? key(run.coordinator) : null]), kind: "group",
      runId: run.runId, objective: run.objective || "编排任务", session, coordinatorStatus,
      input: inputPreview(session?.lastPrompt ?? ""), inputAt: session?.lastInputAt ?? null,
      response: summary?.response ?? "", summary, members, counts, status,
      completedAt: Math.max(run.updatedAt ?? 0, ...runBriefs.map((brief) => brief.completedAt)),
      notificationKey, readAt: null, requiresReview: notificationKey !== null };
  });
  return { briefs: briefs.filter((brief) => !absorbed.has(brief.id)), groups: groups.sort((a, b) => b.completedAt - a.completedAt), memberships };
}

export function ensureGroupBriefSchema(database: Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS group_brief_receipts (
    id TEXT NOT NULL, notification_key TEXT NOT NULL, read_at INTEGER NOT NULL,
    PRIMARY KEY(id, notification_key)
  );
  CREATE TABLE IF NOT EXISTS group_brief_memberships (brief_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);`);
}

/** Remember ownership even when a run ages out of the orchestration source's retention window. */
export function rememberGroupBriefMemberships(database: Database, memberships: Array<{ briefId: string; runId: string }>, briefs: BriefWithSession[]) {
  database.transaction(() => {
    const insert = database.query("INSERT OR REPLACE INTO group_brief_memberships(brief_id, run_id) VALUES (?, ?)");
    for (const item of memberships) insert.run(item.briefId, item.runId);
  })();
  const rows = database.query("SELECT brief_id FROM group_brief_memberships WHERE brief_id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(briefs.map((brief) => brief.id))) as Array<{ brief_id: string }>;
  const grouped = new Set(rows.map((row) => row.brief_id));
  return briefs.filter((brief) => !grouped.has(brief.id));
}

export function applyGroupBriefReceipts(database: Database, groups: OrchestrationBrief[]): OrchestrationBrief[] {
  return groups.map((group) => {
    if (!group.notificationKey) return group;
    const receipt = database.query("SELECT read_at FROM group_brief_receipts WHERE id = ? AND notification_key = ?")
      .get(group.id, group.notificationKey) as { read_at: number } | null;
    return { ...group, readAt: receipt?.read_at ?? null };
  });
}

export function markGroupBriefRead(database: Database, id: string, notificationKey: string, read: boolean, at = Date.now()) {
  if (read) database.query("INSERT OR REPLACE INTO group_brief_receipts(id, notification_key, read_at) VALUES (?, ?, ?)").run(id, notificationKey, at);
  else database.query("DELETE FROM group_brief_receipts WHERE id = ? AND notification_key = ?").run(id, notificationKey);
  return read ? at : null;
}
