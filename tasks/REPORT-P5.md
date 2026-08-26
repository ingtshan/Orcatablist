# REPORT-P5
文件：src/config.ts — 27 行<br>src/types.ts — 25 行<br>src/db.ts — 254 行
文件：src/indexer.ts — 234 行<br>src/focus.ts — 225 行<br>src/server.ts — 168 行
文件：src/sources/claude.ts — 39 行<br>src/sources/codex.ts — 180 行<br>public/index.html — 444 行
文件：test/db.test.ts — 147 行<br>test/focus.test.ts — 223 行<br>test/indexer.test.ts — 237 行<br>test/projects.test.ts — 156 行
文件：test/server.test.ts — 146 行<br>test/codex-source.test.ts — 112 行<br>test/fixtures/codex.ts — 9 行<br>tasks/REPORT-P5.md — 12 行
决定：source 保持轻量函数描述；真实 Codex 源出现同 session_meta sid 多 rollout，按路径确定性保留最新一份，避免复合键反复重建；同进程无变化增量实测 19 ms。
决定：Codex worktree dry-run 选 01a03bdb-4e55-79e1-9f72-906c5ee671f6，cwd=/Users/bb00/workspace/orcatab；manual 选 01a038ac-e470-76e1-9c39-8abaa62c1042，cwd=/Users/bb00/workspace/plan-review-skill。
验收 1：tsc exit 0；bun test 69 pass / 0 fail / 232 expect；coverage lines：db 98.32%、focus 82.02%、indexer 91.53%、server 95.31%、claude 100%、codex 97.26%。
验收 2：冷启 ready 8.079 s、索引 7.743 s；714 会话=Codex 625+Claude 89（工单冻结 88，当前只读源自然漂移）；默认列表 Codex 411/Claude 89；注入污染 0、非空 Codex 标题 411、搜索 orcatab 命中 Codex 3、scheme grep 1。
验收 3：Claude → switched(term_ea8b32c1-b2d3-43d9-a8f1-a635963f685f)；Codex worktree → resumed(dry-run)，plan 含 codex resume；非 worktree → manual，命令含 codex resume。
验收 4：git diff --check PASS；最终 git status --porcelain 无输出；未运行 pm2/push/非 dry-run 定位；实现 commit 90fdac15b487bee9335ebd6695c0627b10398c6e。
