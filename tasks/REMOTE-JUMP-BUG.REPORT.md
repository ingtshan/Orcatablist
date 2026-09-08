# OrcaTab 远程跳转排查与修复报告

## 【根因（引用代码证据）】
- 证据来自 `/Applications/Orca.app/Contents/Resources/app.asar`（2026-09-01 已安装版本）。`out/main/index.js:48373-48383` 的默认值是 `if (args.clientKind) return "caller"`；旧调用未传 `navigation`，所以配对 RuntimeClient 的 `session.tabs.activate` 只是 caller 导航。
- `out/main/index.js:249527-249543` 的 caller 分支只做 `clientSessionTabSelections.activate(...)` 并以默认 `follow=false` 发快照；`:242990-243004` 又把 epoch 标为 `...:client-navigation`。因此 RPC 返回值和同一客户端重读的 `activeTabId` 会变，但这不等于 renderer 接受了跳转。
- `out/renderer/assets/web-session-tabs-sync-BjIoU1AF.js:3642-3644,3766-3784` 只在本地 `focusIntent` 或 `snapshot.navigationIntent === "follow"` 时采用快照活动 tab，否则 `nextActiveUnifiedTabId` 优先保留 `currentVisibleUnifiedTabId`；这正是 UI 不动的代码原因。
- 本地 `terminal switch` 是另一条通道：`out/main/index.js:126933-126939,261711-261825` 调 runtime notifier，`:221684-221688` 发 `ui:focusTerminal {tabId,worktreeId,leafId}`；preload `out/preload/index.js:6593-6596` 转发，renderer `App-fF6jySRm.js:35603-35618` 直接写 active worktree/tab。`:221443-221460` 说明它只投递给该 runtime 绑定且存活的 mainWindow/webContents；打远端 runtime 不会送到本机 renderer。

## 【GUI 通路（调用链）】
- Worktree Palette 回车：`WorktreeJumpPalette-D8uNLMm-.js:3332-3333` → `browser-palette-page-entries-DhbnYgR0.js:325-353` 的 `activateWorkspaceTabPaletteResult` → renderer 本地 `activateAndRevealWorktree`、`state.focusGroup/activateTab/setActiveTab`。
- 远端 tab 同时走 `web-runtime-session-Dm0zTjSC.js:1325-1365`：先 `recordWebSessionFocusIntent(...)`，再调 `session.tabs.activate {notifyClients:false,navigation:"caller",intent:"user"}`；外部进程无法调用前一个 renderer 内存函数。
- 外部可达等价入口是两个已注册 runtime 方法：`session.tabs.activate {navigation:"clients",notifyClients:true,intent:"user"}` 让 `out/main/index.js:264131-264137` 发 `navigationIntent:"follow"`，随后 `worktree.activate {navigation:"clients"}` 让 `:248317-248347` 发 `activateWorktree` client event；实测最小调用已落入验证脚本。

## 【修复（文件级一行一条+判断记录）】
- `src/orca-tabs.ts`：显式走 clients 导航；先发布 tab follow，再 reveal worktree，规避两个订阅异步交付时 worktree refresh 用旧 tab 覆盖新选择的竞态。
- `src/focus.ts`：保留 live remote 分支；缺 worktree 仍回退 `terminal switch --environment`，离线 remote 的 `manual`/ssh 语义未变。
- `public/index.html`：删除“只选中远端状态/请手动打开”的旧提示，改为准确的“已通知 Orca 打开目标 tab”。
- `test/orca-tabs.test.ts`、`test/remote-m2.test.ts`：覆盖 RPC 顺序、clients/follow 载荷、失败短路和原有 focus 回退。
- `scratch/verify-jump.mjs`：固定只写许可的 feibo2/we-orca；默认在两个已知 tab 间选一个不同目标，并检查激活后状态。

## 【验证（master 命令 + 用户目视步骤）】
- 全量：`/opt/homebrew/bin/bun x tsc --noEmit && /opt/homebrew/bin/bun test`。
- 状态级一条命令：`/opt/homebrew/bin/bun scratch/verify-jump.mjs`；预期 JSON 为 `ok:true`，且 `verifiedActiveTabId` 属于输出的 `targetTabId`。
- 目视：在本机 Orca 任意页面停留 → 运行上一命令 → 读取输出的 `targetTitle/targetTabId`；预期本机 Orca 自动打开 feibo2 的 we-orca 工作区并显示该 tab，无需 ⌘J、点击或重开工作区。
