import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaDatabase, type StoredSession } from "../src/db";
import {
  createProjectDeps, mergeOrcaWorkspaceProjects, refreshProjectMetadata, resolveProjectKey,
  type ProjectDeps,
} from "../src/projects";

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-projects-"));
  temporaryDirectories.push(path);
  return path;
}
function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}
function stored(projectKey: string): StoredSession {
  return {
    sid: "11111111-1111-1111-1111-111111111111", projectKey, cwd: "/tmp/wt", branch: null,
    title: null, firstPrompt: null, lastInputAt: null, promptCount: 0, filePath: "/tmp/a", fileSize: 0,
    fileMtime: 0, parsedOffset: 0,
  };
}
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

describe("resolveProjectKey", () => {
  test("maps a repository and linked worktree to one git common-dir key", async () => {
    const root = temporaryDirectory();
    const repo = join(root, "repo");
    const worktree = join(root, "worktree");
    git("init", repo);
    writeFileSync(join(repo, "seed.txt"), "seed");
    git("-C", repo, "add", "seed.txt");
    git("-C", repo, "-c", "user.name=OrcaTab", "-c", "user.email=orcatab@example.test", "commit", "-m", "seed");
    git("-C", repo, "worktree", "add", "-b", "feature", worktree);
    const db = new OrcaDatabase(join(root, "index.db"));
    const deps = createProjectDeps(db);
    const baseProject = await resolveProjectKey(repo, deps);
    const worktreeProject = await resolveProjectKey(worktree, deps);
    expect(baseProject.key).toBe(worktreeProject.key);
    expect(baseProject).toMatchObject({ root: realpathSync(repo), name: "repo" });
    expect(await resolveProjectKey(repo, deps)).toEqual(baseProject);
    db.close();
  });

  test("uses unknown, Orca workspace, and ordinary-directory fallbacks", async () => {
    const root = temporaryDirectory();
    const db = new OrcaDatabase(join(root, "index.db"));
    const deps = createProjectDeps(db);
    expect(await resolveProjectKey(null, deps)).toMatchObject({ key: "unknown", name: "未知" });
    expect(await resolveProjectKey("relative", deps)).toMatchObject({ key: "unknown" });
    const orcaPath = join(root, "orca", "workspaces", "foo", "missing-child");
    expect(await resolveProjectKey(orcaPath, deps)).toMatchObject({ key: "orca-workspaces:foo", name: "foo", root: "" });
    const ordinary = join(root, "ordinary");
    mkdirSync(ordinary);
    expect(await resolveProjectKey(ordinary, deps)).toMatchObject({ key: ordinary, name: "ordinary", root: ordinary });
    db.close();
  });

  test("keeps a non-dot-git common directory unchanged", async () => {
    let cached: { cwd: string; key: string } | null = null;
    const deps: ProjectDeps = {
      runGit: async () => ({ ok: true, stdout: "/custom/common\n" }),
      getCached: () => null, getProject: () => null,
      setCached: (cwd, project) => { cached = { cwd, key: project.key }; },
    };
    expect(await resolveProjectKey("/some/cwd", deps)).toMatchObject({ key: "/custom/common", root: "/custom/common", name: "common" });
    expect(cached as { cwd: string; key: string } | null).toEqual({ cwd: "/some/cwd", key: "/custom/common" });
  });
});

describe("project post-processing", () => {
  test("merges matching Orca workspace groups into a real project", () => {
    const db = new OrcaDatabase(":memory:");
    db.upsertProject({ key: "/repo/lumina", name: "lumina", root: "/repo/lumina", color: null });
    db.upsertProject({ key: "orca-workspaces:lumina", name: "lumina", root: "", color: null });
    db.upsertSession(stored("orca-workspaces:lumina"));
    db.setCachedProjectKey("/tmp/wt", "orca-workspaces:lumina");
    expect(mergeOrcaWorkspaceProjects(db)).toBe(1);
    expect(db.getSession("11111111-1111-1111-1111-111111111111")!.projectKey).toBe("/repo/lumina");
    expect(db.getCachedProjectKey("/tmp/wt")).toBe("/repo/lumina");
    expect(db.listProjectRecords()).toHaveLength(1);
    db.close();
  });

  test("applies mocked Orca repo display name and badge color", async () => {
    const root = temporaryDirectory();
    const fakeOrca = join(root, "fake-orca");
    const payload = JSON.stringify({ ok: true, result: { repos: [{ path: "/repo", displayName: "展示仓库", badgeColor: "#737373" }] } });
    writeFileSync(fakeOrca, `#!/bin/sh\nprintf '%s\\n' '${payload}'\n`);
    chmodSync(fakeOrca, 0o755);
    const db = new OrcaDatabase(join(root, "index.db"));
    db.upsertProject({ key: "/repo", name: "repo", root: "/repo", color: null });
    expect(await refreshProjectMetadata(db, fakeOrca)).toBe(1);
    expect(db.listProjectRecords()[0]).toMatchObject({ name: "展示仓库", color: "#737373" });
    expect(await refreshProjectMetadata(db, join(root, "missing"))).toBe(0);
    db.close();
  });
});
