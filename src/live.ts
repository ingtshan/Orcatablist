import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_CACHE_MS, ORCATAB_CLAUDE_DIR } from "./config";
import type { LiveInfo } from "./types";

interface LiveFile {
  sessionId?: unknown; pid?: unknown; status?: unknown; waitingFor?: unknown; name?: unknown;
}

function rawStatus(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

export interface LiveReaderDeps {
  claudeDir: string;
  now(): number;
  listFiles(directory: string): string[];
  readFile(path: string): string;
  isPidAlive(pid: number): boolean;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function defaultListFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`failed to read live sessions directory ${directory}: ${String(error)}`);
  }
}

export function createLiveReader(overrides: Partial<LiveReaderDeps> = {}) {
  const deps: LiveReaderDeps = {
    claudeDir: overrides.claudeDir ?? ORCATAB_CLAUDE_DIR,
    now: overrides.now ?? Date.now,
    listFiles: overrides.listFiles ?? defaultListFiles,
    readFile: overrides.readFile ?? ((path) => readFileSync(path, "utf8")),
    isPidAlive: overrides.isPidAlive ?? defaultPidAlive,
  };
  let cachedAt = Number.NEGATIVE_INFINITY;
  let cached = new Map<string, LiveInfo>();

  function getLiveMap(): Map<string, LiveInfo> {
    const now = deps.now();
    if (now - cachedAt < LIVE_CACHE_MS) return cached;
    const next = new Map<string, LiveInfo>();
    const directory = join(deps.claudeDir, "sessions");
    for (const file of deps.listFiles(directory)) {
      try {
        const value = JSON.parse(deps.readFile(join(directory, file))) as LiveFile;
        if (typeof value.sessionId !== "string" || !Number.isInteger(value.pid)) continue;
        const pid = value.pid as number;
        if (!deps.isPidAlive(pid)) continue;
        const status = rawStatus(value.status);
        next.set(value.sessionId, {
          pid, status,
          waitingFor: typeof value.waitingFor === "string" ? value.waitingFor : null,
          name: typeof value.name === "string" ? value.name : null,
        });
      } catch {
        continue;
      }
    }
    cached = next;
    cachedAt = now;
    return cached;
  }

  return { getLiveMap };
}

const defaultReader = createLiveReader();
export function getLiveMap(): Map<string, LiveInfo> { return defaultReader.getLiveMap(); }
