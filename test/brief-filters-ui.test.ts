import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function source(name: string) {
  const start = html.indexOf(`      function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return html.slice(start, html.indexOf("\n      }", start) + 8);
}
const row = (projectKey: string, root: string, env = "local") => ({ projectKey, worktreeRoot: root, env, sid: `${projectKey}-${root}-${env}`, displayTitle: projectKey });
const worktreeKey = (session: ReturnType<typeof row>) => JSON.stringify([session.env, session.projectKey, session.worktreeRoot]);
function harness() {
  const a = row("A", "/main"), feature = row("A", "/feature"), remote = row("A", "/main", "n1"), b = row("B", "/main");
  const briefs = [a, feature, remote, b].map((session, index) => ({ id: String(index), session, completedAt: index + 1, input: "", response: "", readAt: null }));
  const state = { query: "", focusBriefs: briefs as any[], focusSearchMatches: new Map(),
    focusHiddenProjects: new Set<string>(),
    focusBriefProjectFilters: new Set<string>(), focusBriefWorktreeFilters: new Set<string>(),
    focusProjectFilters: new Set<string>(), focusWorktreeFilters: new Set<string>() };
  const api = new Function("state", "worktreeKey", `
    const sessionKey = row => row.sid;
    const focusRowMatchesProject = row => !state.focusProjectFilters.size || state.focusProjectFilters.has(row.projectKey);
    const focusRowMatchesWorktree = () => true, focusRowMatchesExecution = () => true;
    const projectFor = key => ({key, name:key, root:'/'+key});
    const worktreeRootFor = row => row.worktreeRoot, basename = path => path.split('/').pop();
    const focusWorktreeFilterKey = worktreeKey, environmentLabel = env => env === 'local' ? '本机' : env;
    const briefList = { scrollTop: 100 };
    function resetFocusBriefSnapshot() {}
    function renderFocusBriefs() {}
    ${["focusRowMatchesEnvironment", "briefNeedsReview", "focusBriefMatchingRows", "scopedFocusBriefs", "focusBriefFilterOptions", "reconcileFocusBriefFilters", "toggleFocusBriefFilter", "focusBriefScopeReadIds"].map(source).join("\n")}
    return { scopedFocusBriefs, focusBriefFilterOptions, reconcileFocusBriefFilters, toggleFocusBriefFilter, focusBriefScopeReadIds };
  `)(state, worktreeKey);
  return { state, a, feature, remote, b, ...api };
}

describe("brief dialog linked filters", () => {
  test("focus-hidden projects are absent from brief options and scope read actions", () => {
    const app = harness(); app.state.focusHiddenProjects.add("A");
    expect(app.focusBriefFilterOptions().projects.map((project: {key:string}) => project.key)).toEqual(["B"]);
    expect(app.focusBriefScopeReadIds("project", "A")).toEqual([]);
    expect(app.scopedFocusBriefs().map((item: {id:string}) => item.id)).toEqual(["3"]);
  });
  test("project read includes its worktrees but never unrelated projects or already-read items", () => {
    const app = harness();
    app.state.focusBriefs[1].readAt = 100;
    app.state.focusBriefWorktreeFilters = new Set([worktreeKey(app.a)]);
    expect(app.focusBriefScopeReadIds("project", "A")).toEqual(["0", "2"]);
    expect(app.focusBriefScopeReadIds("project", "B")).toEqual(["3"]);
  });
  test("worktree read is scoped by environment and project", () => {
    const app = harness();
    expect(app.focusBriefScopeReadIds("worktree", worktreeKey(app.a))).toEqual(["0"]);
    expect(app.focusBriefScopeReadIds("worktree", worktreeKey(app.remote))).toEqual(["2"]);
  });
  test("a group counts once, and non-reviewable child progress cannot be marked read", () => {
    const app = harness();
    const group = { id: "group", kind: "group", readAt: null, requiresReview: true,
      session: app.a, members: [{session:app.feature}, {session:app.b}] };
    app.state.focusBriefs = [group, {...group, id:"progress", requiresReview:false}];
    expect(app.focusBriefScopeReadIds("project", "A")).toEqual(["group"]);
    expect(app.focusBriefScopeReadIds("worktree", worktreeKey(app.b))).toEqual(["group"]);
    app.state.focusProjectFilters = new Set(["A"]);
    expect(app.focusBriefScopeReadIds("project", "B")).toEqual([]);
  });
  test("options only come from briefs and worktrees follow selected projects", () => {
    const app = harness();
    expect(app.focusBriefFilterOptions().projects.map((p: any) => p.key)).toEqual(["B", "A"]);
    app.toggleFocusBriefFilter("project", "A");
    expect(app.focusBriefFilterOptions().worktrees).toHaveLength(3);
    expect(app.scopedFocusBriefs()).toHaveLength(3);
    expect(app.state.focusProjectFilters.size).toBe(0);
  });
  test("switching project removes incompatible worktrees, preserving still-valid selections", () => {
    const app = harness();
    app.toggleFocusBriefFilter("project", "A"); app.toggleFocusBriefFilter("worktree", worktreeKey(app.a));
    app.toggleFocusBriefFilter("project", "B");
    expect(app.state.focusBriefWorktreeFilters.has(worktreeKey(app.a))).toBeTrue();
    app.toggleFocusBriefFilter("project", "A");
    expect(app.state.focusBriefWorktreeFilters.size).toBe(0);
    expect(app.scopedFocusBriefs().map((b: any) => b.session.projectKey)).toEqual(["B"]);
  });
  test("same-path local and remote worktrees stay distinct; clearing restores all", () => {
    const app = harness(); app.toggleFocusBriefFilter("worktree", worktreeKey(app.remote));
    expect(app.scopedFocusBriefs().map((b: any) => b.session.env)).toEqual(["n1"]);
    expect(app.scopedFocusBriefs(false)).toHaveLength(4);
    app.toggleFocusBriefFilter("worktree", ""); expect(app.scopedFocusBriefs()).toHaveLength(4);
  });
  test("group matching requires project and worktree on one member, and retains the entire group", () => {
    const app = harness();
    const group = { id: "group", kind: "group", session: app.a, members: [{session:app.b}] };
    app.state.focusBriefs = [group];
    app.state.focusBriefProjectFilters = new Set(["A"]);
    app.state.focusBriefWorktreeFilters = new Set([worktreeKey(app.b)]);
    expect(app.scopedFocusBriefs()).toEqual([]);
    app.state.focusBriefProjectFilters = new Set(["B"]);
    expect(app.scopedFocusBriefs()).toEqual([group]);
  });
  test("refresh reconciles removed options without changing outer page filters", () => {
    const app = harness(); app.toggleFocusBriefFilter("project", "A");
    app.toggleFocusBriefFilter("worktree", worktreeKey(app.a));
    app.state.focusBriefs = app.state.focusBriefs.filter((brief: { session: ReturnType<typeof row> }) => brief.session.projectKey === "B");
    app.reconcileFocusBriefFilters();
    expect(app.state.focusBriefProjectFilters.size).toBe(0); expect(app.state.focusBriefWorktreeFilters.size).toBe(0);
    expect(app.state.focusWorktreeFilters.size).toBe(0);
  });
});
