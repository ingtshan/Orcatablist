import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo, SessionRow } from "../src/types";

/**
 * The page's coverage rules are the ones users actually see, so this runs them — the real function
 * bodies lifted out of `public/index.html` — rather than asserting that a string appears in the
 * file. Extraction is by name: renaming one of these functions is expected to update this test.
 */
const html = readFileSync(join(import.meta.dir, "..", "public", "index.html"), "utf8");

function sourceOf(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`public/index.html has no function ${name}`);
  const open = html.indexOf("{", html.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === "{") depth += 1;
    else if (html[index] === "}" && (depth -= 1) === 0) return html.slice(start, index + 1);
  }
  throw new Error(`function ${name} in public/index.html is unbalanced`);
}

function constantOf(name: string): string {
  const match = new RegExp(`^\\s*const ${name} = .*;$`, "m").exec(html);
  if (match === null) throw new Error(`public/index.html has no constant ${name}`);
  return match[0];
}

const FUNCTIONS = [
  "basename", "projectFor", "environmentOf", "liveWorktreePath", "liveWorktreeRootFor",
  "worktreeRootFor", "worktreePreferenceKey", "worktreePreferenceFor", "sessionKey",
  "liveSessionRowFor", "liveSessionRows", "unindexedLiveRows", "liveOnlyInjectedRows",
  "compareLastInput", "orderLiveSessionRows", "syncSessionLive",
] as const;

interface PageState {
  projects: Array<Record<string, unknown>>;
  sessions: SessionRow[];
  sourceSessions: SessionRow[];
  liveBySession: Record<string, unknown>;
  selectedProject: string;
  query: string;
  liveOnly: boolean;
  showArchived: boolean;
  worktreePreferences: Map<string, { archived?: boolean }>;
}

const page = new Function("state", [
  constantOf("UNINDEXED_LIVE_PROJECT_KEY"),
  constantOf("LOCAL_ENVIRONMENT"),
  constantOf("VISIBLE_SESSION_LIMIT"),
  ...FUNCTIONS.map(sourceOf),
  "return { syncSessionLive, unindexedLiveRows, liveSessionRows, sessionKey };",
].join("\n\n")) as (state: PageState) => {
  syncSessionLive(): void;
  unindexedLiveRows(loaded: Set<string>): SessionRow[];
  liveSessionRows(): SessionRow[];
  sessionKey(row: { agent: string; sid: string; env?: string }): string;
};

const PROJECT = { key: "/repo", name: "repo", root: "/repo", color: null, pinned: false, archived: false };
const OTHER_PROJECT = { key: "/other", name: "other", root: "/other", color: null, pinned: false, archived: false };

function info(name: string): LiveInfo {
  return { pid: 1, status: "working", waitingFor: null, name };
}

function indexedRow(sid: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    agent: "claude", sid, projectKey: PROJECT.key, cwd: "/repo", worktreeRoot: "/repo", branch: "main",
    title: null, firstPrompt: "hi", lastPrompt: "hi", displayTitle: sid, lastInputAt: 1,
    promptCount: 1, live: null, goals: [], ...overrides,
  };
}

/** One `/api/live` entry exactly as the server builds it. */
function liveEntry(session: SessionRow, indexed: boolean, live: LiveInfo) {
  return {
    ...live,
    projectKey: indexed ? session.projectKey : null,
    indexed,
    session: { ...session, live, indexed },
  };
}

function unknownRow(sid: string, live: LiveInfo, env?: string): SessionRow {
  return {
    agent: "claude", ...(env === undefined ? {} : { env }), sid, projectKey: "__unindexed_live__",
    cwd: null, worktreeRoot: null, branch: null, title: null, firstPrompt: null,
    lastPrompt: live.name, displayTitle: "未索引在线会话", lastInputAt: null, promptCount: 0,
    live, goals: [], indexed: false,
  };
}

function pageState(overrides: Partial<PageState> = {}): PageState {
  return {
    projects: [PROJECT, OTHER_PROJECT], sessions: [], sourceSessions: [], liveBySession: {},
    selectedProject: "", query: "", liveOnly: false, showArchived: false,
    worktreePreferences: new Map(), ...overrides,
  };
}

/** The two indexed live sessions every ordering case below is built from. */
const NEWER = indexedRow("newer", { lastInputAt: 2 });
const OLD = indexedRow("old", { lastInputAt: 1 });
const ORDERED_LIVE = {
  "claude/newer": liveEntry(NEWER, true, info("newer live")),
  "claude/old": liveEntry(OLD, true, info("old live")),
};

