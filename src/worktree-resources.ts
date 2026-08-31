import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { createCachedSnapshot } from "./cached-snapshot";
import { ORCATAB_PM2_DUMP, RESOURCE_DISCOVERY_CACHE_MS } from "./config";
import type { GatewayReader, GatewayRoute } from "./nginx-config";

const COMMAND_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MS = 1_500;
const PROBE_CONCURRENCY = 8;
const SUCCESSFUL_PROBE_CACHE_MS = 60_000;
const MAX_PM2_DUMP_BYTES = 2 * 1_024 * 1_024;
const MAX_PM2_APPS = 256;

interface Pm2State {
  name?: unknown; status?: unknown; pm_cwd?: unknown; pm_pid_path?: unknown;
  env?: { PORT?: unknown } | null;
}
interface Pm2App { name: string; cwd: string; pid: number | null; envPort: number | null; }
interface ProcessRow { pid: number; ppid: number; }
interface Listener { pid: number; host: string; port: number; }
interface CandidateLink { kind: "gateway" | "direct"; url: string; }
interface ResourceCandidate { root: string; app: Pm2App; port: number; links: CandidateLink[]; }

export interface ResourceLink {
  kind: "gateway" | "direct"; url: string; status: number;
}

export interface WorktreeResource {
  worktreeRoot: string; appName: string; pid: number | null; port: number; links: ResourceLink[];
}

export interface WorktreeResourcesSnapshot {
  scannedAt: number; cacheTtlMs: number; resources: Record<string, WorktreeResource[]>; warnings: string[];
}

export interface WorktreeResourceReader {
  refresh(worktreeRoots: string[]): Promise<WorktreeResourcesSnapshot>;
  getVersion(): number;
}

export interface WorktreeResourceReaderOptions {
  gatewayReader: GatewayReader;
  pm2DumpPath?: string;
  now?(): number;
  readText?(path: string): string;
  listProcesses?(): Promise<string>;
  listListeners?(): Promise<string>;
  probe?(url: string): Promise<number | null>;
}

async function commandText(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}: ${stderr.trim()}`);
  return stdout;
}

function limitedText(path: string): string {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.size > MAX_PM2_DUMP_BYTES) throw new Error(`invalid PM2 state file ${path}`);
  return readFileSync(path, "utf8");
}

function positivePort(value: unknown): number | null {
  const port = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function readPid(path: unknown, readText: (path: string) => string): number | null {
  if (typeof path !== "string" || !path) return null;
  try {
    const value = Number.parseInt(readText(path).trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch { return null; }
}

function pm2Apps(text: string, readText: (path: string) => string): Pm2App[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("PM2 state is not an array");
  return (parsed as Pm2State[]).filter((row) => row.status === "online")
    .flatMap((row) => typeof row.name === "string" && typeof row.pm_cwd === "string" ? [{
      name: row.name, cwd: row.pm_cwd, pid: readPid(row.pm_pid_path, readText), envPort: positivePort(row.env?.PORT),
    }] : []).slice(0, MAX_PM2_APPS);
}

export function parseProcessTable(text: string): ProcessRow[] {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)(?:\s|$)/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]) }] : [];
  });
}

export function parseListenerTable(text: string): Listener[] {
  const result: Listener[] = [];
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); continue; }
    if (pid === null || !line.startsWith("n")) continue;
    const address = line.slice(1);
    const match = /:(\d+)$/.exec(address);
    const port = match ? positivePort(match[1]) : null;
    if (port !== null) result.push({ pid, host: address.slice(0, -match![0].length), port });
  }
  return result;
}

function descendants(pid: number | null, processes: ProcessRow[]): Set<number> {
  if (pid === null) return new Set();
  const result = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!result.has(process.pid) && result.has(process.ppid)) { result.add(process.pid); changed = true; }
    }
  }
  return result;
}

function isWithin(root: string, cwd: string): boolean {
  const path = relative(root, cwd);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function matchingRoot(cwd: string, roots: string[]): string | null {
  return roots.filter((root) => root && isWithin(root, cwd)).sort((left, right) => right.length - left.length)[0] ?? null;
}

function localGatewayUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol)) return null;
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]" ? url.href : null;
  } catch { return null; }
}

function routeUrl(route: GatewayRoute, base: string): string | null {
  const safe = localGatewayUrl(base);
  if (safe === null) return null;
  const location = route.location.split(/\s+/).reverse().find((token) => token.startsWith("/"));
  if (!location || location === "/" || /[~*]/.test(route.location)) return safe;
  try { return new URL(location, safe).href; } catch { return safe; }
}

function directUrl(port: number, listeners: Listener[]): string {
  const hosts = listeners.filter((listener) => listener.port === port).map((listener) => listener.host);
  const host = hosts.length > 0 && hosts.every((value) => /::1/.test(value)) ? "[::1]" : "127.0.0.1";
  return `http://${host}:${port}/`;
}

