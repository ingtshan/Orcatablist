import { FIRST_PROMPT_MAX_CHARS } from "./config";
import type { ParsedEvent } from "./types";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null ? value as JsonRecord : null;
}

function metadata(record: JsonRecord): Pick<ParsedEvent, "cwd" | "branch" | "version"> {
  return {
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(typeof record.gitBranch === "string" ? { branch: record.gitBranch } : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
  };
}

function timestamp(record: JsonRecord): number | null {
  if (typeof record.timestamp !== "string") return null;
  const parsed = Date.parse(record.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstUserText(message: JsonRecord | null): string | null {
  if (message === null) return null;
  if (typeof message.content === "string") return message.content.trim() ? message.content : null;
  if (!Array.isArray(message.content)) return null;
  const first = asRecord(message.content[0]);
  if (first?.type !== "text" || typeof first.text !== "string") return null;
  return first.text.trim() ? first.text : null;
}

export function cleanPromptForDisplay(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FIRST_PROMPT_MAX_CHARS);
}

export function parseLine(line: string): ParsedEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "skip" };
  }
  const record = asRecord(value);
  if (record === null) return { kind: "skip" };
  const meta = metadata(record);

  if (record.type === "ai-title") {
    const title = typeof record.aiTitle === "string" ? record.aiTitle.trim() : "";
    return title ? { kind: "title", title, ...meta } : { kind: "skip" };
  }

  if (record.type === "user") {
    if (record.isMeta === true) return { kind: "skip" };
    const text = firstUserText(asRecord(record.message));
    return text === null ? { kind: "skip" } : { kind: "prompt", text, ts: timestamp(record), ...meta };
  }

  if (record.type === "assistant") {
    const message = asRecord(record.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      const text = content
        .map(asRecord)
        .filter((block): block is JsonRecord => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .filter((part) => part.length > 0)
        .join("\n");
      if (text) return { kind: "assistant-text", text, ts: timestamp(record), ...meta };
    }
    return { kind: "skip" };
  }

  return { kind: "skip" };
}
