import { AGENTS } from "./config";
import type { Agent } from "./types";

/**
 * Every agent writes session ids differently — Claude and Codex use uuids, Hermes uses a
 * timestamped slug — so the shared rule is only "opaque, path-safe, bounded".
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const URI_SCHEME = "orcatab://";

/**
 * The implicit environment of everything indexed from this machine. Remote environments are
 * named after `orca environment list` entries; the name doubles as a project-key namespace and
 * an identity-key prefix, so it must stay free of `:` and `/`.
 */
export const LOCAL_ENV = "local";
export const ENV_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface SessionIdentity { agent: Agent; sid: string; env?: string; }

/** `<agent>/<sid>`. The map key every store, live reader and route agrees on. */
export type SessionIdentityKey = `${string}/${string}`;

export function isAgent(value: unknown): value is Agent {
  return typeof value === "string" && AGENTS.some((agent) => agent === value);
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isEnvName(value: unknown): value is string {
  return typeof value === "string" && ENV_NAME_PATTERN.test(value);
}

export function normalizeEnv(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? LOCAL_ENV : value;
}

/**
 * Local keys keep the historical `<agent>/<sid>` shape so every existing store, live reader and
 * GUI join stays byte-identical; only remote identities grow an `<env>:` prefix.
 */
export function sessionIdentityKey(agent: string, sid: string, env?: string): SessionIdentityKey {
  const scope = normalizeEnv(env);
  return scope === LOCAL_ENV ? `${agent}/${sid}` : `${scope}:${agent}/${sid}`;
}

export function identityKey(identity: SessionIdentity): SessionIdentityKey {
  return sessionIdentityKey(identity.agent, identity.sid, identity.env);
}

/** Inverse of {@link sessionIdentityKey}. Returns null for anything this codebase did not produce. */
export function parseSessionIdentity(key: string): SessionIdentity | null {
  const separator = key.indexOf("/");
  if (separator < 1) return null;
  let agent = key.slice(0, separator);
  const sid = key.slice(separator + 1);
  let env = LOCAL_ENV;
  const scopeSeparator = agent.indexOf(":");
  if (scopeSeparator > 0) {
    env = agent.slice(0, scopeSeparator);
    agent = agent.slice(scopeSeparator + 1);
    if (!isEnvName(env) || env === LOCAL_ENV) return null;
  }
  if (!isAgent(agent) || !isSessionId(sid)) return null;
  return env === LOCAL_ENV ? { agent, sid } : { agent, sid, env };
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

/**
 * The inverse of {@link parseSessionUri}. Built from the identity key, so a remote session's link
 * carries its environment; a local one keeps its historical `orcatab://<agent>/<sid>` bytes.
 */
export function sessionUri(identity: SessionIdentity): string {
  return `${URI_SCHEME}${identityKey(identity)}`;
}
