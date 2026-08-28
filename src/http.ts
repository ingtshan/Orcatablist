import { ValidationError } from "./focus";
import type { FocusResult } from "./types";

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(value, { status, headers: responseHeaders });
}

export function conditionalJson(request: Request, etag: string, value: () => unknown): Response {
  const headers = { ETag: etag, "Cache-Control": "no-store" };
  if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  return json(value(), 200, { ETag: etag });
}

export function boundedLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); }
  catch { throw new ValidationError("invalid JSON body"); }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ValidationError("JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

export function requiredName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("name is required");
  return value.trim();
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new ValidationError(`${field} is required`);
  return value;
}

export function nullableText(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string or null`);
  return value.trim() || null;
}

export function decodeParts(pathname: string, prefix: string): string[] {
  try { return pathname.slice(prefix.length).split("/").map(decodeURIComponent); }
  catch { throw new ValidationError("invalid path encoding"); }
}

/** `same-site` is excluded on purpose: another local port is a different app, not this page. */
const SAFE_FETCH_SITES = new Set(["same-origin", "none"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function allowedOrigin(origin: string, request: Request): boolean {
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTNAMES.has(url.hostname) || url.host === request.headers.get("Host");
  } catch { return false; }
}

/**
 * State-changing routes are reachable from any page the user visits, because the server has no
 * auth and browsers happily send cross-site POSTs. Reject anything a browser marks as foreign.
 */
export function assertSameOriginWrite(request: Request): void {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && !SAFE_FETCH_SITES.has(site)) throw new ValidationError("cross-site request rejected");
  const origin = request.headers.get("Origin");
  if (origin !== null && !allowedOrigin(origin, request)) throw new ValidationError("cross-origin request rejected");
}

/** A JSON content type forces a CORS preflight, which this server never answers. */
export function assertJsonRequest(request: Request): void {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ValidationError("Content-Type must be application/json");
  }
}

export function focusText(result: FocusResult): string {
  if (result.action === "switched") return `switched ${result.handle}`;
  if (result.action === "resumed") return `resumed ${result.handle}`;
  return `manual ${result.reason}${result.command ? ` ${result.command}` : ""}`;
}
