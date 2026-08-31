import { createGatewayReader, type GatewayReader } from "./nginx-config";
import { serveFresh, versionSource } from "./freshness";
import type { OrcaDatabase } from "./db";
import { createWorktreeResourceReader, type WorktreeResourceReader } from "./worktree-resources";

const DISCOVERY_SESSION_LIMIT = 5_000;

export interface DiscoveryReaders {
  gateway: GatewayReader;
  resources: WorktreeResourceReader;
}

export function createDiscoveryReaders(): DiscoveryReaders {
  const gateway = createGatewayReader();
  return { gateway, resources: createWorktreeResourceReader({ gatewayReader: gateway }) };
}

export async function handleDiscoveryRequest(
  request: Request,
  url: URL,
  db: OrcaDatabase,
  readers: DiscoveryReaders,
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  if (url.pathname === "/api/gateway") {
    const snapshot = await readers.gateway.refresh();
    return serveFresh(request, "gateway", [
      versionSource("gateway", readers.gateway.getVersion),
    ], () => snapshot);
  }
  if (url.pathname === "/api/worktree-resources") {
    const roots = db.listSessions({ limit: DISCOVERY_SESSION_LIMIT })
      .map((session) => session.worktreeRoot || session.cwd).filter((root): root is string => Boolean(root));
    const snapshot = await readers.resources.refresh(roots);
    return serveFresh(request, "resources", [
      versionSource("resources", readers.resources.getVersion),
    ], () => snapshot);
  }
  return null;
}
