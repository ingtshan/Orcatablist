import { serveFresh, versionSource } from "./freshness";
import type { OrcaWorktreeAuditReader } from "./orca-worktree-audit";

export async function handleOrcaAuditRequest(
  request: Request,
  url: URL,
  reader: OrcaWorktreeAuditReader,
): Promise<Response | null> {
  if (request.method !== "GET" || url.pathname !== "/api/orca-worktree-audit") return null;
  const snapshot = await reader.refresh();
  return serveFresh(request, "orca-audit", [
    versionSource("orca-audit", reader.getVersion),
  ], () => snapshot);
}
