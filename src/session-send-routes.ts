import { AGENTS } from "./config";
import { OrcaError, ValidationError } from "./focus";
import { assertJsonRequest, assertSameOriginWrite, json, jsonObject } from "./http";
import {
  SendConflictError, sendSessionInput,
  type SentInput, type SentInputConfirmationQueue, type SentInputStore, type SessionSendDeps,
} from "./session-send";
import type { Agent } from "./types";

const COLLECTION_ROUTE = "/api/session-send";
const RECORD_ROUTE = /^\/api\/session-send\/([^/]+)\/([^/]+)$/;
const CONFLICT_STATUS = 409;

export interface SessionSendRouteDeps extends Omit<SessionSendDeps, "store"> {
  store: SentInputStore;
  confirmationQueue: SentInputConfirmationQueue;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value) throw new ValidationError(`${field} must be a non-empty string`);
  return value;
}

function requestedAgent(value: string): Agent {
  const agent = AGENTS.find((candidate) => candidate === value);
  if (agent === undefined) throw new ValidationError("invalid agent");
  return agent;
}

function decodeIdentity(pathname: string): { agent: Agent; sid: string } | null {
  const match = RECORD_ROUTE.exec(pathname);
  if (match === null) return null;
  let parts: string[];
  try { parts = [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)]; }
  catch { throw new ValidationError("invalid session path encoding"); }
  return { agent: requestedAgent(parts[0]!), sid: parts[1]! };
}

export function logSentInput(entry: SentInput): void {
  console.log(`orcatab sent input to ${entry.agent}/${entry.sid} terminal=${entry.handle} chars=${entry.text.length}`);
}

export async function handleSessionSendRequest(
  request: Request,
  url: URL,
  deps: SessionSendRouteDeps,
): Promise<Response | null> {
  if (url.pathname !== COLLECTION_ROUTE && !url.pathname.startsWith(`${COLLECTION_ROUTE}/`)) return null;
  try {
    if (request.method === "GET" && url.pathname === COLLECTION_ROUTE) {
      return json({ records: await deps.confirmationQueue.reconcile() });
    }
    const identity = decodeIdentity(url.pathname);
    if (identity !== null && request.method === "DELETE") {
      assertSameOriginWrite(request);
      deps.store.remove(identity.agent, identity.sid);
      return json({ ok: true });
    }
    if (identity !== null && request.method === "POST") {
      assertSameOriginWrite(request);
      assertJsonRequest(request);
      const body = await jsonObject(request);
      const handle = optionalString(body.expectedHandle, "expectedHandle");
      const status = optionalString(body.expectedStatus, "expectedStatus");
      const record = await sendSessionInput(
        identity.agent, identity.sid, body.text,
        { ...deps, onSent: deps.onSent ?? logSentInput },
        { ...(handle === undefined ? {} : { handle }), ...(status === undefined ? {} : { status }) },
      );
      return json({ ok: true, record });
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof SendConflictError) return json({ error: error.message, code: error.code }, CONFLICT_STATUS);
    if (error instanceof ValidationError) return json({ error: error.message }, 400);
    if (error instanceof OrcaError) return json({ error: error.message }, 502);
    throw error;
  }
}
