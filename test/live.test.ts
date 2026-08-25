import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLiveReader } from "../src/live";

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-live-"));
  temporaryDirectories.push(path);
  return path;
}
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

describe("live session reader", () => {
  test("keeps live pids, drops ESRCH pids, and maps unknown status to idle", () => {
    const root = temporaryDirectory();
    const directory = join(root, "sessions");
    mkdirSync(directory);
    writeFileSync(join(directory, "live.json"), JSON.stringify({ sessionId: "live", pid: process.pid, status: "mystery", name: "self" }));
    writeFileSync(join(directory, "waiting.json"), JSON.stringify({ sessionId: "waiting", pid: process.pid, status: "waiting", waitingFor: "dialog open" }));
    writeFileSync(join(directory, "dead.json"), JSON.stringify({ sessionId: "dead", pid: 2_147_483_000, status: "busy" }));
    writeFileSync(join(directory, "bad.json"), "not json");
    const reader = createLiveReader({ claudeDir: root });
    expect(reader.findLive("live")).toEqual({ pid: process.pid, status: "idle", waitingFor: null, name: "self" });
    expect(reader.findLive("waiting")).toMatchObject({ status: "waiting", waitingFor: "dialog open" });
    expect(reader.findLive("dead")).toBeNull();
  });

  test("returns empty when sessions directory is absent", () => {
    expect(createLiveReader({ claudeDir: temporaryDirectory() }).getLiveMap().size).toBe(0);
  });

  test("serves cache hits without reading again until cache expiry", () => {
    let now = 0;
    let reads = 0;
    const reader = createLiveReader({
      claudeDir: "/fixture",
      now: () => now,
      listFiles: () => { reads += 1; return ["1.json"]; },
      readFile: () => JSON.stringify({ sessionId: "sid", pid: process.pid, status: "shell" }),
      isPidAlive: () => true,
    });
    expect(reader.getLiveMap().get("sid")!.status).toBe("shell");
    now = 100;
    expect(reader.getLiveMap().size).toBe(1);
    expect(reads).toBe(1);
    now = 4_000;
    reader.getLiveMap();
    expect(reads).toBe(2);
  });
});
