import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredSession } from "../src/db";
import type { FocusDeps } from "../src/focus";
import { createServer, type OrcaTabServer } from "../src/server";
import { toSppSession, toSppState } from "../src/spp";
import type { Agent, LiveInfo } from "../src/types";

const SWITCH_SID = "11111111-1111-1111-1111-111111111111";
const RESUME_SID = "22222222-2222-2222-2222-222222222222";
const MANUAL_SID = "33333333-3333-3333-3333-333333333333";
const SWITCH_CWD = "/workspace/switch";
const CONTEXT_CWD = "/workspace/orcatab";
const MANUAL_CWD = "/workspace/manual";

let root = "";
let baseUrl = "";
let app: OrcaTabServer;

function storedSession(
  agent: Agent,
  sid: string,
  title: string,
  projectKey: string,
  cwd: string,
  lastInputAt: number,
): StoredSession {
  return {
    agent, sid, projectKey, cwd, branch: "main", title, firstPrompt: `${title} first prompt`,
    lastPrompt: `${title} last prompt`, lastInputAt, promptCount: 2,
    filePath: join(root, `${sid}.jsonl`), fileSize: 1, fileMtime: 1, parsedOffset: 1,
  };
}

const switchLive: LiveInfo = {
  pid: process.pid, status: "busy", waitingFor: "tool approval", name: "SPP live fixture",
};

const focusDeps: FocusDeps = {
  findLive: (agent, sid) => agent === "claude" && sid === SWITCH_SID ? switchLive : null,
  getSessionCwd: (_agent, sid) => {
    if (sid === RESUME_SID) return CONTEXT_CWD;
    if (sid === MANUAL_SID) return MANUAL_CWD;
    return sid === SWITCH_SID ? SWITCH_CWD : null;
  },
  psEnv: async () => "ORCA_TERMINAL_HANDLE=term_spp ORCA_TAB_ID=tab_spp",
  orcaJson: async (args) => ({ ok: args.includes(`path:${CONTEXT_CWD}`) }),
  openOrca: async () => {},
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "orcatab-spp-"));
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "codex");
  mkdirSync(join(claudeDir, "projects"), { recursive: true });
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  mkdirSync(join(codexDir, "sessions"), { recursive: true });
  writeFileSync(join(claudeDir, "sessions", "switch.json"), JSON.stringify({
    sessionId: SWITCH_SID, ...switchLive,
  }));

  app = await createServer({
    port: 0, claudeDir, codexDir, hermesDb: join(root, "missing-hermes.db"),
    dataDir: join(root, "data"), orcaBin: join(root, "missing-orca"),
    focusDeps, startTimers: false, quiet: true,
  });
  baseUrl = `http://127.0.0.1:${app.server.port}`;
  app.db.upsertSession(storedSession(
    "claude", SWITCH_SID, "OrcaTab provider evidence", "/repos/orcatab", SWITCH_CWD, 300,
  ));
  app.db.upsertSession(storedSession(
    "codex", RESUME_SID, "Unrelated archive", "/repos/elsewhere", CONTEXT_CWD, 200,
  ));
  app.db.upsertSession(storedSession(
    "hermes", MANUAL_SID, "Manual recovery", "/repos/manual", MANUAL_CWD, 100,
  ));
  app.db.appendSessionFts([
    { text: "OrcaTab provider first", agent: "claude", sid: SWITCH_SID, role: "user", ts: 100 },
    { text: "OrcaTab provider progress", agent: "claude", sid: SWITCH_SID, role: "user", ts: 250 },
    { text: "provider response", agent: "claude", sid: SWITCH_SID, role: "assistant", ts: 280 },
    { text: "context-only progress", agent: "codex", sid: RESUME_SID, role: "user", ts: 220 },
  ]);
});

