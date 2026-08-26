const HERMES_PROCESS_SCAN_LIMIT = 64;

async function psText(args: string[], tolerateExit = false): Promise<string> {
  const child = Bun.spawn(["ps", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0 && !tolerateExit) throw new Error(`ps process scan failed (${exitCode}): ${stderr.trim()}`);
  return stdout;
}

export async function listHermesProcessEnvironments(): Promise<string> {
  const listing = await psText(["-axo", "pid=,command="]);
  const pids = listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || !/(?:hermes|ui-tui|tui_dist)/i.test(match[2]!)) return [];
    return [match[1]!];
  }).slice(0, HERMES_PROCESS_SCAN_LIMIT);
  return (await Promise.all(pids.map((pid) => psText(["-Eww", "-o", "command=", "-p", pid], true)))).join("\n");
}
