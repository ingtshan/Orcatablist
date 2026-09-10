import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SessionRow } from "../src/types";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function sourceOf(name: string): string {
  const start = html.indexOf(`      function ${name}(`);
  if (start < 0) throw new Error(`Missing page function: ${name}`);
  return html.slice(start, html.indexOf("\n      }", start) + "\n      }".length);
}

const FUNCTIONS = [
  "sessionKey", "basename", "projectFor", "environmentOf", "environmentLabel",
  "liveWorktreePath", "liveWorktreeRootFor", "worktreeRootFor", "worktreePreferenceKey",
  "worktreeGroupKey", "worktreePreferenceFor", "focusWorktreeFilterKey",
  "focusRowMatchesProject", "focusRowMatchesWorktree", "focusSearchRowVisible",
  "focusHistoryActive", "allFocusRows", "allFocusHistoryRows", "focusHistoryRows",
  "focusLaneRows", "visibleFocusRows", "orchestrationGroups", "focusLaneEmptyText",
  "focusRowMatchesEnvironment", "focusScopeEntries", "focusPresentation", "focusExecutionValue", "focusRowMatchesExecution",
  "focusExecutionFacets", "renderFocus", "focusRunCluster",
];

interface Group { key: string; workers: Array<{ row: SessionRow }>; }
interface Lane { key: string; rows: SessionRow[]; groups: Map<string, Group>; }
interface ElementStub {
  tag: string; className: string; text: string; children: ElementStub[]; hidden: boolean;
  dataset: Record<string, string>; attributes: Record<string, string>;
  classList: { add(): void; toggle(): void };
  append(...children: ElementStub[]): void;
  replaceChildren(): void;
  setAttribute(key: string, value: string): void;
  addEventListener(): void;
}
function make(tag: string, className = "", text = ""): ElementStub {
  return {
    tag, className, text, children: [], hidden: false, dataset: {}, attributes: {},
    classList: { add() {}, toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener() {},
  };
}

function row(sid: string, status: string | null, worktreeRoot = "/repo/main"): SessionRow {
  return {
    agent: "codex", sid, projectKey: "project", cwd: worktreeRoot, worktreeRoot, branch: "main",
    title: null, firstPrompt: null, lastPrompt: null, displayTitle: sid, lastInputAt: 1,
    promptCount: 1, goals: [], live: status === null ? null
      : { status, updatedAt: 10, pid: null, waitingFor: null, name: null },
  };
}

const parent = row("parent", "done");
const child = row("child", "working", "/repo/child");
const run = { runId: "run-test", objective: "fixture", coordinator: parent, workers: [{ ...child, taskTitle: "child task" }] };

function harness(options: { query?: string; worktree?: string; parent?: SessionRow } = {}) {
  const coordinator = options.parent ?? parent;
  const state = {
    query: options.query ?? "", projects: [{ key: "project", root: "/repo", name: "project" }],
    focusProjectFilters: new Set<string>(),
    focusLocalOnly: false, focusEnvironmentFilters: new Set<string>(), focusHiddenProjects: new Set<string>(),
    focusExecutionFilters: { agent: new Set<string>(), model: new Set<string>(), reasoningEffort: new Set<string>() },
    focusWorktreeFilters: new Set(options.worktree
      ? [JSON.stringify(["local", "project", options.worktree])] : []),
    worktreePreferences: new Map(), expandedRuns: new Set(), focusCollapsedRuns: new Set(),
    orchestrationRuns: [{ ...run, coordinator }], orchestrationSessions: [coordinator, child],
    focusSearchMatches: new Map(options.query ? [["codex/child", { ...child, hits: [{ snippet: "child-only needle" }] }]] : []),
    focusFilterHistoryRows: [],
    focusBoard: { lanes: [
      { key: "working", rows: [child] },
      { key: "non-working-today", rows: coordinator.live ? [coordinator] : [] },
      { key: "non-working-recent", rows: [] },
    ] },
  };
  const lanes: Lane[] = [];
  const api = new Function("state", "make", "lanes", `
    const UNINDEXED_LIVE_PROJECT_KEY = "__unindexed_live__";
    const LOCAL_ENVIRONMENT = "local";
    const FOCUS_LANES = ["working", "non-working-today", "non-working-recent"].map(key => ({ key }));
    const FOCUS_HISTORY_LANE = { key: "history" };
    const FOCUS_EXECUTION_FIELDS = ["agent", "model", "reasoningEffort"].map(key => ({ key }));
    const focusBoard = make("div");
    const activeSendFocus = () => null, restoreSendFocus = () => {}, renderFocusMonitor = () => {};
    const renderFocusExecutionFilters = () => {}, renderFocusBriefs = () => {}, renderFocusEnvironmentControls = () => {}, renderFocusHiddenProjects = () => {};
    const setRunExpanded = () => {};
    const focusSessionCard = row => make("article", "session", row.sid);
    const renderFocusGroups = (_parent, key, rows, runs) => lanes.push({ key, rows, groups: runs.groups });
    ${FUNCTIONS.map(sourceOf).join("\n")}
    return { renderFocus, focusRunCluster, focusExecutionFacets };
  `)(state, make, lanes) as {
    renderFocus(): void; focusRunCluster(group: Group, row: SessionRow): ElementStub;
    focusExecutionFacets(rows: SessionRow[], filters: Record<string, Set<string>>, reconcileFrom?: number): {
      options: Record<string, string[]>; selected: Record<string, Set<string>>;
    };
  };
  return { state, lanes, ...api };
}

describe("focus orchestration presentation", () => {
  test("hiding a project excludes its cards from every focus lane without archiving it", () => {
    const page = harness(); page.state.focusHiddenProjects.add("project");
    page.renderFocus();
    expect(page.lanes.flatMap((lane) => lane.rows)).toEqual([]);
    expect(page.state.projects[0]).not.toHaveProperty("archived");
    page.lanes.length = 0; page.state.focusHiddenProjects.clear(); page.renderFocus();
    expect(page.lanes.flatMap((lane) => lane.rows)).not.toHaveLength(0);
  });
  test("a hidden coordinator cannot leak back through a matching child search result", () => {
    const page = harness({ query: "needle", parent: { ...parent, projectKey: "hidden-parent" } });
    page.state.focusHiddenProjects.add("hidden-parent"); page.renderFocus();
    expect(page.lanes.flatMap((lane) => lane.rows).map((row) => row.sid)).toEqual(["child"]);
    expect(page.lanes.some((lane) => lane.groups.size)).toBeFalse();
  });

  test("local-only removes a remote coordinator but retains its local worker as a card", () => {
    const page = harness({ parent: { ...parent, env: "n1" } });
    page.state.focusLocalOnly = true;
    page.renderFocus();
    expect(page.lanes.flatMap((lane) => lane.rows).map((row) => row.sid)).toEqual(["child"]);
    page.lanes.length = 0;
    page.state.focusLocalOnly = false;
    page.state.focusEnvironmentFilters = new Set(["n1"]);
    page.renderFocus();
    expect(page.lanes.flatMap((lane) => lane.rows).map((row) => row.sid)).toEqual(["parent"]);
    expect(page.lanes.some((lane) => lane.groups.size > 0)).toBeFalse();
  });

  test("environment and search must match the same visible member", () => {
    const page = harness({ query: "needle", parent: { ...parent, env: "n1" } });
    page.state.focusEnvironmentFilters = new Set(["n1"]);
    page.renderFocus();
    expect(page.lanes.flatMap((lane) => lane.rows)).toEqual([]);
    page.lanes.length = 0;
    page.state.focusLocalOnly = true;
    page.renderFocus();
    expect(page.lanes.flatMap((lane) => lane.rows).map((row) => row.sid)).toEqual(["child"]);
  });

  test("a running child keeps the completed parent and the whole group in the working lane", () => {
    const page = harness();
    page.renderFocus();
    const working = page.lanes.find((lane) => lane.key === "working");
    expect(working?.rows.map((row) => row.sid)).toEqual(["parent"]);
    expect(working?.groups.get("codex/parent")?.workers.map(({ row }) => row.sid)).toEqual(["child"]);
    expect(page.lanes.some((lane) => lane.key !== "working" && lane.rows.some((row) => row.sid === "parent"))).toBeFalse();
    expect(parent.live?.status).toBe("done");
  });

  test("a child-only content match stays discoverable while filtering the parent's worktree", () => {
    const page = harness({ query: "needle", worktree: "/repo/main" });
    page.renderFocus();
    const working = page.lanes.find((lane) => lane.key === "working");
    expect(working?.rows.map((row) => row.sid)).toEqual(["parent"]);
    const group = working?.groups.get("codex/parent");
    expect(group?.workers.map(({ row }) => row.sid)).toEqual(["child"]);
    if (!group) throw new Error("matching child's group was lost");
    const cluster = page.focusRunCluster(group, parent);
    expect(cluster.children.find((element) => element.className === "focus-run-worker-list")?.hidden).toBeFalse();
  });

  test("an offline parent is restored as context for its working child", () => {
    const offlineParent = row("parent", null);
    const page = harness({ parent: offlineParent });
    page.renderFocus();
    const working = page.lanes.find((lane) => lane.key === "working");
    expect(working?.rows.map((row) => row.sid)).toEqual(["parent"]);
    expect(working?.rows[0]?.live).toBeNull();
    const group = working?.groups.get("codex/parent");
    if (!group) throw new Error("offline parent's group was lost");
    expect(page.focusRunCluster(group, offlineParent).children[1]?.hidden).toBeFalse();
  });

  test("a wholly completed group leaves working and appears once in today's lane", () => {
    const page = harness();
    const finished = row("child", "done", "/repo/child");
    page.state.orchestrationSessions = [parent, finished];
    page.state.focusBoard.lanes[0]!.rows = [];
    page.state.focusBoard.lanes[1]!.rows = [parent, finished];
    page.renderFocus();
    expect(page.lanes.map((lane) => [lane.key, lane.rows.map((row) => row.sid)]))
      .toEqual([["non-working-today", ["parent"]]]);
  });

  test("historical child-only hits retain the offline parent and matching snippet", () => {
    const page = harness({ query: "needle", parent: row("parent", null) });
    page.state.focusBoard.lanes.forEach((lane) => { lane.rows = []; });
    page.state.orchestrationSessions = [row("parent", null), row("child", null, "/repo/child")];
    page.renderFocus();
    const history = page.lanes.find((lane) => lane.key === "history");
    expect(history?.rows.map((row) => row.sid)).toEqual(["parent"]);
    expect(history?.groups.get("codex/parent")?.workers[0]?.row).toMatchObject({
      sid: "child", live: null, hits: [{ snippet: "child-only needle" }],
    });
  });

  test("filtering the child's worktree retains the main session as context", () => {
    const page = harness({ query: "needle", worktree: "/repo/child" });
    page.renderFocus();
    expect(page.lanes[0]?.rows.map((row) => row.sid)).toEqual(["parent"]);
  });

  test("an unrelated scope or a nonmatching query does not reveal a group", () => {
    const unrelated = harness({ query: "needle", worktree: "/repo/unrelated" });
    unrelated.renderFocus();
    expect(unrelated.lanes).toEqual([]);
    const noMatch = harness({ query: "absent" });
    noMatch.state.focusSearchMatches.clear();
    noMatch.renderFocus();
    expect(noMatch.lanes).toEqual([]);
  });

  test("archived children cannot match or keep a group running", () => {
    const page = harness();
    page.state.worktreePreferences.set(JSON.stringify(["project", "/repo/child"]), { archived: true });
    page.renderFocus();
    expect(page.lanes.map((lane) => [lane.key, lane.rows.map((row) => row.sid)]))
      .toEqual([["non-working-today", ["parent"]]]);
    expect(page.lanes[0]?.groups.size).toBe(0);
  });

  test("a remote identity with the same sid is not absorbed into the local group", () => {
    const page = harness();
    page.state.focusBoard.lanes[0]!.rows.push({ ...child, env: "remote" });
    page.renderFocus();
    const working = page.lanes.find((lane) => lane.key === "working");
    expect(working?.rows.map((row) => row.env ? `${row.env}:${row.sid}` : row.sid)).toEqual(["parent", "remote:child"]);
    expect(working?.groups.get("codex/parent")?.workers).toHaveLength(1);
  });

  test("facets cascade by the same session and remove only invalid downstream selections", () => {
    const page = harness();
    const rows: SessionRow[] = [
      { ...parent, model: "model-a", reasoningEffort: "high" },
      { ...child, model: "model-b", reasoningEffort: "max" },
      { ...row("claude", "working"), agent: "claude", model: "model-c", reasoningEffort: "medium" },
    ];
    const filters = { agent: new Set(["codex"]), model: new Set(["model-a"]), reasoningEffort: new Set(["high"]) };
    const facets = page.focusExecutionFacets(rows, filters);
    expect(facets.options.agent).toEqual(["claude", "codex"]);
    expect(facets.options.model).toEqual(["model-a", "model-b"]);
    expect(facets.options.reasoningEffort).toEqual(["high"]);
    const changed = page.focusExecutionFacets(rows, { ...filters, agent: new Set(["claude"]) }, 1);
    expect([...changed.selected.model!]).toEqual([]);
    expect([...changed.selected.reasoningEffort!]).toEqual([]);
    expect(changed.options.model).toEqual(["model-c"]);
    const multiple = page.focusExecutionFacets(rows, { ...filters, model: new Set(["model-a", "model-b"]) }, 2);
    expect(multiple.options.reasoningEffort).toEqual(["high", "max"]);
    expect([...multiple.selected.reasoningEffort!]).toEqual(["high"]);
    expect([...filters.model]).toEqual(["model-a"]);
  });

  test("filters cannot combine the parent's model with a different child's effort", () => {
    const page = harness();
    page.state.focusBoard.lanes.forEach((lane) => {
      lane.rows = lane.rows.map((entry) => ({ ...entry,
        model: entry.sid === "parent" ? "model-a" : "model-b",
        reasoningEffort: entry.sid === "parent" ? "high" : "max",
      }));
    });
    page.state.focusExecutionFilters.model.add("model-a");
    page.state.focusExecutionFilters.reasoningEffort.add("max");
    page.renderFocus();
    expect(page.lanes).toEqual([]);
    page.state.focusExecutionFilters.model = new Set(["model-b"]);
    page.renderFocus();
    expect(page.lanes[0]?.rows.map((entry) => entry.sid)).toEqual(["parent"]);
    expect(page.lanes[0]?.groups.get("codex/parent")?.workers).toHaveLength(1);
  });

  test("search and execution filters must match the same member, with parent context retained", () => {
    const page = harness({ query: "needle", worktree: "/repo/main" });
    page.state.focusBoard.lanes[0]!.rows = [{ ...child, model: "child-model" }];
    page.state.focusBoard.lanes[1]!.rows = [{ ...parent, model: "parent-model" }];
    page.state.focusExecutionFilters.model.add("parent-model");
    page.renderFocus();
    expect(page.lanes).toEqual([]);
    page.state.focusExecutionFilters.model = new Set(["child-model"]);
    page.renderFocus();
    expect(page.lanes[0]?.rows.map((entry) => entry.sid)).toEqual(["parent"]);
  });

  test("missing metadata has an explicit filter value and selecting it excludes known values", () => {
    const page = harness();
    page.state.focusBoard.lanes[0]!.rows = [{ ...child, model: "known" }];
    page.state.focusExecutionFilters.model.add("");
    page.renderFocus();
    expect(page.lanes[0]?.rows.map((entry) => entry.sid)).toEqual(["parent"]);
    const facets = page.focusExecutionFacets([parent, { ...child, model: "known" }], page.state.focusExecutionFilters);
    expect(facets.options.model).toEqual(["known", ""]);
    expect(facets.options.reasoningEffort).toEqual([""]);
  });
});
