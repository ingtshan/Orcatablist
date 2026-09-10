import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function sourceOf(name: string): string {
  const match = new RegExp(`      (?:async )?function ${name}\\(`).exec(html);
  if (!match) throw new Error(`Missing function: ${name}`);
  return html.slice(match.index, html.indexOf("\n      }", match.index) + 8);
}

function harness(hidden = false, missing = false) {
  const state = { view: "sessions", query: "旧搜索", requestId: 0,
    focusProjectFilters: new Set(["previous"]), focusWorktreeFilters: new Set(["old"]),
    focusExecutionFilters: { agent: new Set(["claude"]) } };
  const item = { id: "brief", session: { agent: "codex", sid: "same-sid", env: "remote", projectKey: "project" } };
  const calls: string[] = [];
  const card = { classList: { add: () => calls.push("highlight") }, tabIndex: 0,
    focus: () => calls.push("focus"), scrollIntoView: () => calls.push("scroll") };
  let loaded = false;
  const locate = new Function("state", "sessionKey", "briefDialog", "setView", "revealFocusSessionCard",
    "searchInput", "focusWorktreeFilterKey", "loadFocus", "requestAnimationFrame", "focusBoard", "acknowledgeFocusBrief", "showToast", `
    const FOCUS_EXECUTION_FIELDS = [{key:"agent"}, {key:"model"}, {key:"reasoningEffort"}];
    ${sourceOf("locateFocusBriefSession")}
    return locateFocusBriefSession;
  `)(state, (row: typeof item.session) => `${row.env}:${row.agent}/${row.sid}`,
  { close: () => calls.push("close") }, async (view: string) => { state.view = view; calls.push("view"); },
  (key: string) => { expect(key).toBe("remote:codex/same-sid"); return missing || (hidden && !loaded) ? null : card; },
  { value: "old" }, () => '["remote","project","/repo"]', async () => { loaded = true; calls.push("load"); },
  (callback: () => void) => callback(), { querySelectorAll: () => [] }, async () => calls.push("read"),
  (message: string) => calls.push(message));
  const button = { disabled: false };
  return { state, item, calls, button, locate };
}

describe("brief focus navigation", () => {
  test("closes the dialog, switches view, locates the exact remote card, then marks read", async () => {
    const app = harness(); await app.locate(app.item, app.button);
    expect(app.calls).toEqual(["close", "view", "highlight", "focus", "scroll", "read"]);
    expect(app.state.focusProjectFilters).toEqual(new Set(["previous"]));
    expect(app.button.disabled).toBeFalse();
  });

  test("hidden or historical targets switch scope and clear conflicting search/execution filters", async () => {
    const app = harness(true); await app.locate(app.item, app.button);
    expect(app.state.query).toBe("");
    expect(app.state.focusProjectFilters).toEqual(new Set(["project"]));
    expect(app.state.focusWorktreeFilters).toEqual(new Set(['["remote","project","/repo"]']));
    expect(app.state.focusExecutionFilters.agent.size).toBe(0);
    expect(app.calls).toEqual(["close", "view", "load", "highlight", "focus", "scroll", "read"]);
  });

  test("an unavailable session reports failure without marking read", async () => {
    const app = harness(true, true); await app.locate(app.item, app.button);
    expect(app.calls).not.toContain("read");
    expect(app.calls.at(-1)).toContain("定位失败");
    expect(app.button.disabled).toBeFalse();
  });

  test("expands only target ancestors and re-queries after each render", () => {
    const clicks: string[] = [];
    let queries = 0;
    const board = { querySelector: (selector: string) => {
      expect(selector).toContain('data-session-key="remote:codex/same-sid"'); queries += 1;
      return { closest: (ancestor: string) => ({ querySelector: (toggle: string) => {
        expect(toggle).toContain('[aria-expanded="false"]');
        return { click: () => clicks.push(ancestor) };
      } }) };
    } };
    const reveal = new Function("focusBoard", "CSS", `${sourceOf("revealFocusSessionCard")}\nreturn revealFocusSessionCard;`)(board, { escape: (key: string) => key });
    expect(reveal("remote:codex/same-sid")).toBeTruthy();
    expect(clicks).toEqual([".focus-project-group", ".focus-worktree-group", ".run-cluster"]);
    expect(queries).toBe(4);
  });
});
