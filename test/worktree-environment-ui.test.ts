import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { LiveInfo, SessionRow } from "../src/types";

/**
 * The page's own worktree identity rules, executed rather than pattern-matched: the function
 * bodies are lifted out of `public/index.html` by name and run against a stubbed DOM. Renaming one
 * of these functions is expected to update this test.
 *
 * The fixtures are the shape the user actually hit — a local `class-plan-practice-v01` and the
 * `feibo1` workspace of the same name and the same path.
 */
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function sourceOf(name: string): string {
  const declaration = html.indexOf(`function ${name}(`);
  if (declaration < 0) throw new Error(`public/index.html has no function ${name}`);
  // Keep an `async` prefix: dropping it turns the body's `await` into a syntax error.
  const start = html.startsWith("async ", declaration - "async ".length)
    ? declaration - "async ".length : declaration;
  const open = html.indexOf("{", html.indexOf(")", declaration));
  let depth = 0;
  for (let index = open; index < html.length; index += 1) {
    if (html[index] === "{") depth += 1;
    else if (html[index] === "}" && (depth -= 1) === 0) return html.slice(start, index + 1);
  }
  throw new Error(`function ${name} in public/index.html is unbalanced`);
}

function constantOf(name: string): string {
  const match = new RegExp(`^\\s*const ${name} = .*;$`, "m").exec(html);
  if (match === null) throw new Error(`public/index.html has no constant ${name}`);
  return match[0];
}

const FUNCTIONS = [
  "basename", "projectFor", "sessionKey", "environmentOf", "environmentLabel",
  "liveWorktreePath", "liveWorktreeRootFor", "worktreeRootFor", "worktreePreferenceKey",
  "worktreeGroupKey", "worktreePreferenceFor", "sessionDomId", "applyWorktreePreferences",
  "groupedWorktrees", "worktreeKind", "focusRowActivity",
  "legacyWorktreeCollapseKey", "isWorktreeCollapsed", "setWorktreeCollapsed",
  "focusProjectCollapseKey", "focusWorktreeCollapseKey", "legacyFocusWorktreeCollapseKey",
  "isFocusWorktreeCollapsed", "setFocusWorktreeCollapsed",
  "focusWorktreeFilterKey", "focusWorktreeFilterParts", "focusFilterHistoryProjectKeys",
  "focusWorktreeChoiceMatches", "focusSearchRowVisible", "worktreeResourceDrawer",
  "renderFocusGroups", "focusEnvQuery", "sessionUri", "focusSession", "focusWorktreeSession",
] as const;

const REMOTE_ENV = "feibo1";
const REMOTE_SID = "01a079d4-cce3-7a01-8f45-066d21c37940";
const LOCAL_SID = "44444444-4444-4444-4444-444444444444";
const WORKSPACE = "/Users/feibo/orca/workspaces/lumina/class-plan-practice-v01";
const WORKSPACE_KEY = `bd8d1516-ff77-4454-86e2-5a1ea570b169::${WORKSPACE}`;
const LOCAL_PROJECT = { key: "/Users/bb00/workspace/lumina", name: "lumina", root: "/Users/bb00/workspace/lumina", color: null, pinned: false, archived: false };
const REMOTE_PROJECT = { key: `${REMOTE_ENV}:${WORKSPACE}`, name: `class-plan-practice-v01 @${REMOTE_ENV}`, root: "", color: null, pinned: false, archived: false };

interface ElementStub {
  tag: string; className: string; text: string; id: string; hidden: boolean; title: string;
  children: ElementStub[]; dataset: Record<string, string>; attributes: Record<string, string>;
  classList: { add(name: string): void; toggle(name: string, on?: boolean): void };
  style: { setProperty(): void };
  append(...children: ElementStub[]): void;
  replaceChildren(): void;
  setAttribute(key: string, value: string): void;
  removeAttribute(): void;
  addEventListener(type: string, handler: () => void): void;
  fire(type: string): void;
}

function make(tag: string, className = "", text = ""): ElementStub {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    tag, className, text, id: "", hidden: false, title: "",
    children: [], dataset: {}, attributes: {},
    classList: { add() {}, toggle() {} },
    style: { setProperty() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute() {},
    addEventListener(type, handler) { (handlers[type] ||= []).push(handler); },
    fire(type) { (handlers[type] || []).forEach((handler) => handler()); },
  };
}

