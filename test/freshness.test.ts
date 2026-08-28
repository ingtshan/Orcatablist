import { describe, expect, test } from "bun:test";
import { composeEtag, serveFresh, versionSource } from "../src/freshness";

function fixed(name: string, value: number | string) {
  return versionSource(name, () => value);
}

describe("composing an ETag", () => {
  test("is stable for unchanged versions", () => {
    const sources = [fixed("list", 3), fixed("live", 7)];
    expect(composeEtag("sessions", sources)).toBe(composeEtag("sessions", sources));
  });

  test("changes when any single declared source changes", () => {
    let list = 1;
    let live = 1;
    let goals = 1;
    const sources = [
      versionSource("list", () => list),
      versionSource("live", () => live),
      versionSource("goals", () => goals),
    ];
    const seen = new Set([composeEtag("sessions", sources)]);
    for (const bump of [() => { list += 1; }, () => { live += 1; }, () => { goals += 1; }]) {
      bump();
      const etag = composeEtag("sessions", sources);
      expect(seen.has(etag)).toBeFalse();
      seen.add(etag);
    }
  });

  test("two routes reading the same versions do not collide", () => {
    const sources = [fixed("list", 3)];
    expect(composeEtag("projects", sources)).not.toBe(composeEtag("worktrees", sources));
  });

  test("source order is part of a route's identity", () => {
    expect(composeEtag("r", [fixed("a", 1), fixed("b", 2)]))
      .not.toBe(composeEtag("r", [fixed("b", 2), fixed("a", 1)]));
  });

  test("distinguishes versions that would collide once concatenated", () => {
    // "1" + "23" and "12" + "3" must not produce the same tag.
    expect(composeEtag("r", [fixed("a", 1), fixed("b", 23)]))
      .not.toBe(composeEtag("r", [fixed("a", 12), fixed("b", 3)]));
  });

  test("is a syntactically valid quoted ETag", () => {
    const etag = composeEtag("focus-board", [fixed("list", 4), fixed("day", 1787900400000)]);
    expect(etag.startsWith('"')).toBeTrue();
    expect(etag.endsWith('"')).toBeTrue();
    expect(etag.slice(1, -1)).not.toContain('"');
  });
});

describe("serving under a derived ETag", () => {
  const url = "http://127.0.0.1/api/thing";

  test("returns the payload and its ETag on a cold request", async () => {
    const response = serveFresh(new Request(url), "thing", [fixed("v", 1)], () => ({ ok: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(composeEtag("thing", [fixed("v", 1)]));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });

  test("304s a matching ETag without building the payload", () => {
    const etag = composeEtag("thing", [fixed("v", 1)]);
    let built = 0;
    const response = serveFresh(
      new Request(url, { headers: { "If-None-Match": etag } }),
      "thing", [fixed("v", 1)], () => { built += 1; return {}; },
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(built).toBe(0);
  });

  test("rebuilds when the client holds a stale ETag", () => {
    let built = 0;
    const response = serveFresh(
      new Request(url, { headers: { "If-None-Match": composeEtag("thing", [fixed("v", 1)]) } }),
      "thing", [fixed("v", 2)], () => { built += 1; return {}; },
    );
    expect(response.status).toBe(200);
    expect(built).toBe(1);
  });
});
