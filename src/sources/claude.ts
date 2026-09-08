import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseLine } from "../parse";
import {
  errorText, isMissingPath, sourceIssue,
  type DiscoveryResult, type SessionFileInfo, type SessionSource, type SourceIssue,
} from "../session-source";
import { indexLocalJsonlSession } from "./jsonl";

const SESSION_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/**
 * A project directory or session file that vanished or cannot be read costs only itself: the
 * remaining projects and files are still returned, with the failure carried alongside them.
 */
export function discoverClaudeSessions(claudeDir: string): DiscoveryResult {
  const projectsDir = join(claudeDir, "projects");
  const files: SessionFileInfo[] = [];
  const errors: SourceIssue[] = [];
  let projectEntries;
  try {
    projectEntries = readdirSync(projectsDir, { withFileTypes: true });
  } catch (error) {
    return {
      files,
      errors: [sourceIssue("discover", "claude",
        `failed to read Claude projects directory ${projectsDir}: ${errorText(error)}`, { path: projectsDir })],
    };
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const directory = join(projectsDir, projectEntry.name);
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPath(error)) {
        errors.push(sourceIssue("discover", "claude",
          `failed to read Claude project directory ${directory}: ${errorText(error)}`, { path: directory }));
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !SESSION_FILE_PATTERN.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const sid = entry.name.slice(0, -6);
      let stat;
      try {
        stat = statSync(path);
      } catch (error) {
        if (!isMissingPath(error)) {
          errors.push(sourceIssue("discover", "claude",
            `failed to stat Claude session file ${path}: ${errorText(error)}`, { path, sid }));
        }
        continue;
      }
      files.push({ agent: "claude", path, sid, size: stat.size, mtime: Math.trunc(stat.mtimeMs) });
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), errors };
}

export function discoverClaudeSessionFiles(claudeDir: string): SessionFileInfo[] {
  return discoverClaudeSessions(claudeDir).files;
}

export function createClaudeSource(claudeDir: string): SessionSource {
  return {
    agent: "claude",
    discover: () => discoverClaudeSessions(claudeDir),
    index: (info, stored) => indexLocalJsonlSession(info, stored, { parseLine }),
  };
}
