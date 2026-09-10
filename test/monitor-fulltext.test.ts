import { expect, test } from "bun:test";
import { OrcaDatabase } from "../src/db";
import { parseLine } from "../src/parse";
import { indexJsonlSession } from "../src/sources/jsonl";
import { handleSessionInputsRequest } from "../src/session-input-routes";

const SID = "bbbbbbbb-1111-2222-3333-444444444444";
const URL = new globalThis.URL("http://127.0.0.1/api/session-inputs");
const LONG_INPUT = "第一行\n\n  <section>保留原文</section>\n" + "长消息🦀\n".repeat(2_000) + "全文结束标记";

test("Monitor reads the entire ingested message, including text beyond both former limits", async () => {
  const db = new OrcaDatabase(":memory:");
  try {
    const text = JSON.stringify({ type: "user", message: { content: LONG_INPUT }, timestamp: "2026-09-09T00:00:00Z" }) + "\n";
    const update = indexJsonlSession({
      info: { agent: "claude", env: "remote", sid: SID, path: "/fixture/session.jsonl", size: Buffer.byteLength(text), mtime: 1 },
      stored: null, window: { offset: 0, bytes: Buffer.from(text), rebuild: true }, parseLine,
    })!;
    db.applySessionUpdate({ ...update, project: { key: "fixture", name: "fixture", root: "/fixture", color: null } });
    db.appendSessionFts([{ agent: "claude", sid: SID, role: "user", text: "同 SID 本机消息", ts: 1 }]);
    const request = (fullText: boolean, offset = 0) => new Request(URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: [{ agent: "claude", env: "remote", sid: SID }], limit: 1, offset, fullText }),
    });
    const full = await (await handleSessionInputsRequest(request(true), URL, db))!.json();
    expect(full.inputs[`remote:claude/${SID}`][0]).toBe(LONG_INPUT);
    expect(full.hasMore[`remote:claude/${SID}`]).toBe(false);
    const preview = await (await handleSessionInputsRequest(request(false), URL, db))!.json();
    expect([...preview.inputs[`remote:claude/${SID}`][0]]).toHaveLength(320);
    expect(preview.inputs[`remote:claude/${SID}`][0]).toEndWith("…");
    const empty = await (await handleSessionInputsRequest(request(true, 1), URL, db))!.json();
    expect(empty.inputs[`remote:claude/${SID}`]).toEqual([]);
  } finally { db.close(); }
});
