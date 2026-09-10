import { closeSync, openSync, readSync } from "node:fs";
import type { StoredSession } from "../db";
import type { RemoteReadAck } from "../remote-read-state";
import type { SessionFileInfo, SessionUpdate } from "../session-source";
import type { ParsedEvent } from "../types";
import { emptySession, foldTranscript } from "./transcript";

const BYTE_NEWLINE = 0x0a;

export interface CompleteRead { lines: string[]; consumedBytes: number; }

/** JSONL is consumed only up to its final newline; a half-written line waits for the next round. */
export function completeLines(bytes: Uint8Array): CompleteRead {
  const complete = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const finalNewline = complete.lastIndexOf(BYTE_NEWLINE);
  if (finalNewline < 0) return { lines: [], consumedBytes: 0 };
  const text = complete.subarray(0, finalNewline).toString("utf8");
  return { lines: text ? text.split("\n") : [], consumedBytes: finalNewline + 1 };
}

export function readFileBytes(path: string, offset: number, size: number): Uint8Array {
  const byteLength = size - offset;
  if (byteLength <= 0) return new Uint8Array(0);
  const buffer = Buffer.allocUnsafe(byteLength);
  const descriptor = openSync(path, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < byteLength) {
      const count = readSync(descriptor, buffer, bytesRead, byteLength - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
  } finally {
    closeSync(descriptor);
  }
  return buffer.subarray(0, bytesRead);
}

/** Bytes to fold, and where they sit in the file. `rebuild` starts a fresh read generation. */
export interface JsonlWindow { offset: number; bytes: Uint8Array; rebuild: boolean; }

export interface JsonlIndexInput {
  info: SessionFileInfo;
  stored: StoredSession | null;
  /** Null when the source has nothing fetched for this file this round. */
  window: JsonlWindow | null;
  parseLine(line: string): ParsedEvent;
  /** Undefined when the source carries no out-of-band title; null removes a stored title. */
  title?: string | null;
  /** Remote only: builds the acknowledgement for however many bytes the fold consumed. */
  ack?(consumed: number): RemoteReadAck;
}

/**
 * The one JSONL ingest: title-only updates, partial-record handling, cursor arithmetic and the
 * observed stat all live here so local and remote sources cannot drift apart.
 */
export function indexJsonlSession(input: JsonlIndexInput): SessionUpdate | null {
  const { info, stored, window } = input;
  const titled = input.title !== undefined;
  const title = input.title ?? null;
  const rebuild = window?.rebuild === true;
  const read = window === null ? null : completeLines(window.bytes);
  if (!rebuild && (read === null || read.consumedBytes === 0)) {
    if (stored === null || !titled || stored.title === title) return null;
    return { session: { ...stored, title }, fts: [], replaceFts: false };
  }
  const base = rebuild || stored === null ? emptySession(info) : stored;
  const parsed = foldTranscript(titled ? { ...base, title: null } : base, read?.lines ?? [], input.parseLine);
  const consumed = read?.consumedBytes ?? 0;
  const session: StoredSession = {
    ...parsed.session,
    title: titled ? title : parsed.session.title,
    filePath: info.path,
    // The full observed size, even when only part of it has been transferred: the parse cursor,
    // not the size, records how far this session has actually been read.
    fileSize: info.size,
    fileMtime: info.mtime,
    parsedOffset: (window?.offset ?? base.parsedOffset) + consumed,
  };
  const ack = input.ack?.(consumed);
  return { session, fts: parsed.fts, briefEvents: parsed.briefEvents, replaceFts: rebuild, ...(ack === undefined ? {} : { ack }) };
}

export interface LocalJsonlOptions {
  parseLine(line: string): ParsedEvent;
  title?: string | null;
}

/** Local files are always readable in full, so the window is just the tail past the cursor. */
export function indexLocalJsonlSession(
  info: SessionFileInfo, stored: StoredSession | null, options: LocalJsonlOptions,
): SessionUpdate | null {
  const rebuild = stored === null || stored.filePath !== info.path || info.size < stored.fileSize
    || stored.executionMetadataVersion === 0
    || (info.size === stored.fileSize && info.mtime !== stored.fileMtime);
  const settled = !rebuild && stored !== null && stored.fileMtime === info.mtime && stored.parsedOffset >= info.size;
  const offset = rebuild ? 0 : stored!.parsedOffset;
  const window: JsonlWindow | null = settled
    ? null
    : { offset, bytes: readFileBytes(info.path, offset, info.size), rebuild };
  const update = indexJsonlSession({ info, stored, window, parseLine: options.parseLine, ...("title" in options ? { title: options.title } : {}) });
  if (stored?.executionMetadataVersion === 0 && update && stored.filePath === info.path
    && stored.fileSize === info.size && stored.fileMtime === info.mtime) {
    return { session: { ...stored, title: update.session.title, model: update.session.model,
      reasoningEffort: update.session.reasoningEffort, executionMetadataVersion: update.session.executionMetadataVersion },
    fts: [], replaceFts: false };
  }
  return update;
}
