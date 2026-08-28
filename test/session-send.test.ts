import { describe, expect, test } from "bun:test";
import { handleSessionSendRequest, type SessionSendRouteDeps } from "../src/session-send-routes";
import {
  CONFIRMATION_INPUT_TOLERANCE_MS, CONFIRMATION_TIMEOUT_MS, confirmationState,
  createSentInputConfirmationQueue, createSentInputStore, normalizeInputText, SendConflictError,
  sendSessionInput, sentInputRecords, type SentInput,
} from "../src/session-send";
import type { LiveInfo } from "../src/types";

const SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";
const SENT_AT = 1_000_000;

function live(overrides: Partial<LiveInfo> = {}): LiveInfo {
  return {
    pid: null, status: "done", updatedAt: SENT_AT - 5_000, waitingFor: null,
    name: "Claude tab", handle: "term_claude", tabId: "tab_claude", leafId: "leaf_claude", ...overrides,
  };
}

function sentInput(overrides: Partial<SentInput> = {}): SentInput {
  return {
    agent: "claude", sid: SID, text: "继续", handle: "term_claude", sentAt: SENT_AT,
    workingObservedAt: null, confirmedAt: null, confirmedInputAt: null, ...overrides,
  };
}

interface Recorder { calls: string[][]; }

function sendDeps(overrides: Partial<SessionSendRouteDeps> = {}, recorder: Recorder = { calls: [] }) {
  const store = overrides.store ?? createSentInputStore();
  const confirmationQueue = overrides.confirmationQueue ?? createSentInputConfirmationQueue({
    store, refreshLive: async () => new Map(), getUserInputs: () => new Map(), now: () => SENT_AT,
  });
  const deps: SessionSendRouteDeps = {
    findLive: () => live(),
    psEnv: async () => "",
    orcaJson: async (args) => { recorder.calls.push(args); return { ok: true, result: {} }; },
    store,
    confirmationQueue,
    now: () => SENT_AT,
    onSent: () => {},
    ...overrides,
  };
  return { deps, recorder };
}

function sendRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:47831/api/session-send/claude/${SID}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

async function post(body: unknown, deps: SessionSendRouteDeps, headers?: Record<string, string>) {
  const request = sendRequest(body, headers);
  const response = await handleSessionSendRequest(request, new URL(request.url), deps);
  expect(response).not.toBeNull();
  return { response: response!, body: await response!.json() as Record<string, any> };
}

describe("normalizeInputText", () => {
  test("trims and keeps a single line", () => {
    expect(normalizeInputText("  继续实现 P8  ")).toBe("继续实现 P8");
  });

  test("rejects empty, multi-line, and control-character payloads", () => {
    expect(() => normalizeInputText("   ")).toThrow("text is required");
    expect(() => normalizeInputText(42)).toThrow("text is required");
    expect(() => normalizeInputText("第一行\n第二行")).toThrow("single line");
    expect(() => normalizeInputText("清屏\u001B[2J")).toThrow("control characters");
    expect(() => normalizeInputText("x".repeat(4_001))).toThrow("at most 4000 characters");
  });
});

describe("confirmationState", () => {
  test("reflects the queue phases without treating live status alone as confirmation", () => {
    expect(confirmationState(sentInput(), SENT_AT)).toBe("pending");
    expect(confirmationState(sentInput({ workingObservedAt: SENT_AT + 1 }), SENT_AT + 2)).toBe("verifying");
    expect(confirmationState(sentInput({ confirmedAt: SENT_AT + 2 }), SENT_AT + 3)).toBe("confirmed");
  });

  test("stays pending until the timeout, then reports stalled", () => {
    expect(confirmationState(sentInput(), SENT_AT + CONFIRMATION_TIMEOUT_MS - 1)).toBe("pending");
    expect(confirmationState(sentInput(), SENT_AT + CONFIRMATION_TIMEOUT_MS)).toBe("stalled");
  });
});

