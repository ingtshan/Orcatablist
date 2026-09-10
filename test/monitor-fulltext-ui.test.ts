import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function sourceOf(name: string): string {
  const match = new RegExp(`      (?:async )?function ${name}\\(`).exec(html);
  if (!match) throw new Error(`missing page function ${name}`);
  return html.slice(match.index, html.indexOf("\n      }", match.index) + 8);
}

test("Monitor loads full text only when opened and preserves it across cache reuse and multi-page refresh", async () => {
  const row = { agent: "claude", sid: "same", env: "remote" };
  const key = "remote:claude/same";
  const text = "\n  <section>原文</section>\n\n" + "长消息".repeat(3_000) + "完整结尾";
  const values = Array.from({ length: 25 }, (_, index) => `${text} ${index}`);
  const requests: Array<{ sessions: unknown[]; fullText: boolean; limit: number; offset: number }> = [];
  const state = { recentInputsSupported: true, recentInputsBySession: {}, recentInputTimesBySession: {},
    recentInputsHasMoreBySession: {}, recentInputsLoadingBySession: {}, recentInputsVersion: 1,
    focusMonitorSessionKey: "" };
  const page = new Function("state", "row", "fetch", [
    'const LOCAL_ENVIRONMENT = "local", FOCUS_INPUT_PAGE_SIZE = 5, FOCUS_INPUT_MAX_PAGE_SIZE = 20;',
    'let focusMonitorInputRequestId = 0;',
    'const renderFocusMonitor = () => {}, showToast = (text) => { throw new Error(text); };',
    'const jsonRequest = (method, body) => ({ method, body: JSON.stringify(body) });',
    'const focusMonitorRow = () => state.focusMonitorSessionKey ? row : null;',
    ...["environmentOf", "sessionKey", "focusMonitorInputs", "resetRecentInputsForVersion", "loadFocusMonitorInputs", "loadFocusInputs"].map(sourceOf),
    'return { loadFocusInputs, loadFocusMonitorInputs, focusMonitorInputs };',
  ].join("\n"))(state, row, async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    requests.push(body);
    expect(body.fullText).toBe(true);
    expect(body.sessions).toEqual([row]);
    expect(body.limit).toBeLessThanOrEqual(20);
    const inputs = values.slice(body.offset, body.offset + body.limit);
    return new Response(JSON.stringify({ listVersion: 1, inputs: { [key]: inputs },
      inputTimes: { [key]: inputs.map((_: string, index: number) => 25 - body.offset - index) },
      hasMore: { [key]: body.offset + body.limit < values.length } }));
  });
  await page.loadFocusInputs(1);
  expect(requests).toHaveLength(0);
  state.focusMonitorSessionKey = key;
  await page.loadFocusInputs(1);
  expect(requests).toHaveLength(1);
  expect(page.focusMonitorInputs(row).map((item: { text: string }) => item.text)).toEqual(values.slice(0, 5).reverse());
  await page.loadFocusInputs(1);
  expect(requests).toHaveLength(1);
  state.recentInputsBySession = { [key]: values };
  await page.loadFocusMonitorInputs(row, true);
  expect(requests.slice(1).map(({ limit, offset }) => ({ limit, offset }))).toEqual([{ limit: 20, offset: 0 }, { limit: 5, offset: 20 }]);
  expect(page.focusMonitorInputs(row).map((item: { text: string }) => item.text)).toEqual([...values].reverse());
});
