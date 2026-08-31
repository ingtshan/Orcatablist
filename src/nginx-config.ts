import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createCachedSnapshot } from "./cached-snapshot";
import { GATEWAY_DISCOVERY_CACHE_MS, ORCATAB_NGINX_CONFIG } from "./config";

const COMMAND_TIMEOUT_MS = 3_000;
const MAX_DOCKER_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAX_CONFIG_FILE_BYTES = 512 * 1_024;
const MAX_CONFIG_FILES = 256;
const MAX_CONFIG_SCAN_DEPTH = 8;
const DEFAULT_CONFIG_PATHS = [
  "/opt/homebrew/etc/nginx/nginx.conf", "/usr/local/etc/nginx/nginx.conf", "/etc/nginx/nginx.conf",
];

interface NginxDirective { name: string; args: string[]; children: NginxDirective[]; }
interface ConfigMount { source: string; destination: string; }
interface ConfigEntry { label: string; path: string; sourcePath: string; mounts: ConfigMount[] | null; }
interface DockerMount { Type?: unknown; Source?: unknown; Destination?: unknown; }
interface DockerConfig { Image?: unknown; Cmd?: unknown; Entrypoint?: unknown; }
interface DockerContainer {
  Id?: unknown; Name?: unknown; Args?: unknown; Config?: DockerConfig; Mounts?: unknown;
}

export interface NginxConfigFile {
  path: string; sourcePath: string; source: string; content: string;
}

export interface GatewayRoute {
  source: string; file: string; serverNames: string[]; listen: string[]; location: string;
  proxyPass: string; upstreamPort: number | null; urls: string[];
}

export interface GatewaySnapshot {
  scannedAt: number; cacheTtlMs: number; sources: string[];
  files: NginxConfigFile[]; routes: GatewayRoute[]; warnings: string[];
}

export interface GatewayReader {
  refresh(): Promise<GatewaySnapshot>;
  getVersion(): number;
}