describe("the page's default session list", () => {
  test("an indexed live session missing from the loaded page is never shown as unindexed", () => {
    const state = pageState({
      sourceSessions: [NEWER],
      liveBySession: { "claude/old": liveEntry(OLD, true, info("old live")) },
    });
    const api = page(state);
    api.syncSessionLive();
    // The default list is paginated: an indexed row off the end of the page stays off it, and is
    // never turned into a placeholder because the page did not happen to contain it.
    expect(state.sessions.map((row) => row.sid)).toEqual(["newer"]);
    expect(api.unindexedLiveRows(new Set(["claude/newer"]))).toEqual([]);
  });

  test("only the server's indexed flag produces a placeholder row", () => {
    const unknown = info("unknown live");
    const state = pageState({
      sourceSessions: [NEWER],
      liveBySession: {
        "claude/unknown": liveEntry(unknownRow("unknown", unknown), false, unknown),
        "claude/old": liveEntry(OLD, true, info("old live")),
      },
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => [row.sid, row.indexed ?? null]))
      .toEqual([["unknown", false], ["newer", null]]);
  });

  test("a row already on the page is never duplicated", () => {
    const unknown = info("unknown live");
    const placeholder = unknownRow("unknown", unknown);
    const state = pageState({
      sourceSessions: [placeholder],
      liveBySession: { "claude/unknown": liveEntry(placeholder, false, unknown) },
    });
    page(state).syncSessionLive();
    expect(state.sessions).toHaveLength(1);
  });
});

