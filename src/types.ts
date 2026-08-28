export type Agent = "claude" | "codex" | "hermes";
/** Raw state reported by Orca or the fallback live-session source. Intentionally not normalized. */
export type LiveStatus = string;
export type GoalStatus = "active" | "done" | "archived";
export interface LiveInfo {
  pid: number | null;
  status: LiveStatus;
  /** Raw Orca agentStatus.updatedAt timestamp when the live provider exposes it. */
  updatedAt?: number | null;
  waitingFor: string | null;
  name: string | null;
  handle?: string;
  tabId?: string | null;
  leafId?: string | null;
}
export interface ProjectRow {
  key: string; name: string; root: string; color: string | null;
  sessionCount: number; lastInputAt: number | null; pinned: boolean; archived: boolean;
}
export interface Goal {
  id: string; name: string; status: GoalStatus; externalRef: string | null;
  color: string | null; createdAt: number; updatedAt: number;
}
export interface GoalSummary extends Goal { sessionCount: number; lastActivityAt: number | null; }
export interface GoalRef { id: string; name: string; }
export interface SessionRow {
  agent: Agent;
  sid: string; projectKey: string; cwd: string | null; worktreeRoot: string | null; branch: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  displayTitle: string;
  lastInputAt: number | null;
  promptCount: number;
  live: LiveInfo | null;
  goals: GoalRef[];
  /** False only for a live provider identity that has no indexed transcript. */
  indexed?: boolean;
}
export interface SuggestionReason { code: "branch" | "project" | "title"; label: string; }
export interface SessionSuggestion extends SessionRow { score: number; reasons: SuggestionReason[]; }
export interface SearchHit { role: "user" | "assistant"; ts: number | null; snippet: string; }
export interface SearchResult extends SessionRow { hits: SearchHit[]; score: number; }
export type FocusResult =
  | { action: "switched"; handle: string; tabId: string | null }
  | { action: "resumed"; handle: string }
  | { action: "manual"; reason: "running-outside-orca" | "not-orca-worktree" | "unknown-session"; command: string | null };
export type WorktreeFocusResult =
  | { action: "switched"; handle: string; tabId: string | null; cwd: string }
  | { action: "manual"; reason: "no-active-terminal"; cwd: string };
export interface ParsedEvent {
  kind: "title" | "prompt" | "assistant-text" | "meta" | "skip";
  title?: string; text?: string; ts?: number | null; cwd?: string; branch?: string; version?: string;
}
