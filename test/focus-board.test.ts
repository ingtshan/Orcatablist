import { describe, expect, test } from "bun:test";
import {
  assignFocusLanes, focusBoardRows, focusDayBoundaries, focusLaneFor, isVisibleOnBoard,
  worktreeRootFor, type FocusVisibility,
} from "../src/focus-board";
import type { LiveInfo, SessionRow } from "../src/types";

const NOON = new Date(2026, 7, 28, 12, 0, 0).getTime();
const boundaries = focusDayBoundaries(NOON);

function live(status: string, updatedAt: number | null = null): LiveInfo {
  return { pid: null, status, updatedAt, waitingFor: null, name: null };
}

function row(sid: string, options: Partial<SessionRow> = {}): SessionRow {
  return {
    agent: "claude", sid, projectKey: "proj", cwd: "/work/proj", worktreeRoot: null, branch: null,
    title: null, firstPrompt: null, lastPrompt: null, displayTitle: sid, lastInputAt: null,
    promptCount: 0, live: null, goals: [], indexed: true, ...options,
  } as SessionRow;
}

function visibility(overrides: Partial<FocusVisibility> = {}): FocusVisibility {
  return {
    archivedProjects: new Set(), archivedWorktrees: new Set(),
    projectRoots: new Map([["proj", "/work/proj"]]), ...overrides,
  };
}

describe("focus day boundaries", () => {
  test("brackets today by local midnight and reaches back three whole days", () => {
    expect(new Date(boundaries.today).getHours()).toBe(0);
    expect(boundaries.tomorrow - boundaries.today).toBe(24 * 60 * 60 * 1_000);
    expect(boundaries.today - boundaries.recent).toBe(3 * 24 * 60 * 60 * 1_000);
  });

  test("a timestamp at midnight belongs to the new day, not the old one", () => {
    expect(focusLaneFor(live("done", boundaries.today), boundaries)).toBe("non-working-today");
    expect(focusLaneFor(live("done", boundaries.today - 1), boundaries)).toBe("non-working-recent");
  });
});

describe("focus lane assignment", () => {
  test("anything running lands in working regardless of its clock", () => {
    expect(focusLaneFor(live("working"), boundaries)).toBe("working");
    expect(focusLaneFor(live("working", boundaries.recent - 999_999), boundaries)).toBe("working");
  });

  test("a non-working session without a usable timestamp is off the board", () => {
    expect(focusLaneFor(live("done"), boundaries)).toBeNull();
    expect(focusLaneFor(live("done", Number.NaN), boundaries)).toBeNull();
    expect(focusLaneFor(live("done", Number.POSITIVE_INFINITY), boundaries)).toBeNull();
  });

  test("a session with no liveness at all is off the board", () => {
    expect(focusLaneFor(null, boundaries)).toBeNull();
    expect(focusLaneFor(undefined, boundaries)).toBeNull();
  });

  test("older than the recent window drops off entirely", () => {
    expect(focusLaneFor(live("done", boundaries.recent - 1), boundaries)).toBeNull();
    expect(focusLaneFor(live("done", boundaries.recent), boundaries)).toBe("non-working-recent");
  });

  test("a future timestamp does not land in today", () => {
    expect(focusLaneFor(live("done", boundaries.tomorrow), boundaries)).toBeNull();
  });

  test("keeps every non-working status, not just done", () => {
    for (const status of ["done", "waiting", "idle", "unknown", "shell"]) {
      expect(focusLaneFor(live(status, NOON), boundaries)).toBe("non-working-today");
    }
  });
});

describe("board visibility", () => {
  test("an archived project hides its rows", () => {
    const archived = visibility({ archivedProjects: new Set(["proj"]) });
    expect(isVisibleOnBoard(row("a"), archived)).toBeFalse();
    expect(isVisibleOnBoard(row("a"), visibility())).toBeTrue();
  });

  test("an archived worktree hides the rows grouped under it", () => {
    const archived = visibility({ archivedWorktrees: new Set(["/work/proj/feature"]) });
    expect(isVisibleOnBoard(row("a", { worktreeRoot: "/work/proj/feature" }), archived)).toBeFalse();
    expect(isVisibleOnBoard(row("b", { worktreeRoot: "/work/proj/other" }), archived)).toBeTrue();
  });

  test("resolves a row's worktree the way the board groups it", () => {
    const roots = new Map([["proj", "/work/proj"]]);
    expect(worktreeRootFor(row("a", { worktreeRoot: "/wt" }), roots)).toBe("/wt");
    expect(worktreeRootFor(row("a", { worktreeRoot: null, cwd: "/cwd" }), roots)).toBe("/cwd");
    expect(worktreeRootFor(row("a", { worktreeRoot: null, cwd: null }), roots)).toBe("/work/proj");
    expect(worktreeRootFor(row("a", { worktreeRoot: null, cwd: null, projectKey: "gone" }), roots)).toBe("");
  });
});

describe("assembling the board", () => {
  test("sorts each lane by most recently updated", () => {
    const board = assignFocusLanes([
      row("old", { live: live("done", NOON - 3_000) }),
      row("new", { live: live("done", NOON - 1_000) }),
      row("mid", { live: live("done", NOON - 2_000) }),
    ], { now: NOON, visibility: visibility() });
    const today = board.lanes.find((lane) => lane.key === "non-working-today")!;
    expect(today.rows.map((entry) => entry.sid)).toEqual(["new", "mid", "old"]);
  });

  test("always returns all three lanes, empty ones included", () => {
    const board = assignFocusLanes([], { now: NOON });
    expect(board.lanes.map((lane) => lane.key))
      .toEqual(["working", "non-working-today", "non-working-recent"]);
    expect(focusBoardRows(board)).toEqual([]);
  });

  test("drops archived and out-of-window rows before lane assignment", () => {
    const board = assignFocusLanes([
      row("visible", { live: live("working") }),
      row("archived", { live: live("working"), projectKey: "old" }),
      row("ancient", { live: live("done", boundaries.recent - 1) }),
      row("offline"),
    ], {
      now: NOON,
      visibility: visibility({ archivedProjects: new Set(["old"]) }),
    });
    expect(focusBoardRows(board).map((entry) => entry.sid)).toEqual(["visible"]);
  });

  test("carries source health and the live read clock through to the board", () => {
    const sources = [{
      name: "orca-tab", ok: false, readAt: 500, stale: true, sessions: 2, error: "socket missing",
    }];
    const board = assignFocusLanes([], { now: NOON, sources, liveAt: 500 });
    expect(board.sources).toEqual(sources);
    expect(board.liveAt).toBe(500);
    expect(board.at).toBe(NOON);
  });
});
