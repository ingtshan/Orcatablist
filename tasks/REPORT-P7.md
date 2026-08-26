文件：public/index.html — 795 行
文件：src/db.ts — 255 行
文件：src/focus.ts — 257 行
文件：src/goals.ts — 166 行
文件：src/server.ts — 284 行
文件：src/suggest.ts — 99 行
文件：src/types.ts — 35 行
文件：test/goals.test.ts — 148 行
文件：test/server.test.ts — 270 行
文件：test/suggest.test.ts — 85 行
文件：tasks/REPORT-P7.md — 14 行
决定：goals.db 与 index.db 使用独立连接且 goals schema 仅加法迁移；索引中已消失的 confirmed 连线仍耐久保留并计入汇总、详情仅省略缺失 session；建议确认/忽略后按 limit=8 重新补位。
验收 1–4：tsc exit 0；bun test 89 pass / 0 fail / 359 expect；coverage lines goals=100%、suggest=100%；47996 初始建议=8（前三项均含 agent）、确认后证据=1/已确认项排除且补位后建议=8、session.goals=1、sessionCount=1、health goals=1/version=p7；用例“index 重建后 goals 存活”PASS；最终 git status --porcelain=0 行。
实现 commit：e959a92287d26dd1420ddc393529480968e24e97