function descendants(element: ElementStub): ElementStub[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function tab(name: string, env?: string, worktree?: string): LiveInfo {
  return {
    pid: 1, status: "working", updatedAt: 10, waitingFor: null, name,
    ...(env === undefined ? {} : { env }),
    ...(worktree === undefined ? {} : { worktree }),
  };
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    agent: "codex", sid: LOCAL_SID, projectKey: LOCAL_PROJECT.key, cwd: null,
    worktreeRoot: WORKSPACE, branch: null, title: null, firstPrompt: null, lastPrompt: null,
    displayTitle: "session", lastInputAt: 10, promptCount: 1, live: null, goals: [], indexed: true,
    ...overrides,
  } as SessionRow;
}

const localRow = row();
const remoteRow = row({ sid: REMOTE_SID, env: REMOTE_ENV, projectKey: REMOTE_PROJECT.key });

interface PageState {
  projects: Array<Record<string, unknown>>;
  query: string;
  worktreePreferences: Map<string, unknown>;
  worktreeResources: Map<string, unknown[]>;
  collapsedWorktrees: Set<string>;
  focusCollapsedWorktrees: Set<string>;
  focusCollapsedProjects: Set<string>;
  focusWorktreeFilters: Set<string>;
  focusProjectFilters: Set<string>;
}

function page(overrides: Partial<PageState> = {}) {
  const state: PageState = {
    projects: [LOCAL_PROJECT, REMOTE_PROJECT],
    query: "",
    worktreePreferences: new Map(),
    worktreeResources: new Map(),
    collapsedWorktrees: new Set(),
    focusCollapsedWorktrees: new Set(),
    focusCollapsedProjects: new Set(),
    focusWorktreeFilters: new Set(),
    focusProjectFilters: new Set(),
    ...overrides,
  };
  const saved: Array<{ store: string; values: string[] }> = [];
  const requests: string[] = [];
  const api = new Function("state", "make", "saved", "floatingMenu", "requests", [
    constantOf("UNINDEXED_LIVE_PROJECT_KEY"),
    constantOf("LOCAL_ENVIRONMENT"),
    constantOf("FOCUS_COLLAPSED_WORKTREES_STORAGE_KEY"),
    // Rendering collaborators the identity rules do not own.
    `const render = () => {}, renderFocus = () => {};`,
    `const saveCollapsedWorktrees = (values) => saved.push({ store: "sessions", values: [...values] });`,
    `const saveStoredStringSet = (_key, _label, values) => saved.push({ store: "focus", values: [...values] });`,
    `const setFocusProjectCollapsed = () => {};`,
    `const orderedFocusProjectKeys = (groups) => [...groups.keys()];`,
    `const focusSessionCard = (row) => make("article", "focus-session-card", row.sid);`,
    `const focusRunCluster = (_group, row) => make("article", "focus-run-cluster", row.sid);`,
    `const document = { createTextNode: (text) => make("text", "", text) };`,
    // Action collaborators: the request path is what these tests read, so nothing is dispatched.
    `const RESULT_RESET_MS = 0, setTimeout = () => {};`,
    `const api = async (path) => { requests.push(path); return { action: "switched" }; };`,
    `const showToast = () => {}, renderManual = () => {}, copyText = async () => {};`,
    ...FUNCTIONS.map(sourceOf),
    `return {
      applyWorktreePreferences, groupedWorktrees, worktreeGroupKey, worktreeRootFor,
      worktreePreferenceFor, worktreePreferenceKey, sessionDomId, environmentLabel,
      isWorktreeCollapsed, setWorktreeCollapsed, isFocusWorktreeCollapsed, setFocusWorktreeCollapsed,
      focusWorktreeCollapseKey, focusWorktreeFilterKey, focusFilterHistoryProjectKeys,
      focusWorktreeChoiceMatches, focusSearchRowVisible, worktreeResourceDrawer, renderFocusGroups,
      focusEnvQuery, sessionUri, focusSession, focusWorktreeSession,
    };`,
  ].join("\n\n"))(state, make, saved, () => ({ menu: make("details"), panel: make("div") }), requests);
  return { state, saved, requests, ...(api as Record<string, (...args: never[]) => unknown>) } as typeof api & {
    state: PageState; saved: typeof saved; requests: string[];
  };
}

