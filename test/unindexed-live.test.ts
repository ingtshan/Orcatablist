import { describe, expect, test } from "bun:test";
import { appendUnindexedLiveSessions } from "../src/unindexed-live";
import type { LiveInfo, SessionRow } from "../src/types";

const indexed: SessionRow = {
  agent: "claude", sid: "indexed", projectKey: "/repo", cwd: "/repo", worktreeRoot: "/repo",
  branch: "main", title: null, firstPrompt: "indexed", lastPrompt: "indexed", displayTitle: "indexed",
  lastInputAt: 1, promptCount: 1, live: null, goals: [],
};

const info: LiveInfo = {
  pid: 123, status: "working", waitingFor: null, name: "live process",
};

describe("unindexed live sessions", () => {
  test("prepends valid live identities without transcripts and does not duplicate indexed sessions", () => {
    const rows = appendUnindexedLiveSessions([indexed], new Map([
      ["claude/indexed", info],
      ["claude/no-transcript", info],
      ["invalid/no-transcript", info],
      ["malformed", info],
    ]));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      agent: "claude", sid: "no-transcript", projectKey: "__unindexed_live__", cwd: null, worktreeRoot: null,
      branch: null, title: null, firstPrompt: null, lastPrompt: "live process",
      displayTitle: "未索引在线会话", lastInputAt: null, promptCount: 0,
      live: info, goals: [], indexed: false,
    });
    expect(rows[1]).toBe(indexed);
  });
});
