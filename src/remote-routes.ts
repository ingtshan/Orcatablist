import type { OrcaDatabase } from "./db";
import type { OrcaJsonResult } from "./focus";
import { assertSameOriginWrite, json, jsonObject, requiredString } from "./http";
import {
  validateEnvironmentName, validateEnvironmentPatch,
  type EnvironmentConfig, type EnvironmentStore,
} from "./remote-environments";
import type { EnvironmentHealth, RemoteIndexing } from "./remote-poller";
import { runProbe, type ProbeResult } from "./remote-pull";

export interface EnvironmentCandidate { name: string; host: string | null; }
export interface RemoteRouteDeps {
  db: OrcaDatabase;
  store: EnvironmentStore;
  indexing: RemoteIndexing;
  orcaJson(args: string[]): Promise<OrcaJsonResult>;
  probe?(config: Pick<EnvironmentConfig, "sshUser" | "sshHost" | "sshPort">): Promise<ProbeResult>;
}

interface EnvironmentPayload extends EnvironmentConfig { health: EnvironmentHealth | null; }

function environmentPayloads(store: EnvironmentStore, indexing: RemoteIndexing): EnvironmentPayload[] {
  const health = new Map(indexing.health().map((entry) => [entry.name, entry]));
  return store.list().map((config) => ({ ...config, health: health.get(config.name) ?? null }));
}

interface OrcaEnvironmentEntry { name?: unknown; endpoints?: unknown; }

function hostFromEndpoints(endpoints: unknown): string | null {
  if (!Array.isArray(endpoints)) return null;
  for (const endpoint of endpoints as Array<{ endpoint?: unknown }>) {
    if (typeof endpoint?.endpoint !== "string") continue;
    try { return new URL(endpoint.endpoint).hostname; } catch { continue; }
  }
  return null;
}

/** Pre-fills the GUI's "add machine" form from `orca environment list` — names first, host guessed from the ws endpoint. */
async function listCandidates(deps: RemoteRouteDeps): Promise<EnvironmentCandidate[]> {
  const response = await deps.orcaJson(["environment", "list", "--json"]);
  if (!response.ok) return [];
  const entries = (response.result as { environments?: unknown } | undefined)?.environments;
  if (!Array.isArray(entries)) return [];
  return (entries as OrcaEnvironmentEntry[]).flatMap((entry) => {
    if (typeof entry.name !== "string" || !entry.name) return [];
    return [{ name: entry.name, host: hostFromEndpoints(entry.endpoints) }];
  });
}

export async function handleEnvironmentRequest(
  request: Request,
  url: URL,
  deps: RemoteRouteDeps,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/environments")) return null;
  if (request.method === "GET" && url.pathname === "/api/environments") {
    return json({ environments: environmentPayloads(deps.store, deps.indexing) });
  }
  if (request.method === "GET" && url.pathname === "/api/environments/candidates") {
    const existing = new Set(deps.store.list().map((config) => config.name));
    const candidates = (await listCandidates(deps)).filter((candidate) => !existing.has(candidate.name));
    return json({ candidates });
  }
  if (request.method === "POST" && url.pathname === "/api/environments") {
    assertSameOriginWrite(request);
    const body = await jsonObject(request);
    const config = validateEnvironmentPatch({
      name: body.name, sshUser: body.sshUser, sshHost: body.sshHost, sshPort: body.sshPort,
      enabled: body.enabled, agents: body.agents, pollMs: body.pollMs,
    });
    const saved = deps.store.upsert(config);
    deps.indexing.reload();
    if (saved.enabled) deps.indexing.kick(saved.name);
    return json({ environments: environmentPayloads(deps.store, deps.indexing), saved: saved.name });
  }
  if (request.method === "POST" && url.pathname === "/api/environments/delete") {
    assertSameOriginWrite(request);
    const body = await jsonObject(request);
    const name = validateEnvironmentName(requiredString(body.name, "name"));
    const removed = deps.store.remove(name);
    deps.indexing.reload();
    if (removed) deps.db.purgeEnvironment(name);
    return json({ removed, environments: environmentPayloads(deps.store, deps.indexing) });
  }
  if (request.method === "POST" && url.pathname === "/api/environments/probe") {
    assertSameOriginWrite(request);
    const body = await jsonObject(request);
    // Probe validates the connection details alone — the form runs it before anything is saved.
    const candidate = validateEnvironmentPatch({
      name: body.name ?? "probe-target", sshUser: body.sshUser, sshHost: body.sshHost, sshPort: body.sshPort,
    });
    const probe = deps.probe ?? runProbe;
    return json({ probe: await probe(candidate) });
  }
  return null;
}
