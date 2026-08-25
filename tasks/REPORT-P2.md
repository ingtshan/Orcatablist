# REPORT-P2
文件：src/config.ts — 25 行<br>src/db.ts — 245 行<br>src/focus.ts — 190 行<br>src/indexer.ts — 213 行<br>src/live.ts — 96 行<br>src/parse.ts — 86 行<br>src/projects.ts — 133 行<br>src/server.ts — 158 行
文件：public/index.html — 425 行
文件：test/db.test.ts — 125 行<br>test/focus.test.ts — 172 行<br>test/indexer.test.ts — 139 行<br>test/live.test.ts — 73 行<br>test/parse.test.ts — 79 行<br>test/projects.test.ts — 156 行<br>test/server.test.ts — 116 行<br>tasks/REPORT-P2.md — 12 行
决定：仅在实际索引、合并或元数据变化时递增 dataVersion；非回退候选须目录存在且 key!=root 或含 .git，以保护现存 cwd fallback；Git 不能在提交内自引 hash，沿用 P1 的实现提交后仅更新报告方案。
验收 1：frozen install 无变更；`bun x tsc --noEmit` exit 0；`bun test` 53 pass / 0 fail；coverage lines：parse 100%、indexer 91.62%、projects 95.88%、live 100%、focus 81.25%、db 98.27%；`git diff --check` 通过。
验收 2：fixture 47997 初始 promptCount 5 / lastInputAt 1787652184187；追加副本后 ≤400 ms 变为 6 / 1787653511305（要求 ≤1.5 s）。
验收 3：sessions ETag `"2-0"`；携带 If-None-Match 返回 `HTTP/1.1 304 Not Modified`；索引变化后为 `"3-0"`。
验收 4：真实只读数据 47996 indexed 88；lumina.sessionCount 71；三个误分组名均 0；mic-sync 3、rc-projects 1；health version p2 / dataVersion 4 / watch fs.watch。
验收 5：无库 CLI：6d329823…=`manual/not-orca-worktree` 且 command 含 `/Users/bb00/workspace`，3c952b07…=`resumed`；在线 02998b64… 连跑 5 次均 `switched`；stderr 均有 JSON plan，`database is locked` 0 次，未执行定位命令。
验收 6：两次提交后核验 `git status --porcelain` 为空；未 push、未触碰 pm2、真实 `~/.claude` 只读且未读写 `~/.orcatab`。
实现 commit：`PENDING`
