import type { OrcaDatabase } from "./db";
import type { OrchestrationRun } from "./orchestration";
import { sessionIdentityKey } from "./session-identity";
import { mergeSessionLive } from "./session-live";
import type { LiveInfo, SessionRow } from "./types";
import { resolveLiveSessionRows } from "./unindexed-live";

/** Fetch exact run members, including offline parents and siblings outside the live board. */
export function orchestrationSessionRows(
  db: OrcaDatabase, runs: readonly OrchestrationRun[], live: Map<string, LiveInfo>,
): SessionRow[] {
  const members = runs.flatMap((run) => [...(run.coordinator ? [run.coordinator] : []), ...run.workers]);
  const keys = new Set<string>(members.map((member) => sessionIdentityKey(member.agent, member.sid, member.env)));
  const indexed = db.getSessionsByIdentity(members);
  const memberLive = new Map([...live].filter(([key]) => keys.has(key)));
  const rows = new Map(mergeSessionLive([...indexed.values()], memberLive)
    .map((row) => [sessionIdentityKey(row.agent, row.sid, row.env), row]));
  for (const entry of resolveLiveSessionRows(db, memberLive)) {
    const row = entry.session;
    rows.set(sessionIdentityKey(row.agent, row.sid, row.env), row);
  }
  return [...rows.values()];
}
