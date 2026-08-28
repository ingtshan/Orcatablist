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
  test("keeps raw statuses for live pids and drops ESRCH pids", () => {
    const root = temporaryDirectory();
    const directory = join(root, "sessions");
    mkdirSync(directory);
    writeFileSync(join(directory, "live.json"), JSON.stringify({ sessionId: "live", pid: process.pid, status: "mystery", name: "self" }));
    writeFileSync(join(directory, "waiting.json"), JSON.stringify({ sessionId: "waiting", pid: process.pid, status: "waiting", waitingFor: "dialog open" }));
    writeFileSync(join(directory, "dead.json"), JSON.stringify({ sessionId: "dead", pid: 2_147_483_000, status: "busy" }));
    writeFileSync(join(directory, "bad.json"), "not json");
    const live = createLiveReader({ claudeDir: root }).getLiveMap();
    expect(live.get("live")).toEqual({ pid: process.pid, status: "mystery", waitingFor: null, name: "self" });
    expect(live.get("waiting")).toMatchObject({ status: "waiting", waitingFor: "dialog open" });
    expect(live.has("dead")).toBeFalse();
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
