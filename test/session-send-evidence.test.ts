import { afterEach, describe, expect, test } from "bun:test";
import { OrcaDatabase, type FtsRow } from "../src/db";
import { findSentInputEvidence } from "../src/session-send-evidence";
import {
  CONFIRMATION_INPUT_TOLERANCE_MS, type SentInput,
} from "../src/session-send";

const databases: OrcaDatabase[] = [];
const SENT_AT = 1_000_000;
const SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";

function sentInput(agent: SentInput["agent"], sid: string, text: string): SentInput {
  return {
    agent, sid, text, handle: `term_${agent}`, sentAt: SENT_AT,
    workingObservedAt: SENT_AT + 1, confirmedAt: null, confirmedInputAt: null,
  };
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("sent input confirmation evidence", () => {
  test("batch-loads full matching-window user inputs by composite identity", () => {
    const db = new OrcaDatabase(":memory:");
    databases.push(db);
    const longInput = "安全提交".repeat(120);
    const rows: FtsRow[] = [
      { text: "too early", agent: "claude", sid: SID, role: "user", ts: SENT_AT - CONFIRMATION_INPUT_TOLERANCE_MS - 1 },
      { text: "before edge", agent: "claude", sid: SID, role: "user", ts: SENT_AT - CONFIRMATION_INPUT_TOLERANCE_MS },
      { text: "assistant", agent: "claude", sid: SID, role: "assistant", ts: SENT_AT },
      { text: "without time", agent: "claude", sid: SID, role: "user", ts: null },
      { text: "after edge", agent: "claude", sid: SID, role: "user", ts: SENT_AT + CONFIRMATION_INPUT_TOLERANCE_MS },
      { text: "too late", agent: "claude", sid: SID, role: "user", ts: SENT_AT + CONFIRMATION_INPUT_TOLERANCE_MS + 1 },
      { text: longInput, agent: "codex", sid: SID, role: "user", ts: SENT_AT + 1 },
    ];
    db.appendSessionFts(rows);

    const evidence = findSentInputEvidence(db, [
      sentInput("claude", SID, "after edge"),
      sentInput("codex", SID, longInput),
      sentInput("hermes", "missing", "missing"),
    ]);
    expect(evidence.get(`claude/${SID}`)).toEqual([
      { text: "after edge", ts: SENT_AT + CONFIRMATION_INPUT_TOLERANCE_MS },
      { text: "before edge", ts: SENT_AT - CONFIRMATION_INPUT_TOLERANCE_MS },
    ]);
    expect(evidence.get(`codex/${SID}`)).toEqual([{ text: longInput, ts: SENT_AT + 1 }]);
    expect(evidence.get(`codex/${SID}`)?.[0]?.text.length).toBeGreaterThan(320);
    expect(evidence.get("hermes/missing")).toEqual([]);
    expect(findSentInputEvidence(db, []).size).toBe(0);
  });
});
