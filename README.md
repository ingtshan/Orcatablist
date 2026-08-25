# OrcaTab

Claude Code 会话面板：按项目聚合、最近输入倒序、零 token 摘要、`orcatab://claude/<sid>` 一键回到 Orca 的 tab、中文全文搜索。

- 设计：`docs/PLAN.md`
- 运行：`bun run src/server.ts` → http://127.0.0.1:47831
- 测试：`bun test`
- 托管：`pm2 start ecosystem.config.cjs && pm2 save`
