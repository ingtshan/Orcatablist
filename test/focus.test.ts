import { describe, expect, test } from "bun:test";
import {
  createFocusDeps, OrcaError, resolveFocus, shellQuote, ValidationError, type FocusDeps, type OrcaJsonResult,
} from "../src/focus";
import { OrcaDatabase } from "../src/db";
import type { LiveInfo } from "../src/types";

const SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";

function deps(options: {
  live?: LiveInfo | null;
  cwd?: string | null | undefined;
  environment?: string;
  orca?: (args: string[]) => Promise<OrcaJsonResult>;
  opened?: () => void;
} = {}): FocusDeps {
  return {
    findLive: () => options.live ?? null,
    getSessionCwd: () => options.cwd,
    psEnv: async () => options.environment ?? "",
    orcaJson: options.orca ?? (async () => ({ ok: false, error: "not found" })),
    openOrca: async () => { options.opened?.(); },
  };
}

describe("resolveFocus", () => {
  test("switches an online Orca terminal and uses returned focus tab id", async () => {
    let opens = 0;
    const calls: string[][] = [];
    const result = await resolveFocus(SID, deps({
      live: { pid: 42, status: "busy", waitingFor: null, name: "test" },
      environment: "claude --effort max TERM_PROGRAM=Orca ORCA_TERMINAL_HANDLE=term_live ORCA_TAB_ID=tab_env",
      opened: () => { opens += 1; },
      orca: async (args) => { calls.push(args); return { ok: true, result: { focus: { tabId: "tab_result" } } }; },
    }), { dryRun: false });
    expect(result).toEqual({ action: "switched", handle: "term_live", tabId: "tab_result" });
    expect(opens).toBe(1);
    expect(calls).toEqual([["terminal", "switch", "--terminal", "term_live", "--json"]]);
  });

  test("reports an online process without an Orca handle as manual", async () => {
    const result = await resolveFocus(SID, deps({
      live: { pid: 42, status: "idle", waitingFor: null, name: null },
      environment: "claude TERM_PROGRAM=Apple_Terminal",
    }), { dryRun: false });
    expect(result).toEqual({ action: "manual", reason: "running-outside-orca", command: null });
  });

  test("creates and switches a terminal for an offline Orca worktree", async () => {
    const calls: string[][] = [];
    const result = await resolveFocus(SID, deps({
      cwd: "/repo/worktree",
      orca: async (args) => {
        calls.push(args);
        if (args[0] === "worktree") return { ok: true, result: { worktree: { id: "repo::wt" } } };
        if (args[1] === "create") return { ok: true, result: { terminal: { handle: "term_new" } } };
        return { ok: true, result: { focus: { tabId: "tab_new" } } };
      },
    }), { dryRun: false });
    expect(result).toEqual({ action: "resumed", handle: "term_new" });
    expect(calls[1]).toContain("claude --resume " + SID);
    expect(calls[2]).toEqual(["terminal", "switch", "--terminal", "term_new", "--json"]);
  });

  test("returns a safely quoted manual command for a non-Orca worktree", async () => {
    const cwd = "/tmp/user's folder";
    const result = await resolveFocus(SID, deps({ cwd }), { dryRun: false });
    expect(result).toEqual({
      action: "manual", reason: "not-orca-worktree",
      command: `cd ${shellQuote(cwd)} && claude --resume ${SID}`,
    });
    if (result.action !== "manual") throw new Error("expected manual result");
    expect(result.command).toContain("'\"'\"'");
  });

  test("returns unknown-session when no indexed cwd exists", async () => {
    expect(await resolveFocus(SID, deps({ cwd: undefined }), { dryRun: false }))
      .toEqual({ action: "manual", reason: "unknown-session", command: null });
  });

  test("rejects invalid session ids", async () => {
    await expect(resolveFocus("bad", deps(), { dryRun: true })).rejects.toBeInstanceOf(ValidationError);
  });

  test("dry-run online does not open or call switch", async () => {
    let opens = 0;
    let calls = 0;
    const result = await resolveFocus(SID, deps({
      live: { pid: 42, status: "busy", waitingFor: null, name: null },
      environment: "claude ORCA_TERMINAL_HANDLE=term_dry ORCA_TAB_ID=tab_dry",
      opened: () => { opens += 1; }, orca: async () => { calls += 1; return { ok: true }; },
    }), { dryRun: true });
    expect(result).toEqual({ action: "switched", handle: "term_dry", tabId: "tab_dry" });
    expect(opens).toBe(0);
    expect(calls).toBe(0);
  });

  test("dry-run offline only performs read-only worktree show", async () => {
    const calls: string[][] = [];
    const result = await resolveFocus(SID, deps({
      cwd: "/repo/worktree", orca: async (args) => { calls.push(args); return { ok: true }; },
    }), { dryRun: true });
    expect(result).toEqual({ action: "resumed", handle: "(dry-run)" });
    expect(calls).toEqual([["worktree", "show", "--worktree", "path:/repo/worktree", "--json"]]);
  });

  test("turns Orca switch and missing-handle failures into OrcaError", async () => {
    await expect(resolveFocus(SID, deps({
      live: { pid: 42, status: "busy", waitingFor: null, name: null },
      environment: "ORCA_TERMINAL_HANDLE=term_bad", orca: async () => ({ ok: false, error: { code: "stale" } }),
    }), { dryRun: false })).rejects.toBeInstanceOf(OrcaError);
    await expect(resolveFocus(SID, deps({
      cwd: "/repo", orca: async (args) => args[0] === "worktree" ? { ok: true } : { ok: true, result: {} },
    }), { dryRun: false })).rejects.toThrow("returned no handle");
  });

  test("default ps dependency reads the current process environment without a shell", async () => {
    const db = new OrcaDatabase(":memory:");
    const actual = createFocusDeps(db);
    expect((await actual.psEnv(process.pid)).length).toBeGreaterThan(0);
    db.close();
  });
});