describe("the page's online-only session list", () => {
  test("keeps indexed recency order when the older live session is not on the loaded page", () => {
    const state = pageState({ liveOnly: true, sourceSessions: [NEWER], liveBySession: ORDERED_LIVE });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["newer", "old"]);
  });

  test("keeps that order when both live sessions are already on the loaded page", () => {
    const state = pageState({
      liveOnly: true, sourceSessions: [NEWER, OLD], liveBySession: ORDERED_LIVE,
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["newer", "old"]);
  });

  test("genuine unknowns keep the prefix ahead of indexed rows in recency order", () => {
    const unknown = info("unknown live");
    const state = pageState({
      liveOnly: true,
      sourceSessions: [OLD],
      liveBySession: {
        ...ORDERED_LIVE,
        "claude/unknown": liveEntry(unknownRow("unknown", unknown), false, unknown),
      },
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["unknown", "newer", "old"]);
  });

  test("an indexed live session that never took input sorts last, not first", () => {
    const quiet = indexedRow("quiet", { lastInputAt: null });
    const state = pageState({
      liveOnly: true, sourceSessions: [],
      liveBySession: { "claude/quiet": liveEntry(quiet, true, info("quiet live")), ...ORDERED_LIVE },
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["newer", "old", "quiet"]);
  });

  test("a selected project includes every matching live session, loaded or not", () => {
    const state = pageState({
      liveOnly: true, selectedProject: PROJECT.key, sourceSessions: [],
      liveBySession: ORDERED_LIVE,
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["newer", "old"]);
  });

  test("a selected project excludes live sessions belonging to a different project", () => {
    const elsewhere = indexedRow("elsewhere", { projectKey: OTHER_PROJECT.key, lastInputAt: 9 });
    const unknown = info("unknown live");
    const state = pageState({
      liveOnly: true, selectedProject: PROJECT.key, sourceSessions: [],
      liveBySession: {
        ...ORDERED_LIVE,
        "claude/elsewhere": liveEntry(elsewhere, true, info("elsewhere live")),
        // A genuine unknown has no indexed project, so a project-scoped view cannot claim it.
        "claude/unknown": liveEntry(unknownRow("unknown", unknown), false, unknown),
      },
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["newer", "old"]);
  });

  test("drops a loaded row that is not live", () => {
    const offline = indexedRow("offline", { lastInputAt: 9 });
    const state = pageState({
      liveOnly: true, sourceSessions: [offline, NEWER], liveBySession: ORDERED_LIVE,
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["newer", "old"]);
  });
});

describe("the page's identity and search handling", () => {
  test("a remote placeholder keeps the environment that distinguishes it from the local session", () => {
    const remote = info("remote live");
    const state = pageState({
      sourceSessions: [indexedRow("shared")],
      liveBySession: {
        "claude/shared": liveEntry(indexedRow("shared"), true, info("local live")),
        "feibo-n2:claude/shared": liveEntry(unknownRow("shared", remote, "feibo-n2"), false, remote),
      },
    });
    const api = page(state);
    api.syncSessionLive();
    expect(state.sessions.map((row) => api.sessionKey(row)))
      .toEqual(["feibo-n2:claude/shared", "claude/shared"]);
    expect(state.sessions[0]!.env).toBe("feibo-n2");
  });

  test("a live entry carrying no resolved row is ignored rather than guessed at", () => {
    // The server drops identities it cannot resolve; the page stays defensive about older payloads.
    const state = pageState({
      liveBySession: { malformed: { ...info("not an identity"), projectKey: null } },
    });
    const api = page(state);
    api.syncSessionLive();
    expect(api.liveSessionRows()).toEqual([]);
    expect(state.sessions).toEqual([]);
  });

  test("an active search constrains the list and never injects unrelated live rows", () => {
    const hit = indexedRow("hit", { lastInputAt: 5 });
    const elsewhere = indexedRow("elsewhere", { projectKey: OTHER_PROJECT.key, lastInputAt: 9 });
    const liveBySession = {
      ...ORDERED_LIVE,
      "claude/elsewhere": liveEntry(elsewhere, true, info("elsewhere live")),
    };
    for (const liveOnly of [false, true]) {
      const state = pageState({ query: "课堂树", liveOnly, liveBySession, sourceSessions: [hit] });
      page(state).syncSessionLive();
      // "hit" has no live entry, so online mode drops it; either way nothing else is pulled in.
      expect(state.sessions.map((row) => row.sid)).toEqual(liveOnly ? [] : ["hit"]);
    }
  });
});

/**
 * A search already carries its own ranking, and its rows carry the hits and score that ranking was
 * computed from. Online mode narrows that list to what is live; it must not reorder it, because
 * recency is a different question from relevance.
 */
describe("the page's online-only list during an active search", () => {
  const BEST = { ...indexedRow("best-search-hit", { lastInputAt: 1 }), score: 9, hits: [{ role: "user", ts: 1, snippet: "‹needle›" }] };
  const SECOND = { ...indexedRow("second-search-hit", { lastInputAt: 2 }), score: 4, hits: [{ role: "user", ts: 2, snippet: "a ‹needle›" }] };
  const OFFLINE = indexedRow("offline-search-hit", { lastInputAt: 3 });
  const SEARCH_LIVE = {
    "claude/best-search-hit": liveEntry(BEST, true, info("best live")),
    "claude/second-search-hit": liveEntry(SECOND, true, info("second live")),
  };

  test("keeps search rank when recency would reverse it, and drops the offline result", () => {
    const state = pageState({
      query: "needle", liveOnly: true, liveBySession: SEARCH_LIVE,
      // Incoming order is relevance: the best hit is the oldest session.
      sourceSessions: [{ ...BEST }, { ...SECOND }, { ...OFFLINE }],
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["best-search-hit", "second-search-hit"]);
  });

  test("leaves each search row's own result metadata intact", () => {
    const state = pageState({
      query: "needle", liveOnly: true, liveBySession: SEARCH_LIVE,
      sourceSessions: [{ ...BEST }, { ...SECOND }],
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => (row as { score?: number }).score)).toEqual([9, 4]);
    expect(state.sessions[0]!).toMatchObject({ hits: BEST.hits, live: { name: "best live" } });
  });

  test("keeps that rank with a project selected, and pulls in nothing from elsewhere", () => {
    const elsewhere = indexedRow("elsewhere", { projectKey: OTHER_PROJECT.key, lastInputAt: 9 });
    const state = pageState({
      query: "needle", liveOnly: true, selectedProject: PROJECT.key,
      liveBySession: { ...SEARCH_LIVE, "claude/elsewhere": liveEntry(elsewhere, true, info("elsewhere live")) },
      // `runSearch` already scoped the results to the selected project before this point.
      sourceSessions: [{ ...BEST }, { ...SECOND }],
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["best-search-hit", "second-search-hit"]);
  });

  test("still applies recency ordering once the search is cleared", () => {
    const state = pageState({
      query: "", liveOnly: true, liveBySession: SEARCH_LIVE,
      sourceSessions: [{ ...BEST }, { ...SECOND }],
    });
    page(state).syncSessionLive();
    expect(state.sessions.map((row) => row.sid)).toEqual(["second-search-hit", "best-search-hit"]);
  });
});
