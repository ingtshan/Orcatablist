import { describe, expect, test, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemblePullOutput, buildSshArgv, COLLECTOR_SCRIPT, remoteCollectorCommand, spawnExec,
} from "../src/remote-pull";

const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-remote-pull-"));
  temporaryDirectories.push(path);
  return path;
}

/** Fixtures deliberately make directories unreadable; give them back before removal. */
function restorePermissions(path: string): void {
  try { chmodSync(path, 0o700); } catch { return; }
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) if (entry.isDirectory()) restorePermissions(join(path, entry.name));
}

afterEach(() => {
  while (temporaryDirectories.length) {
    const path = temporaryDirectories.pop()!;
    restorePermissions(path);
    rmSync(path, { recursive: true, force: true });
  }
});

/** Verifies the fixture really is unreadable; otherwise the assertion below proves nothing. */
function blockAccess(path: string): void {
  chmodSync(path, 0o000);
  let readable = true;
  try { readdirSync(path); } catch { readable = false; }
  expect(readable).toBeFalse();
}

function line(event: unknown): string { return `${JSON.stringify(event)}\n`; }
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("assemblePullOutput", () => {
  test("assembles list, contiguous chunks and the done marker", () => {
    const stdout =
      line({ type: "list", agent: "claude", files: [{ path: "/r/a.jsonl", size: 10, mtime: 5 }] }) +
      line({ type: "chunk", path: "/r/a.jsonl", offset: 4, data: b64("hel") }) +
      line({ type: "chunk", path: "/r/a.jsonl", offset: 7, data: b64("lo\n") }) +
      line({ type: "done", truncated: true });
    const result = assemblePullOutput(stdout);
    expect(result.files).toEqual([{ path: "/r/a.jsonl", size: 10, mtime: 5 }]);
    expect(result.done).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.errors).toEqual([]);
    const chunk = result.chunks.get("/r/a.jsonl")!;
    expect(chunk.offset).toBe(4);
    expect(Buffer.from(chunk.bytes).toString("utf8")).toBe("hello\n");
  });

  test("a chunk gap invalidates that file instead of corrupting it", () => {
    const stdout =
      line({ type: "chunk", path: "/r/a.jsonl", offset: 0, data: b64("abc") }) +
      line({ type: "chunk", path: "/r/a.jsonl", offset: 9, data: b64("xyz") }) +
      line({ type: "chunk", path: "/r/b.jsonl", offset: 0, data: b64("ok\n") }) +
      line({ type: "done", truncated: false });
    const result = assemblePullOutput(stdout);
    expect(result.chunks.has("/r/a.jsonl")).toBe(false);
    expect(result.chunks.has("/r/b.jsonl")).toBe(true);
    expect(result.errors.some((error) => error.includes("non-contiguous"))).toBe(true);
  });

  test("rebuild resets any bytes buffered before it", () => {
    const stdout =
      line({ type: "chunk", path: "/r/a.jsonl", offset: 40, data: b64("stale") }) +
      line({ type: "rebuild", path: "/r/a.jsonl" }) +
      line({ type: "chunk", path: "/r/a.jsonl", offset: 0, data: b64("fresh\n") }) +
      line({ type: "done", truncated: false });
    const result = assemblePullOutput(stdout);
    expect(result.rebuilds.has("/r/a.jsonl")).toBe(true);
    const chunk = result.chunks.get("/r/a.jsonl")!;
    expect(chunk.offset).toBe(0);
    expect(Buffer.from(chunk.bytes).toString("utf8")).toBe("fresh\n");
  });

  test("collects collector errors and flags a missing done marker as not done", () => {
    const result = assemblePullOutput(line({ type: "error", message: "boom" }) + "not json\n");
    expect(result.done).toBe(false);
    expect(result.errors.some((error) => error.includes("boom"))).toBe(true);
    expect(result.errors.some((error) => error.includes("unparseable"))).toBe(true);
  });
});

