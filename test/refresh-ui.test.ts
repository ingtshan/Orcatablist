import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function source(name: string): string {
  for (const prefix of [`      function ${name}(`, `      async function ${name}(`]) {
    const start = html.indexOf(prefix);
    if (start >= 0) return html.slice(start, html.indexOf("\n      }", start) + 8);
  }
  throw new Error(`Missing ${name}`);
}

interface FakeButton { disabled: boolean; textContent: string; busy: string | null }

function harness(respond: (path: string, options: unknown) => Promise<unknown>) {
  const state: Record<string, unknown> = {
    liveEtag: "W/live-1", sessionEtag: "W/sessions-1", focusBoardEtag: "W/focus-1",
    view: "sessions", query: "", sourceSessions: [],
  };
  const button: FakeButton = { disabled: false, textContent: "刷新", busy: null };
  const calls: Array<{ path: string; options: unknown }> = [];
  const toasts: string[] = [];
  const indexStatus = { textContent: "索引更新时间未知" };
  let reloads = 0;
  const runtime = new Function("state", "refreshNow", "indexStatus", "api", "showToast", "reloadCurrentView", `
    const LIVE_SOURCE_LABELS = { "orca-tab": "Orca 标签页", "claude-pid": "Claude 进程" };
    const relativeTime = (value) => value === null ? "无时间" : "刚刚";
    ${[source("refreshSummary"), source("runManualRefresh")].join("\n")}
    return { refreshSummary, runManualRefresh };
  `)(
    state,
    {
      get disabled() { return button.disabled; },
      set disabled(value: boolean) { button.disabled = value; },
      get textContent() { return button.textContent; },
      set textContent(value: string) { button.textContent = value; },
      setAttribute: (_name: string, value: string) => { button.busy = value; },
      removeAttribute: () => { button.busy = null; },
    },
    indexStatus,
    (path: string, options: unknown) => { calls.push({ path, options }); return respond(path, options); },
    (message: string) => { toasts.push(message); },
    () => { reloads += 1; return Promise.resolve(); },
  );
  return { state, button, calls, toasts, indexStatus, reloads: () => reloads, ...runtime };
}

const CLEAN = {
  indexed: { files: 12, changed: 1, ms: 40, errors: [] },
  sources: [{ name: "orca-tab", ok: true, readAt: 7, stale: false, sessions: 1, error: null }],
  environments: ["feibo1", "feibo2"],
  indexedAt: 1_700,
};

describe("manual refresh button", () => {
  test("summarises what the pass actually did", () => {
    const app = harness(async () => CLEAN);
    expect(app.refreshSummary(CLEAN)).toBe("已刷新：索引 12 个会话，1 个更新，已拉取 2 个远程环境");
  });

  test("names a live source that is still down instead of reporting success", () => {
    const app = harness(async () => CLEAN);
    expect(app.refreshSummary({
      ...CLEAN,
      indexed: { files: 12, changed: 0, ms: 40, errors: [{ message: "读取失败" }] },
      sources: [{ name: "orca-tab", ok: false, readAt: 3, stale: true, sessions: 1, error: "runtime down" }],
    })).toBe("已刷新：索引 12 个会话，已拉取 2 个远程环境，1 个来源报错；⚠ Orca 标签页仍不可用");
  });

  test("drops every cached ETag so the reload cannot be answered 304", async () => {
    const app = harness(async () => CLEAN);

    await app.runManualRefresh();

    expect(app.calls).toEqual([{ path: "/api/refresh", options: { method: "POST" } }]);
    expect(app.state.liveEtag).toBe("");
    expect(app.state.sessionEtag).toBe("");
    expect(app.state.focusBoardEtag).toBe("");
    // Keys that are not ETags keep their value.
    expect(app.state.view).toBe("sessions");
    expect(app.reloads()).toBe(1);
    expect(app.indexStatus.textContent).toBe("索引更新于 刚刚");
    expect(app.toasts).toEqual(["已刷新：索引 12 个会话，1 个更新，已拉取 2 个远程环境"]);
  });

  test("restores the button after a failure and says why", async () => {
    const app = harness(async () => { throw new Error("HTTP 500"); });

    await app.runManualRefresh();

    expect(app.toasts).toEqual(["刷新失败：HTTP 500"]);
    expect(app.button.disabled).toBeFalse();
    expect(app.button.textContent).toBe("刷新");
    expect(app.button.busy).toBeNull();
    expect(app.reloads()).toBe(0);
  });

  test("ignores a second press while a pass is still running", async () => {
    let release = (_value: unknown) => {};
    const app = harness(() => new Promise((resolve) => { release = resolve; }));

    const first = app.runManualRefresh();
    expect(app.button.disabled).toBeTrue();
    expect(app.button.textContent).toBe("刷新中…");
    await app.runManualRefresh();
    expect(app.calls).toHaveLength(1);

    release(CLEAN);
    await first;
    expect(app.button.disabled).toBeFalse();
    expect(app.calls).toHaveLength(1);
  });
});