describe("sent input confirmation queue", () => {
  test("remembers a working event and confirms only an exact near-time user input", async () => {
    const store = createSentInputStore();
    store.record(sentInput());
    let currentLive = live();
    let inputs = new Map<string, Array<{ text: string; ts: number | null }>>();
    const queue = createSentInputConfirmationQueue({
      store,
      refreshLive: async () => new Map([[`claude/${SID}`, currentLive]]),
      getUserInputs: () => inputs,
      now: () => SENT_AT + 2_000,
    });

    expect((await queue.reconcile())[`claude/${SID}`]?.state).toBe("pending");
    currentLive = live({ status: "working", updatedAt: SENT_AT + 1_000 });
    inputs = new Map([[`claude/${SID}`, [{ text: "不匹配", ts: SENT_AT + 1_000 }]]]);
    expect((await queue.reconcile())[`claude/${SID}`]).toMatchObject({
      state: "verifying", workingObservedAt: SENT_AT + 1_000, confirmedAt: null,
    });

    currentLive = live({ status: "done", updatedAt: SENT_AT + 3_000 });
    inputs = new Map([[`claude/${SID}`, [{
      text: "继续", ts: SENT_AT + CONFIRMATION_INPUT_TOLERANCE_MS,
    }]]]);
    expect((await queue.reconcile())[`claude/${SID}`]).toMatchObject({
      state: "confirmed", confirmedAt: SENT_AT + 2_000,
      confirmedInputAt: SENT_AT + CONFIRMATION_INPUT_TOLERANCE_MS,
    });
  });

  test("does not treat busy, mismatched text, or an out-of-window input as confirmation", async () => {
    const store = createSentInputStore();
    store.record(sentInput());
    let currentLive = live({ status: "busy", updatedAt: SENT_AT + 1 });
    const inputs = new Map([[`claude/${SID}`, [
      { text: "继续", ts: SENT_AT + CONFIRMATION_INPUT_TOLERANCE_MS + 1 },
      { text: "别的输入", ts: SENT_AT + 1 },
    ]]]);
    const queue = createSentInputConfirmationQueue({
      store,
      refreshLive: async () => new Map([[`claude/${SID}`, currentLive]]),
      getUserInputs: () => inputs,
      now: () => SENT_AT + 2_000,
    });
    expect((await queue.reconcile())[`claude/${SID}`]?.state).toBe("pending");
    currentLive = live({ status: "working", updatedAt: SENT_AT + 1 });
    expect((await queue.reconcile())[`claude/${SID}`]?.state).toBe("verifying");
  });

  test("refreshes live once and loads evidence once for the whole queue", async () => {
    const otherSid = "other-session";
    const store = createSentInputStore();
    store.record(sentInput());
    store.record(sentInput({ agent: "codex", sid: otherSid, text: "safe commit" }));
    const forces: boolean[] = [];
    const batches: string[][] = [];
    const queue = createSentInputConfirmationQueue({
      store,
      refreshLive: async (force) => {
        forces.push(force);
        return new Map([
          [`claude/${SID}`, live({ status: "working" })],
          [`codex/${otherSid}`, live({ status: "working" })],
        ]);
      },
      getUserInputs: (entries) => {
        batches.push(entries.map((entry) => `${entry.agent}/${entry.sid}`));
        return new Map(entries.map((entry) => [
          `${entry.agent}/${entry.sid}`, [{ text: entry.text, ts: entry.sentAt + 1 }],
        ]));
      },
      now: () => SENT_AT + 2_000,
    });
    const records = await queue.reconcile({ forceLive: true });
    expect(forces).toEqual([true]);
    expect(batches).toEqual([[`claude/${SID}`, `codex/${otherSid}`]]);
    expect(Object.values(records).map((record) => record.state)).toEqual(["confirmed", "confirmed"]);
    expect(queue.hasPending()).toBeFalse();
  });
});