function candidates(apps: Pm2App[], roots: string[], processes: ProcessRow[], listeners: Listener[], routes: GatewayRoute[]): ResourceCandidate[] {
  const result: ResourceCandidate[] = [];
  const seen = new Set<string>();
  for (const app of apps) {
    const root = matchingRoot(app.cwd, roots);
    if (root === null) continue;
    const appPids = descendants(app.pid, processes);
    const appListeners = listeners.filter((listener) => appPids.has(listener.pid));
    const ports = [...new Set([...appListeners.map((listener) => listener.port), ...(app.envPort ? [app.envPort] : [])])];
    for (const port of ports) {
      const key = `${root}\0${app.name}\0${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const gatewayLinks = routes.filter((route) => route.upstreamPort === port)
        .flatMap((route) => route.urls.map((url) => routeUrl(route, url)))
        .filter((url): url is string => url !== null).map((url) => ({ kind: "gateway" as const, url }));
      const links = [...gatewayLinks, { kind: "direct" as const, url: directUrl(port, appListeners) }]
        .filter((link, index, all) => all.findIndex((candidate) => candidate.url === link.url) === index);
      result.push({ root, app, port, links });
    }
  }
  return result;
}

async function probeUrl(url: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal });
    void response.body?.cancel().catch(() => {});
    return response.status;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function probeAll(urls: string[], probe: (url: string) => Promise<number | null>): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  for (let index = 0; index < urls.length; index += PROBE_CONCURRENCY) {
    const batch = urls.slice(index, index + PROBE_CONCURRENCY);
    const statuses = await Promise.all(batch.map(probe));
    batch.forEach((url, offset) => result.set(url, statuses[offset] ?? null));
  }
  return result;
}

function toRecord(items: WorktreeResource[]): Record<string, WorktreeResource[]> {
  const resources: Record<string, WorktreeResource[]> = {};
  for (const item of items) (resources[item.worktreeRoot] ??= []).push(item);
  for (const rows of Object.values(resources)) rows.sort((left, right) => left.port - right.port || left.appName.localeCompare(right.appName));
  return resources;
}

export function createWorktreeResourceReader(options: WorktreeResourceReaderOptions): WorktreeResourceReader {
  const now = options.now ?? Date.now;
  const dumpPath = options.pm2DumpPath ?? ORCATAB_PM2_DUMP;
  const readText = options.readText ?? limitedText;
  const listProcesses = options.listProcesses ?? (() => commandText(["ps", "-axo", "pid=,ppid=,command="]));
  const listListeners = options.listListeners ?? (() => commandText(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  const probe = options.probe ?? probeUrl;
  const probeCache = new Map<string, { checkedAt: number; status: number | null }>();

  async function load(roots: string[], startedAt: number): Promise<WorktreeResourcesSnapshot> {
    const warnings: string[] = [];
    let apps: Pm2App[] = [];
    try { apps = pm2Apps(readText(dumpPath), readText); }
    catch (cause) { warnings.push(`PM2 状态读取失败：${cause instanceof Error ? cause.message : String(cause)}`); }
    let processText = "";
    let listenerText = "";
    if (apps.length > 0 && roots.length > 0) {
      const scans = await Promise.allSettled([listProcesses(), listListeners()]);
      if (scans[0].status === "fulfilled") processText = scans[0].value;
      else warnings.push(`进程扫描失败：${String(scans[0].reason)}`);
      if (scans[1].status === "fulfilled") listenerText = scans[1].value;
      else warnings.push(`监听端口扫描失败：${String(scans[1].reason)}`);
    }
    const gateway = await options.gatewayReader.refresh();
    const pendingResources = candidates(apps, roots, parseProcessTable(processText), parseListenerTable(listenerText), gateway.routes);
    const urls = [...new Set(pendingResources.flatMap((item) => item.links.map((link) => link.url)))];
    const statuses = await probeAll(urls, async (url) => {
      const cachedProbe = probeCache.get(url);
      const ttl = cachedProbe?.status === null ? RESOURCE_DISCOVERY_CACHE_MS : SUCCESSFUL_PROBE_CACHE_MS;
      if (cachedProbe && startedAt - cachedProbe.checkedAt < ttl) return cachedProbe.status;
      const status = await probe(url);
      probeCache.set(url, { checkedAt: startedAt, status });
      return status;
    });
    for (const url of probeCache.keys()) if (!urls.includes(url)) probeCache.delete(url);
    const rows = pendingResources.flatMap((item): WorktreeResource[] => {
      const links = item.links.flatMap((link) => {
        const status = statuses.get(link.url);
        return status === null || status === undefined ? [] : [{ ...link, status }];
      });
      return links.length ? [{ worktreeRoot: item.root, appName: item.app.name, pid: item.app.pid, port: item.port, links }] : [];
    });
    return {
      scannedAt: startedAt, cacheTtlMs: RESOURCE_DISCOVERY_CACHE_MS, resources: toRecord(rows), warnings,
    };
  }

  const snapshot = createCachedSnapshot<string[], WorktreeResourcesSnapshot>({
    ttlMs: RESOURCE_DISCOVERY_CACHE_MS, now, load,
    // The scan answers a question about a specific set of roots, so each set gets its own slot.
    cacheKey: (roots) => roots.join("\0"),
    // scannedAt moves on every load; the version must track content only.
    signature: ({ resources, warnings }) => JSON.stringify({ resources, warnings }),
  });
  return {
    refresh: (worktreeRoots) => snapshot.refresh([...new Set(worktreeRoots.filter(Boolean))].sort()),
    getVersion: snapshot.getVersion,
  };
}
