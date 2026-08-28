import { createGatewayReader, type GatewayReader } from "./nginx-config";
import { conditionalJson } from "./http";
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
    return conditionalJson(request, `"g-${readers.gateway.getVersion()}"`, () => snapshot);
  }
  if (url.pathname === "/api/worktree-resources") {
    const roots = db.listSessions({ limit: DISCOVERY_SESSION_LIMIT })
      .map((session) => session.worktreeRoot || session.cwd).filter((root): root is string => Boolean(root));
    const snapshot = await readers.resources.refresh(roots);
    return conditionalJson(request, `"r-${readers.resources.getVersion()}"`, () => snapshot);
  }
  return null;
}
