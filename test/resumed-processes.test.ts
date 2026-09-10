import { describe, expect, test } from "bun:test";
import { listResumedProcesses, resumeProcessIdentity } from "../src/resumed-processes";

const SID = "11111111-1111-4111-8111-111111111111";
const OTHER_SID = "22222222-2222-4222-8222-222222222222";

describe("explicit resume process discovery", () => {
  test("recognises direct agent launches and their interpreter wrappers", () => {
    for (const command of [
      `codex resume ${SID}`,
      `/opt/bin/codex resume ${SID}`,
      `node /opt/bin/codex resume ${SID}`,
      `/opt/bin/node /opt/bin/codex --dangerously-bypass-approvals-and-sandbox resume ${SID}`,
    ]) expect(resumeProcessIdentity(`123 ${command}`)).toEqual({ pid: 123, agent: "codex", sid: SID });
    expect(resumeProcessIdentity(`123 claude --resume ${SID}`)).toEqual({ pid: 123, agent: "claude", sid: SID });
    expect(resumeProcessIdentity("123 python3 /opt/bin/hermes --resume 20260811_031044_76b3bb"))
      .toEqual({ pid: 123, agent: "hermes", sid: "20260811_031044_76b3bb" });
  });

  test("ignores shell strings, prompts, display names and implicit last-session resumes", () => {
    for (const command of [
      `sh -c codex resume ${SID}`, `echo codex resume ${SID}`, `codex exec resume ${SID}`,
      `node -e codex resume ${SID}`, `codex resume --last`, `claude --resume`,
      `codex resume friendly-title`, `hermes --resume --last`,
    ]) expect(resumeProcessIdentity(`123 ${command}`)).toBeNull();
  });

  test("only reads candidate environments and rechecks identity after PID reuse", async () => {
    const calls: string[][] = [];
    const identities = await listResumedProcesses(async (args) => {
      calls.push(args);
      if (calls.length === 1) return [
        `123 node /opt/bin/codex resume ${SID}`,
        `456 /opt/bin/codex resume ${SID}`,
        `789 claude --resume ${SID}`,
        `999 sh -c codex resume ${SID}`,
      ].join("\n");
      return [
        `123 node /opt/bin/codex resume ${SID} ORCA_TERMINAL_HANDLE=term_a ORCA_TAB_ID=tab_a ORCA_PANE_KEY=tab_a:leaf_a`,
        `456 /opt/bin/codex resume ${OTHER_SID} ORCA_TERMINAL_HANDLE=term_wrong`,
        `789 claude --resume ${SID}`,
      ].join("\n");
    });
    expect(calls).toEqual([
      ["-axww", "-o", "pid=,command="], ["-Eww", "-o", "pid=,command=", "-p", "123,456,789"],
    ]);
    expect(identities).toEqual([
      { pid: 123, agent: "codex", sid: SID, handle: "term_a", tabId: "tab_a", paneKey: "tab_a:leaf_a" },
    ]);
  });

  test("does not read environments if no resume process exists", async () => {
    let reads = 0;
    expect(await listResumedProcesses(async () => { reads += 1; return "123 /bin/zsh"; })).toEqual([]);
    expect(reads).toBe(1);
  });

  test("ignores terminal handles mentioned in a prompt instead of the process environment", async () => {
    const command = `123 codex resume ${SID} check ORCA_TERMINAL_HANDLE=term_wrong`;
    let reads = 0;
    const processes = await listResumedProcesses(async () => {
      reads += 1;
      return reads === 1 ? command : `${command} ORCA_TERMINAL_HANDLE=term_real ORCA_TAB_ID=tab_real`;
    });
    expect(processes[0]?.handle).toBe("term_real");
  });

  test("batches all candidates so older resumes do not hide newly restored sessions", async () => {
    const listing = Array.from({ length: 65 }, (_, index) => `${index + 1} codex resume ${SID}`).join("\n");
    const batches: string[][] = [];
    const processes = await listResumedProcesses(async (args) => {
      if (args[0] === "-axww") return listing;
      const pids = args.at(-1)!.split(",");
      batches.push(pids);
      return pids.map((pid) => `${pid} codex resume ${SID} ORCA_TERMINAL_HANDLE=term_${pid}`).join("\n");
    });
    expect(batches.map((batch) => batch.length)).toEqual([64, 1]);
    expect(processes).toHaveLength(65);
    expect(processes.at(-1)?.handle).toBe("term_65");
  });
});
