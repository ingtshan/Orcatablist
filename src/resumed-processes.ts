import { basename } from "node:path";
import { psText } from "./process-environments";
import { isAgent, isSessionId } from "./session-identity";
import type { Agent } from "./types";

const PROCESS_QUERY_BATCH_SIZE = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERPRETER_PATTERN = /^(?:node(?:js)?|bun|python(?:\d+(?:\.\d+)*)?)$/;
const RESUME_FLAGS = new Set([
  "--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions",
  "--full-auto", "--no-alt-screen",
]);

export interface ResumedProcess {
  pid: number;
  agent: Agent;
  sid: string;
  handle: string;
  tabId: string | null;
  paneKey: string | null;
}

/** Only explicit resume launches, never a shell command or prompt mentioning another session. */
export function resumeProcessIdentity(line: string): Pick<ResumedProcess, "pid" | "agent" | "sid"> | null {
  const match = /^\s*(\d+)\s+(.+)$/.exec(line);
  if (match === null) return null;
  const pid = Number(match[1]);
  const tokens = match[2]!.trim().split(/\s+/);
  const executableIndex = INTERPRETER_PATTERN.test(basename(tokens[0]!)) ? 1 : 0;
  const agent = basename(tokens[executableIndex] ?? "");
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isAgent(agent)) return null;
  let index = executableIndex + 1;
  while (RESUME_FLAGS.has(tokens[index] ?? "")) index += 1;
  if (tokens[index] !== (agent === "codex" ? "resume" : "--resume")) return null;
  const sid = tokens[index + 1];
  if (!isSessionId(sid) || sid.startsWith("-")) return null;
  // Claude/Codex also accept display names; those cannot establish an exact session identity.
  if (agent !== "hermes" && !UUID_PATTERN.test(sid)) return null;
  return { pid, agent, sid };
}

function environmentValue(line: string, name: string): string | null {
  return line.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)(?:\\s|$)`))?.[1] ?? null;
}

export async function listResumedProcesses(readText: typeof psText = psText): Promise<ResumedProcess[]> {
  const listing = await readText(["-axww", "-o", "pid=,command="]);
  const candidates = listing.split("\n").flatMap((line) => {
    const identity = resumeProcessIdentity(line);
    return identity === null ? [] : [{ ...identity, command: line.replace(/^\s*\d+\s+/, "").trimEnd() }];
  });
  const processes: ResumedProcess[] = [];
  // Read environments only for matching PIDs, in one argv-based subprocess. A process may exit
  // between these two reads; re-parse its identity instead of assigning a reused PID to a session.
  for (let offset = 0; offset < candidates.length; offset += PROCESS_QUERY_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + PROCESS_QUERY_BATCH_SIZE);
    const expected = new Map(batch.map((candidate) => [candidate.pid, candidate]));
    const details = await readText(["-Eww", "-o", "pid=,command=", "-p", [...expected.keys()].join(",")], true);
    for (const line of details.split("\n")) {
      const identity = resumeProcessIdentity(line);
      if (identity === null) continue;
      const candidate = expected.get(identity.pid);
      if (candidate?.agent !== identity.agent || candidate.sid !== identity.sid) continue;
      const expanded = line.replace(/^\s*\d+\s+/, "");
      if (!expanded.startsWith(`${candidate.command} `)) continue;
      // The command itself can contain a prompt mentioning ORCA_*; only parse ps's appended env.
      const environment = expanded.slice(candidate.command.length);
      const handle = environmentValue(environment, "ORCA_TERMINAL_HANDLE");
      if (handle === null) continue;
      processes.push({ ...identity, handle,
        tabId: environmentValue(environment, "ORCA_TAB_ID"), paneKey: environmentValue(environment, "ORCA_PANE_KEY"),
      });
    }
  }
  return processes;
}
