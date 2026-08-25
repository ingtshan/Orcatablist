# OrcaTab — agent conventions

本地 Web GUI：把 Claude Code 会话按项目聚合、按最近用户输入倒序、零 token 出摘要、一键定位到 Orca 的 tab，并支持中文全文搜索。设计文档见 `docs/PLAN.md`，工单见 `tasks/P*.md`（工单与 PLAN 冲突时以工单为准）。

## Stack
- Bun 1.3（`/opt/homebrew/bin/bun`）：`Bun.serve` + `bun:sqlite`（FTS5 trigram）。零运行时依赖；devDependencies 只允许 `typescript`、`@types/bun`。
- 前端：`public/index.html` 一个文件，原生 JS，不引入任何 CDN / 外部字体。
- 运行：`bun run src/server.ts`；测试：`bun test`；类型检查：`bun x tsc --noEmit`。
- 生产托管：pm2（`ecosystem.config.cjs`），由人/协调者执行 `pm2 start`，agent 不得运行 pm2。

## Hard rules
- `~/.claude` 一律只读。绝不创建、修改、删除其下任何文件。
- 不得执行任何改变用户桌面/终端状态的命令：`orca terminal switch|create|send|close|split|rename`、`orca worktree create|rm|set`、`open -a`、`lsregister`、`pm2 *`、`osacompile -o ~/Applications/*`。只读的 `orca … --json`（`status`、`repo list`、`worktree list|show`、`terminal list|show`、`skills get`、`--help`）允许。
- 只在本仓库目录内写文件；测试用 `mktemp -d` 目录做 fixture，不碰真实 `~/.claude`。
- 不 `git push`；不安装全局包；不改 `docs/`、`tasks/`（除工单指定的 REPORT 文件）。
- 所有子进程用 argv 数组 spawn，禁止拼接 shell 字符串；服务只监听 `127.0.0.1`。

## Code style
- 小模块（≤ 300 行），纯函数优先，早返回，无深层嵌套；不可变数据（返回新对象，不原地修改）。
- 无魔法数字：阈值/端口/超时用命名常量。
- 错误显式处理并带上下文；不吞异常。
- 命名：变量/函数 camelCase，类型 PascalCase，常量 UPPER_SNAKE_CASE。
- 提交信息：`<type>: <description>`，type ∈ feat/fix/refactor/docs/test/chore。