describe("buildSshArgv", () => {
  test("pins the option set and puts the destination after --", () => {
    const argv = buildSshArgv({ sshUser: "bb00", sshHost: "192.168.24.117", sshPort: null }, "python3 -c x", "/data");
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("BatchMode=yes");
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
    expect(argv.indexOf("--")).toBe(argv.length - 3);
    expect(argv[argv.length - 2]).toBe("bb00@192.168.24.117");
    expect(argv[argv.length - 1]).toBe("python3 -c x");
    expect(argv).not.toContain("-p");
  });

  test("adds -p only when a port is set", () => {
    const argv = buildSshArgv({ sshUser: "u", sshHost: "h", sshPort: 2222 }, "cmd", "/data");
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("-p") + 1]).toBe("2222");
  });

  test("the remote command wraps the script so no shell metacharacter escapes single quotes", () => {
    const command = remoteCollectorCommand();
    expect(command.startsWith("python3 -c 'import base64;exec(base64.b64decode(\"")).toBe(true);
    const inner = command.slice(command.indexOf('"') + 1, command.lastIndexOf('"'));
    expect(inner).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

/** Runs the real collector under the local python3 — the exact bytes ssh would carry. */
async function runCollector(request: unknown): Promise<string> {
  const result = await spawnExec(
    ["python3", "-c", COLLECTOR_SCRIPT],
    JSON.stringify(request), 10_000, 64 * 1024 * 1024,
  );
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("collector script under local python3", () => {
  test("lists, ships ranges from cursors, honors the budget and reports probe stats", async () => {
    const root = temporaryDirectory();
    const projects = join(root, "projects", "-fixture-repo");
    mkdirSync(projects, { recursive: true });
    const sessionPath = join(projects, `${SID}.jsonl`);
    writeFileSync(sessionPath, "first line\nsecond line\n");
    writeFileSync(join(projects, "not-a-session.txt"), "ignored");

    const probe = assemblePullOutput(await runCollector({ probe: true, claude: { dir: join(root, "projects") } }));
    expect(probe.done).toBe(true);

    const full = assemblePullOutput(await runCollector({
      claude: { dir: join(root, "projects") }, cursors: {}, maxBytes: 1024,
    }));
    expect(full.done).toBe(true);
    expect(full.truncated).toBe(false);
    expect(full.files).toHaveLength(1);
    expect(full.files[0]!.path).toBe(sessionPath);
    expect(Buffer.from(full.chunks.get(sessionPath)!.bytes).toString("utf8")).toBe("first line\nsecond line\n");

    const incremental = assemblePullOutput(await runCollector({
      claude: { dir: join(root, "projects") }, cursors: { [sessionPath]: 11 }, maxBytes: 1024,
    }));
    const tail = incremental.chunks.get(sessionPath)!;
    expect(tail.offset).toBe(11);
    expect(Buffer.from(tail.bytes).toString("utf8")).toBe("second line\n");

    const budgeted = assemblePullOutput(await runCollector({
      claude: { dir: join(root, "projects") }, cursors: {}, maxBytes: 5,
    }));
    expect(budgeted.truncated).toBe(true);
    expect(budgeted.chunks.get(sessionPath)!.bytes.byteLength).toBe(5);

    const shrunk = assemblePullOutput(await runCollector({
      claude: { dir: join(root, "projects") }, cursors: { [sessionPath]: 999 }, maxBytes: 1024,
    }));
    expect(shrunk.rebuilds.has(sessionPath)).toBe(true);
    expect(Buffer.from(shrunk.chunks.get(sessionPath)!.bytes).toString("utf8")).toBe("first line\nsecond line\n");
  });

  test("codex listing honors the sinceDays window and ships the session index once", async () => {
    const CODEX_SID = "bbbbbbbb-2222-3333-4444-555555555555";
    const OLD_SID = "cccccccc-3333-4444-5555-666666666666";
    const base = temporaryDirectory();
    const day = join(base, "sessions", "2026", "08", "30");
    mkdirSync(day, { recursive: true });
    const freshPath = join(day, `rollout-2026-08-30T09-00-00-${CODEX_SID}.jsonl`);
    const stalePath = join(day, `rollout-2020-01-01T00-00-00-${OLD_SID}.jsonl`);
    writeFileSync(freshPath, "fresh line\n");
    writeFileSync(stalePath, "stale line\n");
    const staleSeconds = Date.parse("2020-01-01T00:00:00Z") / 1000;
    utimesSync(stalePath, staleSeconds, staleSeconds);
    writeFileSync(join(base, "session_index.jsonl"), `${JSON.stringify({ id: CODEX_SID, thread_name: "标题" })}\n`);

    const request = {
      codex: { dir: base, sinceDays: 30, index: null }, cursors: {}, maxBytes: 4096,
    };
    const first = assemblePullOutput(await runCollector(request));
    expect(first.done).toBe(true);
    expect(first.codexFiles.map((file) => file.path)).toEqual([freshPath]);
    expect(first.files).toEqual([]);
    expect(Buffer.from(first.chunks.get(freshPath)!.bytes).toString("utf8")).toBe("fresh line\n");
    expect(first.codexIndex).not.toBeNull();
    expect(Buffer.from(first.codexIndex!.data).toString("utf8")).toContain("标题");

    const second = assemblePullOutput(await runCollector({
      ...request,
      codex: { ...request.codex, index: { size: first.codexIndex!.size, mtime: first.codexIndex!.mtime } },
      cursors: { [freshPath]: 11 },
    }));
    expect(second.codexIndex).toBeNull();
    expect(second.chunks.size).toBe(0);
  });

  test("accepts historical numeric cursors and typed cursors that describe the observed file", async () => {
    const root = temporaryDirectory();
    const dir = join(root, "projects");
    const projects = join(dir, "-fixture-repo");
    mkdirSync(projects, { recursive: true });
    const path = join(projects, `${SID}.jsonl`);
    writeFileSync(path, "first line\nsecond line\n");
    const stat = statSync(path);
    const size = stat.size;
    const mtime = Math.trunc(stat.mtimeMs);
    const collect = async (cursor: unknown) => assemblePullOutput(await runCollector({
      claude: { dir }, cursors: { [path]: cursor }, maxBytes: 1024,
    }));
    const text = (result: ReturnType<typeof assemblePullOutput>) =>
      Buffer.from(result.chunks.get(path)!.bytes).toString("utf8");

    const numeric = await collect(11);
    expect(numeric.rebuilds.size).toBe(0);
    expect(text(numeric)).toBe("second line\n");

    const settled = await collect({ offset: size, size, mtime });
    expect(settled.chunks.size).toBe(0);
    expect(settled.rebuilds.size).toBe(0);

    const rewritten = await collect({ offset: size, size, mtime: mtime - 5_000 });
    expect(rewritten.rebuilds.has(path)).toBeTrue();
    expect(text(rewritten)).toBe("first line\nsecond line\n");

    // A shrink is a replacement even while the file is still longer than what was received.
    const shrunk = await collect({ offset: 5, size: size + 100, mtime });
    expect(shrunk.rebuilds.has(path)).toBeTrue();
    expect(text(shrunk)).toBe("first line\nsecond line\n");

    const skipped = await collect({ offset: 11, size, mtime, skip: true });
    expect(skipped.chunks.size).toBe(0);
    expect(skipped.rebuilds.size).toBe(0);

    const movedOn = await collect({ offset: 11, size: size - 1, mtime, skip: true });
    expect(movedOn.rebuilds.size).toBe(0);
    expect(text(movedOn)).toBe("second line\n");
  });

  test("cyclic quanta share one budget, and an exact fit with EOF files is not truncated", async () => {
    const root = temporaryDirectory();
    const dir = join(root, "projects");
    const projects = join(dir, "-fixture-repo");
    mkdirSync(projects, { recursive: true });
    const first = join(projects, `${SID}.jsonl`);
    const second = join(projects, "bbbbbbbb-2222-3333-4444-555555555555.jsonl");
    const done = join(projects, "cccccccc-3333-4444-5555-666666666666.jsonl");
    writeFileSync(first, "a".repeat(60));
    writeFileSync(second, "b".repeat(60));
    writeFileSync(done, "c".repeat(30));
    // Pin the mtimes so "start at the freshest path" picks a known file on any filesystem clock.
    const second0 = Math.trunc(Date.now() / 1000);
    utimesSync(first, second0, second0);
    utimesSync(second, second0 - 10, second0 - 10);
    utimesSync(done, second0 - 20, second0 - 20);
    const collect = async (request: Record<string, unknown>) =>
      assemblePullOutput(await runCollector({ claude: { dir }, maxBytes: 1024, ...request }));
    const sent = (result: ReturnType<typeof assemblePullOutput>, path: string) =>
      result.chunks.get(path)?.bytes.byteLength ?? 0;
    /** A finished file: the cursor describes exactly the file on disk, so nothing is eligible. */
    const finished = (path: string) => {
      const stat = statSync(path);
      return { offset: stat.size, size: stat.size, mtime: Math.trunc(stat.mtimeMs) };
    };

    // 40 bytes each per pass: nobody may swallow the whole round on the first turn.
    const shared = await collect({ cursors: {}, maxBytes: 80, quantum: 40 });
    expect(sent(shared, first)).toBe(40);
    expect(sent(shared, second)).toBe(40);
    expect(sent(shared, done)).toBe(0);
    expect(shared.truncated).toBeTrue();
    expect(shared.lastPath).toBe(second);

    // A lone eligible file may keep taking turns until the round budget is gone.
    const alone = await collect({
      cursors: { [second]: finished(second), [done]: finished(done) },
      maxBytes: 1024, quantum: 40,
    });
    expect(sent(alone, first)).toBe(60);
    expect(alone.truncated).toBeFalse();

    // Exactly enough budget for the unread bytes, with already-finished files still listed.
    const exact = await collect({
      cursors: { [done]: finished(done) }, maxBytes: 120, quantum: 40,
    });
    expect(sent(exact, first) + sent(exact, second)).toBe(120);
    expect(exact.truncated).toBeFalse();
  });

  test("resumes after the last visited path so a busy file cannot starve a cold one", async () => {
    const root = temporaryDirectory();
    const dir = join(root, "projects");
    const projects = join(dir, "-fixture-repo");
    mkdirSync(projects, { recursive: true });
    const paths = ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map((prefix) =>
      join(projects, `${prefix}-1111-2222-3333-444444444444.jsonl`));
    for (const path of paths) writeFileSync(path, "x".repeat(60));
    // The lexically first file is also the freshest, and stays that way.
    utimesSync(paths[0]!, Date.now() / 1000, Date.now() / 1000);
    const collect = async (lastPath: string | null) => assemblePullOutput(await runCollector({
      claude: { dir }, cursors: {}, maxBytes: 40, quantum: 40, lastPath,
    }));

    const firstRound = await collect(null);
    expect(firstRound.lastPath).toBe(paths[0]!);
    const secondRound = await collect(firstRound.lastPath);
    expect(secondRound.lastPath).toBe(paths[1]!);
    const thirdRound = await collect(secondRound.lastPath);
    expect(thirdRound.lastPath).toBe(paths[2]!);
    // A path that disappeared resumes at its lexical successor rather than restarting.
    const wrapped = await collect(join(projects, "b0000000-1111-2222-3333-444444444444.jsonl"));
    expect(wrapped.lastPath).toBe(paths[1]!);
  });

  test("an excluded duplicate is never shipped, and the exclusion is re-evaluated each round", async () => {
    const root = temporaryDirectory();
    const dir = join(root, "projects");
    const projects = join(dir, "-fixture-repo");
    mkdirSync(projects, { recursive: true });
    const path = join(projects, `${SID}.jsonl`);
    writeFileSync(path, "duplicate loser\n");

    const skipped = assemblePullOutput(await runCollector({
      claude: { dir }, cursors: { [path]: { offset: 0, size: 0, mtime: 0, exclude: true } }, maxBytes: 1024,
    }));
    expect(skipped.chunks.size).toBe(0);
    expect(skipped.rebuilds.size).toBe(0);
    expect(skipped.truncated).toBeFalse();
    expect(skipped.files).toHaveLength(1);

    const promoted = assemblePullOutput(await runCollector({
      claude: { dir }, cursors: {}, maxBytes: 1024,
    }));
    expect(Buffer.from(promoted.chunks.get(path)!.bytes).toString("utf8")).toBe("duplicate loser\n");
  });

  test("an unreadable Claude project directory is reported while healthy siblings still list", async () => {
    const root = temporaryDirectory();
    const dir = join(root, "projects");
    const healthy = join(dir, "-healthy");
    const blocked = join(dir, "-blocked");
    mkdirSync(healthy, { recursive: true });
    mkdirSync(blocked, { recursive: true });
    const kept = join(healthy, `${SID}.jsonl`);
    writeFileSync(kept, "listed\n");
    writeFileSync(join(blocked, "bbbbbbbb-2222-3333-4444-555555555555.jsonl"), "hidden\n");
    blockAccess(blocked);

    const result = assemblePullOutput(await runCollector({ claude: { dir }, cursors: {}, maxBytes: 1024 }));
    expect(result.done).toBeTrue();
    // The listing is short by one directory, and the round says so instead of looking complete.
    expect(result.files.map((file) => file.path)).toEqual([kept]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(blocked);
    expect(result.errors[0]).toContain("claude");
    expect(result.missing).toEqual([]);
  });

  test("an unreadable root is a failure, while an absent root stays a normal empty state", async () => {
    const root = temporaryDirectory();
    const dir = join(root, "projects");
    mkdirSync(join(dir, "-project"), { recursive: true });
    writeFileSync(join(dir, "-project", `${SID}.jsonl`), "hidden\n");
    blockAccess(dir);

    const denied = assemblePullOutput(await runCollector({ claude: { dir }, cursors: {}, maxBytes: 1024 }));
    expect(denied.done).toBeTrue();
    expect(denied.files).toEqual([]);
    expect(denied.errors).toHaveLength(1);
    expect(denied.errors[0]).toContain(dir);
    // An access failure must never masquerade as "this machine never ran the CLI".
    expect(denied.missing).toEqual([]);

    const absent = assemblePullOutput(await runCollector({
      claude: { dir: join(root, "never-used") }, cursors: {}, maxBytes: 1024,
    }));
    expect(absent.errors).toEqual([]);
    expect(absent.missing).toEqual(["claude"]);

    // The root itself cannot even be examined: still a failure, still not "missing".
    const sealed = temporaryDirectory();
    const hidden = join(sealed, "home", "projects");
    mkdirSync(hidden, { recursive: true });
    blockAccess(join(sealed, "home"));
    const unexaminable = assemblePullOutput(await runCollector({
      claude: { dir: hidden }, cursors: {}, maxBytes: 1024,
    }));
    expect(unexaminable.done).toBeTrue();
    expect(unexaminable.errors).toHaveLength(1);
    expect(unexaminable.errors[0]).toContain(hidden);
    expect(unexaminable.missing).toEqual([]);
  });

  test("Codex reports unreadable directories found while walking, and an unreadable root", async () => {
    const base = temporaryDirectory();
    const sessions = join(base, "sessions");
    const healthy = join(sessions, "2026", "09", "05");
    const blocked = join(sessions, "2026", "09", "04");
    mkdirSync(healthy, { recursive: true });
    mkdirSync(blocked, { recursive: true });
    const kept = join(healthy, "rollout-2026-09-05T09-00-00-bbbbbbbb-2222-3333-4444-555555555555.jsonl");
    writeFileSync(kept, "listed\n");
    writeFileSync(join(blocked, "rollout-2026-09-04T09-00-00-cccccccc-3333-4444-5555-666666666666.jsonl"), "hidden\n");
    blockAccess(blocked);

    const walked = assemblePullOutput(await runCollector({
      codex: { dir: base, sinceDays: null, index: null }, cursors: {}, maxBytes: 1024,
    }));
    expect(walked.done).toBeTrue();
    expect(walked.codexFiles.map((file) => file.path)).toEqual([kept]);
    expect(walked.errors).toHaveLength(1);
    expect(walked.errors[0]).toContain(blocked);
    expect(walked.errors[0]).toContain("codex");
    expect(walked.missing).toEqual([]);

    const missingBase = temporaryDirectory();
    const missingRoot = join(missingBase, "sessions");
    mkdirSync(missingRoot, { recursive: true });
    blockAccess(missingRoot);
    const deniedRoot = assemblePullOutput(await runCollector({
      codex: { dir: missingBase, sinceDays: null, index: null }, cursors: {}, maxBytes: 1024,
    }));
    expect(deniedRoot.codexFiles).toEqual([]);
    expect(deniedRoot.errors).toHaveLength(1);
    expect(deniedRoot.errors[0]).toContain(missingRoot);
    expect(deniedRoot.missing).toEqual([]);
  });

  test("a machine without the projects directory is a normal empty state, not an error", async () => {
    const result = assemblePullOutput(await runCollector({
      claude: { dir: "/nonexistent-orcatab-fixture" }, cursors: {}, maxBytes: 100,
    }));
    expect(result.done).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.missing).toEqual(["claude"]);
    expect(result.files).toEqual([]);
  });
});
