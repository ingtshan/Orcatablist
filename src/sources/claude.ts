import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseLine } from "../parse";
import type { SessionFileInfo, SessionSource } from "../indexer";

const SESSION_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export function discoverClaudeSessionFiles(claudeDir: string): SessionFileInfo[] {
  const projectsDir = join(claudeDir, "projects");
  let projectEntries;
  try {
    projectEntries = readdirSync(projectsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`failed to read Claude projects directory ${projectsDir}: ${String(error)}`);
  }
  const files: SessionFileInfo[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const directory = join(projectsDir, projectEntry.name);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !SESSION_FILE_PATTERN.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const stat = statSync(path);
      files.push({
        agent: "claude", path, sid: entry.name.slice(0, -6),
        size: stat.size, mtime: Math.trunc(stat.mtimeMs),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function createClaudeSource(claudeDir: string): SessionSource {
  return {
    agent: "claude",
    discover: () => discoverClaudeSessionFiles(claudeDir),
    parseLine,
  };
}
