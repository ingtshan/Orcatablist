import { describe, expect, test } from "bun:test";
import type { GatewayReader, GatewaySnapshot } from "../src/nginx-config";
import {
  createWorktreeResourceReader, parseListenerTable, parseProcessTable,
} from "../src/worktree-resources";

function gatewayReader(snapshot: GatewaySnapshot): GatewayReader {
  return { refresh: async () => snapshot, getVersion: () => 1 };
}

const gateway: GatewaySnapshot = {
  scannedAt: 1, cacheTtlMs: 30_000, sources: ["fixture"], files: [], warnings: [],
  routes: [{
    source: "fixture", file: "/etc/nginx/routes/demo.conf", serverNames: ["demo.localhost"],
    listen: ["80"], location: "/", proxyPass: "http://host.docker.internal:4321",
    upstreamPort: 4321, urls: ["http://demo.localhost"],
  }],
};

describe("worktree resource discovery", () => {
  test("parses process and lsof machine output", () => {
    expect(parseProcessTable(" 100 1 launch\n101 100 next\ninvalid")).toEqual([
      { pid: 100, ppid: 1 }, { pid: 101, ppid: 100 },
    ]);
    expect(parseListenerTable("p101\nf13\nn127.0.0.1:4321\np202\nn[::1]:8080\nnoise")).toEqual([
      { pid: 101, host: "127.0.0.1", port: 4321 }, { pid: 202, host: "[::1]", port: 8080 },
    ]);
  });

  test("maps descendant listeners to the longest worktree, probes links, and caches work", async () => {
    let clock = 1_000;
    let processScans = 0;
    let listenerScans = 0;
    let gatewayAvailable = true;
    const state = JSON.stringify([
      { name: "demo-web", status: "online", pm_cwd: "/repo/worktree/apps/web", pm_pid_path: "/pids/demo.pid", env: {} },
      { name: "stopped", status: "stopped", pm_cwd: "/repo/worktree", pm_pid_path: "/pids/stopped.pid" },
    ]);
    const reader = createWorktreeResourceReader({
      gatewayReader: gatewayReader(gateway), pm2DumpPath: "/pm2/dump.pm2", now: () => clock,
      readText: (path) => path === "/pm2/dump.pm2" ? state : path === "/pids/demo.pid" ? "100\n" : "",
      listProcesses: async () => { processScans += 1; return "100 1 launch\n101 100 next-server\n"; },
      listListeners: async () => { listenerScans += 1; return "p101\nn127.0.0.1:4321\n"; },
      probe: async (url) => gatewayAvailable && url.includes("demo.localhost") ? 200 : null,
    });

    const first = await reader.refresh(["/repo", "/repo/worktree"]);
    expect(first.warnings).toEqual([]);
    expect(first.resources).toEqual({
      "/repo/worktree": [{
        worktreeRoot: "/repo/worktree", appName: "demo-web", pid: 100, port: 4321,
        links: [{ kind: "gateway", url: "http://demo.localhost/", status: 200 }],
      }],
    });
    expect(reader.getVersion()).toBe(1);
    await reader.refresh(["/repo/worktree", "/repo"]);
    expect([processScans, listenerScans]).toEqual([1, 1]);

    gatewayAvailable = false;
    clock += 15_000;
    expect((await reader.refresh(["/repo", "/repo/worktree"])).resources["/repo/worktree"]).toHaveLength(1);
    expect([processScans, listenerScans]).toEqual([2, 2]);
    clock += 45_000;
    const changed = await reader.refresh(["/repo", "/repo/worktree"]);
    expect(changed.resources["/repo/worktree"]).toBeUndefined();
    expect(reader.getVersion()).toBe(2);
    expect([processScans, listenerScans]).toEqual([3, 3]);
  });

  test("uses PM2 PORT when the listener scan cannot associate a process", async () => {
    const reader = createWorktreeResourceReader({
      gatewayReader: gatewayReader({ ...gateway, routes: [] }), pm2DumpPath: "dump",
      readText: (path) => path === "dump" ? JSON.stringify([{
        name: "api", status: "online", pm_cwd: "/repo", pm_pid_path: "missing", env: { PORT: "1337" },
      }]) : (() => { throw new Error("missing"); })(),
      listProcesses: async () => "", listListeners: async () => "",
      probe: async (url) => url === "http://127.0.0.1:1337/" ? 404 : null,
    });
    expect((await reader.refresh(["/repo"])).resources["/repo"]).toEqual([{
      worktreeRoot: "/repo", appName: "api", pid: null, port: 1337,
      links: [{ kind: "direct", url: "http://127.0.0.1:1337/", status: 404 }],
    }]);
  });

  test("returns an empty snapshot with a contextual warning for malformed PM2 state", async () => {
    const reader = createWorktreeResourceReader({
      gatewayReader: gatewayReader(gateway), pm2DumpPath: "dump", readText: () => "{}",
      listProcesses: async () => { throw new Error("must not scan"); },
      listListeners: async () => { throw new Error("must not scan"); }, probe: async () => null,
    });
    const snapshot = await reader.refresh(["/repo"]);
    expect(snapshot.resources).toEqual({});
    expect(snapshot.warnings[0]).toContain("PM2 state is not an array");
  });
});
