import { describe, expect, test } from "bun:test";
import { OrcaDatabase } from "../src/db";
import { createIndexer } from "../src/indexer";
import type { RemoteReadCursor } from "../src/remote-read-state";
import type { PullAgentsRequest, PullResult } from "../src/remote-pull";
import { createRemoteEnvironmentSources, createRemoteProjectResolver } from "../src/sources/remote";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const CODEX_SID = "bbbbbbbb-2222-3333-4444-555555555555";
const REMOTE_PATH = `/Users/mac/.claude/projects/-Users-mac-workspace-we-orca/${SID}.jsonl`;
const CODEX_PATH = `/Users/mac/.codex/sessions/2026/08/30/rollout-2026-08-30T09-00-00-${CODEX_SID}.jsonl`;
const BOTH_AGENTS: PullAgentsRequest = { claude: true, codex: { sinceDays: 90, index: null } };

function prompt(text: string, timestamp: string): string {
  return `${JSON.stringify({
    type: "user", message: { content: text }, timestamp, cwd: "/Users/mac/workspace/we-orca", gitBranch: "main",
  })}\n`;
}

function codexLines(text: string, timestamp: string): string {
  return [
    JSON.stringify({ timestamp, type: "session_meta", payload: { session_id: CODEX_SID, cwd: "/Users/mac/workspace/we-orca" } }),
    JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
  ].join("\n") + "\n";
}

function emptyRound(): PullResult {
  return {
    files: [], codexFiles: [], chunks: new Map(), rebuilds: new Set(), codexIndex: null,
    truncated: false, done: true, lastPath: null, errors: [], missing: [],
  };
}

function round(content: string | Buffer, options: {
  path?: string; agent?: "claude" | "codex"; size?: number; mtime?: number; offset?: number; done?: boolean;
} = {}): PullResult {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const offset = options.offset ?? 0;
  const path = options.path ?? REMOTE_PATH;
  const stat = { path, size: options.size ?? offset + bytes.byteLength, mtime: options.mtime ?? 1 };
  return {
    ...emptyRound(),
    files: options.agent === "codex" ? [] : [stat],
    codexFiles: options.agent === "codex" ? [stat] : [],
    chunks: new Map([[path, { offset, bytes }]]),
    done: options.done ?? true,
  };
}

function createRemoteIndexer(
  db: OrcaDatabase,
  rounds: PullResult[],
  cursorLog: Array<Record<string, RemoteReadCursor>> = [],
  agents: PullAgentsRequest = BOTH_AGENTS,
) {
  const handle = createRemoteEnvironmentSources({
    env: "feibo2", db, agents,
    pull: (cursors) => {
      cursorLog.push(cursors);
      return Promise.resolve(rounds.shift() ?? emptyRound());
    },
  });
  const indexer = createIndexer({
    db, sources: handle.sources, foldProjects: false,
    resolveProject: (cwd) => createRemoteProjectResolver("feibo2")(cwd),
    resolveWorktree: () => null,
  });
  return {
    indexAll: async () => { await handle.runRound(); return indexer.indexAll(); },
  };
}

