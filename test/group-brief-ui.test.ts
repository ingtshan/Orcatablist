import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const source = (name: string) => {
  const start = html.indexOf(`      function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  return html.slice(start, html.indexOf("\n      }", start) + 8);
};
test("only actionable group notifications enter review; child filtering retains coordinator context", () => {
  const group = { id: "g", kind: "group", readAt: null, requiresReview: false, input: "target input", response: "",
    session: { sid: "parent", projectKey: "parent-project", displayTitle: "Coordinator" },
    members: [{ session: { sid: "child", projectKey: "child-project", displayTitle: "Child" } }] };
  const state = { focusBriefTab: "unread", query: "", focusBriefs: [group], focusSearchMatches: new Map() };
  const api = new Function("state", `
    const focusRowMatchesProject = row => row.projectKey === 'child-project';
    const focusRowMatchesWorktree = () => true, focusRowMatchesExecution = () => true;
    const sessionKey = row => row.sid;
    ${["focusRowMatchesEnvironment", "briefNeedsReview", "briefMatchesTab", "focusBriefMatchingRows", "scopedFocusBriefs"].map(source).join("\n")}
    return { briefNeedsReview, briefMatchesTab, scopedFocusBriefs };
  `)(state);
  expect(api.scopedFocusBriefs()).toEqual([group]);
  expect(api.briefNeedsReview(group)).toBeFalse(); expect(api.briefMatchesTab(group)).toBeFalse();
  state.focusBriefTab = "groups"; expect(api.briefMatchesTab(group)).toBeTrue();
  group.requiresReview = true; state.focusBriefTab = "unread"; expect(api.briefNeedsReview(group)).toBeTrue();
  expect(api.briefMatchesTab(group)).toBeTrue();
});
