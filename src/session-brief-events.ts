import { createHash } from "node:crypto";
import type { Agent, ParsedEvent } from "./types";

export interface BriefEvent {
  kind: "user" | "assistant" | "complete";
  key: string;
  at: number | null;
  text?: string;
  complete?: boolean;
}

export function briefHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Preserve the original text before FTS truncation; completion needs an explicit source signal. */
export function jsonlBriefEvent(agent: Agent, line: string, event: ParsedEvent, offset: number): BriefEvent | null {
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(line)); } catch { return null; }
  const payload = record(raw.payload);
  const message = record(raw.message);
  const parsedAt = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
  const at = event.ts ?? (Number.isFinite(parsedAt) ? parsedAt : null);
  const identity = raw.uuid ?? payload.id ?? (at === null ? offset : raw.timestamp);
  const key = briefHash([identity, raw.type, payload.type, event.kind, event.text]);
  if (event.kind === "prompt" && event.text?.trim()) return { kind: "user", key, at, text: event.text };
  if (event.kind === "assistant-text" && event.text?.trim()) {
    if (agent === "codex" && payload.channel === "analysis") return null;
    return {
      kind: "assistant", key, at, text: event.text,
      complete: agent === "codex" ? payload.channel === "final" : message.stop_reason === "end_turn",
    };
  }
  if ((agent === "claude" && raw.type === "system" && raw.subtype === "turn_duration")
    || (agent === "codex" && raw.type === "event_msg" && payload.type === "task_complete")) {
    return { kind: "complete", key, at,
      ...(typeof payload.last_agent_message === "string" ? { text: payload.last_agent_message } : {}) };
  }
  return null;
}

export const BRIEF_RESPONSE_LINES = 6;
export const BRIEF_RESPONSE_MAX_CHARS = 2_400;
export const BRIEF_INPUT_MAX_CHARS = 1_200;

/** Keep the end, including the end of an exceptionally long single line. No summarization. */
export function responseTail(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").trimEnd().split("\n");
  const tail = lines.slice(-BRIEF_RESPONSE_LINES).join("\n");
  return (lines.length > BRIEF_RESPONSE_LINES || tail.length > BRIEF_RESPONSE_MAX_CHARS ? "…\n" : "")
    + tail.slice(-BRIEF_RESPONSE_MAX_CHARS);
}

export function inputPreview(text: string): string {
  return text.length > BRIEF_INPUT_MAX_CHARS ? text.slice(0, BRIEF_INPUT_MAX_CHARS) + "…" : text;
}
