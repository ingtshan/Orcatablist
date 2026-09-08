import type { OrcaDatabase } from "./db";
import { ValidationError } from "./focus";
import { serveFresh, versionSource } from "./freshness";
import { json, jsonObject, requiredString } from "./http";
import type { ProjectPreferencesStore } from "./project-preferences";
import type { SessionLiveReader } from "./session-live";
import { resolveLiveSessionRows } from "./unindexed-live";
import { resolveWorktreeRoot } from "./worktree-identity";

export class NotFoundError extends Error { override name = "NotFoundError"; }

function booleanPatch(body: Record<string, unknown>, subject: string): { pinned?: boolean; archived?: boolean } {
  if (body.pinned !== undefined && typeof body.pinned !== "boolean") throw new ValidationError("pinned must be a boolean");
  if (body.archived !== undefined && typeof body.archived !== "boolean") throw new ValidationError("archived must be a boolean");
  if (body.pinned === undefined && body.archived === undefined) throw new ValidationError("pinned or archived is required");
  if (body.pinned === true && body.archived === true) throw new ValidationError(`${subject} cannot be pinned and archived`);
  return { pinned: body.pinned as boolean | undefined, archived: body.archived as boolean | undefined };
}

export async function handleProjectRequest(
  request: Request,
  url: URL,
  db: OrcaDatabase,
  preferences: ProjectPreferencesStore,
  liveReader?: Pick<SessionLiveReader, "refresh">,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/projects") {
    return serveFresh(request, "projects", [
      versionSource("list", () => db.getListVersion()),
      versionSource("projects", () => preferences.preferencesVersion),
    ], () => preferences.apply(db.listProjects()));
  }
  if (request.method === "PATCH" && url.pathname === "/api/projects") {
    const body = await jsonObject(request);
    const projectKey = requiredString(body.projectKey, "projectKey");
    const patch = booleanPatch(body, "project");
    const project = db.listProjects().find((candidate) => candidate.key === projectKey);
    if (!project) throw new NotFoundError("project not found");
    preferences.update(projectKey, patch);
    return json(preferences.apply([project])[0]);
  }
  if (request.method === "GET" && url.pathname === "/api/worktrees") {
    return serveFresh(request, "worktrees", [
      versionSource("worktrees", () => preferences.worktreePreferencesVersion),
    ], () => preferences.listWorktreePreferences());
  }
  if (request.method !== "PATCH" || url.pathname !== "/api/worktrees") return null;

  const body = await jsonObject(request);
  const projectKey = requiredString(body.projectKey, "projectKey");
  const root = requiredString(body.root, "root");
  const patch = booleanPatch(body, "worktree");
  const project = db.listProjects().find((candidate) => candidate.key === projectKey);
  if (!project) throw new NotFoundError("project not found");
  // Scoped by project: a stale preference is clearable only through the project that stored it,
  // never through another project that happens to share the path.
  const preference = preferences.getWorktreePreference(projectKey, root);
  const canClearStale = preference !== null
    && ((patch.archived === false && preference.archived) || (patch.pinned === false && preference.pinned));
  let knownWorktree = db.hasWorktree(projectKey, root) || canClearStale;
  if (!knownWorktree && liveReader) {
    // A remote transcript may record a nested cwd while its live tab supplies the worktree root.
    // Validate the same projection the page groups; an unindexed tab alone cannot grant a write.
    const live = await liveReader.refresh();
    knownWorktree = resolveLiveSessionRows(db, live).some((entry) => entry.indexed
      && entry.session.projectKey === projectKey
      && resolveWorktreeRoot(entry.session, project.root ?? "") === root);
  }
  if (!knownWorktree) throw new NotFoundError("worktree not found");
  return json(preferences.updateWorktree(projectKey, root, patch));
}
