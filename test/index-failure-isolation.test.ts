import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase, type StoredSession } from "../src/db";
import { createIndexer } from "../src/indexer";
import { discoverClaudeSessions } from "../src/sources/claude";
import { sourceIssue, type SessionFileInfo, type SessionSource } from "../src/session-source";
import type { Agent } from "../src/types";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-isolation-"));
  temporaryDirectories.push(path);
  return path;
}

function file(agent: Agent, sid: string, path: string, mtime = 1): SessionFileInfo {
  return { agent, sid, path, size: 10, mtime };
}

function session(info: SessionFileInfo, prompt: string): StoredSession {
  return {
    agent: info.agent, sid: info.sid, projectKey: "unknown", cwd: "/fixture", worktreeRoot: null,
    branch: null, title: null, firstPrompt: prompt, lastPrompt: prompt, lastInputAt: info.mtime,
    promptCount: 1, filePath: info.path, fileSize: info.size, fileMtime: info.mtime, parsedOffset: info.size,
  };
}

/** A source whose files can be made to fail one at a time, with real change detection. */
function scriptedSource(agent: Agent, files: () => SessionFileInfo[], broken: () => Set<string>): SessionSource {
  return {
    agent,
    discover: () => ({ files: files(), errors: [] }),
    index: (info, stored) => {
      if (broken().has(info.sid)) throw new Error(`无法读取 ${info.sid}`);
      if (stored !== null && stored.filePath === info.path && stored.fileMtime === info.mtime) return null;
      return {
        session: session(info, `${info.sid} 内容`),
        fts: [{ text: `${info.sid} 内容`, agent, sid: info.sid, role: "user", ts: info.mtime }],
        replaceFts: true,
      };
    },
  };
}

afterEach(() => {
  while (temporaryDirectories.length) {
    const path = temporaryDirectories.pop()!;
    try { chmodSync(path, 0o700); } catch { /* already gone */ }
    rmSync(path, { recursive: true, force: true });
  }
});

