import type { LiveSourceHealth } from "./live-source";
import type { LiveInfo, SessionRow } from "./types";

/**
 * The focus board answers one question: what is worth my attention right now, and what did I
 * finish recently. The rule lived in inline browser JS with no test, and every lane depended on
 * `live.updatedAt`, so a session vanished from "today" the moment its Orca tab closed.
 *
 * Lane membership is decided here so it can be tested through the same interface the board renders
 * from. Day boundaries are local-midnight; the server binds 127.0.0.1, so its clock and the
 * browser's are the same clock.
 */

export const FOCUS_RECENT_DAYS = 3;

export type FocusLaneKey = "working" | "non-working-today" | "non-working-recent";

export const FOCUS_LANE_KEYS: readonly FocusLaneKey[] = [
  "working", "non-working-today", "non-working-recent",
];

export interface FocusDayBoundaries { recent: number; today: number; tomorrow: number; }

export function focusDayBoundaries(now: number, recentDays: number = FOCUS_RECENT_DAYS): FocusDayBoundaries {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const recent = new Date(today);
  recent.setDate(recent.getDate() - recentDays);
  return { recent: recent.getTime(), today: today.getTime(), tomorrow: tomorrow.getTime() };
}

function liveStatus(live: LiveInfo | null | undefined): string {
  return typeof live?.status === "string" && live.status ? live.status : "unknown";
}

/**
 * Anything still running is worth attention regardless of when it last spoke. Everything else is
 * placed by when it last changed, and drops off the board beyond the recent window.
 */
export function focusLaneFor(
  live: LiveInfo | null | undefined,
  boundaries: FocusDayBoundaries,
): FocusLaneKey | null {
  if (live === null || live === undefined) return null;
  if (liveStatus(live) === "working") return "working";
  const updatedAt = live.updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  if (updatedAt >= boundaries.today && updatedAt < boundaries.tomorrow) return "non-working-today";
  if (updatedAt >= boundaries.recent && updatedAt < boundaries.today) return "non-working-recent";
  return null;
}

export interface FocusVisibility {
  archivedProjects: ReadonlySet<string>;
  archivedWorktrees: ReadonlySet<string>;
  projectRoots: ReadonlyMap<string, string>;
}

export const EMPTY_FOCUS_VISIBILITY: FocusVisibility = {
  archivedProjects: new Set(), archivedWorktrees: new Set(), projectRoots: new Map(),
};

/** Mirrors how the board groups a row, so archiving a worktree hides exactly what it groups. */
export function worktreeRootFor(row: SessionRow, projectRoots: ReadonlyMap<string, string>): string {
  return row.worktreeRoot || row.cwd || projectRoots.get(row.projectKey) || "";
}

export function isVisibleOnBoard(row: SessionRow, visibility: FocusVisibility): boolean {
  if (visibility.archivedProjects.has(row.projectKey)) return false;
  return !visibility.archivedWorktrees.has(worktreeRootFor(row, visibility.projectRoots));
}

export interface FocusLane { key: FocusLaneKey; rows: SessionRow[]; }

export interface FocusBoard {
  at: number;
  lanes: FocusLane[];
  sources: LiveSourceHealth[];
  /** When the liveness behind these lanes was read. Null before any source has succeeded. */
  liveAt: number | null;
}

export interface AssignFocusLanesOptions {
  now: number;
  visibility?: FocusVisibility;
  sources?: LiveSourceHealth[];
  liveAt?: number | null;
  recentDays?: number;
}

function updatedAt(row: SessionRow): number {
  const value = row.live?.updatedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function assignFocusLanes(rows: readonly SessionRow[], options: AssignFocusLanesOptions): FocusBoard {
  const visibility = options.visibility ?? EMPTY_FOCUS_VISIBILITY;
  const boundaries = focusDayBoundaries(options.now, options.recentDays);
  const byLane = new Map<FocusLaneKey, SessionRow[]>(FOCUS_LANE_KEYS.map((key) => [key, []]));
  for (const row of rows) {
    if (!isVisibleOnBoard(row, visibility)) continue;
    const lane = focusLaneFor(row.live, boundaries);
    if (lane !== null) byLane.get(lane)!.push(row);
  }
  return {
    at: options.now,
    lanes: FOCUS_LANE_KEYS.map((key) => ({
      key,
      rows: byLane.get(key)!.sort((left, right) => updatedAt(right) - updatedAt(left)),
    })),
    sources: options.sources ?? [],
    liveAt: options.liveAt ?? null,
  };
}

/** Every row the board will actually draw, in lane order. */
export function focusBoardRows(board: FocusBoard): SessionRow[] {
  return board.lanes.flatMap((lane) => lane.rows);
}