export interface GatewayReaderOptions {
  now?(): number;
  configPaths?: string[];
  inspectContainers?(): Promise<unknown[]>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function commandText(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}: ${stderr.trim()}`);
  if (stdout.length > MAX_DOCKER_OUTPUT_BYTES) throw new Error(`${argv[0]} output exceeded limit`);
  return stdout;
}

async function inspectRunningContainers(): Promise<unknown[]> {
  const ids = (await commandText(["docker", "ps", "--filter", "status=running", "--format", "{{.ID}}"])).trim()
    .split("\n").filter((id) => /^[a-f0-9]{12,64}$/.test(id)).slice(0, 128);
  if (ids.length === 0) return [];
  const parsed = JSON.parse(await commandText(["docker", "inspect", ...ids]));
  if (!Array.isArray(parsed)) throw new Error("docker inspect returned invalid JSON");
  return parsed;
}

function mountsFor(container: DockerContainer): ConfigMount[] {
  if (!Array.isArray(container.Mounts)) return [];
  return (container.Mounts as DockerMount[]).flatMap((mount) => {
    if (mount.Type !== "bind" || typeof mount.Source !== "string" || typeof mount.Destination !== "string") return [];
    return [{ source: mount.Source.replace(/\/$/, ""), destination: mount.Destination.replace(/\/$/, "") }];
  }).sort((left, right) => right.destination.length - left.destination.length);
}

function translatedPath(path: string, mounts: ConfigMount[]): string | null {
  const mount = mounts.find((candidate) => path === candidate.destination || path.startsWith(`${candidate.destination}/`));
  return mount ? join(mount.source, relative(mount.destination, path)) : null;
}

function nginxContainerEntries(value: unknown): ConfigEntry[] {
  const container = value as DockerContainer;
  const args = strings(container.Args).length ? strings(container.Args) : strings(container.Config?.Cmd);
  const identity = [container.Name, container.Config?.Image, ...args, ...strings(container.Config?.Entrypoint)].join(" ");
  if (!/(?:^|[\s/:-])(nginx|openresty)(?:[\s/:-]|$)/i.test(identity)) return [];
  const mounts = mountsFor(container);
  const configIndex = args.indexOf("-c");
  const prefixIndex = args.indexOf("-p");
  const prefix = prefixIndex >= 0 && args[prefixIndex + 1] ? args[prefixIndex + 1]! : "/etc/nginx";
  const configured = configIndex >= 0 && args[configIndex + 1] ? args[configIndex + 1]! : "/etc/nginx/nginx.conf";
  const path = isAbsolute(configured) ? configured : resolve(prefix, configured);
  const sourcePath = translatedPath(path, mounts);
  if (sourcePath === null || !existsSync(sourcePath)) return [];
  const label = typeof container.Name === "string" ? container.Name.replace(/^\//, "") : "nginx container";
  return [{ label, path, sourcePath, mounts }];
}

function tokenize(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote = "";
  const flush = () => { if (current) result.push(current); current = ""; };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quote) {
      if (char === "\\" && index + 1 < input.length) { current += input[index + 1]!; index += 1; continue; }
      if (char === quote) quote = ""; else current += char;
      continue;
    }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (char === "#") { flush(); while (index < input.length && input[index] !== "\n") index += 1; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if (char === "{" || char === "}" || char === ";") { flush(); result.push(char); continue; }
    current += char;
  }
  flush();
  return result;
}

function directiveList(tokens: string[], start = 0): [NginxDirective[], number] {
  const directives: NginxDirective[] = [];
  let index = start;
  while (index < tokens.length && tokens[index] !== "}") {
    const name = tokens[index++]!;
    const args: string[] = [];
    while (index < tokens.length && ![";", "{", "}"].includes(tokens[index]!)) args.push(tokens[index++]!);
    let children: NginxDirective[] = [];
    if (tokens[index] === "{") {
      [children, index] = directiveList(tokens, index + 1);
      if (tokens[index] === "}") index += 1;
    } else if (tokens[index] === ";") index += 1;
    else if (tokens[index] === "}") break;
    directives.push({ name, args, children });
  }
  return [directives, index];
}

function findDirectives(directives: NginxDirective[], name: string): NginxDirective[] {
  return directives.flatMap((directive) => [
    ...(directive.name === name ? [directive] : []), ...findDirectives(directive.children, name),
  ]);
}

function globPattern(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") { expression += ".*"; index += 1; }
    else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function walkFiles(root: string, depth = 0): string[] {
  if (depth > MAX_CONFIG_SCAN_DEPTH) return [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isFile()) return [path];
    return entry.isDirectory() ? walkFiles(path, depth + 1) : [];
  }).slice(0, MAX_CONFIG_FILES);
}

function expandPattern(pattern: string): string[] {
  const wildcard = pattern.search(/[?*]/);
  if (wildcard < 0) return existsSync(pattern) ? [pattern] : [];
  const prefix = pattern.slice(0, wildcard);
  const root = prefix.endsWith("/") ? prefix.slice(0, -1) : dirname(prefix);
  const matcher = globPattern(pattern);
  return walkFiles(root || "/").filter((path) => matcher.test(path)).sort().slice(0, MAX_CONFIG_FILES);
}

function includedEntries(entry: ConfigEntry, content: string): ConfigEntry[] {
  const [directives] = directiveList(tokenize(content));
  return findDirectives(directives, "include").flatMap((directive) => directive.args.slice(0, 1)).flatMap((include) => {
    const logicalPattern = isAbsolute(include) ? include : resolve(dirname(entry.path), include);
    const hostPattern = entry.mounts === null ? logicalPattern : translatedPath(logicalPattern, entry.mounts);
    if (hostPattern === null) return [];
    return expandPattern(hostPattern).map((sourcePath) => {
      if (entry.mounts === null) return { ...entry, path: sourcePath, sourcePath };
      const mount = entry.mounts.find((candidate) => sourcePath === candidate.source || sourcePath.startsWith(`${candidate.source}/`));
      const path = mount ? join(mount.destination, relative(mount.source, sourcePath)) : logicalPattern;
      return { ...entry, path, sourcePath };
    });
  });
}

function listenPort(value: string): number {
  const token = value.split(/\s+/)[0] ?? "80";
  const match = /(?:^|:)(\d+)$/.exec(token.replace(/^\[.*\]:/, ":"));
  return match ? Number(match[1]) : 80;
}

function routeUrls(names: string[], listen: string[]): string[] {
  const listeners = listen.length ? listen : ["80"];
  return names.filter((name) => name !== "_" && !/[$*]/.test(name)).flatMap((name) => listeners.map((binding) => {
    const port = listenPort(binding);
    const https = port === 443 || /\bssl\b/.test(binding);
    const suffix = port === (https ? 443 : 80) ? "" : `:${port}`;
    return `${https ? "https" : "http"}://${name}${suffix}`;
  }));
}

