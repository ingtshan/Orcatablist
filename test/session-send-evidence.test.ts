import { afterEach, describe, expect, test } from "bun:test";
import { OrcaDatabase, type FtsRow } from "../src/db";
import { findLatestSentInputEvidence } from "../src/session-send-evidence";
import type { SentInput } from "../src/session-send";

const databases: OrcaDatabase[] = [];
const SENT_AT = 1_000_000;
const SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";

function sentInput(agent: SentInput["agent"], sid: string, text: string): SentInput {
  return { agent, sid, text, handle: `term_${agent}`, sentAt: SENT_AT };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("sent input confirmation evidence", () => {
  test("batch-loads only the full latest user input by composite identity", () => {
    const db = new OrcaDatabase(":memory:");
    databases.push(db);
    const longInput = "安全提交".repeat(120);
    const rows: FtsRow[] = [
      { text: "Claude old despite later timestamp", agent: "claude", sid: SID, role: "user", ts: SENT_AT + 99_000 },
      { text: "Claude actual latest", agent: "claude", sid: SID, role: "user", ts: null },
      { text: "assistant ignored", agent: "claude", sid: SID, role: "assistant", ts: SENT_AT + 100_000 },
      { text: "Codex old", agent: "codex", sid: SID, role: "user", ts: SENT_AT - 99_000 },
      { text: longInput, agent: "codex", sid: SID, role: "user", ts: SENT_AT + 99_000 },
    ];
    db.appendSessionFts(rows);

    const evidence = findLatestSentInputEvidence(db, [
      sentInput("claude", SID, "Claude actual latest"),
      sentInput("claude", SID, "duplicate"),
      sentInput("codex", SID, longInput),
      sentInput("hermes", "missing", "missing"),
    ]);
    expect(evidence.get(`claude/${SID}`)).toEqual([{ text: "Claude actual latest", ts: null }]);
    expect(evidence.get(`codex/${SID}`)).toEqual([{ text: longInput, ts: SENT_AT + 99_000 }]);
    expect(evidence.get(`codex/${SID}`)?.[0]?.text.length).toBeGreaterThan(320);
    expect(evidence.get("hermes/missing")).toEqual([]);
    expect(findLatestSentInputEvidence(db, []).size).toBe(0);
  });
});
