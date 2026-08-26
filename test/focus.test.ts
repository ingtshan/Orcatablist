import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFocusDeps, findSessionCwdInClaudeDir, OrcaError, resolveFocus, shellQuote, ValidationError,
  type FocusDeps, type OrcaJsonResult,
} from "../src/focus";
import { OrcaDatabase } from "../src/db";
import type { LiveInfo } from "../src/types";

const SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";
const temporaryDirectories: string[] = [];

function deps(options: {
  live?: LiveInfo | null;
  cwd?: string | null | undefined;
  environment?: string;
  orca?: (args: string[]) => Promise<OrcaJsonResult>;
  opened?: () => void;
  plans?: string[][];
} = {}): FocusDeps {
  return {
    findLive: () => options.live ?? null,
    getSessionCwd: () => options.cwd,
    psEnv: async () => options.environment ?? "",
    orcaJson: options.orca ?? (async () => ({ ok: false, error: "not found" })),
    openOrca: async () => { options.opened?.(); },
    reportPlan: (plan) => options.plans?.push(plan),
  };
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("resolveFocus", () => {
  test("switches an online Orca terminal and uses returned focus tab id", async () => {
    let opens = 0;
    const calls: string[][] = [];
    const result = await resolveFocus("claude", SID, deps({
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
    const result = await resolveFocus("claude", SID, deps({
      live: { pid: 42, status: "idle", waitingFor: null, name: null },
      environment: "claude TERM_PROGRAM=Apple_Terminal",
    }), { dryRun: false });
    expect(result).toEqual({ action: "manual", reason: "running-outside-orca", command: null });
  });

  test("creates and switches a terminal for an offline Orca worktree", async () => {
    const calls: string[][] = [];
    const result = await resolveFocus("claude", SID, deps({
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
    const result = await resolveFocus("claude", SID, deps({ cwd }), { dryRun: false });
    expect(result).toEqual({
      action: "manual", reason: "not-orca-worktree",
      command: `cd ${shellQuote(cwd)} && claude --resume ${SID}`,
    });
    if (result.action !== "manual") throw new Error("expected manual result");
    expect(result.command).toContain("'\"'\"'");
  });

  test("returns unknown-session when no indexed cwd exists", async () => {
    expect(await resolveFocus("claude", SID, deps({ cwd: undefined }), { dryRun: false }))
      .toEqual({ action: "manual", reason: "unknown-session", command: null });
  });

  test("rejects invalid session ids", async () => {
    await expect(resolveFocus("claude", "bad", deps(), { dryRun: true })).rejects.toBeInstanceOf(ValidationError);
  });

  test("dry-run online does not open or call switch", async () => {
    let opens = 0;
    let calls = 0;
    const plans: string[][] = [];
    const result = await resolveFocus("claude", SID, deps({
      live: { pid: 42, status: "busy", waitingFor: null, name: null },
      environment: "claude ORCA_TERMINAL_HANDLE=term_dry ORCA_TAB_ID=tab_dry",
      opened: () => { opens += 1; }, orca: async () => { calls += 1; return { ok: true }; }, plans,
    }), { dryRun: true });
    expect(result).toEqual({ action: "switched", handle: "term_dry", tabId: "tab_dry" });
    expect(opens).toBe(0);
    expect(calls).toBe(0);
    expect(plans).toEqual([["orca", "terminal", "switch", "--terminal", "term_dry", "--json"]]);
  });

  test("dry-run offline only performs read-only worktree show", async () => {
    const calls: string[][] = [];
    const plans: string[][] = [];
    const result = await resolveFocus("claude", SID, deps({
      cwd: "/repo/worktree", orca: async (args) => { calls.push(args); return { ok: true }; }, plans,
    }), { dryRun: true });
    expect(result).toEqual({ action: "resumed", handle: "(dry-run)" });
    expect(calls).toEqual([["worktree", "show", "--worktree", "path:/repo/worktree", "--json"]]);
    expect(plans[0]).toContain("terminal");
  });

  test("turns Orca switch and missing-handle failures into OrcaError", async () => {
    await expect(resolveFocus("claude", SID, deps({
      live: { pid: 42, status: "busy", waitingFor: null, name: null },
      environment: "ORCA_TERMINAL_HANDLE=term_bad", orca: async () => ({ ok: false, error: { code: "stale" } }),
    }), { dryRun: false })).rejects.toBeInstanceOf(OrcaError);
    await expect(resolveFocus("claude", SID, deps({
      cwd: "/repo", orca: async (args) => args[0] === "worktree" ? { ok: true } : { ok: true, result: {} },
    }), { dryRun: false })).rejects.toThrow("returned no handle");
  });

  test("default ps dependency reads the current process environment without a shell", async () => {
    const db = new OrcaDatabase(":memory:");
    const actual = createFocusDeps(db);
    expect((await actual.psEnv(process.pid)).length).toBeGreaterThan(0);
    db.close();
  });

  test("finds cwd directly from a source JSONL when no cache exists", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-focus-source-"));
    temporaryDirectories.push(root);
    const directory = join(root, "projects", "fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${SID}.jsonl`), `not-json\n${JSON.stringify({ type: "user", cwd: "/fixture/workspace" })}\n`);
    expect(findSessionCwdInClaudeDir(SID, root)).toBe("/fixture/workspace");
    expect(createFocusDeps(null, { claudeDir: root }).getSessionCwd("claude", SID)).toBe("/fixture/workspace");
  });

  test("resumes Codex in an Orca worktree and switches the created terminal", async () => {
    const calls: string[][] = [];
    const result = await resolveFocus("codex", SID, deps({
      cwd: "/repo/codex-worktree",
      orca: async (args) => {
        calls.push(args);
        if (args[0] === "worktree") return { ok: true };
        if (args[1] === "create") return { ok: true, result: { terminal: { handle: "codex_term" } } };
        return { ok: true };
      },
    }), { dryRun: false });
    expect(result).toEqual({ action: "resumed", handle: "codex_term" });
    expect(calls[1]).toEqual([
      "terminal", "create", "--worktree", "path:/repo/codex-worktree", "--title", "codex resume",
      "--command", `codex resume ${SID}`, "--json",
    ]);
    expect(calls[2]).toEqual(["terminal", "switch", "--terminal", "codex_term", "--json"]);
  });

  test("Codex dry-run only checks the worktree and reports codex resume", async () => {
    const calls: string[][] = [];
    const plans: string[][] = [];
    const result = await resolveFocus("codex", SID, deps({
      cwd: "/repo/codex-worktree", plans,
      orca: async (args) => { calls.push(args); return { ok: true }; },
    }), { dryRun: true });
    expect(result).toEqual({ action: "resumed", handle: "(dry-run)" });
    expect(calls).toEqual([["worktree", "show", "--worktree", "path:/repo/codex-worktree", "--json"]]);
    expect(plans).toEqual([["codex", "resume", SID]]);
  });

  test("Codex returns manual outside Orca and unknown without cwd", async () => {
    const cwd = "/tmp/codex user's repo";
    expect(await resolveFocus("codex", SID, deps({ cwd }), { dryRun: false })).toEqual({
      action: "manual", reason: "not-orca-worktree", command: `cd ${shellQuote(cwd)} && codex resume ${SID}`,
    });
    expect(await resolveFocus("codex", SID, deps({ cwd: null }), { dryRun: false }))
      .toEqual({ action: "manual", reason: "unknown-session", command: null });
  });

  test("Codex cwd falls back to rollout session_meta", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-focus-codex-"));
    temporaryDirectories.push(root);
    const directory = join(root, "sessions", "2026", "08", "25");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `rollout-2026-08-25T00-00-00-${SID}.jsonl`), `${JSON.stringify({
      type: "session_meta", payload: { session_id: SID, cwd: "/fixture/codex-workspace" },
    })}\n`);
    expect(createFocusDeps(null, { codexDir: root }).getSessionCwd("codex", SID)).toBe("/fixture/codex-workspace");
  });

  test("CLI without a database falls back to JSONL and writes a dry-run plan to stderr", () => {
    const root = mkdtempSync(join(tmpdir(), "orcatab-focus-cli-"));
    temporaryDirectories.push(root);
    const claudeDir = join(root, "claude");
    const directory = join(claudeDir, "projects", "fixture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${SID}.jsonl`), `${JSON.stringify({ type: "user", cwd: "/fixture/orca/worktree" })}\n`);
    const fakeOrca = join(root, "fake-orca");
    writeFileSync(fakeOrca, "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true,\"result\":{\"worktree\":{}}}'\n");
    chmodSync(fakeOrca, 0o755);
    const result = Bun.spawnSync([
      "/opt/homebrew/bin/bun", "run", "src/focus.ts", "--dry-run", SID,
    ], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ORCATAB_CLAUDE_DIR: claudeDir, ORCATAB_DATA_DIR: join(root, "data"), ORCATAB_ORCA_BIN: fakeOrca },
    });
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const stderr = new TextDecoder().decode(result.stderr).trim();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ action: "resumed", handle: "(dry-run)" });
    expect(stderr).toContain('"plan"');
    expect(stderr).toContain('"terminal","create"');
  });
});
