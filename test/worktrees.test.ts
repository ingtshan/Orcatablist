import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorktreeRoot } from "../src/worktrees";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "orcatab-worktrees-"));
  temporaryDirectories.push(path);
  return path;
}

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("resolveWorktreeRoot", () => {
  test("finds the nearest .git directory or linked-worktree .git file", () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const linked = join(root, "linked-feature");
    git("init", repository);
    writeFileSync(join(repository, "seed.txt"), "seed");
    git("-C", repository, "add", "seed.txt");
    git("-C", repository, "-c", "user.name=OrcaTab", "-c", "user.email=orcatab@example.test", "commit", "-m", "seed");
    git("-C", repository, "worktree", "add", "-b", "feature", linked);
    const repositoryChild = join(repository, "src", "nested");
    const linkedChild = join(linked, "packages", "app");
    mkdirSync(repositoryChild, { recursive: true });
    mkdirSync(linkedChild, { recursive: true });

    expect(statSync(join(repository, ".git")).isDirectory()).toBeTrue();
    expect(statSync(join(linked, ".git")).isFile()).toBeTrue();
    expect(resolveWorktreeRoot(repositoryChild)).toBe(realpathSync(repository));
    expect(resolveWorktreeRoot(linkedChild)).toBe(realpathSync(linked));
  });

  test("returns null outside a detectable absolute Git worktree", () => {
    const ordinary = join(temporaryDirectory(), "ordinary");
    mkdirSync(ordinary);
    expect(resolveWorktreeRoot(ordinary)).toBeNull();
    expect(resolveWorktreeRoot("relative/path")).toBeNull();
    expect(resolveWorktreeRoot(null)).toBeNull();
  });
});
