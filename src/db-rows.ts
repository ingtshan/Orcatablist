import { DISPLAY_TITLE_MAX_CHARS } from "./config";
import type { StoredSession } from "./db";
import type { Agent, SessionRow } from "./types";

const LIKE_CONTEXT_CHARS = 40;

export function sessionRow(row: Record<string, unknown>): SessionRow {
  const agent: Agent = row.agent === "codex" || row.agent === "hermes" ? row.agent : "claude";
  const sid = String(row.sid);
  const title = typeof row.title === "string" && row.title ? row.title : null;
  const firstPrompt = typeof row.first_prompt === "string" && row.first_prompt ? row.first_prompt : null;
  const lastPrompt = typeof row.last_prompt === "string" && row.last_prompt ? row.last_prompt : null;
  return {
    agent,
    sid,
    projectKey: String(row.project_key),
    cwd: typeof row.cwd === "string" ? row.cwd : null,
    worktreeRoot: typeof row.worktree_root === "string" ? row.worktree_root : null,
    branch: typeof row.git_branch === "string" ? row.git_branch : null,
    title,
    firstPrompt,
    lastPrompt,
    displayTitle: (title ?? firstPrompt ?? sid.slice(0, 8)).slice(0, DISPLAY_TITLE_MAX_CHARS),
    lastInputAt: typeof row.last_input_at === "number" ? row.last_input_at : null,
    promptCount: Number(row.prompt_count),
    live: null,
    goals: [],
  };
}

export function storedSession(row: Record<string, unknown>): StoredSession {
  return {
    ...sessionRow(row),
    filePath: String(row.file_path), fileSize: Number(row.file_size),
    fileMtime: Number(row.file_mtime), parsedOffset: Number(row.parsed_offset),
  };
}

export function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function likeSnippet(text: string, query: string): string {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text.slice(0, LIKE_CONTEXT_CHARS * 2);
  const start = Math.max(0, index - LIKE_CONTEXT_CHARS);
  const end = Math.min(text.length, index + query.length + LIKE_CONTEXT_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, index)}‹${text.slice(index, index + query.length)}›${text.slice(index + query.length, end)}${end < text.length ? "…" : ""}`;
}