afterAll(() => {
  app.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("SPP pure mappings and database additions", () => {
  test("maps a SessionRow to the frozen SPP session shape", () => {
    const row = app.db.getSession("claude", SWITCH_SID)!;
    expect(toSppSession(row)).toEqual({
      providerId: "orcatab", sessionId: SWITCH_SID, agent: "claude",
      title: "OrcaTab provider evidence", contextPath: SWITCH_CWD, branch: "main",
      lastActivityAt: 300, messageCount: 2, webUrl: null,
      actionUrl: `orcatab://claude/${SWITCH_SID}`,
    });
  });

  test("maps every live status and absence to SPP states", () => {
    expect([toSppState("busy"), toSppState("waiting"), toSppState("idle"), toSppState("shell"), toSppState(null)])
      .toEqual(["live", "waiting", "idle", "idle", "offline"]);
  });

  test("finds sessions across agents and counts strict user deltas", () => {
    expect(app.db.getSessionBySid(RESUME_SID)?.agent).toBe("codex");
    expect(app.db.getSessionBySid("missing")).toBeNull();
    expect(app.db.countUserActivitySince(SWITCH_SID, 150)).toBe(1);
    expect(app.db.countUserActivitySince(SWITCH_SID, 250)).toBe(0);
  });
});

describe("SPP HTTP server", () => {
  test("serves capabilities with no-store and SPP-only CORS", async () => {
    const response = await fetch(`${baseUrl}/spp/v1/capabilities`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({
      protocol: "spp/1.0",
      provider: { id: "orcatab", name: "OrcaTab", version: "1.0.0" },
      agents: ["claude", "codex", "hermes"],
      features: { search: true, suggest: true, status: true, action: true, progressDelta: true },
    });
    expect((await fetch(`${baseUrl}/healthz`)).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("lists, filters, and full-text searches sessions", async () => {
    const listed = await (await fetch(`${baseUrl}/spp/v1/sessions?limit=2&cursor=ignored`)).json();
    expect(listed.nextCursor).toBeNull();
    expect(listed.sessions).toHaveLength(2);
    expect(listed.sessions[0]).toMatchObject({
      providerId: "orcatab", sessionId: SWITCH_SID, agent: "claude",
      actionUrl: `orcatab://claude/${SWITCH_SID}`,
    });

    const contextual = await (await fetch(
      `${baseUrl}/spp/v1/sessions?context=${encodeURIComponent(CONTEXT_CWD)}`,
    )).json();
    expect(contextual.sessions.map((row: { sessionId: string }) => row.sessionId)).toEqual([RESUME_SID]);

    const searched = await (await fetch(`${baseUrl}/spp/v1/sessions?q=orcatab&limit=5`)).json();
    expect(searched.sessions.map((row: { sessionId: string }) => row.sessionId)).toEqual([SWITCH_SID]);
  });

  test("ranks context-only candidates and excludes by sid regardless of providerId", async () => {
    const response = await fetch(`${baseUrl}/spp/v1/suggest`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: { title: "OrcaTab", contextPath: CONTEXT_CWD },
        exclude: [{ providerId: "another-provider", sessionId: SWITCH_SID }], limit: 5,
      }),
    });
    const payload = await response.json();
    expect(payload.suggestions).toHaveLength(1);
    expect(payload.suggestions[0]).toMatchObject({
      providerId: "orcatab", sessionId: RESUME_SID, score: 2,
      reasons: [{ code: "project", label: "同上下文 orcatab" }],
    });
  });

  test("reports live/offline states, waiting details, and optional progress deltas", async () => {
    const response = await fetch(`${baseUrl}/spp/v1/status`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refs: [
        { providerId: "foreign", sessionId: MANUAL_SID },
        { providerId: "orcatab", sessionId: SWITCH_SID },
        { providerId: "orcatab", sessionId: RESUME_SID },
      ], since: 150 }),
    });
    expect(await response.json()).toEqual({ statuses: [
      {
        providerId: "orcatab", sessionId: SWITCH_SID, state: "live", lastActivityAt: 300,
        newActivityCount: 1, waitingFor: "tool approval",
      },
      {
        providerId: "orcatab", sessionId: RESUME_SID, state: "offline", lastActivityAt: 200,
        newActivityCount: 1, waitingFor: null,
      },
    ] });

    const withoutSince = await (await fetch(`${baseUrl}/spp/v1/status`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refs: [{ providerId: "orcatab", sessionId: SWITCH_SID }] }),
    })).json();
    expect("newActivityCount" in withoutSince.statuses[0]).toBeFalse();
  });

  test("describes switch, resume, and manual actions without performing them", async () => {
    const switchAction = await (await fetch(
      `${baseUrl}/spp/v1/sessions/orcatab/${SWITCH_SID}/action`,
    )).json();
    expect(switchAction).toEqual({
      kind: "switch", url: `orcatab://claude/${SWITCH_SID}`, command: null, label: "回到 Orca tab",
    });

    const resumeAction = await (await fetch(
      `${baseUrl}/spp/v1/sessions/orcatab/${RESUME_SID}/action`,
    )).json();
    expect(resumeAction).toEqual({
      kind: "resume", url: `orcatab://codex/${RESUME_SID}`, command: null, label: "在 Orca 恢复会话",
    });

    const manualAction = await (await fetch(
      `${baseUrl}/spp/v1/sessions/orcatab/${MANUAL_SID}/action`,
    )).json();
    expect(manualAction).toMatchObject({ kind: "manual", url: null, label: "手动恢复" });
    expect(manualAction.command).toContain(`hermes --resume ${MANUAL_SID}`);
  });

  test("returns CORS errors, 404s, and an empty 204 preflight", async () => {
    const options = await fetch(`${baseUrl}/spp/v1/sessions`, { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(await options.text()).toBe("");
    expect(options.headers.get("Access-Control-Allow-Methods")).toBe("GET,POST,OPTIONS");

    const badProvider = await fetch(`${baseUrl}/spp/v1/sessions/notaprovider/${SWITCH_SID}/action`);
    expect(badProvider.status).toBe(404);
    expect(await badProvider.json()).toEqual({ error: "provider not found" });
    expect((await fetch(`${baseUrl}/spp/v1/sessions/orcatab/missing/action`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/spp/v1/unknown`)).status).toBe(404);

    const malformed = await fetch(`${baseUrl}/spp/v1/suggest`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });
  });
});
