import { describe, expect, spyOn, test } from "bun:test";
import { FTS_TEXT_MAX_CHARS } from "../src/config";
import { OrcaDatabase, type StoredSession } from "../src/db";
import { createIndexer, type IndexSummary } from "../src/indexer";
import { parseLine } from "../src/parse";
import type { PullAgentsRequest, PullResult } from "../src/remote-pull";
import type { SessionFileInfo } from "../src/session-source";
import { indexJsonlSession } from "../src/sources/jsonl";
import { createRemoteEnvironmentSources, createRemoteProjectResolver } from "../src/sources/remote";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const CODEX_SID = "bbbbbbbb-2222-3333-4444-555555555555";
const REMOTE_PATH = `/Users/mac/.claude/projects/-p/${SID}.jsonl`;
const CODEX_PATH = `/Users/mac/.codex/sessions/2026/08/30/rollout-2026-08-30T09-00-00-${CODEX_SID}.jsonl`;
const BOTH_AGENTS: PullAgentsRequest = { claude: true, codex: { sinceDays: 90, index: null } };

function info(overrides: Partial<SessionFileInfo> = {}): SessionFileInfo {
  return { agent: "claude", sid: SID, path: REMOTE_PATH, size: 0, mtime: 1, ...overrides };
}

function prompt(text: string, timestamp: string): string {
  return `${JSON.stringify({ type: "user", message: { content: text }, timestamp, cwd: "/p", gitBranch: "main" })}\n`;
}

function assistant(text: string, timestamp: string): string {
  return `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp })}\n`;
}

function window(text: string, options: { offset?: number; rebuild?: boolean } = {}) {
  return { offset: options.offset ?? 0, bytes: Buffer.from(text, "utf8"), rebuild: options.rebuild ?? true };
}

function codexLines(text: string, timestamp: string): string {
  return [
    JSON.stringify({ timestamp, type: "session_meta", payload: { session_id: CODEX_SID, cwd: "/p" } }),
    JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
  ].join("\n") + "\n";
}

function emptyRound(): PullResult {
  return {
    files: [], codexFiles: [], chunks: new Map(), rebuilds: new Set(), codexIndex: null,
    truncated: false, done: true, lastPath: null, errors: [], missing: [],
  };
}

describe("shared JSONL ingest", () => {
  test("folds complete prompts and capped assistant text into counters and cursors", () => {
    const long = "长".repeat(FTS_TEXT_MAX_CHARS + 1_000);
    const text = prompt("  第一条 <context>忽略标签</context>  ", "2026-08-30T01:00:00.000Z")
      + JSON.stringify({ type: "user", isMeta: true, message: { content: "注入不计数" }, timestamp: "2026-08-30T01:30:00.000Z" }) + "\n"
      + assistant("助手回答", "2026-08-30T03:00:00.000Z")
      + prompt(long, "2026-08-30T02:00:00.000Z");
    const update = indexJsonlSession({
      info: info({ env: "feibo2", size: Buffer.byteLength(text), mtime: 42 }),
      stored: null, window: window(text), parseLine,
    })!;

    expect(update.replaceFts).toBeTrue();
    expect(update.session).toMatchObject({
      env: "feibo2", cwd: "/p", branch: "main", promptCount: 2,
      firstPrompt: "第一条 忽略标签", lastPrompt: "长".repeat(200),
      // The later prompt timestamp wins even though an assistant row sits between them.
      lastInputAt: Date.parse("2026-08-30T02:00:00.000Z"),
      fileSize: Buffer.byteLength(text), fileMtime: 42, parsedOffset: Buffer.byteLength(text),
    });
    expect(update.fts.map((row) => row.role)).toEqual(["user", "assistant", "user"]);
    expect(update.fts.every((row) => row.env === "feibo2")).toBeTrue();
    expect(update.fts[2]!.text).toBe(long);
  });

  test("a window without a complete record makes no progress and no commit", () => {
    const stored: StoredSession = {
      agent: "claude", sid: SID, projectKey: "p", cwd: "/p", worktreeRoot: null, branch: null, title: null,
      firstPrompt: "旧", lastPrompt: "旧", lastInputAt: 1, promptCount: 1, filePath: REMOTE_PATH,
      fileSize: 10, fileMtime: 5, parsedOffset: 10,
    };
    expect(indexJsonlSession({
      info: info({ size: 24, mtime: 6 }), stored, window: window('{"type":"user"', { offset: 10, rebuild: false }), parseLine,
    })).toBeNull();
    expect(indexJsonlSession({ info: info({ size: 10, mtime: 5 }), stored, window: null, parseLine })).toBeNull();
  });

  test("an out-of-band title is applied, removed and never taken from the transcript", () => {
    const stored: StoredSession = {
      agent: "codex", sid: CODEX_SID, projectKey: "p", cwd: "/p", worktreeRoot: null, branch: null,
      title: "旧标题", firstPrompt: "问", lastPrompt: "问", lastInputAt: 1, promptCount: 1,
      filePath: CODEX_PATH, fileSize: 10, fileMtime: 5, parsedOffset: 10,
    };
    const removed = indexJsonlSession({
      info: info({ agent: "codex", sid: CODEX_SID, path: CODEX_PATH, size: 10, mtime: 5 }),
      stored, window: null, parseLine, title: null,
    })!;
    expect(removed).toMatchObject({ replaceFts: false, fts: [] });
    expect(removed.session.title).toBeNull();
    expect(removed.session.promptCount).toBe(1);

    const renamed = indexJsonlSession({
      info: info({ agent: "codex", sid: CODEX_SID, path: CODEX_PATH, size: 10, mtime: 5 }),
      stored, window: null, parseLine, title: "新标题",
    })!;
    expect(renamed.session.title).toBe("新标题");
    expect(indexJsonlSession({
      info: info({ agent: "codex", sid: CODEX_SID, path: CODEX_PATH, size: 10, mtime: 5 }),
      stored, window: null, parseLine, title: "旧标题",
    })).toBeNull();
  });

  test("a title carried by the transcript survives when the source has no title channel", () => {
    const text = `${JSON.stringify({ type: "ai-title", aiTitle: "转写标题" })}\n`;
    const update = indexJsonlSession({ info: info({ size: Buffer.byteLength(text) }), stored: null, window: window(text), parseLine })!;
    expect(update.session.title).toBe("转写标题");
  });
});

