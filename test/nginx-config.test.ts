import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayReader } from "../src/nginx-config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orcatab-nginx-"));
  roots.push(root);
  return root;
}

describe("nginx gateway discovery", () => {
  test("reads a mounted container config, follows includes, parses routes, and caches snapshots", async () => {
    const root = fixtureRoot();
    const routes = join(root, "routes");
    mkdirSync(routes);
    writeFileSync(join(root, "nginx.conf"), `
      events {}
      http {
        # include /ignored/*.conf;
        include /etc/nginx/local/routes/*.conf;
      }
    `);
    const routePath = join(routes, "demo.conf");
    writeFileSync(routePath, `
      server {
        listen 80;
        server_name demo.localhost;
        location / { proxy_pass http://host.docker.internal:4321; }
      }
    `);
    let clock = 1_000;
    let inspections = 0;
    const reader = createGatewayReader({
      now: () => clock,
      configPaths: [],
      inspectContainers: async () => {
        inspections += 1;
        return [{
          Name: "/demo-nginx", Args: ["nginx", "-c", "/etc/nginx/local/nginx.conf"],
          Config: { Image: "nginx:1.27-alpine" },
          Mounts: [{ Type: "bind", Source: root, Destination: "/etc/nginx/local", RW: false }],
        }];
      },
    });

    const first = await reader.refresh();
    expect(inspections).toBe(1);
    expect(reader.getVersion()).toBe(1);
    expect(first.sources).toEqual(["demo-nginx"]);
    expect(first.files.map((file) => file.path).sort()).toEqual([
      "/etc/nginx/local/nginx.conf", "/etc/nginx/local/routes/demo.conf",
    ]);
    expect(first.routes).toEqual([{
      source: "demo-nginx", file: "/etc/nginx/local/routes/demo.conf",
      serverNames: ["demo.localhost"], listen: ["80"], location: "/",
      proxyPass: "http://host.docker.internal:4321", upstreamPort: 4321,
      urls: ["http://demo.localhost"],
    }]);

    writeFileSync(routePath, `server { listen 8080; server_name changed.localhost;
      location /app { proxy_pass http://127.0.0.1:5432; } }`);
    expect((await reader.refresh()).routes[0]?.upstreamPort).toBe(4321);
    expect(inspections).toBe(1);
    clock += 30_000;
    const changed = await reader.refresh();
    expect(inspections).toBe(2);
    expect(reader.getVersion()).toBe(2);
    expect(changed.routes[0]).toMatchObject({
      serverNames: ["changed.localhost"], location: "/app", upstreamPort: 5432,
      urls: ["http://changed.localhost:8080"],
    });
  });

  test("keeps readable native config when Docker discovery is unavailable", async () => {
    const root = fixtureRoot();
    const path = join(root, "nginx.conf");
    writeFileSync(path, `server {
      listen [::]:8443 ssl;
      server_name secure.localhost *.ignored.localhost $variable _;
      location ~ /private { proxy_pass http://named_upstream; }
    }`);
    const reader = createGatewayReader({
      configPaths: [path], inspectContainers: async () => { throw new Error("docker unavailable"); },
    });
    const snapshot = await reader.refresh();
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]).toMatchObject({ source: "本机 nginx", path, sourcePath: path });
    expect(snapshot.routes[0]).toMatchObject({
      proxyPass: "http://named_upstream", upstreamPort: null,
      urls: ["https://secure.localhost:8443"],
    });
    expect(snapshot.warnings[0]).toContain("docker unavailable");
  });
});
