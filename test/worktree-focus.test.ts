import { describe, expect, test } from "bun:test";
import { OrcaError, ValidationError, type OrcaJsonResult } from "../src/focus";
import { resolveWorktreeFocus, type WorktreeFocusDeps } from "../src/worktree-focus";

const CWD = "/repo/orcatab-worktree";

function deps(
  orcaJson: (args: string[]) => Promise<OrcaJsonResult>,
  opened: () => void = () => {},
): WorktreeFocusDeps {
  return { orcaJson, openOrca: async () => { opened(); } };
}

describe("resolveWorktreeFocus", () => {
  test("switches to the most recently active connected terminal", async () => {
    const calls: string[][] = [];
    let opens = 0;
    const result = await resolveWorktreeFocus(CWD, deps(async (args) => {
      calls.push(args);
      if (args[1] === "list") return { ok: true, result: { terminals: [
        null,
        { handle: "old", tabId: "tab-old", connected: true, orphaned: false, lastOutputAt: 10, worktreePath: CWD },
        { handle: "other", connected: true, orphaned: false, lastOutputAt: 99, worktreePath: "/repo/other" },
        { handle: "new", tabId: "tab-new", connected: true, orphaned: false, lastOutputAt: 20, worktreePath: CWD },
      ] } };
      return { ok: true, result: { focus: { tabId: "tab-returned" } } };
    }, () => { opens += 1; }));

    expect(result).toEqual({ action: "switched", handle: "new", tabId: "tab-returned", cwd: CWD });
    expect(opens).toBe(1);
    expect(calls).toEqual([
      ["terminal", "list", "--worktree", `path:${CWD}`, "--json"],
      ["terminal", "focus", "--terminal", "new", "--json"],
    ]);
  });

  test("falls back to the listed tab id", async () => {
    const result = await resolveWorktreeFocus(CWD, deps(async (args) => args[1] === "list"
      ? { ok: true, result: { terminals: [
        { handle: "term", tabId: "listed-tab", connected: true, orphaned: false, worktreePath: CWD },
      ] } }
      : { ok: true }));
    expect(result).toMatchObject({ action: "switched", handle: "term", tabId: "listed-tab" });
  });

  test("returns manual when no connected non-orphaned terminal exists", async () => {
    let opens = 0;
    const result = await resolveWorktreeFocus(CWD, deps(async () => ({ ok: true, result: { terminals: [
      { handle: "offline", connected: false, orphaned: false, worktreePath: CWD },
      { handle: "orphan", connected: true, orphaned: true, worktreePath: CWD },
    ] } }), () => { opens += 1; }));
    expect(result).toEqual({ action: "manual", reason: "no-active-terminal", cwd: CWD });
    expect(opens).toBe(0);
  });

  test("validates paths and reports list, shape, and focus failures", async () => {
    await expect(resolveWorktreeFocus("relative", deps(async () => ({ ok: true })))).rejects.toBeInstanceOf(ValidationError);
    await expect(resolveWorktreeFocus(CWD, deps(async () => ({ ok: false, error: { code: "missing" } }))))
      .rejects.toThrow("terminal list failed");
    await expect(resolveWorktreeFocus(CWD, deps(async () => ({ ok: true, result: {} }))))
      .rejects.toThrow("no terminals array");
    await expect(resolveWorktreeFocus(CWD, deps(async (args) => args[1] === "list"
      ? { ok: true, result: { terminals: [
        { handle: "term", connected: true, orphaned: false, worktreePath: CWD },
      ] } }
      : { ok: false, error: "stale" }))).rejects.toBeInstanceOf(OrcaError);
  });
});
