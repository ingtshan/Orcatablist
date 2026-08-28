import { existsSync } from "node:fs";
import type { OrcaDatabase } from "./db";
import { auditDirectories, type DirectoryAudit } from "./directory-governance";
import { json } from "./http";
import type { ProjectPreferencesStore } from "./project-preferences";

const GOVERNANCE_SESSION_LIMIT = 5_000;

export interface GovernanceOptions {
  pathExists?(path: string): boolean;
  now?(): number;
}

function currentAudit(
  db: OrcaDatabase,
  preferences: ProjectPreferencesStore,
  options: GovernanceOptions,
): DirectoryAudit {
  return auditDirectories(
    preferences.apply(db.listProjects()),
    db.listSessions({ limit: GOVERNANCE_SESSION_LIMIT }),
    preferences.listWorktreePreferences(),
    options.pathExists ?? existsSync,
    options.now ?? Date.now,
  );
}

export async function handleGovernanceRequest(
  request: Request,
  url: URL,
  db: OrcaDatabase,
  preferences: ProjectPreferencesStore,
  options: GovernanceOptions = {},
): Promise<Response | null> {
  if (url.pathname === "/api/directory-audit" && request.method === "GET") {
    return json(currentAudit(db, preferences, options));
  }
  if (url.pathname !== "/api/directory-audit/archive-missing" || request.method !== "POST") return null;

  const before = db.countSessions();
  const plan = currentAudit(db, preferences, options).archivePlan;
  const applied = preferences.archiveBatch(plan.projectKeys, plan.worktrees);
  const after = db.countSessions();
  if (after !== before) throw new Error(`directory archive changed indexed sessions: ${before} -> ${after}`);
  return json({
    applied,
    indexedSessionsPreserved: after,
    audit: currentAudit(db, preferences, options),
  });
}
