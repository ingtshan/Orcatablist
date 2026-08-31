import { AGENTS } from "./config";
import type { Agent } from "./types";

/**
 * Every agent writes session ids differently — Claude and Codex use uuids, Hermes uses a
 * timestamped slug — so the shared rule is only "opaque, path-safe, bounded".
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const URI_SCHEME = "orcatab://";

export interface SessionIdentity { agent: Agent; sid: string; }

/** `<agent>/<sid>`. The map key every store, live reader and route agrees on. */
export type SessionIdentityKey = `${string}/${string}`;

export function isAgent(value: unknown): value is Agent {
  return typeof value === "string" && AGENTS.some((agent) => agent === value);
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function sessionIdentityKey(agent: string, sid: string): SessionIdentityKey {
  return `${agent}/${sid}`;
}

export function identityKey(identity: SessionIdentity): SessionIdentityKey {
  return sessionIdentityKey(identity.agent, identity.sid);
}

/** Inverse of {@link sessionIdentityKey}. Returns null for anything this codebase did not produce. */
export function parseSessionIdentity(key: string): SessionIdentity | null {
  const separator = key.indexOf("/");
  if (separator < 1) return null;
  const agent = key.slice(0, separator);
  const sid = key.slice(separator + 1);
  return isAgent(agent) && isSessionId(sid) ? { agent, sid } : null;
}

/** Accepts a loose `{ agent, sid }` from a request body or path segment. */
export function toSessionIdentity(agent: unknown, sid: unknown): SessionIdentity | null {
  return isAgent(agent) && isSessionId(sid) ? { agent, sid } : null;
}

export function isSessionUri(value: string): boolean {
  return value.startsWith(URI_SCHEME);
}

/** `orcatab://<agent>/<sid>` — the format the scheme handler and the copy-link button share. */
export function parseSessionUri(value: string): SessionIdentity | null {
  return isSessionUri(value) ? parseSessionIdentity(value.slice(URI_SCHEME.length)) : null;
}

export function sessionUri(identity: SessionIdentity): string {
  return `${URI_SCHEME}${identity.agent}/${identity.sid}`;
}
