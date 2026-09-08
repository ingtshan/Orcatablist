import type { FtsRow, StoredSession } from "./db";
import type { RemoteReadAck } from "./remote-read-state";
import { normalizeEnv } from "./session-identity";
import type { Agent } from "./types";

export interface SessionFileInfo { agent: Agent; env?: string; sid: string; path: string; size: number; mtime: number; }

/** Where a failure happened, so a degraded pass can say what it could not do. */
export type SourceStage = "prepare" | "discover" | "read" | "project" | "commit";

/**
 * One contextual failure. Issues travel as data instead of exceptions: a broken root, file or
 * commit degrades that one thing and every healthy sibling still gets indexed.
 */
export interface SourceIssue {
  stage: SourceStage;
  source: Agent;
  message: string;
  path?: string;
  sid?: string;
  env?: string;
}

/** Discovery is explicit about both halves: what was really seen, and what could not be read. */
export interface DiscoveryResult { files: SessionFileInfo[]; errors: SourceIssue[]; }

/** One session's complete next state, committed by the coordinator in a single transaction. */
export interface SessionUpdate {
  session: StoredSession;
  fts: FtsRow[];
  /** True when this update starts a fresh read of the file and must drop the stored transcript. */
  replaceFts: boolean;
  /** Remote only: the exact read generation and consumed range this commit acknowledges. */
  ack?: RemoteReadAck;
}

/**
 * Every source owns its own reading, parsing and change detection; the coordinator only discovers,
 * resolves the project/worktree and applies the update atomically.
 */
export interface SessionSource {
  agent: Agent;
  discover(): DiscoveryResult;
  /** Awaited before discovery; a remote source runs its pull round here. */
  prepare?(): void | Promise<void>;
  /** Null when this file has nothing to commit this round. */
  index(info: SessionFileInfo, stored: StoredSession | null): SessionUpdate | null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sourceIssue(
  stage: SourceStage, source: Agent, message: string, context: Omit<SourceIssue, "stage" | "source" | "message"> = {},
): SourceIssue {
  return { stage, source, message, ...context };
}

/** A file disappearing mid-scan is a race, not a fault; anything else is worth reporting. */
export function isMissingPath(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/** The `(env, agent, sid)` identity a file claims ownership of. */
export function sessionOwnerKey(file: SessionFileInfo): string {
  return `${normalizeEnv(file.env)}/${file.agent}/${file.sid}`;
}

/**
 * The single duplicate-owner rule, shared by the coordinator and by remote reception so both
 * agree on which file matters: the lexicographically greatest path wins, and equal paths keep
 * the order they were discovered in.
 */
export function selectSessionOwners<T>(items: readonly T[], fileOf: (item: T) => SessionFileInfo): T[] {
  const owners = new Map<string, T>();
  for (const item of items) {
    const file = fileOf(item);
    const key = sessionOwnerKey(file);
    const current = owners.get(key);
    if (current === undefined || file.path.localeCompare(fileOf(current).path) > 0) owners.set(key, item);
  }
  return [...owners.values()];
}
