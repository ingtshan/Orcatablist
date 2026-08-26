import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionFileInfo, SessionSource } from "../indexer";
import type { ParsedEvent } from "../types";

type JsonRecord = Record<string, unknown>;

const FIRST_LINE_CHUNK_BYTES = 64 * 1_024;
const FIRST_LINE_MAX_BYTES = 4 * 1_024 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLLOUT_FILE_PATTERN = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const INJECTED_TAGS = ["<user_instructions>", "<environment_context>", "<INSTRUCTIONS>"];

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? value as JsonRecord : null;
}

function eventTimestamp(record: JsonRecord): number | null {
  if (typeof record.timestamp !== "string") return null;
  const parsed = Date.parse(record.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFirstLine(path: string, size?: number): string | null {
  const byteLength = Math.min(size ?? statSync(path).size, FIRST_LINE_MAX_BYTES);
  if (byteLength <= 0) return null;
  const descriptor = openSync(path, "r");
  const chunks: Buffer[] = [];
  let offset = 0;
  try {
    while (offset < byteLength) {
      const buffer = Buffer.allocUnsafe(Math.min(FIRST_LINE_CHUNK_BYTES, byteLength - offset));
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
      offset += bytesRead;
      if (newline >= 0) break;
    }
  } finally { closeSync(descriptor); }
  return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "") || null;
}

function sessionMeta(line: string | null): JsonRecord | null {
  if (line === null) return null;
  try {
    const record = asRecord(JSON.parse(line));
    return record?.type === "session_meta" ? asRecord(record.payload) : null;
  } catch {
    return null;
  }
}

function discoverDirectory(directory: string, files: SessionFileInfo[], sessionIds: Map<string, string>): void {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      discoverDirectory(path, files, sessionIds);
      continue;
    }
    const match = entry.isFile() ? ROLLOUT_FILE_PATTERN.exec(entry.name) : null;
    if (match === null) continue;
    const stat = statSync(path);
    const fallbackSid = match[1]!;
    const cachedSid = sessionIds.get(path);
    const metaSid = cachedSid ?? sessionMeta(readFirstLine(path, stat.size))?.session_id;
    const sid = typeof metaSid === "string" && UUID_PATTERN.test(metaSid) ? metaSid : fallbackSid;
    if (sid === metaSid) sessionIds.set(path, sid);
    files.push({ agent: "codex", sid, path, size: stat.size, mtime: Math.trunc(stat.mtimeMs) });
  }
}

function discoverCodexSessionFilesCached(codexDir: string, sessionIds: Map<string, string>): SessionFileInfo[] {
  const files: SessionFileInfo[] = [];
  discoverDirectory(join(codexDir, "sessions"), files, sessionIds);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function discoverCodexSessionFiles(codexDir: string): SessionFileInfo[] {
  return discoverCodexSessionFilesCached(codexDir, new Map());
}

function findRolloutPath(directory: string, sid: string): string | null {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return null; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findRolloutPath(path, sid);
      if (found !== null) return found;
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${sid}.jsonl`)) return path;
  }
  return null;
}

export function findCodexSessionCwd(sid: string, codexDir: string): string | null {
  const path = findRolloutPath(join(codexDir, "sessions"), sid);
  if (path === null) return null;
  const cwd = sessionMeta(readFirstLine(path))?.cwd;
  return typeof cwd === "string" && cwd ? cwd : null;
}

function messageText(content: unknown, blockType: "input_text" | "output_text" | "text"): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .map(asRecord)
    .filter((block): block is JsonRecord => block?.type === blockType && typeof block.text === "string")
    .map((block) => block.text as string)
    .filter((text) => text.length > 0);
}

function isInjectedUserMessage(text: string): boolean {
  if (text.startsWith("# AGENTS.md instructions") || text.startsWith("## Memory")) return true;
  const trimmed = text.trim();
  return trimmed.startsWith("<") && INJECTED_TAGS.some((tag) => text.includes(tag));
}

export function parseCodexLine(line: string): ParsedEvent {
  let record: JsonRecord | null;
  try { record = asRecord(JSON.parse(line)); }
  catch { return { kind: "skip" }; }
  if (record === null) return { kind: "skip" };
  const payload = asRecord(record.payload);
  if (record.type === "session_meta" && payload !== null) {
    const git = asRecord(payload.git);
    return {
      kind: "meta",
      ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
      ...(typeof git?.branch === "string" ? { branch: git.branch } : {}),
    };
  }
  if (record.type !== "response_item" || payload?.type !== "message") return { kind: "skip" };
  if (payload.role === "user") {
    const text = messageText(payload.content, "input_text").join("\n");
    if (!text || isInjectedUserMessage(text)) return { kind: "skip" };
    return { kind: "prompt", text, ts: eventTimestamp(record) };
  }
  if (payload.role === "assistant") {
    const output = messageText(payload.content, "output_text");
    const text = (output.length > 0 ? output : messageText(payload.content, "text")).join("\n");
    return text ? { kind: "assistant-text", text, ts: eventTimestamp(record) } : { kind: "skip" };
  }
  return { kind: "skip" };
}

function loadTitles(codexDir: string): Map<string, string> {
  const titles = new Map<string, string>();
  let text: string;
  try { text = readFileSync(join(codexDir, "session_index.jsonl"), "utf8"); }
  catch { return titles; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const record = asRecord(JSON.parse(line));
      const id = record?.id;
      const title = record?.thread_name;
      if (typeof id === "string" && typeof title === "string" && title.trim()) titles.set(id, title.trim());
    } catch { continue; }
  }
  return titles;
}

export function createCodexSource(codexDir: string): SessionSource {
  let titles = new Map<string, string>();
  const sessionIds = new Map<string, string>();
  return {
    agent: "codex",
    discover: () => discoverCodexSessionFilesCached(codexDir, sessionIds),
    parseLine: parseCodexLine,
    prepare: () => { titles = loadTitles(codexDir); },
    titleFor: (sid) => titles.get(sid) ?? null,
  };
}