function createRemoteHarness(db: OrcaDatabase, rounds: PullResult[]) {
  const agentsLog: PullAgentsRequest[] = [];
  const handle = createRemoteEnvironmentSources({
    env: "feibo2", db, agents: BOTH_AGENTS,
    pull: (_cursors, agents) => {
      agentsLog.push(agents);
      return Promise.resolve(rounds.shift() ?? emptyRound());
    },
  });
  const indexer = createIndexer({
    db, sources: handle.sources, foldProjects: false, markIndexedAt: false,
    resolveProject: (cwd) => createRemoteProjectResolver("feibo2")(cwd),
    resolveWorktree: () => null,
  });
  const errors: string[] = [];
  const summaries: IndexSummary[] = [];
  return {
    agentsLog, errors, summaries,
    round: async () => {
      errors.push(...(await handle.runRound()).errors);
      summaries.push(await indexer.indexAll());
    },
  };
}

function claudeRound(content: string, options: { offset?: number; mtime?: number } = {}): PullResult {
  const bytes = Buffer.from(content, "utf8");
  const offset = options.offset ?? 0;
  return {
    ...emptyRound(),
    files: [{ path: REMOTE_PATH, size: offset + bytes.byteLength, mtime: options.mtime ?? 10 }],
    chunks: new Map([[REMOTE_PATH, { offset, bytes }]]),
  };
}

