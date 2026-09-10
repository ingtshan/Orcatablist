import { FTS_TEXT_MAX_CHARS } from "../config";
import type { FtsRow, StoredSession } from "../db";
import { cleanPromptForDisplay } from "../parse";
import type { SessionFileInfo } from "../session-source";
import type { ParsedEvent } from "../types";
import { EXECUTION_METADATA_VERSION } from "../session-execution";
import { jsonlBriefEvent, type BriefEvent } from "../session-brief-events";

export interface FoldedTranscript { session: StoredSession; fts: FtsRow[]; briefEvents: BriefEvent[]; }

export function emptySession(file: SessionFileInfo): StoredSession {
  return {
    agent: file.agent, ...(file.env === undefined ? {} : { env: file.env }), sid: file.sid,
    projectKey: "unknown", cwd: null, worktreeRoot: null, branch: null, title: null,
    firstPrompt: null, lastPrompt: null, lastInputAt: null, promptCount: 0, filePath: file.path,
    fileSize: 0, fileMtime: 0, parsedOffset: 0,
    model: null, reasoningEffort: null, executionMetadataVersion: EXECUTION_METADATA_VERSION,
  };
}

/**
 * Folds transcript events onto a session: first/last cleaned prompt, prompt counter, the maximum
 * user timestamp and the searchable rows. Shared by every JSONL source, local and remote.
 */
export function foldTranscript(
  base: StoredSession, lines: string[], parseLine: (line: string) => ParsedEvent,
): FoldedTranscript {
  let session = { ...base };
  const fts: FtsRow[] = [];
  const briefEvents: BriefEvent[] = [];
  let offset = base.parsedOffset;
  for (const line of lines) {
    const event = parseLine(line);
    const briefEvent = jsonlBriefEvent(base.agent, line, event, offset);
    if (briefEvent !== null) briefEvents.push(briefEvent);
    offset += Buffer.byteLength(line) + 1;
    if (event.model !== undefined) session = { ...session, model: event.model };
    if (event.reasoningEffort !== undefined) session = { ...session, reasoningEffort: event.reasoningEffort };
    if (session.cwd === null && event.cwd) {
      session = { ...session, cwd: event.cwd, branch: event.branch ?? session.branch };
    }
    if (event.kind === "title" && event.title !== undefined) session = { ...session, title: event.title };
    if (event.kind === "prompt" && event.text !== undefined) {
      const cleaned = cleanPromptForDisplay(event.text);
      session = {
        ...session,
        firstPrompt: session.firstPrompt ?? (cleaned || null),
        lastPrompt: cleaned ? cleaned : session.lastPrompt,
        lastInputAt: event.ts === null || event.ts === undefined
          ? session.lastInputAt : Math.max(session.lastInputAt ?? event.ts, event.ts),
        promptCount: session.promptCount + 1,
      };
      fts.push({
        text: event.text, agent: session.agent, sid: session.sid, role: "user", ts: event.ts ?? null,
        ...(session.env === undefined ? {} : { env: session.env }),
      });
    }
    if (event.kind === "assistant-text" && event.text !== undefined) {
      fts.push({
        text: event.text.slice(0, FTS_TEXT_MAX_CHARS), agent: session.agent, sid: session.sid, role: "assistant", ts: event.ts ?? null,
        ...(session.env === undefined ? {} : { env: session.env }),
      });
    }
  }
  return { session, fts, briefEvents };
}
