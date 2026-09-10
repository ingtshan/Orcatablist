import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function sourceOf(name: string): string {
  const match = new RegExp(`      (?:async )?function ${name}\\(`).exec(html);
  if (!match) throw new Error(`Missing function: ${name}`);
  return html.slice(match.index, html.indexOf("\n      }", match.index) + 8);
}

class Element {
  children: Element[] = [];
  value = "";
  textContent = "";
  disabled = false;
  placeholder = "";
  append(...children: Element[]) { this.children.push(...children); }
  setAttribute() {}
  querySelector() { return this.children[0]; }
  get childElementCount() { return this.children.length; }
}

function harness(status: string | null = "done", readAt: number | null = null) {
  const item = { id: "brief", readAt, session: { agent: "codex", sid: "sid", env: "remote",
    live: status === null ? null : { status, handle: "remote-terminal" } } };
  const state = { sendSupported: true, sendRecords: {} as Record<string, { state: string }>,
    focusBriefSending: new Set<string>(), focusBriefSendErrors: {} as Record<string, string>, focusBriefs: [item],
    focusBriefRequestId: 0, focusBriefError: "" };
  const forms: Array<{ row: typeof item.session; submit: Function }> = [];
  const calls: unknown[] = [];
  const receipts: Array<{ ids: string[]; read: boolean }> = [];
  let focusResult: { action: string } | undefined = { action: "switched" };
  let receiptFails = false;
  let result = { ok: true, error: "" };
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const runtime = new Function("state", "make", "sessionKey", "sessionSendForm", "submitSessionInput", "markFocusBriefs", "focusSession", `
    function renderFocusBriefs() {}
    function focusSessionSendInput() {}
    async function loadFocusBriefs() {}
    ${["rawLiveState", "canSendInput", "focusBriefComposer", "acknowledgeFocusBrief", "openFocusBriefSession", "submitFocusBriefInput"].map(sourceOf).join("\n")}
    return { focusBriefComposer, submitFocusBriefInput, openFocusBriefSession };
  `)(state, (_tag: string, _className: string, text = "") => {
    const element = new Element(); element.textContent = text; return element;
  }, (row: typeof item.session) => `${row.env}:${row.agent}/${row.sid}`,
  (row: typeof item.session, submit: Function) => {
    forms.push({ row, submit }); const form = new Element(); form.append(new Element()); return form;
  }, async (row: typeof item.session, input: Element) => {
    calls.push({ row, text: input.value }); await pending; return result;
  }, async (ids: string[], read: boolean) => {
    if (receiptFails) throw new Error("receipt unavailable");
    receipts.push({ ids, read }); item.readAt = 1;
  }, async () => focusResult);
  return { item, state, forms, calls, receipts, runtime,
    focusResult(action?: string) { focusResult = action ? { action } : undefined; },
    failReceipt() { receiptFails = true; },
    fail() { result = { ok: false, error: "会话正在运行" }; },
    hold() { pending = new Promise<void>((resolve) => { release = resolve; }); },
    release() { release?.(); },
  };
}

describe("brief reply UI", () => {
  test("only unread, done sessions with a terminal get the shared send form", () => {
    for (const status of ["working", "busy", "waiting", "idle", "unknown", null]) {
      const app = harness(status); app.runtime.focusBriefComposer(app.item); expect(app.forms).toHaveLength(0);
    }
    const read = harness("done", 1); read.runtime.focusBriefComposer(read.item); expect(read.forms).toHaveLength(0);
    const offline = harness(); offline.item.session.live!.handle = "";
    offline.runtime.focusBriefComposer(offline.item); expect(offline.forms).toHaveLength(0);
    const ready = harness(); ready.runtime.focusBriefComposer(ready.item);
    expect(ready.forms).toHaveLength(1); expect(ready.forms[0]!.row.env).toBe("remote");
  });

  test("the composer callback sends to the current exact identity and refuses duplicate submits", async () => {
    const app = harness(); app.hold(); app.runtime.focusBriefComposer(app.item);
    const input = new Element(); input.value = "继续实现";
    const submit = app.forms[0]!.submit;
    const first = submit(app.item.session, input, new Element());
    await submit(app.item.session, input, new Element());
    expect(app.calls).toHaveLength(1);
    expect(app.calls[0]).toEqual({ row: app.item.session, text: "继续实现" });
    expect(app.receipts).toHaveLength(0);
    app.release(); await first;
    expect(app.state.focusBriefSending.size).toBe(0);
    expect(app.receipts).toEqual([{ ids: ["brief"], read: true }]);
  });

  test("a changed live status or read receipt prevents sending from an old card", async () => {
    for (const read of [false, true]) {
      const app = harness(); app.runtime.focusBriefComposer(app.item);
      if (read) app.item.readAt = 1; else app.item.session.live!.status = "working";
      const input = new Element(); input.value = "继续";
      await app.forms[0]!.submit(app.item.session, input, new Element());
      expect(app.calls).toHaveLength(0);
      expect(Object.values(app.state.focusBriefSendErrors)[0]).toContain("状态已变化");
    }
  });

  test("send errors are shown in the dialog and preserve the input for retry", async () => {
    const app = harness(); app.fail(); const input = new Element(); input.value = "保留草稿";
    await app.runtime.submitFocusBriefInput(app.item, input, new Element());
    const composer = app.runtime.focusBriefComposer(app.item);
    expect(composer.children[0].textContent).toBe("发送失败：会话正在运行");
    expect(input.value).toBe("保留草稿"); expect(app.forms).toHaveLength(1);
    expect(app.receipts).toHaveLength(0);
  });

  test("opening or restoring a session marks read, but failure or manual instructions do not", async () => {
    for (const action of ["switched", "resumed", "manual", undefined]) {
      const app = harness(); app.focusResult(action);
      await app.runtime.openFocusBriefSession(app.item, new Element(), new Element());
      expect(app.receipts).toHaveLength(action === "switched" || action === "resumed" ? 1 : 0);
    }
  });

  test("a receipt failure does not turn a successful send into a retry", async () => {
    const app = harness(); app.failReceipt(); const input = new Element(); input.value = "继续";
    await app.runtime.submitFocusBriefInput(app.item, input, new Element());
    expect(app.calls).toHaveLength(1);
    expect(app.state.focusBriefError).toContain("操作已成功，但标记已读失败");
    expect(app.state.focusBriefSendErrors).toEqual({});
    expect(app.item.readAt).toBeNull();
  });

  test("pending or unconfirmed delivery cannot be sent again", async () => {
    for (const status of ["pending", "stalled"]) {
      const app = harness(); app.state.sendRecords["remote:codex/sid"] = { state: status };
      app.runtime.focusBriefComposer(app.item); expect(app.forms).toHaveLength(0);
      const input = new Element(); input.value = "继续";
      await app.runtime.submitFocusBriefInput(app.item, input, new Element());
      expect(app.calls).toHaveLength(0);
    }
  });
});
