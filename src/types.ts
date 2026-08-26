export type Agent = "claude" | "codex" | "hermes";
export type LiveStatus = "busy" | "waiting" | "idle" | "shell";
export interface LiveInfo { pid: number; status: LiveStatus; waitingFor: string | null; name: string | null; }
export interface ProjectRow { key: string; name: string; root: string; color: string | null; sessionCount: number; lastInputAt: number | null; }
export interface SessionRow {
  agent: Agent;
  sid: string; projectKey: string; cwd: string | null; branch: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  displayTitle: string;
  lastInputAt: number | null;
  promptCount: number;
  live: LiveInfo | null;
}
export interface SearchHit { role: "user" | "assistant"; ts: number | null; snippet: string; }
export interface SearchResult extends SessionRow { hits: SearchHit[]; score: number; }
export type FocusResult =
  | { action: "switched"; handle: string; tabId: string | null }
  | { action: "resumed"; handle: string }
  | { action: "manual"; reason: "running-outside-orca" | "not-orca-worktree" | "unknown-session"; command: string | null };
export interface ParsedEvent {
  kind: "title" | "prompt" | "assistant-text" | "meta" | "skip";
  title?: string; text?: string; ts?: number | null; cwd?: string; branch?: string; version?: string;
}