function routesFromFile(file: NginxConfigFile): GatewayRoute[] {
  const [directives] = directiveList(tokenize(file.content));
  return findDirectives(directives, "server").flatMap((server) => {
    const serverNames = server.children.filter((item) => item.name === "server_name").flatMap((item) => item.args);
    const listen = server.children.filter((item) => item.name === "listen").map((item) => item.args.join(" "));
    return server.children.filter((item) => item.name === "location").flatMap((location) => {
      const proxy = findDirectives(location.children, "proxy_pass")[0]?.args[0];
      if (!proxy) return [];
      const match = /^https?:\/\/[^/]*:(\d+)(?:\/|$)/.exec(proxy);
      return [{
        source: file.source, file: file.path, serverNames, listen, location: location.args.join(" ") || "/",
        proxyPass: proxy, upstreamPort: match ? Number(match[1]) : null, urls: routeUrls(serverNames, listen),
      }];
    });
  });
}

function readConfig(entry: ConfigEntry): NginxConfigFile {
  const stats = lstatSync(entry.sourcePath);
  if (!stats.isFile() || stats.size > MAX_CONFIG_FILE_BYTES) throw new Error(`invalid nginx config ${entry.sourcePath}`);
  return { path: entry.path, sourcePath: entry.sourcePath, source: entry.label, content: readFileSync(entry.sourcePath, "utf8") };
}

export function createGatewayReader(options: GatewayReaderOptions = {}): GatewayReader {
  const now = options.now ?? Date.now;
  const inspect = options.inspectContainers ?? inspectRunningContainers;
  const configured = ORCATAB_NGINX_CONFIG ? ORCATAB_NGINX_CONFIG.split(",").map((path) => path.trim()).filter(Boolean) : [];
  const nativePaths = options.configPaths ?? [...configured, ...DEFAULT_CONFIG_PATHS];

  async function load(startedAt: number): Promise<GatewaySnapshot> {
    const warnings: string[] = [];
    const entries: ConfigEntry[] = nativePaths.filter(existsSync)
      .map((path) => ({ label: "本机 nginx", path, sourcePath: path, mounts: null }));
    try { entries.push(...(await inspect()).flatMap(nginxContainerEntries)); }
    catch (cause) { warnings.push(`容器 nginx 发现失败：${cause instanceof Error ? cause.message : String(cause)}`); }
    const files: NginxConfigFile[] = [];
    const queue = [...entries];
    const visited = new Set<string>();
    while (queue.length && files.length < MAX_CONFIG_FILES) {
      const entry = queue.shift()!;
      const key = `${entry.label}\0${entry.sourcePath}`;
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        const file = readConfig(entry);
        files.push(file);
        queue.push(...includedEntries(entry, file.content));
      } catch (cause) {
        warnings.push(`读取 ${entry.sourcePath} 失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (queue.length) warnings.push(`nginx 配置文件超过 ${MAX_CONFIG_FILES} 个，已截断`);
    const routes = files.flatMap(routesFromFile).sort((left, right) => left.urls.join().localeCompare(right.urls.join())
      || left.proxyPass.localeCompare(right.proxyPass));
    const sources = [...new Set(files.map((file) => file.source))].sort();
    return { scannedAt: startedAt, cacheTtlMs: GATEWAY_DISCOVERY_CACHE_MS, sources, files, routes, warnings };
  }

  const snapshot = createCachedSnapshot<void, GatewaySnapshot>({
    ttlMs: GATEWAY_DISCOVERY_CACHE_MS, now,
    load: (_input, startedAt) => load(startedAt),
    // scannedAt moves on every load; the version must track content only.
    signature: ({ sources, files, routes, warnings }) => JSON.stringify({ sources, files, routes, warnings }),
  });
  return { refresh: () => snapshot.refresh(), getVersion: snapshot.getVersion };
}
