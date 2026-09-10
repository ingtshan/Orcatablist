import { OrcaError, ValidationError } from "./focus";
import { assertJsonRequest, assertSameOriginWrite, conditionalJson, json, jsonObject } from "./http";
import { isEnvName, LOCAL_ENV, toSessionIdentity, type SessionIdentity } from "./session-identity";
import { normalizeInputText, SendConflictError, type SessionSendDeps } from "./session-send";
import { sendOutboxInput } from "./session-outbox-runtime";
import { type SessionOutboxItem, type SessionOutboxStore } from "./session-outbox";

const COLLECTION_ROUTE = "/api/session-outbox";
const ITEM_ROUTE = /^\/api\/session-outbox\/([^/]+)$/;
const SEND_ROUTE = /^\/api\/session-outbox\/([^/]+)\/send$/;
const CONFLICT_STATUS = 409;

export interface SessionOutboxRouteDeps extends SessionSendDeps { outbox: SessionOutboxStore; }

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value) throw new ValidationError(`${field} must be a non-empty string`);
  return value;
}

function optionalEnv(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "" || value === LOCAL_ENV) return undefined;
  if (!isEnvName(value)) throw new ValidationError("invalid environment name");
  return value;
}

function requestedIdentity(body: Record<string, unknown>): SessionIdentity {
  const identity = toSessionIdentity(body.agent, body.sid);
  if (identity === null) throw new ValidationError("invalid session identity");
  const env = optionalEnv(body.env);
  return env === undefined ? identity : { ...identity, env };
}

function decodedId(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  if (match === null) return null;
  try { return decodeURIComponent(match[1]!); }
  catch { throw new ValidationError("invalid outbox id encoding"); }
}

async function queueInput(request: Request, deps: SessionOutboxRouteDeps): Promise<Response> {
  assertSameOriginWrite(request);
  assertJsonRequest(request);
  const body = await jsonObject(request);
  const identity = requestedIdentity(body);
  const item = deps.outbox.add({ ...identity, text: normalizeInputText(body.text) });
  return json({ ok: true, version: deps.outbox.version, item }, 201);
}

async function sendQueuedInput(
  request: Request,
  item: SessionOutboxItem,
  deps: SessionOutboxRouteDeps,
): Promise<Response> {
  assertSameOriginWrite(request);
  assertJsonRequest(request);
  const body = await jsonObject(request);
  const handle = optionalString(body.expectedHandle, "expectedHandle");
  const status = optionalString(body.expectedStatus, "expectedStatus");
  const record = await sendOutboxInput(
    item.id, deps,
    { ...(handle === undefined ? {} : { handle }), ...(status === undefined ? {} : { status }) },
  );
  return json({ ok: true, version: deps.outbox.version, record });
}

export async function handleSessionOutboxRequest(
  request: Request,
  url: URL,
  deps: SessionOutboxRouteDeps,
): Promise<Response | null> {
  if (url.pathname !== COLLECTION_ROUTE && !url.pathname.startsWith(`${COLLECTION_ROUTE}/`)) return null;
  try {
    if (request.method === "GET" && url.pathname === COLLECTION_ROUTE) {
      return conditionalJson(request, `"outbox-${deps.outbox.version}"`, () => ({
        version: deps.outbox.version, items: deps.outbox.list(), settings: deps.outbox.settings(),
      }));
    }
    if (request.method === "POST" && url.pathname === COLLECTION_ROUTE) return await queueInput(request, deps);
    if (request.method === "PATCH" && [COLLECTION_ROUTE + "/settings", COLLECTION_ROUTE + "/order"].includes(url.pathname)) {
      assertSameOriginWrite(request);
      assertJsonRequest(request);
      const body = await jsonObject(request);
      const identity = requestedIdentity(body);
      if (url.pathname.endsWith("/settings")) {
        if (typeof body.autoSend !== "boolean") throw new ValidationError("autoSend must be boolean");
        deps.outbox.updateSetting(identity, { autoSend: body.autoSend, error: null });
      } else {
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string") || !Number.isInteger(body.version)) {
          throw new ValidationError("order requires ids and queue version");
        }
        deps.outbox.reorder(identity, body.ids as string[], body.version as number);
      }
      return json({ ok: true, version: deps.outbox.version });
    }
    const sendId = decodedId(url.pathname, SEND_ROUTE);
    if (request.method === "POST" && sendId !== null) {
      const item = deps.outbox.get(sendId);
      return item === null ? json({ error: "outbox item not found" }, 404) : await sendQueuedInput(request, item, deps);
    }
    const itemId = decodedId(url.pathname, ITEM_ROUTE);
    if (request.method === "DELETE" && itemId !== null) {
      assertSameOriginWrite(request);
      return json({ ok: deps.outbox.remove(itemId), version: deps.outbox.version });
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof SendConflictError) return json({ error: error.message, code: error.code }, CONFLICT_STATUS);
    if (error instanceof ValidationError) return json({ error: error.message }, 400);
    if (error instanceof OrcaError) return json({ error: error.message }, 502);
    throw error;
  }
}
