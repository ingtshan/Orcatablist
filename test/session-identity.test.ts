import { describe, expect, test } from "bun:test";
import {
  identityKey, isAgent, isSessionId, isSessionUri, parseSessionIdentity, parseSessionUri,
  sessionIdentityKey, sessionUri, toSessionIdentity,
} from "../src/session-identity";

const CLAUDE_SID = "02998b64-f0d0-48a9-9bf1-8c90e265de7a";
const HERMES_SID = "20260811_031044_76b3bb";

describe("session identity", () => {
  test("round-trips every agent's session id shape through the map key", () => {
    for (const [agent, sid] of [["claude", CLAUDE_SID], ["codex", CLAUDE_SID], ["hermes", HERMES_SID]] as const) {
      const key = sessionIdentityKey(agent, sid);
      expect(key).toBe(`${agent}/${sid}`);
      expect(parseSessionIdentity(key)).toEqual({ agent, sid });
    }
  });

  test("identityKey and sessionIdentityKey agree", () => {
    expect(identityKey({ agent: "codex", sid: CLAUDE_SID })).toBe(sessionIdentityKey("codex", CLAUDE_SID));
  });

  test("rejects keys this codebase never produces", () => {
    expect(parseSessionIdentity(`gemini/${CLAUDE_SID}`)).toBeNull();
    expect(parseSessionIdentity(`/${CLAUDE_SID}`)).toBeNull();
    expect(parseSessionIdentity("claude/")).toBeNull();
    expect(parseSessionIdentity(CLAUDE_SID)).toBeNull();
    expect(parseSessionIdentity("claude/../../etc/passwd")).toBeNull();
  });

  test("keeps the sid separator ambiguity resolved on the first slash", () => {
    // A sid can never contain "/", so the first slash always ends the agent.
    expect(parseSessionIdentity("claude/a/b")).toBeNull();
  });

  test("guards agents and session ids independently", () => {
    expect(isAgent("claude")).toBe(true);
    expect(isAgent("gemini")).toBe(false);
    expect(isAgent(undefined)).toBe(false);
    expect(isSessionId(HERMES_SID)).toBe(true);
    expect(isSessionId("a".repeat(129))).toBe(false);
    expect(isSessionId("has space")).toBe(false);
    expect(isSessionId(42)).toBe(false);
  });

  test("toSessionIdentity accepts only well-formed request input", () => {
    expect(toSessionIdentity("hermes", HERMES_SID)).toEqual({ agent: "hermes", sid: HERMES_SID });
    expect(toSessionIdentity("hermes", "bad sid")).toBeNull();
    expect(toSessionIdentity(null, HERMES_SID)).toBeNull();
  });

  test("round-trips the orcatab:// uri", () => {
    const identity = { agent: "codex", sid: CLAUDE_SID } as const;
    expect(sessionUri(identity)).toBe(`orcatab://codex/${CLAUDE_SID}`);
    expect(parseSessionUri(sessionUri(identity))).toEqual(identity);
  });

  test("a remote uri carries its environment, and a local one keeps its historical bytes", () => {
    const local = { agent: "codex", sid: CLAUDE_SID } as const;
    const remote = { agent: "codex", sid: CLAUDE_SID, env: "feibo1" } as const;
    expect(sessionUri(local)).toBe(`orcatab://codex/${CLAUDE_SID}`);
    expect(sessionUri(remote)).toBe(`orcatab://feibo1:codex/${CLAUDE_SID}`);
    expect(sessionUri(local)).not.toBe(sessionUri(remote));
    expect(parseSessionUri(sessionUri(remote))).toEqual(remote);
    expect(parseSessionUri(sessionUri(local))).toEqual(local);
    // The same agent and sid on two machines must not resolve to one identity.
    expect(parseSessionUri(sessionUri(remote))).not.toEqual(parseSessionUri(sessionUri(local)));
  });

  test("separates 'not a uri' from 'a uri naming an unknown agent'", () => {
    expect(isSessionUri(CLAUDE_SID)).toBe(false);
    expect(parseSessionUri(CLAUDE_SID)).toBeNull();
    expect(isSessionUri(`orcatab://gemini/${CLAUDE_SID}`)).toBe(true);
    expect(parseSessionUri(`orcatab://gemini/${CLAUDE_SID}`)).toBeNull();
  });
});
