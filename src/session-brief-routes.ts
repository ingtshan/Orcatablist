import type { OrcaDatabase } from "./db";
import { isVisibleOnBoard } from "./focus-board";
import { ValidationError } from "./focus";
import { assertJsonRequest, assertSameOriginWrite, json, jsonObject } from "./http";
import type { ProjectPreferencesStore } from "./project-preferences";
import { completeLiveBriefs, getBrief, listBriefs, markBriefsRead } from "./session-briefs";
import { sessionIdentityKey } from "./session-identity";
import type { SessionLiveReader } from "./session-live";
import { worktreePreferenceKey } from "./worktree-identity";
import type { OrchestrationReader } from "./orchestration";
import { orchestrationSessionRows } from "./orchestration-sessions";
import { applyGroupBriefReceipts, buildOrchestrationBriefs, markGroupBriefRead, rememberGroupBriefMemberships } from "./orchestration-briefs";

const ROUTE = "/api/session-briefs";
const MAX_READ_IDS = 5_000;
const BRIEF_ID = /^[a-f0-9]{64}$/;

export interface SessionBriefRouteDeps {
  db: OrcaDatabase;
  liveReader: SessionLiveReader;
  preferences: ProjectPreferencesStore;
  orchestrationReader?: OrchestrationReader;
}

export async function handleSessionBriefRequest(request: Request, url: URL, deps: SessionBriefRouteDeps): Promise<Response | null> {
  if (url.pathname !== ROUTE && !url.pathname.startsWith(ROUTE + "/")) return null;
  if (url.pathname === ROUTE && request.method === "GET") {
    const snapshot = await deps.liveReader.refreshSnapshot();
    if (snapshot.sources.length && snapshot.sources.every((source) => source.ok && !source.stale)) {
      completeLiveBriefs(deps.db.raw, snapshot.live);
    }
    const projects = deps.preferences.apply(deps.db.listProjects());
    const visibility = {
      archivedProjects: new Set(projects.filter((project) => project.archived).map((project) => project.key)),
      archivedWorktrees: new Set(deps.preferences.listWorktreePreferences().filter((item) => item.archived)
        .map((item) => worktreePreferenceKey(item.projectKey, item.root))),
      projectRoots: new Map(projects.map((project) => [project.key, project.root])),
    };
    const briefs = listBriefs(deps.db.raw);
    const sessions = deps.db.getSessionsByIdentity(briefs);
    const liveAvailable = snapshot.sources.every((source) => source.ok && !source.stale);
    const visibleBriefs = briefs.flatMap((brief) => {
      const key = sessionIdentityKey(brief.agent, brief.sid, brief.env);
      const session = sessions.get(key);
      const live = liveAvailable ? snapshot.live.get(key) ?? null : null;
      return session && isVisibleOnBoard(session, visibility) ? [{ ...brief, session: { ...session, live } }] : [];
    });
    if (!deps.orchestrationReader) return json({ briefs: visibleBriefs });
    const orchestration = deps.orchestrationReader.refresh();
    const rows = orchestrationSessionRows(deps.db, orchestration.runs, liveAvailable ? snapshot.live : new Map())
      .filter((row) => isVisibleOnBoard(row, visibility));
    const visibleKeys = new Set(rows.map((row) => sessionIdentityKey(row.agent, row.sid, row.env)));
    const runs = orchestration.runs.filter((run) => [run.coordinator, ...run.workers]
      .some((member) => member && visibleKeys.has(sessionIdentityKey(member.agent, member.sid, member.env))));
    const result = buildOrchestrationBriefs(runs, visibleBriefs, rows, liveAvailable);
    return json({ briefs: rememberGroupBriefMemberships(deps.db.raw, result.memberships, result.briefs), groups: applyGroupBriefReceipts(deps.db.raw, result.groups),
      orchestrationAvailable: orchestration.available, warnings: orchestration.warnings });
  }
  if (url.pathname === ROUTE + "/group-read" && request.method === "POST") {
    assertSameOriginWrite(request); assertJsonRequest(request);
    const body = await jsonObject(request);
    if (typeof body.id !== "string" || !BRIEF_ID.test(body.id) || typeof body.notificationKey !== "string"
      || !BRIEF_ID.test(body.notificationKey) || typeof body.read !== "boolean") throw new ValidationError("invalid group read receipt");
    return json({ id: body.id, notificationKey: body.notificationKey,
      readAt: markGroupBriefRead(deps.db.raw, body.id, body.notificationKey, body.read) });
  }
  if (url.pathname === ROUTE + "/read" && request.method === "POST") {
    assertSameOriginWrite(request);
    assertJsonRequest(request);
    const body = await jsonObject(request);
    if (!Array.isArray(body.ids) || body.ids.length > MAX_READ_IDS
      || body.ids.some((id) => typeof id !== "string" || !BRIEF_ID.test(id)) || typeof body.read !== "boolean") {
      throw new ValidationError("invalid brief read receipt");
    }
    const ids = [...new Set(body.ids as string[])];
    const readAt = body.read ? Date.now() : null;
    markBriefsRead(deps.db.raw, ids, body.read, readAt ?? undefined);
    return json({ ids, read: body.read, readAt });
  }
  if (request.method === "GET" && url.pathname.startsWith(ROUTE + "/")) {
    const id = url.pathname.slice(ROUTE.length + 1);
    if (!BRIEF_ID.test(id)) throw new ValidationError("invalid brief ID");
    const brief = getBrief(deps.db.raw, id);
    return brief ? json(brief) : json({ error: "brief not found" }, 404);
  }
  return json({ error: "method not allowed" }, 405);
}