describe("grouping a worktree by machine as well as by path", () => {
  test("one path under a local and a remote project is two groups, not one", () => {
    const view = page();
    const local = view.groupedWorktrees([localRow], LOCAL_PROJECT);
    const remote = view.groupedWorktrees([remoteRow], REMOTE_PROJECT);
    expect(local).toHaveLength(1);
    expect(remote).toHaveLength(1);
    expect(local[0]).toMatchObject({ root: WORKSPACE, env: "local", projectKey: LOCAL_PROJECT.key });
    expect(remote[0]).toMatchObject({ root: WORKSPACE, env: REMOTE_ENV, projectKey: REMOTE_PROJECT.key });
    expect(local[0].key).not.toBe(remote[0].key);
    expect(view.focusWorktreeFilterKey(localRow)).not.toBe(view.focusWorktreeFilterKey(remoteRow));
  });

  test("two unknown environments with no root at all still stay apart", () => {
    const unknown = { key: "__unindexed_live__", name: "未索引在线会话", root: "", color: null };
    const view = page();
    const groups = view.groupedWorktrees([
      row({ projectKey: unknown.key, worktreeRoot: null, live: tab("local shell") }),
      row({ projectKey: unknown.key, env: REMOTE_ENV, worktreeRoot: null, live: tab("remote shell", REMOTE_ENV) }),
      row({ projectKey: unknown.key, env: "feibo2", worktreeRoot: null, live: tab("other shell", "feibo2") }),
    ], unknown);
    expect(groups).toHaveLength(3);
    expect(groups.every((group: { root: string }) => group.root === "")).toBeTrue();
    expect(new Set(groups.map((group: { env: string }) => group.env)))
      .toEqual(new Set(["local", REMOTE_ENV, "feibo2"]));
  });

  test("a live tab supplies the root only for its own machine, and only when well formed", () => {
    const view = page();
    const unrooted = { worktreeRoot: null, cwd: null };
    expect(view.worktreeRootFor(
      row({ ...unrooted, env: REMOTE_ENV, live: tab("remote", REMOTE_ENV, WORKSPACE_KEY) }), REMOTE_PROJECT,
    )).toBe(WORKSPACE);
    expect(view.worktreeRootFor(
      row({ ...unrooted, live: tab("cross machine", REMOTE_ENV, WORKSPACE_KEY) }), LOCAL_PROJECT,
    )).toBe(LOCAL_PROJECT.root);
    for (const worktree of ["::" + WORKSPACE, "bd8d1516::relative/path", "bd8d1516", ""]) {
      expect(view.worktreeRootFor(row({ ...unrooted, live: tab("bad", undefined, worktree) }), LOCAL_PROJECT))
        .toBe(LOCAL_PROJECT.root);
    }
  });

  test("group ids stay distinct when a local and a remote session share agent and sid", () => {
    const view = page();
    const shared = row({ sid: REMOTE_SID });
    expect(view.sessionDomId("worktree-sessions", shared))
      .not.toBe(view.sessionDomId("worktree-sessions", remoteRow));
    expect(view.sessionDomId("worktree-sessions", remoteRow)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("preferences and visibility scoped per project", () => {
  test("archiving the local copy leaves the remote row visible and unarchived", () => {
    const view = page();
    view.applyWorktreePreferences([
      { projectKey: LOCAL_PROJECT.key, root: WORKSPACE, pinned: false, archived: true },
    ]);
    expect(view.worktreePreferenceFor(localRow, LOCAL_PROJECT)).toMatchObject({ archived: true });
    expect(view.worktreePreferenceFor(remoteRow, REMOTE_PROJECT)).toBeUndefined();
    expect(view.focusSearchRowVisible(localRow)).toBeFalse();
    expect(view.focusSearchRowVisible(remoteRow)).toBeTrue();
  });

  test("a pin on the remote copy does not pin the local group", () => {
    const view = page();
    view.applyWorktreePreferences([
      { projectKey: REMOTE_PROJECT.key, root: WORKSPACE, pinned: true, archived: false },
    ]);
    expect(view.groupedWorktrees([remoteRow], REMOTE_PROJECT)[0].pinned).toBeTrue();
    expect(view.groupedWorktrees([localRow], LOCAL_PROJECT)[0].pinned).toBeFalse();
  });

  test("the history fetch still recovers the project key from a filter selection", () => {
    const view = page();
    view.state.focusWorktreeFilters = new Set([
      view.focusWorktreeFilterKey(localRow), view.focusWorktreeFilterKey(remoteRow),
    ]);
    expect(view.focusFilterHistoryProjectKeys()).toEqual([LOCAL_PROJECT.key, REMOTE_PROJECT.key].sort());
  });

  test("the picker's search box matches on environment as well as name and path", () => {
    const view = page();
    const choice = { name: "class-plan-practice-v01", root: WORKSPACE, projectName: REMOTE_PROJECT.name, env: REMOTE_ENV, envLabel: REMOTE_ENV };
    expect(view.focusWorktreeChoiceMatches(choice, "feibo1")).toBeTrue();
    expect(view.focusWorktreeChoiceMatches(choice, "feibo3")).toBeFalse();
    expect(view.focusWorktreeChoiceMatches({ ...choice, env: "local", envLabel: "本机" }, "本机")).toBeTrue();
  });
});

describe("collapse state per machine", () => {
  test("a legacy local collapse is honoured locally and never applied to the remote group", () => {
    const view = page({ collapsedWorktrees: new Set([WORKSPACE]) });
    const [local] = view.groupedWorktrees([localRow], LOCAL_PROJECT);
    const [remote] = view.groupedWorktrees([remoteRow], REMOTE_PROJECT);
    expect(view.isWorktreeCollapsed(local)).toBeTrue();
    expect(view.isWorktreeCollapsed(remote)).toBeFalse();

    // Expanding clears the legacy key too, so the group does not spring back on the next render.
    view.setWorktreeCollapsed(local, false);
    expect(view.state.collapsedWorktrees.has(WORKSPACE)).toBeFalse();
    expect(view.isWorktreeCollapsed(local)).toBeFalse();
    expect(view.saved.at(-1)).toEqual({ store: "sessions", values: [] });
  });

  test("collapsing the remote group leaves the local group open", () => {
    const view = page();
    const [local] = view.groupedWorktrees([localRow], LOCAL_PROJECT);
    const [remote] = view.groupedWorktrees([remoteRow], REMOTE_PROJECT);
    view.setWorktreeCollapsed(remote, true);
    expect(view.isWorktreeCollapsed(remote)).toBeTrue();
    expect(view.isWorktreeCollapsed(local)).toBeFalse();
  });

  test("Focus honours a legacy lane key locally only, and collapses each machine on its own", () => {
    const legacy = JSON.stringify(["working", LOCAL_PROJECT.key, WORKSPACE]);
    const view = page({ focusCollapsedWorktrees: new Set([legacy]) });
    const [local] = view.groupedWorktrees([localRow], LOCAL_PROJECT);
    const [remote] = view.groupedWorktrees([remoteRow], REMOTE_PROJECT);
    expect(view.isFocusWorktreeCollapsed("working", local)).toBeTrue();
    expect(view.isFocusWorktreeCollapsed("working", remote)).toBeFalse();
    expect(view.isFocusWorktreeCollapsed("non-working-today", local)).toBeFalse();

    view.setFocusWorktreeCollapsed("working", remote, true);
    expect(view.isFocusWorktreeCollapsed("working", remote)).toBeTrue();
    view.setFocusWorktreeCollapsed("working", local, false);
    expect(view.state.focusCollapsedWorktrees.has(legacy)).toBeFalse();
    expect(view.isFocusWorktreeCollapsed("working", local)).toBeFalse();
    expect(view.isFocusWorktreeCollapsed("working", remote)).toBeTrue();
  });
});

describe("what the page draws for each environment", () => {
  function focusHead(view: ReturnType<typeof page>, rows: SessionRow[]): ElementStub {
    const parent = make("div");
    view.renderFocusGroups(parent, "working", rows, { groups: new Map() });
    const head = descendants(parent).find((element) => element.className === "focus-worktree-head");
    if (!head) throw new Error("no worktree header was drawn");
    return head;
  }

  test("the Focus worktree header names the machine it belongs to", () => {
    const view = page();
    const localHead = focusHead(view, [localRow]);
    const remoteHead = focusHead(view, [remoteRow]);
    const envOf = (head: ElementStub) => head.children.find((child) => child.className.startsWith("focus-worktree-env"));
    expect(envOf(localHead)).toMatchObject({ text: "本机", className: "focus-worktree-env" });
    expect(envOf(remoteHead)).toMatchObject({ text: REMOTE_ENV, className: "focus-worktree-env remote" });
    expect(remoteHead.title).toContain(REMOTE_ENV);
    expect(localHead.title).toContain("本机");
  });

  test("a remote group gets no local resource drawer for the same path", () => {
    const view = page({
      worktreeResources: new Map([[WORKSPACE, [{ appName: "vite", port: 5173, links: [] }]]]),
    });
    const [local] = view.groupedWorktrees([localRow], LOCAL_PROJECT);
    const [remote] = view.groupedWorktrees([remoteRow], REMOTE_PROJECT);
    expect(view.worktreeResourceDrawer(local, "class-plan-practice-v01")).not.toBeNull();
    expect(view.worktreeResourceDrawer(remote, "class-plan-practice-v01")).toBeNull();
  });

  test("the two machines' rows are drawn under separate headers with separate list ids", () => {
    const view = page();
    const parent = make("div");
    view.renderFocusGroups(parent, "working", [localRow, remoteRow], { groups: new Map() });
    const heads = descendants(parent).filter((element) => element.className === "focus-worktree-head");
    const lists = descendants(parent).filter((element) => element.className === "focus-session-list");
    expect(heads).toHaveLength(2);
    expect(new Set(lists.map((list) => list.id)).size).toBe(2);
    const groups = descendants(parent).filter((element) => element.className === "focus-worktree-group");
    expect(groups.map((group) => group.dataset.worktreeEnv).sort()).toEqual([REMOTE_ENV, "local"].sort());
  });
});

describe("identities that survive being turned into ids and requests", () => {
  test("environments that differ only in punctuation get different DOM ids", () => {
    const view = page();
    const ids = ["feibo.1", "feibo-1", "feibo_1", "feibo.1.a", "feibo-1-a"].map((env) =>
      view.sessionDomId("worktree-sessions", row({ sid: REMOTE_SID, env })));
    expect(new Set(ids).size).toBe(ids.length);
    // A remote identity never borrows the id of the local one with the same agent and sid.
    expect(view.sessionDomId("worktree-sessions", remoteRow))
      .not.toBe(view.sessionDomId("worktree-sessions", row({ sid: REMOTE_SID })));
    expect(new Set([
      view.sessionDomId("worktree-sessions", row({ sid: "a_b" })),
      view.sessionDomId("worktree-sessions", row({ sid: "a-b" })),
      view.sessionDomId("worktree-sessions", row({ sid: "a", env: "b" })),
    ]).size).toBe(3);
    // Distinct lane prefixes stay distinct too, and every id is selector-safe.
    expect(view.sessionDomId("focus-worktree-sessions-working", remoteRow))
      .not.toBe(view.sessionDomId("focus-worktree-sessions-non-working-today", remoteRow));
    expect(view.sessionDomId("worktree-sessions", remoteRow)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("the copy link carries the environment, so two machines' links differ", () => {
    const view = page();
    expect(view.sessionUri(localRow)).toBe(`orcatab://codex/${LOCAL_SID}`);
    expect(view.sessionUri(row({ sid: LOCAL_SID, env: REMOTE_ENV })))
      .toBe(`orcatab://${REMOTE_ENV}:codex/${LOCAL_SID}`);
  });

  test("both jump buttons state their environment for one agent and sid on two machines", async () => {
    const view = page();
    const button = make("button");
    // Same agent, same sid, two machines: only the query string tells the server them apart.
    const here = row({ sid: REMOTE_SID });
    const there = row({ sid: REMOTE_SID, env: REMOTE_ENV, projectKey: REMOTE_PROJECT.key });
    await view.focusSession(here, button, make("div"));
    await view.focusSession(there, button, make("div"));
    await view.focusWorktreeSession(here, "class-plan-practice-v01", button);
    await view.focusWorktreeSession(there, "class-plan-practice-v01", button);
    expect(view.requests).toEqual([
      `/api/focus/codex/${REMOTE_SID}?env=local`,
      `/api/focus/codex/${REMOTE_SID}?env=${REMOTE_ENV}`,
      `/api/focus/codex/${REMOTE_SID}?env=local`,
      `/api/focus/codex/${REMOTE_SID}?env=${REMOTE_ENV}`,
    ]);
    expect(new Set(view.requests).size).toBe(2);
  });

  test("a local unknown whose sid is indexed only remotely is still asked for locally", async () => {
    // The opposite direction of the same bug: without `?env=local` the server's legacy
    // auto-detection would send this click to the machine that has the sid indexed.
    const view = page();
    const unknownLocal = row({
      sid: REMOTE_SID, projectKey: "__unindexed_live__", worktreeRoot: null,
      indexed: false, live: tab("local shell"),
    });
    await view.focusSession(unknownLocal, make("button"), make("div"));
    await view.focusWorktreeSession(unknownLocal, "在线进程", make("button"));
    expect(view.requests).toEqual([
      `/api/focus/codex/${REMOTE_SID}?env=local`, `/api/focus/codex/${REMOTE_SID}?env=local`,
    ]);
    expect(view.requests.every((request: string) => !request.includes(REMOTE_ENV))).toBeTrue();
  });
});
