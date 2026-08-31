import type { BoardKind } from "./board";
import { LOCAL_BOARD_ID } from "./local";

export interface RemoteBoardConfig {
  id: string;
  name: string;
  kind: Exclude<BoardKind, "local">;
  baseUrl: string;
  webUrl: string | null;
  apiKey: string | null;
}

const REMOTE_KINDS = new Set<string>(["kansession"]);

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`ORCATAB_BOARDS: ${field} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`ORCATAB_BOARDS: ${field} must be a string`);
  return value.trim() || null;
}

function normalizedUrl(value: string, field: string): string {
  try { return new URL(value).toString().replace(/\/$/, ""); }
  catch { throw new Error(`ORCATAB_BOARDS: ${field} must be a valid URL`); }
}

/**
 * Boards are configured, never discovered: a board holds the user's work, so OrcaTab must not
 * guess at one. Malformed config throws at startup rather than silently dropping a board.
 */
export function parseBoardConfigs(raw: string): RemoteBoardConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("ORCATAB_BOARDS must be a JSON array"); }
  if (!Array.isArray(parsed)) throw new Error("ORCATAB_BOARDS must be a JSON array");

  const seen = new Set<string>([LOCAL_BOARD_ID]);
  return parsed.map((entry, index) => {
    if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
      throw new Error(`ORCATAB_BOARDS[${index}] must be an object`);
    }
    const value = entry as Record<string, unknown>;
    const id = requiredText(value.id, `[${index}].id`);
    if (seen.has(id)) throw new Error(`ORCATAB_BOARDS contains duplicate id "${id}"`);
    seen.add(id);
    const kind = requiredText(value.kind, `[${index}].kind`);
    if (!REMOTE_KINDS.has(kind)) throw new Error(`ORCATAB_BOARDS[${index}].kind must be one of: ${[...REMOTE_KINDS].join(", ")}`);
    const webUrl = optionalText(value.webUrl, `[${index}].webUrl`);
    return {
      id,
      name: optionalText(value.name, `[${index}].name`) ?? id,
      kind: kind as RemoteBoardConfig["kind"],
      baseUrl: normalizedUrl(requiredText(value.baseUrl, `[${index}].baseUrl`), `[${index}].baseUrl`),
      webUrl: webUrl === null ? null : normalizedUrl(webUrl, `[${index}].webUrl`),
      apiKey: optionalText(value.apiKey, `[${index}].apiKey`),
    };
  });
}

export function boardConfigsFromEnv(raw = process.env.ORCATAB_BOARDS): RemoteBoardConfig[] {
  const configured = raw?.trim();
  return configured ? parseBoardConfigs(configured) : [];
}
