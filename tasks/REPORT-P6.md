# REPORT-P6
文件：src/config.ts — 28 行<br>src/db.ts — 254 行<br>src/indexer.ts — 257 行
文件：src/sources/hermes.ts — 183 行<br>src/focus.ts — 257 行<br>src/server.ts — 169 行
文件：public/index.html — 448 行<br>test/db.test.ts — 156 行<br>test/focus.test.ts — 282 行
文件：test/indexer.test.ts — 293 行<br>test/server.test.ts — 175 行<br>test/hermes-source.test.ts — 105 行
文件：tasks/REPORT-P6.md — 11 行
决定：Hermes 连接惰性且仅 readonly；测试/服务显式注入临时 DB；title 源仅 trim、展示统一截 80 字；worktree 样本 20260811_031044_76b3bb，cwd=/Users/bb00/workspace/hermes；manual 样本 20260613_235924_414299，cwd=/Users/bb00。
验收 1：tsc exit 0；bun test 77 pass / 0 fail / 273 expect；coverage lines：db 98.32%、focus 84.06%、indexer 92.35%、server 95.35%、claude 100%、codex 97.26%、hermes 91.53%。
验收 2：冷启 9.776 s，859 会话=Claude 89+Codex 626+Hermes 144；agents 三项、version p6；Hermes 注入污染 0、空 displayTitle 0；搜索 context7 命中 Hermes 13。
验收 3：Hermes worktree → resumed(dry-run)，plan 含 hermes --resume；非 worktree → manual 且命令正确；Claude 02998b64-f0d0-48a9-9bf1-8c90e265de7a → switched；Codex 01a03bdb-4e55-79e1-9f72-906c5ee671f6 → resumed(dry-run)。
验收 4：git diff --check PASS；最终 git status --porcelain 0 行；未运行 pm2/push/非 dry-run 定位；实现 commit cb5843ca522be9894cff41237d34df65ea1636c0。
