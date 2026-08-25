# REPORT-P1
文件：package.json — 16 行<br>bun.lock — 64 行<br>tsconfig.json — 12 行<br>ecosystem.config.cjs — 15 行
文件：src/config.ts — 23 行<br>src/types.ts — 22 行<br>src/parse.ts — 79 行<br>src/db.ts — 220 行<br>src/projects.ts — 107 行<br>src/live.ts — 81 行<br>src/indexer.ts — 160 行<br>src/focus.ts — 120 行<br>src/server.ts — 130 行
文件：public/index.html — 390 行
文件：test/fixtures/lines.ts — 14 行<br>test/parse.test.ts — 65 行<br>test/indexer.test.ts — 109 行<br>test/projects.test.ts — 103 行<br>test/live.test.ts — 52 行<br>test/focus.test.ts — 123 行<br>test/db.test.ts — 80 行<br>test/server.test.ts — 82 行<br>tasks/REPORT-P1.md — 14 行
决定：R3 冲突处以明确的“isMeta/tool_result/无 text/其余类型 → skip”为准；主 prompt/assistant 事件仍携带 cwd 元数据。
决定：只读核验 Orca 1.4.188 CLI handler/formatter，`orca terminal create --json` 实际 handle 字段为 `result.terminal.handle`；兼容回退 `result.handle`、`result.startupTerminal.handle`，未执行 create/switch/open。
决定：Git 提交不能包含自身 hash；先按指定消息做实现提交，再写入该 hash 并做仅报告提交。
验收 1：`bun x tsc --noEmit` exit 0（无输出）；frozen install 无变更。
验收 2：`bun test` 39 pass / 0 fail；coverage lines：parse 100%、indexer 92.97%、projects 94.67%、live 100%、focus 85.06%、db 98.04%。
验收 3：PASS；indexed 88 / 1108 ms；projects 12；lumina groups 1 / sessions 71；live 59；empty title 0；课堂树 8 / highlight 1；focus 400；HTML title 1。
验收 4：dry-run `switched`，handle `term_ea8b32c1-b2d3-43d9-a8f1-a635963f685f`，tabId `a809d886-95ff-45d5-b727-56a1b8e7b983`。
验收 5：提交后核验 `git status --porcelain` 为空。
实现 commit：`f73b7031b803ab3f05ab5e406a2b6dd6c6e23dd2`