describe("remote environment sources through the indexer", () => {
  test("indexes a remote claude session under its environment with a namespaced project", async () => {
    const db = new OrcaDatabase(":memory:");
    const indexer = createRemoteIndexer(db, [round(prompt("远程第一问", "2026-08-30T01:00:00.000Z"), { mtime: 10 })]);
    const summary = await indexer.indexAll();
    expect(summary).toMatchObject({ files: 1, changed: 1 });
    const stored = db.getStoredSession("claude", SID, "feibo2");
    expect(stored).toMatchObject({
      env: "feibo2", lastPrompt: "远程第一问", projectKey: "feibo2:/Users/mac/workspace/we-orca",
      cwd: "/Users/mac/workspace/we-orca", worktreeRoot: null,
    });
    expect(db.getStoredSession("claude", SID)).toBeNull();
    const project = db.listProjectRecords().find((candidate) => candidate.key.startsWith("feibo2:"));
    expect(project).toMatchObject({ name: "we-orca @feibo2", root: "" });
    const rows = db.listSessions({ limit: 10 });
    expect(rows[0]).toMatchObject({ env: "feibo2", sid: SID });
  });

  test("indexes a remote codex rollout with filename identity and index titles", async () => {
    const db = new OrcaDatabase(":memory:");
    const first = codexLines("codex 远程一问", "2026-08-30T02:00:00.000Z");
    const withTitle: PullResult = {
      ...round(first, { agent: "codex", path: CODEX_PATH, mtime: 10 }),
      codexIndex: {
        data: Buffer.from(`${JSON.stringify({ id: CODEX_SID, thread_name: "远程 codex 标题" })}\n`, "utf8"),
        size: 64, mtime: 5,
      },
    };
    const indexer = createRemoteIndexer(db, [withTitle]);
    await indexer.indexAll();
    const stored = db.getStoredSession("codex", CODEX_SID, "feibo2");
    expect(stored).toMatchObject({
      env: "feibo2", title: "远程 codex 标题", lastPrompt: "codex 远程一问",
      cwd: "/Users/mac/workspace/we-orca", projectKey: "feibo2:/Users/mac/workspace/we-orca",
    });
  });

  test("sends the applied codex index stat back so an unchanged file is not re-shipped", async () => {
    const db = new OrcaDatabase(":memory:");
    const agentsLog: PullAgentsRequest[] = [];
    const handle = createRemoteEnvironmentSources({
      env: "feibo2", db, agents: BOTH_AGENTS,
      pull: (_cursors, agents) => {
        agentsLog.push(agents);
        const result = emptyRound();
        if (agentsLog.length === 1) result.codexIndex = { data: Buffer.from("", "utf8"), size: 9, mtime: 7 };
        return Promise.resolve(result);
      },
    });
    await handle.runRound();
    await handle.runRound();
    expect(agentsLog[0]!.codex).toEqual({ sinceDays: 90, index: null });
    expect(agentsLog[1]!.codex).toEqual({ sinceDays: 90, index: { size: 9, mtime: 7 } });
  });

  test("advances the cursor between rounds and requests exactly the parsed offset", async () => {
    const db = new OrcaDatabase(":memory:");
    const first = prompt("第一轮", "2026-08-30T01:00:00.000Z");
    const second = prompt("第二轮", "2026-08-30T02:00:00.000Z");
    const cursorLog: Array<Record<string, RemoteReadCursor>> = [];
    const firstSize = Buffer.byteLength(first);
    const indexer = createRemoteIndexer(db, [
      round(first, { mtime: 10 }),
      round(second, { offset: firstSize, mtime: 20 }),
    ], cursorLog);
    await indexer.indexAll();
    await indexer.indexAll();
    expect(cursorLog[0]).toEqual({});
    expect(cursorLog[1]).toEqual({ [REMOTE_PATH]: { offset: firstSize, size: firstSize, mtime: 10 } });
    const stored = db.getStoredSession("claude", SID, "feibo2")!;
    expect(stored.lastPrompt).toBe("第二轮");
    expect(stored.promptCount).toBe(2);
    expect(stored.parsedOffset).toBe(firstSize + Buffer.byteLength(second));
  });

  test("a budget-truncated transfer resumes from the consumed offset next round", async () => {
    const db = new OrcaDatabase(":memory:");
    const full = Buffer.from(
      prompt("完整一行", "2026-08-30T01:00:00.000Z") + prompt("被截断的一行", "2026-08-30T02:00:00.000Z"), "utf8",
    );
    const firstLineBytes = Buffer.byteLength(prompt("完整一行", "2026-08-30T01:00:00.000Z"));
    const cursorLog: Array<Record<string, RemoteReadCursor>> = [];
    const indexer = createRemoteIndexer(db, [
      round(full.subarray(0, firstLineBytes + 4), { size: full.byteLength, mtime: 10 }),
      round(full.subarray(firstLineBytes + 4), { offset: firstLineBytes + 4, size: full.byteLength, mtime: 10 }),
    ], cursorLog);
    await indexer.indexAll();
    let stored = db.getStoredSession("claude", SID, "feibo2")!;
    expect(stored.promptCount).toBe(1);
    expect(stored.parsedOffset).toBe(firstLineBytes);
    // The observed size is the whole remote file, not the slice that has arrived so far.
    expect(stored.fileSize).toBe(full.byteLength);
    await indexer.indexAll();
    // The next request resumes from the durably received bytes, not from the parse cursor.
    expect(cursorLog[1]).toEqual({
      [REMOTE_PATH]: { offset: firstLineBytes + 4, size: full.byteLength, mtime: 10 },
    });
    stored = db.getStoredSession("claude", SID, "feibo2")!;
    expect(stored.promptCount).toBe(2);
    expect(stored.lastPrompt).toBe("被截断的一行");
    expect(stored.parsedOffset).toBe(full.byteLength);
    expect(db.countSessionFts("claude", SID, "feibo2")).toBe(2);
  });

  test("a shrunken remote file rebuilds from zero without stale transcript rows", async () => {
    const db = new OrcaDatabase(":memory:");
    const original = prompt("旧内容旧内容", "2026-08-30T01:00:00.000Z");
    const rewritten = prompt("新内容", "2026-08-30T03:00:00.000Z");
    const indexer = createRemoteIndexer(db, [
      round(original, { mtime: 10 }),
      round(rewritten, { mtime: 20 }),
    ]);
    await indexer.indexAll();
    await indexer.indexAll();
    const stored = db.getStoredSession("claude", SID, "feibo2")!;
    expect(stored.lastPrompt).toBe("新内容");
    expect(stored.promptCount).toBe(1);
    expect(db.countSessionFts("claude", SID, "feibo2")).toBe(1);
  });

  test("a session whose bytes did not arrive this round keeps its cursor untouched", async () => {
    const db = new OrcaDatabase(":memory:");
    const content = prompt("第一轮", "2026-08-30T01:00:00.000Z");
    const listedOnly: PullResult = {
      ...round(content, { mtime: 30, size: Buffer.byteLength(content) + 50 }),
      chunks: new Map(),
    };
    const indexer = createRemoteIndexer(db, [round(content, { mtime: 10 }), listedOnly]);
    await indexer.indexAll();
    const before = db.getStoredSession("claude", SID, "feibo2")!;
    await indexer.indexAll();
    const after = db.getStoredSession("claude", SID, "feibo2")!;
    expect(after.parsedOffset).toBe(before.parsedOffset);
    expect(after.fileSize).toBe(before.fileSize);
  });

  test("an aborted round (no done marker) indexes nothing", async () => {
    const db = new OrcaDatabase(":memory:");
    const indexer = createRemoteIndexer(db, [
      { ...round(prompt("不完整轮", "2026-08-30T01:00:00.000Z")), done: false },
    ]);
    const summary = await indexer.indexAll();
    expect(summary.files).toBe(0);
    expect(db.countSessions()).toBe(0);
  });

  test("remote search hits attribute to the remote session identity", async () => {
    const db = new OrcaDatabase(":memory:");
    const indexer = createRemoteIndexer(db, [round(prompt("独特的远程搜索词", "2026-08-30T01:00:00.000Z"))]);
    await indexer.indexAll();
    const hits = db.search("独特的远程搜索词", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ env: "feibo2", sid: SID });
  });

  test("a disabled agent's payload and a duplicate loser never become durable buffers", async () => {
    const db = new OrcaDatabase(":memory:");
    const loserPath = `/Users/mac/.claude/projects/-A-older/${SID}.jsonl`;
    const winner = prompt("胜出文件", "2026-08-30T02:00:00.000Z");
    const loser = prompt("落选副本", "2026-08-30T01:00:00.000Z");
    const codexBytes = codexLines("未订阅的 codex", "2026-08-30T01:00:00.000Z");
    const cursorLog: Array<Record<string, RemoteReadCursor>> = [];
    const unsolicited: PullResult = {
      ...emptyRound(),
      files: [
        { path: loserPath, size: Buffer.byteLength(loser), mtime: 20 },
        { path: REMOTE_PATH, size: Buffer.byteLength(winner), mtime: 10 },
      ],
      codexFiles: [{ path: CODEX_PATH, size: Buffer.byteLength(codexBytes), mtime: 30 }],
      chunks: new Map([
        [loserPath, { offset: 0, bytes: Buffer.from(loser, "utf8") }],
        [REMOTE_PATH, { offset: 0, bytes: Buffer.from(winner, "utf8") }],
        [CODEX_PATH, { offset: 0, bytes: Buffer.from(codexBytes, "utf8") }],
      ]),
    };
    const indexer = createRemoteIndexer(db, [unsolicited, emptyRound()], cursorLog,
      { claude: true, codex: null });

    await indexer.indexAll();
    // Only the file the owner rule actually selected is stored; the loser and the payload for an
    // agent this environment never subscribed to are dropped instead of buffered forever.
    expect([...db.remoteReadStates("feibo2").keys()]).toEqual([REMOTE_PATH]);
    expect(db.getStoredSession("claude", SID, "feibo2")!.lastPrompt).toBe("胜出文件");
    expect(db.getStoredSession("codex", CODEX_SID, "feibo2")).toBeNull();
    expect(db.countSessionFts("claude", SID, "feibo2")).toBe(1);

    await indexer.indexAll();
    // The loser is named explicitly next round rather than hidden behind a forged offset.
    expect(cursorLog[1]![loserPath]).toEqual({ offset: 0, size: 0, mtime: 0, exclude: true });
    expect(cursorLog[1]![REMOTE_PATH]).toMatchObject({ offset: Buffer.byteLength(winner) });
    db.close();
  });

  test("only a completed inventory drops buffers, and it never drops indexed history", async () => {
    const db = new OrcaDatabase(":memory:");
    const gonePath = `/Users/mac/.claude/projects/-gone/${SID}.jsonl`;
    const keptSid = "cccccccc-3333-4444-5555-666666666666";
    const keptPath = `/Users/mac/.claude/projects/-kept/${keptSid}.jsonl`;
    const gone = prompt("即将消失", "2026-08-30T01:00:00.000Z");
    const kept = prompt("留下的会话", "2026-08-30T02:00:00.000Z");
    const partial = `${gone}{"type":"user"`;
    const listing = (paths: Array<[string, number]>): PullResult => ({
      ...emptyRound(), files: paths.map(([path, size]) => ({ path, size, mtime: 10 })),
    });
    const seed: PullResult = {
      ...listing([[gonePath, Buffer.byteLength(partial)], [keptPath, Buffer.byteLength(kept)]]),
      chunks: new Map([
        [gonePath, { offset: 0, bytes: Buffer.from(partial, "utf8") }],
        [keptPath, { offset: 0, bytes: Buffer.from(kept, "utf8") }],
      ]),
    };
    const failed: PullResult = {
      ...listing([[keptPath, Buffer.byteLength(kept)]]), errors: ["ssh timed out"],
    };
    const clean = listing([[keptPath, Buffer.byteLength(kept)]]);
    const indexer = createRemoteIndexer(db, [seed, failed, clean]);

    await indexer.indexAll();
    expect(db.remoteReadStates("feibo2").get(gonePath)!.receivedTo).toBe(Buffer.byteLength(partial));
    expect(db.getStoredSession("claude", SID, "feibo2")!.lastPrompt).toBe("即将消失");

    await indexer.indexAll();
    // A round that failed cannot prove the file is gone, so its buffered tail is untouched.
    expect(db.remoteReadStates("feibo2").get(gonePath)!.receivedTo).toBe(Buffer.byteLength(partial));

    await indexer.indexAll();
    // A clean inventory retires the transfer buffer but never the transcript it already produced.
    expect(db.remoteReadStates("feibo2").has(gonePath)).toBeFalse();
    expect(db.remoteReadStates("feibo2").has(keptPath)).toBeTrue();
    expect(db.getStoredSession("claude", SID, "feibo2")!.lastPrompt).toBe("即将消失");
    expect(db.countSessionFts("claude", SID, "feibo2")).toBe(1);
    expect(db.getStoredSession("claude", keptSid, "feibo2")!.lastPrompt).toBe("留下的会话");
    db.close();
  });

  test("agents gating drops the codex source entirely", () => {
    const db = new OrcaDatabase(":memory:");
    const handle = createRemoteEnvironmentSources({
      env: "feibo2", db, agents: { claude: true, codex: null },
      pull: () => Promise.resolve(emptyRound()),
    });
    expect(handle.sources.map((source) => source.agent)).toEqual(["claude"]);
  });
});