describe("sendSessionInput", () => {
  test("sends through the Orca terminal and records the input", async () => {
    const { deps, recorder } = sendDeps();
    const record = await sendSessionInput("claude", SID, "  继续  ", deps);
    expect(recorder.calls).toEqual([[
      "terminal", "send", "--terminal", "term_claude", "--text", "继续", "--enter", "--json",
    ]]);
    expect(record).toMatchObject({ agent: "claude", sid: SID, text: "继续", handle: "term_claude", state: "pending" });
    expect(deps.store.get("claude", SID)).toMatchObject({ text: "继续", sentAt: SENT_AT });
  });

  test("resolves the handle from the process environment when Orca reports none", async () => {
    const { deps, recorder } = sendDeps({
      findLive: () => live({ handle: undefined, pid: 4_242 }),
      psEnv: async () => "claude ORCA_TERMINAL_HANDLE=term_env ORCA_TAB_ID=tab_env",
    });
    await sendSessionInput("claude", SID, "继续", deps);
    expect(recorder.calls[0]).toContain("term_env");
  });

  test("refuses any status other than done", async () => {
    for (const status of ["working", "waiting", "idle", "shell", "error"]) {
      const { deps, recorder } = sendDeps({ findLive: () => live({ status }) });
      await expect(sendSessionInput("claude", SID, "继续", deps)).rejects.toThrow(`session is ${status}`);
      expect(recorder.calls).toEqual([]);
    }
  });

  test("refuses an offline session and one running outside Orca", async () => {
    const offline = sendDeps({ findLive: () => null });
    await expect(sendSessionInput("claude", SID, "继续", offline.deps)).rejects.toMatchObject({ code: "offline" });
    const outside = sendDeps({ findLive: () => live({ handle: undefined, pid: null }) });
    await expect(sendSessionInput("claude", SID, "继续", outside.deps))
      .rejects.toMatchObject({ code: "running-outside-orca" });
    expect(outside.recorder.calls).toEqual([]);
  });

  test("refuses to send when the card's handle or status is stale", async () => {
    const { deps, recorder } = sendDeps();
    await expect(sendSessionInput("claude", SID, "继续", deps, { handle: "term_old" }))
      .rejects.toMatchObject({ code: "handle-changed" });
    await expect(sendSessionInput("claude", SID, "继续", deps, { status: "idle" }))
      .rejects.toMatchObject({ code: "status-changed" });
    expect(recorder.calls).toEqual([]);
    await sendSessionInput("claude", SID, "继续", deps, { handle: "term_claude", status: "done" });
    expect(recorder.calls).toHaveLength(1);
  });

  test("surfaces an Orca failure without recording the input", async () => {
    const { deps } = sendDeps({ orcaJson: async () => ({ ok: false, error: "terminal gone" }) });
    await expect(sendSessionInput("claude", SID, "继续", deps)).rejects.toThrow("orca terminal send failed");
    expect(deps.store.get("claude", SID)).toBeNull();
  });

  test("rejects an unknown agent or session id", async () => {
    const { deps } = sendDeps();
    await expect(sendSessionInput("gemini" as never, SID, "继续", deps)).rejects.toThrow("invalid agent");
    await expect(sendSessionInput("claude", "bad sid", "继续", deps)).rejects.toThrow("invalid session id");
  });
});

describe("sent input store", () => {
  test("keeps only the newest input per session and evicts beyond capacity", () => {
    const store = createSentInputStore(2);
    store.record(sentInput({ text: "第一次" }));
    store.record(sentInput({ text: "第二次", sentAt: SENT_AT + 1 }));
    expect(store.list()).toHaveLength(1);
    expect(store.get("claude", SID)?.text).toBe("第二次");
    store.record(sentInput({ sid: "other-a" }));
    store.record(sentInput({ sid: "other-b" }));
    expect(store.list().map((entry) => entry.sid)).toEqual(["other-a", "other-b"]);
    store.remove("claude", "other-a");
    expect(store.list()).toHaveLength(1);
  });

  test("annotates records with their delivery state", () => {
    const store = createSentInputStore();
    store.record(sentInput());
    const records = sentInputRecords(store, SENT_AT + CONFIRMATION_TIMEOUT_MS);
    expect(records[`claude/${SID}`]).toMatchObject({ text: "继续", state: "stalled" });
  });
});

