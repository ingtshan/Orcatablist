import { conditionalJson } from "./http";
import type { OrcaWorktreeAuditReader } from "./orca-worktree-audit";

export async function handleOrcaAuditRequest(
  request: Request,
  url: URL,
  reader: OrcaWorktreeAuditReader,
): Promise<Response | null> {
  if (request.method !== "GET" || url.pathname !== "/api/orca-worktree-audit") return null;
  const snapshot = await reader.refresh();
  return conditionalJson(request, `"o-${reader.getVersion()}"`, () => snapshot);
}
