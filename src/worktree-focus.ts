import { isAbsolute } from "node:path";
import { OrcaError, ValidationError, type OrcaJsonResult } from "./focus";
import type { WorktreeFocusResult } from "./types";

export interface WorktreeFocusDeps {
  orcaJson(args: string[]): Promise<OrcaJsonResult>;
  openOrca(): Promise<void>;
}

interface OrcaTerminal {
  handle?: unknown;
  tabId?: unknown;
  connected?: unknown;
  orphaned?: unknown;
  lastOutputAt?: unknown;
  worktreePath?: unknown;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  try { return JSON.stringify(error); }
  catch { return String(error); }
}

function activityTime(terminal: OrcaTerminal): number {
  return typeof terminal.lastOutputAt === "number" && Number.isFinite(terminal.lastOutputAt)
    ? terminal.lastOutputAt : -1;
}

function activeTerminals(value: unknown, cwd: string): OrcaTerminal[] {
  if (!Array.isArray(value)) throw new OrcaError("orca terminal list returned no terminals array");
  return value
    .filter((terminal): terminal is OrcaTerminal => terminal !== null && typeof terminal === "object")
    .filter((terminal) => typeof terminal.handle === "string" && terminal.handle.length > 0)
    .filter((terminal) => terminal.connected === true && terminal.orphaned !== true)
    .filter((terminal) => terminal.worktreePath === undefined || terminal.worktreePath === cwd)
    .sort((left, right) => activityTime(right) - activityTime(left));
}

export async function resolveWorktreeFocus(
  cwd: string,
  deps: WorktreeFocusDeps,
): Promise<WorktreeFocusResult> {
  if (!isAbsolute(cwd)) throw new ValidationError("invalid worktree path");
  const listed = await deps.orcaJson(["terminal", "list", "--worktree", `path:${cwd}`, "--json"]);
  if (!listed.ok) throw new OrcaError(`orca terminal list failed: ${errorText(listed.error)}`);
  const terminal = activeTerminals(listed.result?.terminals, cwd)[0];
  if (!terminal) return { action: "manual", reason: "no-active-terminal", cwd };

  const handle = terminal.handle as string;
  await deps.openOrca();
  const focused = await deps.orcaJson(["terminal", "focus", "--terminal", handle, "--json"]);
  if (!focused.ok) throw new OrcaError(`orca terminal focus failed: ${errorText(focused.error)}`);
  const returnedTabId = focused.result?.focus?.tabId;
  const tabId = typeof returnedTabId === "string" ? returnedTabId
    : typeof terminal.tabId === "string" ? terminal.tabId : null;
  return { action: "switched", handle, tabId, cwd };
}