describe("session send routes", () => {
  test("ignores unrelated paths", async () => {
    const { deps } = sendDeps();
    const request = new Request("http://127.0.0.1:47831/api/live");
    expect(await handleSessionSendRequest(request, new URL(request.url), deps)).toBeNull();
  });

  test("sends and returns the pending record", async () => {
    const { deps, recorder } = sendDeps();
    const { response, body } = await post({ text: "继续", expectedStatus: "done", expectedHandle: "term_claude" }, deps);
    expect(response.status).toBe(200);
    expect(body.record).toMatchObject({ sid: SID, text: "继续", state: "pending" });
    expect(recorder.calls).toHaveLength(1);
  });

  test("answers a stale card with 409 and a machine-readable code", async () => {
    const { deps } = sendDeps({ findLive: () => live({ status: "working" }) });
    const { response, body } = await post({ text: "继续" }, deps);
    expect(response.status).toBe(409);
    expect(body.code).toBe("not-waiting");
  });

  test("rejects cross-site and non-JSON writes", async () => {
    const { deps, recorder } = sendDeps();
    const crossSite = await post({ text: "继续" }, deps, { "Sec-Fetch-Site": "cross-site" });
    expect(crossSite.response.status).toBe(400);
    expect(crossSite.body.error).toContain("cross-site");
    const foreignOrigin = await post({ text: "继续" }, deps, { Origin: "https://evil.example" });
    expect(foreignOrigin.response.status).toBe(400);
    const otherLocalPort = await post({ text: "继续" }, deps, { "Sec-Fetch-Site": "same-site" });
    expect(otherLocalPort.response.status).toBe(400);
    const formPost = new Request(`http://127.0.0.1:47831/api/session-send/claude/${SID}`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ text: "继续" }),
    });
    const response = await handleSessionSendRequest(formPost, new URL(formPost.url), deps);
    expect(response!.status).toBe(400);
    expect(recorder.calls).toEqual([]);
  });

  test("accepts a same-origin browser write", async () => {
    const { deps, recorder } = sendDeps();
    const { response } = await post({ text: "继续" }, deps, {
      "Sec-Fetch-Site": "same-origin", Origin: "http://127.0.0.1:47831",
    });
    expect(response.status).toBe(200);
    expect(recorder.calls).toHaveLength(1);
  });

  test("reconciles queued records and drops one on delete", async () => {
    const store = createSentInputStore();
    store.record(sentInput());
    const confirmationQueue = createSentInputConfirmationQueue({
      store,
      refreshLive: async () => new Map([[`claude/${SID}`, live({ status: "working" })]]),
      getUserInputs: () => new Map([[`claude/${SID}`, [{ text: "继续", ts: SENT_AT + 1 }]]]),
      now: () => SENT_AT + 2,
    });
    const { deps } = sendDeps({
      store, confirmationQueue,
    });
    const listRequest = new Request("http://127.0.0.1:47831/api/session-send");
    const listed = await handleSessionSendRequest(listRequest, new URL(listRequest.url), deps);
    expect(await listed!.json()).toMatchObject({ records: { [`claude/${SID}`]: { state: "confirmed" } } });

    const deleteRequest = new Request(`http://127.0.0.1:47831/api/session-send/claude/${SID}`, { method: "DELETE" });
    const deleted = await handleSessionSendRequest(deleteRequest, new URL(deleteRequest.url), deps);
    expect(deleted!.status).toBe(200);
    expect(store.list()).toEqual([]);
  });

  test("rejects an invalid agent segment", async () => {
    const { deps } = sendDeps();
    const request = new Request(`http://127.0.0.1:47831/api/session-send/gemini/${SID}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "继续" }),
    });
    const response = await handleSessionSendRequest(request, new URL(request.url), deps);
    expect(response!.status).toBe(400);
  });
});

test("SendConflictError carries its code", () => {
  expect(new SendConflictError("offline", "gone")).toMatchObject({ code: "offline", name: "SendConflictError" });
});