describe("remote commit durability", () => {
  test("a failed commit keeps the received bytes and the retry lands exactly once", async () => {
    const db = new OrcaDatabase(":memory:");
    const content = prompt("第一问", "2026-08-30T01:00:00.000Z") + prompt("第二问", "2026-08-30T02:00:00.000Z");
    const listedAgain: PullResult = { ...emptyRound(), files: [{ path: REMOTE_PATH, size: Buffer.byteLength(content), mtime: 10 }] };
    const harness = createRemoteHarness(db, [claudeRound(content), listedAgain]);

    const failing = spyOn(db, "appendSessionFts").mockImplementation(() => { throw new Error("磁盘写入失败"); });
    await harness.round();
    failing.mockRestore();
    // The commit is reported as a contextual issue, not thrown past the pass.
    expect(harness.summaries.at(-1)!.errors).toMatchObject([{ stage: "commit", source: "claude", path: REMOTE_PATH }]);
    expect(harness.summaries.at(-1)!.errors[0]!.message).toContain("磁盘写入失败");

    expect(db.getStoredSession("claude", SID, "feibo2")).toBeNull();
    expect(db.countSessionFts("claude", SID, "feibo2")).toBe(0);
    const held = db.remoteReadStates("feibo2").get(REMOTE_PATH)!;
    expect(held).toMatchObject({ receivedFrom: 0, receivedTo: Buffer.byteLength(content), replacePending: true });
    expect(db.remotePendingBytes("feibo2", REMOTE_PATH).byteLength).toBe(Buffer.byteLength(content));

    await harness.round();
    const stored = db.getStoredSession("claude", SID, "feibo2")!;
    expect(stored.promptCount).toBe(2);
    expect(stored.parsedOffset).toBe(Buffer.byteLength(content));
    expect(db.countSessionFts("claude", SID, "feibo2")).toBe(2);
    expect(db.remotePendingBytes("feibo2", REMOTE_PATH).byteLength).toBe(0);
    db.close();
  });

  test("a chunk restarting at zero without a replacement is refused as an invalid range", async () => {
    const db = new OrcaDatabase(":memory:");
    const first = prompt("第一问", "2026-08-30T01:00:00.000Z");
    const stale = prompt("伪造的重放", "2026-08-30T00:00:00.000Z");
    const bogus: PullResult = {
      ...emptyRound(),
      // Same stat, so nothing was replaced, yet the collector restarts the file at zero.
      files: [{ path: REMOTE_PATH, size: Buffer.byteLength(first), mtime: 10 }],
      chunks: new Map([[REMOTE_PATH, { offset: 0, bytes: Buffer.from(stale, "utf8") }]]),
    };
    const harness = createRemoteHarness(db, [claudeRound(first), bogus]);

    await harness.round();
    const before = db.getStoredSession("claude", SID, "feibo2")!;
    const heldBefore = db.remoteReadStates("feibo2").get(REMOTE_PATH)!;
    expect(heldBefore.generation).toBe(0);

    await harness.round();
    expect(db.getStoredSession("claude", SID, "feibo2")).toEqual(before);
    expect(db.remoteReadStates("feibo2").get(REMOTE_PATH)).toEqual(heldBefore);
    expect(db.countSessionFts("claude", SID, "feibo2")).toBe(1);
    expect(harness.errors.some((error) => error.includes("starts at 0"))).toBeTrue();
    db.close();
  });

  test("an acknowledgement cannot reach past the bytes actually received", async () => {
    const db = new OrcaDatabase(":memory:");
    const content = `${prompt("只到这里", "2026-08-30T01:00:00.000Z")}{"type":"user"`;
    const harness = createRemoteHarness(db, [claudeRound(content)]);
    await harness.round();
    const held = db.remoteReadStates("feibo2").get(REMOTE_PATH)!;
    expect(held.receivedTo - held.receivedFrom).toBe(14);
    const stored = db.getStoredSession("claude", SID, "feibo2")!;

    const overreaching = db.applySessionUpdate({
      session: { ...stored, parsedOffset: stored.parsedOffset + 500 },
      fts: [], replaceFts: false,
      project: { key: "feibo2:/p", name: "p", root: "", color: null },
      ack: { env: "feibo2", path: REMOTE_PATH, generation: held.generation, receivedFrom: held.receivedFrom, consumed: 500 },
    });
    expect(overreaching).toBeFalse();
    expect(db.remoteReadStates("feibo2").get(REMOTE_PATH)).toEqual(held);
    expect(db.remotePendingBytes("feibo2", REMOTE_PATH).byteLength).toBe(14);
    expect(db.getStoredSession("claude", SID, "feibo2")!.parsedOffset).toBe(stored.parsedOffset);
    db.close();
  });

  test("an aborted transfer carrying a title update advances neither content nor the title cache", async () => {
    const db = new OrcaDatabase(":memory:");
    const first = codexLines("codex 第一问", "2026-08-30T01:00:00.000Z");
    const more = prompt("不应被采纳", "2026-08-30T02:00:00.000Z");
    const firstRound: PullResult = {
      ...emptyRound(),
      codexFiles: [{ path: CODEX_PATH, size: Buffer.byteLength(first), mtime: 10 }],
      chunks: new Map([[CODEX_PATH, { offset: 0, bytes: Buffer.from(first, "utf8") }]]),
    };
    const aborted: PullResult = {
      ...emptyRound(), done: false,
      codexFiles: [{ path: CODEX_PATH, size: Buffer.byteLength(first + more), mtime: 20 }],
      chunks: new Map([[CODEX_PATH, { offset: Buffer.byteLength(first), bytes: Buffer.from(more, "utf8") }]]),
      codexIndex: { data: Buffer.from(`${JSON.stringify({ id: CODEX_SID, thread_name: "中断标题" })}\n`, "utf8"), size: 88, mtime: 9 },
    };
    const harness = createRemoteHarness(db, [firstRound, aborted, emptyRound()]);

    await harness.round();
    const before = db.getStoredSession("codex", CODEX_SID, "feibo2")!;
    expect(before.title).toBeNull();
    const heldBefore = db.remoteReadStates("feibo2").get(CODEX_PATH)!;

    await harness.round();
    expect(db.getStoredSession("codex", CODEX_SID, "feibo2")).toEqual(before);
    expect(db.remoteReadStates("feibo2").get(CODEX_PATH)).toEqual(heldBefore);
    expect(db.countSessionFts("codex", CODEX_SID, "feibo2")).toBe(1);

    // The third round still reports no applied index stat, so the aborted aux file is re-requested.
    await harness.round();
    expect(harness.agentsLog.map((agents) => agents.codex?.index)).toEqual([null, null, null]);
    expect(db.getStoredSession("codex", CODEX_SID, "feibo2")!.title).toBeNull();
    db.close();
  });
});
