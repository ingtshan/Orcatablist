import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function source(name: string) {
  const start = html.indexOf(`      function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return html.slice(start, html.indexOf("\n      }", start) + 8);
}
function harness(saved = "{}") {
  let storage = saved;
  const state = { focusLocalOnly: false, focusEnvironmentFilters: new Set<string>(),
    environments: [{name:"n1"}], orchestrationSessions: [{env:"n2",projectKey:"remote"}],
    focusFilterHistoryRows: [], focusSearchMatches: new Map(), sourceSessions: [], focusBriefs: [] as any[],
    query: "", focusProjectFilters: new Set(["remote"]), focusWorktreeFilters: new Set(),
    focusExecutionFilters: {}, focusExecutionScopeChanged: false };
  const runtime = new Function("state", "localStorage", `
    const LOCAL_ENVIRONMENT = 'local', FOCUS_ENVIRONMENT_STORAGE_KEY = 'test';
    const environmentOf = value => value || 'local';
    const allFocusRows = () => [{env: 'local', projectKey: 'local-project'}];
    const renderFocusEnvironmentControls = () => {}, renderFocusProjectFilter = () => {};
    const renderFocusWorktreeFilter = () => {}, resetFocusBriefSnapshot = () => {}, renderFocus = () => {};
    const focusRowMatchesProject = () => true, focusRowMatchesWorktree = () => true, focusRowMatchesExecution = () => true;
    const sessionKey = row => row.sid;
    ${["loadFocusEnvironmentPreferences", "focusRowMatchesEnvironment", "focusEnvironmentOptions", "applyFocusEnvironmentScope", "focusBriefMatchingRows"].map(source).join("\n")}
    return { loadFocusEnvironmentPreferences, focusRowMatchesEnvironment, focusEnvironmentOptions, applyFocusEnvironmentScope, focusBriefMatchingRows };
  `)(state, {getItem:()=>storage,setItem:(_key:string,value:string)=>{storage=value;}});
  return {state,...runtime,stored:()=>JSON.parse(storage)};
}
describe("focus environment scope", () => {
  test("local-only overrides a remembered multiselect without destroying it", () => {
    const app=harness(); app.state.focusEnvironmentFilters=new Set(["n1","n2"]);
    expect(app.focusRowMatchesEnvironment({env:"n1"})).toBeTrue();
    expect(app.focusRowMatchesEnvironment({})).toBeFalse();
    app.state.focusLocalOnly=true;
    expect(app.focusRowMatchesEnvironment({})).toBeTrue();
    expect(app.focusRowMatchesEnvironment({env:"local"})).toBeTrue();
    expect(app.focusRowMatchesEnvironment({env:"n1"})).toBeFalse();
    app.applyFocusEnvironmentScope();
    expect(app.stored()).toEqual({localOnly:true,environments:["n1","n2"]});
    expect(app.state.focusProjectFilters.size).toBe(0);
    app.state.focusLocalOnly=false; expect(app.focusRowMatchesEnvironment({env:"n2"})).toBeTrue();
  });
  test("preferences restore and empty selections include every environment", () => {
    const app=harness('{"localOnly":true,"environments":["n1",42,""]}');
    expect(app.loadFocusEnvironmentPreferences()).toEqual({focusLocalOnly:true,focusEnvironmentFilters:new Set(["n1"])});
    expect(app.focusRowMatchesEnvironment({env:"another"})).toBeTrue();
  });
  test("drawer choices include configured, observed and remembered environments", () => {
    const app=harness(); app.state.focusEnvironmentFilters.add("offline");
    expect(app.focusEnvironmentOptions()).toEqual(["local","n1","n2","offline"]);
  });
  test("group briefs belong to their coordinator's environment", () => {
    const app=harness(); app.state.focusLocalOnly=true;
    const group={kind:"group",session:{env:"n1",sid:"parent"},members:[{session:{env:"local",sid:"child"}}]};
    expect(app.focusBriefMatchingRows(group)).toEqual([]);
    app.state.focusLocalOnly=false; app.state.focusEnvironmentFilters=new Set(["n1"]);
    expect(app.focusBriefMatchingRows(group)).toEqual([group.session]);
  });
});