describe("indexing fault isolation", () => {
  test("a bad file and a broken source still let every healthy file commit, then repair once", async () => {
    const db = new OrcaDatabase(":memory:");
    const broken = new Set(["bad"]);
    const claude = scriptedSource("claude", () => [file("claude", "bad", "/p/bad.jsonl"), file("claude", "good", "/p/good.jsonl")], () => broken);
    const codex = scriptedSource("codex", () => [file("codex", "other", "/p/other.jsonl")], () => new Set<string>());
    const hermes: SessionSource = {
      agent: "hermes",
      discover: () => ({ files: [], errors: [sourceIssue("discover", "hermes", "账本打不开", { path: "/p/state.db" })] }),
      index: () => null,
    };
    const indexer = createIndexer({
      db, sources: [claude, codex, hermes], foldProjects: false,
      resolveProject: async () => ({ key: "unknown", name: "未知", root: "", color: null }),
      resolveWorktree: () => null,
    });

    const degradedPass = await indexer.indexAll();
    expect(degradedPass.changed).toBe(2);
    expect(db.getSession("claude", "good")).not.toBeNull();
    expect(db.getSession("codex", "other")).not.toBeNull();
    expect(db.getSession("claude", "bad")).toBeNull();
    expect(degradedPass.errors.map((issue) => `${issue.stage}/${issue.source}`).sort())
      .toEqual(["discover/hermes", "read/claude"]);
    expect(degradedPass.errors.find((issue) => issue.source === "claude")).toMatchObject({ path: "/p/bad.jsonl", sid: "bad" });
    // Partial success is still real data, so readers must be told; freshness must not be claimed.
    expect(db.getDataVersion()).toBe(1);
    expect(db.getListVersion()).toBe(1);
    expect(db.getMeta("indexed_at")).toBeNull();
    expect(indexer.getHealth().lastSuccessAt).toBeNull();
    expect(indexer.getHealth().lastAttemptAt).not.toBeNull();

    broken.clear();
    const repaired = await indexer.indexAll();
    expect(repaired.changed).toBe(1);
    expect(repaired.errors).toHaveLength(1);
    expect(db.getSession("claude", "bad")).not.toBeNull();
    // The two files that already committed are unchanged, so their transcripts are not duplicated.
    expect(db.countSessionFts("claude", "good")).toBe(1);
    expect(db.countSessionFts("codex", "other")).toBe(1);
    expect(db.countSessionFts("claude", "bad")).toBe(1);
    expect(db.getDataVersion()).toBe(2);
    expect(db.getMeta("indexed_at")).toBeNull();
    db.close();
  });

  test("a clean pass is what moves freshness", async () => {
    const db = new OrcaDatabase(":memory:");
    const healthy = scriptedSource("claude", () => [file("claude", "good", "/p/good.jsonl")], () => new Set<string>());
    const indexer = createIndexer({
      db, sources: [healthy], foldProjects: false, now: () => 777,
      resolveProject: async () => ({ key: "unknown", name: "未知", root: "", color: null }),
      resolveWorktree: () => null,
    });

    const summary = await indexer.indexAll();
    expect(summary.errors).toEqual([]);
    expect(db.getMeta("indexed_at")).toBe("777");
    expect(indexer.getHealth()).toMatchObject({ running: false, lastSuccessAt: 777, errors: [] });
    db.close();
  });

  test("a shutdown stops the pass mid-flight but leaves what already committed versioned", async () => {
    const db = new OrcaDatabase(":memory:");
    const source = scriptedSource("claude",
      () => [file("claude", "first", "/p/a.jsonl"), file("claude", "second", "/p/b.jsonl")],
      () => new Set<string>());
    let resolved = 0;
    let release!: () => void;
    const gate = new Promise<void>((settle) => { release = settle; });
    const indexer = createIndexer({
      db, sources: [source], foldProjects: false, resolveWorktree: () => null,
      resolveProject: async () => {
        resolved += 1;
        if (resolved === 2) await gate;
        return { key: "unknown", name: "未知", root: "", color: null };
      },
    });

    const pass = indexer.indexAll();
    for (let attempt = 0; attempt < 100 && resolved < 2; attempt += 1) await Promise.resolve();
    expect(resolved).toBe(2);
    expect(db.getSession("claude", "first")).not.toBeNull();

    // Shutdown runs while the database is still open, so the first file's commit stays visible.
    indexer.close();
    expect(db.getDataVersion()).toBe(1);
    expect(db.getListVersion()).toBe(1);

    release();
    const summary = await pass;
    expect(summary.errors).toEqual([]);
    // The second file was still mid-resolution when the shutdown landed; it was not committed.
    expect(db.getSession("claude", "second")).toBeNull();
    expect(db.getDataVersion()).toBe(1);
    expect(db.getMeta("indexed_at")).toBeNull();
    // Nothing further may start after a close.
    expect(await indexer.indexAll()).toMatchObject({ files: 0, changed: 0, errors: [] });
    db.close();
  });

  test("a shutdown during prepare stops before discovery and is not reported as a failure", async () => {
    const db = new OrcaDatabase(":memory:");
    let discoverCalls = 0;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((settle) => { enter = settle; });
    const gate = new Promise<void>((settle) => { release = settle; });
    const source: SessionSource = {
      agent: "claude",
      prepare: async () => { enter(); await gate; },
      // Discovery would read the database, which the shutdown has already closed.
      discover: () => { discoverCalls += 1; db.getMeta("probe"); return { files: [], errors: [] }; },
      index: () => null,
    };
    const indexer = createIndexer({ db, sources: [source], foldProjects: false });

    const pending = indexer.indexAll();
    await entered;
    indexer.close();
    db.close();
    release();

    const summary = await pending;
    expect(discoverCalls).toBe(0);
    // A normal shutdown is cancellation, not a degraded index.
    expect(summary.errors).toEqual([]);
    expect(indexer.getHealth().errors).toEqual([]);
    expect(indexer.getHealth().lastSuccessAt).toBeNull();
  });

  test("a shutdown landing between the commit and the caller still versions the committed row", async () => {
    const db = new OrcaDatabase(":memory:");
    const source = scriptedSource("claude", () => [file("claude", "committed", "/p/a.jsonl")], () => new Set<string>());
    const indexer = createIndexer({
      db, sources: [source], foldProjects: false, resolveWorktree: () => null,
      resolveProject: async () => ({ key: "unknown", name: "未知", root: "", color: null }),
    });
    // Shut down in the microtask right after the transaction, before the awaiting pass resumes.
    const commit = db.applySessionUpdate.bind(db);
    db.applySessionUpdate = (update) => {
      const applied = commit(update);
      if (applied) queueMicrotask(() => indexer.close());
      return applied;
    };

    await indexer.indexAll();
    expect(db.getSession("claude", "committed")).not.toBeNull();
    // The row is real, so readers must be told about it even though the pass never finished.
    expect(db.getDataVersion()).toBe(1);
    expect(db.getListVersion()).toBe(1);
    expect(db.getMeta("indexed_at")).toBeNull();
    db.close();
  });

  test("an unreadable project directory keeps its healthy siblings and reports the path", () => {
    const root = temporaryDirectory();
    const healthy = join(root, "projects", "-ok");
    const blocked = join(root, "projects", "-blocked");
    mkdirSync(healthy, { recursive: true });
    mkdirSync(blocked, { recursive: true });
    const sid = "11111111-1111-1111-1111-111111111111";
    writeFileSync(join(healthy, `${sid}.jsonl`), "{}\n");
    writeFileSync(join(blocked, "22222222-2222-2222-2222-222222222222.jsonl"), "{}\n");
    chmodSync(blocked, 0o000);
    let readable = true;
    try { readdirSync(blocked); } catch { readable = false; }
    expect(readable).toBeFalse();

    const result = discoverClaudeSessions(root);
    expect(result.files.map((entry) => entry.sid)).toEqual([sid]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ stage: "discover", source: "claude", path: blocked });
    chmodSync(blocked, 0o700);
  });

  test("an incomplete inventory never hands ownership to a lesser duplicate path", async () => {
    const db = new OrcaDatabase(":memory:");
    const sid = "33333333-3333-3333-3333-333333333333";
    const greater = file("claude", sid, "/p/z.jsonl", 1);
    const lesser = file("claude", sid, "/p/a.jsonl", 2);
    let listing: SessionFileInfo[] = [lesser, greater];
    let errors: ReturnType<typeof sourceIssue>[] = [];
    const source: SessionSource = {
      agent: "claude",
      discover: () => ({ files: listing, errors }),
      index: (info, stored) => {
        if (stored !== null && stored.filePath === info.path && stored.fileMtime === info.mtime) return null;
        return {
          session: session(info, `来自 ${info.path}`),
          fts: [{ text: `来自 ${info.path}`, agent: "claude", sid, role: "user", ts: info.mtime }],
          replaceFts: true,
        };
      },
    };
    const indexer = createIndexer({
      db, sources: [source], foldProjects: false,
      resolveProject: async () => ({ key: "unknown", name: "未知", root: "", color: null }),
      resolveWorktree: () => null,
    });

    await indexer.indexAll();
    expect(db.getStoredSession("claude", sid)!.filePath).toBe("/p/z.jsonl");

    // The greater path was simply not observed this round, and discovery admits it failed.
    listing = [lesser];
    errors = [sourceIssue("discover", "claude", "目录读取失败", { path: "/p" })];
    const degraded = await indexer.indexAll();
    expect(degraded.changed).toBe(0);
    expect(db.getStoredSession("claude", sid)!.filePath).toBe("/p/z.jsonl");
    expect(db.getStoredSession("claude", sid)!.lastPrompt).toBe("来自 /p/z.jsonl");

    // A clean inventory is authoritative: the surviving file becomes the owner.
    errors = [];
    const clean = await indexer.indexAll();
    expect(clean.changed).toBe(1);
    expect(db.getStoredSession("claude", sid)!.filePath).toBe("/p/a.jsonl");
    expect(db.countSessionFts("claude", sid)).toBe(1);
    db.close();
  });
});
