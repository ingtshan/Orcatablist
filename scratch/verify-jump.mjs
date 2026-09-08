#!/opt/homebrew/bin/bun

import { createRequire } from "node:module";

const ENVIRONMENT = "feibo2";
const WORKTREE = "13e1f61a-b6c4-42b5-9ead-29e57c44c72b::/Users/mac/workspace/we-orca";
const DEFAULT_TAB_IDS = [
  "0bfbdfea-1c97-40ff-8ad0-d383c57c4152",
  "5ff92339-df14-419d-b2e8-f54876e9b38d",
];
const RUNTIME_CLIENT_PATH = "/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/runtime-client.js";
const RUNTIME_TIMEOUT_MS = 5_000;
const VERIFY_SETTLE_MS = 250;

const require = createRequire(import.meta.url);
const { RuntimeClient } = require(RUNTIME_CLIENT_PATH);

function tabMatchesTarget(tab, targetTabId) {
  return tab?.id === targetTabId || tab?.parentTabId === targetTabId;
}

async function main() {
  const client = new RuntimeClient(undefined, RUNTIME_TIMEOUT_MS, null, ENVIRONMENT);
  const selector = `id:${WORKTREE}`;
  const before = await client.call("session.tabs.list", { worktree: selector });
  const beforeTabs = before.result?.tabs ?? [];
  const previousActive = beforeTabs.find((tab) => tab.id === before.result?.activeTabId);
  const targetTabId = process.argv[2] ?? DEFAULT_TAB_IDS.find((candidate) => (
    beforeTabs.some((tab) => tabMatchesTarget(tab, candidate)) && !tabMatchesTarget(previousActive, candidate)
  )) ?? DEFAULT_TAB_IDS[0];
  const target = beforeTabs.find((tab) => tabMatchesTarget(tab, targetTabId));
  const activated = await client.call("session.tabs.activate", {
    worktree: selector, tabId: targetTabId, notifyClients: true,
    navigation: "clients", intent: "user",
  });
  await client.call("worktree.activate", {
    worktree: selector, notifyClients: true, navigation: "clients",
  });
  await new Promise((resolve) => setTimeout(resolve, VERIFY_SETTLE_MS));
  const after = await client.call("session.tabs.list", { worktree: selector });
  const active = after.result?.tabs?.find((tab) => tab.id === after.result?.activeTabId);
  const ok = after.ok === true && tabMatchesTarget(active, targetTabId);
  console.log(JSON.stringify({
    ok,
    environment: ENVIRONMENT,
    worktree: WORKTREE,
    targetTabId,
    targetTitle: target?.title ?? null,
    previousActiveTabId: before.result?.activeTabId ?? null,
    activatedActiveTabId: activated.result?.activeTabId ?? null,
    verifiedActiveTabId: after.result?.activeTabId ?? null,
    publicationEpoch: after.result?.publicationEpoch ?? null,
    navigation: "clients",
    visualExpectation: `Orca 打开 feibo2 / we-orca，并显示 ${target?.title ?? targetTabId}`,
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
