import { expect, test } from "bun:test";
import { OrcaDatabase } from "../src/db";
import { handleProjectRequest } from "../src/project-routes";
import { openProjectPreferencesDatabase, ProjectPreferencesStore } from "../src/project-preferences";
import type { LiveInfo } from "../src/types";

test("worktree preference validation uses the indexed row's same-environment live root", async () => {
  const db = new OrcaDatabase(":memory:");
  const preferences = new ProjectPreferencesStore(openProjectPreferencesDatabase(":memory:"));
  const projectKey = "feibo1:/project", root = "/worktrees/class-plan-practice-v01", sid = "same";
  db.upsertProject({ key: projectKey, name: "remote", root: "", color: null });
  db.upsertSession({ agent: "codex", sid, env: "feibo1", projectKey, cwd: `${root}/src`,
    worktreeRoot: null, branch: null, title: null, firstPrompt: null, lastPrompt: null,
    lastInputAt: 1, promptCount: 0, filePath: "/fixture", fileSize: 0, fileMtime: 0, parsedOffset: 0 });
  const live: Map<string, LiveInfo> = new Map([["feibo1:codex/same", {
    env: "feibo1", pid: null, name: "remote", waitingFor: null, status: "working", worktree: `repo::${root}`,
  }]]);
  const url = new URL("http://127.0.0.1/api/worktrees");
  const request = (target: string) => new Request(url, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey, root: target, pinned: true }) });
  try {
    const response = await handleProjectRequest(request(root), url, db, preferences, { refresh: async () => live });
    expect(response?.status).toBe(200);
    expect(preferences.getWorktreePreference(projectKey, root)?.pinned).toBe(true);
    live.set("feibo1:codex/same", { ...live.get("feibo1:codex/same")!, env: "local", worktree: "repo::/foreign" });
    await expect(handleProjectRequest(request("/foreign"), url, db, preferences, { refresh: async () => live }))
      .rejects.toThrow("worktree not found");
    live.set("feibo1:codex/unindexed", { ...live.get("feibo1:codex/same")!, env: "feibo1", worktree: "repo::/unknown" });
    await expect(handleProjectRequest(request("/unknown"), url, db, preferences, { refresh: async () => live }))
      .rejects.toThrow("worktree not found");
  } finally { preferences.close(); db.close(); }
});
