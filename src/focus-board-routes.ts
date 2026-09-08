import type { OrcaDatabase } from "./db";
import {
  assignFocusLanes, focusDayBoundaries, type FocusBoard, type FocusVisibility,
} from "./focus-board";
import type { GoalsStore } from "./goals";
import { serveFresh, versionSource } from "./freshness";
import type { ProjectPreferencesStore } from "./project-preferences";
import type { SessionLiveReader } from "./session-live";
import { sessionIdentityKey } from "./session-identity";
import type { LiveInfo, SessionRow } from "./types";
import { resolveLiveSessionRows } from "./unindexed-live";
import { worktreePreferenceKey } from "./worktree-identity";

const ROUTE = "/api/board/focus";

export interface FocusBoardRouteDeps {
  db: OrcaDatabase;
  goalsStore: GoalsStore;
  preferences: ProjectPreferencesStore;
  liveReader: SessionLiveReader;
  now?(): number;
}

export interface FocusBoardPayload extends FocusBoard {
  indexedAt: number | null;
  listVersion: number;
}

function boardVisibility(db: OrcaDatabase, preferences: ProjectPreferencesStore): FocusVisibility {
  const projects = preferences.apply(db.listProjects());
  return {
    archivedProjects: new Set(projects.filter((project) => project.archived).map((project) => project.key)),
    archivedWorktrees: new Set(preferences.listWorktreePreferences()
      .filter((preference) => preference.archived)
      .map((preference) => worktreePreferenceKey(preference.projectKey, preference.root))),
    projectRoots: new Map(projects.map((project) => [project.key, project.root ?? ""])),
  };
}

/**
 * Only sessions that are live can appear on the board, so the rows are looked up by identity
 * rather than by scanning the session table. The old route listed 5000 rows and attached goals to
 * all of them on every status change, to return the dozen that were actually running.
 *
 * The lookup itself is the shared authoritative join, so the board and the session list agree on
 * which identities the index knows — and a genuinely unindexed remote session keeps its `env`,
 * which is the only thing distinguishing it from a local session with the same agent and sid.
 */
export function focusBoardRows(db: OrcaDatabase, goalsStore: GoalsStore, live: Map<string, LiveInfo>): SessionRow[] {
  return resolveLiveSessionRows(db, live, {
    attachGoals: (rows) => {
      const goals = goalsStore.goalsForSessions(rows.map(({ agent, sid }) => ({ agent, sid })));
      return rows.map((row) => ({ ...row, goals: goals.get(sessionIdentityKey(row.agent, row.sid)) ?? [] }));
    },
  }).map((entry) => entry.session);
}

export async function handleFocusBoardRequest(
  request: Request,
  url: URL,
  deps: FocusBoardRouteDeps,
): Promise<Response | null> {
  if (request.method !== "GET" || url.pathname !== ROUTE) return null;
  const now = deps.now ?? Date.now;
  const at = now();
  const snapshot = await deps.liveReader.refreshSnapshot();
  const indexedAt = deps.db.getMeta("indexed_at");
  return serveFresh(request, "focus-board", [
    versionSource("list", () => deps.db.getListVersion()),
    versionSource("live", () => deps.liveReader.getLiveVersion()),
    versionSource("goals", () => deps.goalsStore.goalsVersion),
    versionSource("projects", () => deps.preferences.preferencesVersion),
    versionSource("worktrees", () => deps.preferences.worktreePreferencesVersion),
    // The day boundary is an input to lane assignment, so it is an input to the ETag: without it
    // a client holds yesterday's "today" lane across midnight and never re-fetches.
    versionSource("day", () => focusDayBoundaries(at).today),
  ], (): FocusBoardPayload => ({
    ...assignFocusLanes(focusBoardRows(deps.db, deps.goalsStore, snapshot.live), {
      now: at,
      visibility: boardVisibility(deps.db, deps.preferences),
      sources: snapshot.sources,
      liveAt: snapshot.at === 0 ? null : snapshot.at,
    }),
    indexedAt: indexedAt === null ? null : Number(indexedAt),
    listVersion: deps.db.getListVersion(),
  }));
}
