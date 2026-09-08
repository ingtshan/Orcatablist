import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
function sourceOf(name: string): string {
  const start = html.indexOf(`      function ${name}(`);
  if (start < 0) throw new Error(`missing page function ${name}`);
  return html.slice(start, html.indexOf("\n      }", start) + "\n      }".length);
}

test("Monitor highlights only its exact environment, including local aliases", () => {
  const cards = ["local", "feibo1", "feibo2"].flatMap((env) => ["focus", "sessions"].map((view) => {
    const card = {
      env, view, marked: false,
      dataset: { sessionKey: env === "local" ? "codex/same" : `${env}:codex/same` },
      classList: { toggle: (_name: string, value: boolean) => { card.marked = value; } },
    };
    return card;
  }));
  const page = new Function("document", [
    'const LOCAL_ENVIRONMENT = "local";',
    ...["environmentOf", "sessionKey", "markFocusMonitorSource"].map(sourceOf),
    "return { sessionKey, markFocusMonitorSource };",
  ].join("\n"))({ querySelectorAll: () => cards });
  for (const env of ["feibo1", "feibo2", "local", "", undefined]) {
    const key = page.sessionKey({ env, agent: "codex", sid: "same" });
    page.markFocusMonitorSource(key);
    expect(cards.filter((card) => card.marked).map((card) => card.env))
      .toEqual([env || "local", env || "local"]);
  }
});
