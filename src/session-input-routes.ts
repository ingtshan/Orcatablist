import { AGENTS } from "./config";
import type { OrcaDatabase } from "./db";
import { ValidationError } from "./focus";
import { isSessionId } from "./session-identity";
import type { SessionIdentity } from "./goals";
import { json, jsonObject } from "./http";

const MAX_REQUESTED_SESSIONS = 5_000;
const DEFAULT_SESSION_INPUT_LIMIT = 5;
const MAX_SESSION_INPUT_LIMIT = 20;
const MAX_SESSION_INPUT_OFFSET = 100_000;
const ENABLED_AGENTS = new Set<string>(AGENTS);

function requestedSessionIdentities(value: unknown): SessionIdentity[] {
  if (!Array.isArray(value) || value.length > MAX_REQUESTED_SESSIONS) {
    throw new ValidationError("invalid session identities");
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null) throw new ValidationError("invalid session identity");
    const { agent, sid } = item as Record<string, unknown>;
    if (typeof agent !== "string" || !ENABLED_AGENTS.has(agent)
      || !isSessionId(sid)) {
      throw new ValidationError("invalid session identity");
    }
    return { agent: agent as SessionIdentity["agent"], sid };
  });
}

function pageInteger(value: unknown, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ValidationError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export async function handleSessionInputsRequest(
  request: Request,
  url: URL,
  db: OrcaDatabase,
): Promise<Response | null> {
  if (request.method !== "POST" || url.pathname !== "/api/session-inputs") return null;
  const body = await jsonObject(request);
  const limit = pageInteger(body.limit, "limit", DEFAULT_SESSION_INPUT_LIMIT, 1, MAX_SESSION_INPUT_LIMIT);
  const offset = pageInteger(body.offset, "offset", 0, 0, MAX_SESSION_INPUT_OFFSET);
  const recentInputs = db.getRecentUserInputPages(requestedSessionIdentities(body.sessions), { limit, offset });
  return json({
    listVersion: db.getListVersion(),
    inputs: Object.fromEntries([...recentInputs].map(([key, page]) => [key, page.inputs.map(({ text }) => text)])),
    inputTimes: Object.fromEntries([...recentInputs].map(([key, page]) => [key, page.inputs.map(({ ts }) => ts)])),
    hasMore: Object.fromEntries([...recentInputs].map(([key, page]) => [key, page.hasMore])),
  });
}
