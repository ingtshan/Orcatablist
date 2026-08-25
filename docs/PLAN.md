# OrcaTab 轻量方案（2026-08-25，数据来自本机实测）

## 一句话
一个 Bun 进程（`Bun.serve` + `bun:sqlite`），零依赖、无构建、一个 HTML 文件；只读 `~/.claude`，不调任何模型；只绑 `127.0.0.1:47831`；生产用 pm2 托管。

## 本机实测规模
- 88 个主会话 jsonl / 241 MB / 66,736 行；可索引文本（用户输入 + 助手 text 块）仅 1.6 MB
- Bun 全量扫描 0.39 s；`ai-title` 覆盖 75/88；在线会话 67，`~/.claude/sessions` 无陈旧文件

## 做 / 不做
做：按项目聚合（同一仓库所有 worktree 归一组，含 `~/orca/workspaces/*`）；按最近一次**用户输入**倒序；摘要用 Claude Code 自己写进 jsonl 的 `ai-title`（无则首条 prompt）；一键定位 Orca tab（离线则在 Orca 新开终端 `claude --resume`）；全文搜索（中文可用）；在线状态徽标。
不做：完整对话渲染；任何 LLM 调用；Codex 会话（预留 `orcatab://codex/<sid>`）；远程访问/账号；前端框架与构建链。

## 架构
```
projects/*/<sid>.jsonl ──增量读(offset)──▶ Indexer ──upsert──▶ SQLite(sessions/projects/msg_fts) ──▶ Bun.serve :47831 ──JSON──▶ 浏览器 UI（5s 轮询）
sessions/<pid>.json    ──每次请求读(缓存3s)────────────────────────────────────────────────▶ Bun.serve（live 状态合并）
OrcaTab.app(orcatab://)──GET /focus?uri=…──▶ Bun.serve(focus 解析器) ──ps -E + orca terminal switch──▶ Orca GUI
```
选定：Bun 1.3；索引按文件 `parsed_offset` 只读新增字节（jsonl append-only）；UI 轮询不做 SSE；端口 47831（`ORCATAB_PORT`）；数据 `~/.orcatab/index.db`；定位全走 Orca 公开 CLI。
放弃：Electron/Tauri；fork claude-code-viewer；读 `history.jsonl`；LLM 摘要。

## 数据与解析规则（已验证）
| 来源 | 取什么 | 规则 |
|---|---|---|
| `~/.claude/projects/*/<uuid>.jsonl` | 会话主体 | 只认文件名为 UUID 的文件；`agent-*.jsonl`、`journal.jsonl`、子目录（`<sid>/tool-results/`）跳过。项目路径取行内 `cwd`，不用目录 slug |
| `{"type":"ai-title","aiTitle":…}` | 标题 | 每轮重写，最后一条为准；没有则首条 prompt 前 80 字 |
| `{"type":"user"}` | 首条 prompt / 最近输入时间 / 计数 / 搜索文本 | 只取 `isMeta` 为假且 `message.content` 为非空字符串、或首块 `type=="text"` 的条目；纯 `tool_result` 的 user 行不算 |
| `{"type":"assistant"}` | 搜索文本 | 只取 `content[].type=="text"`；thinking/tool_use 不索引 |
| 首个带 `cwd` 的行 | cwd / gitBranch / version | 其余类型（attachment、file-history-snapshot、mode、permission-mode、atis-latch、last-prompt、system…）跳过 |
| `~/.claude/sessions/<pid>.json` | 在线状态 | `{sessionId,pid,cwd,status,waitingFor,name}`，status ∈ idle/busy/waiting/shell；`kill(pid,0)` 二次确认；不入库，请求时读、缓存 3 s |
| git / Orca | 项目键与显示名 | 键 = `git rev-parse --git-common-dir` 的仓库根；失败→`~/orca/workspaces/<repo>/` 启发式→cwd 兜底；名字/颜色取 `orca repo list` 中 path 匹配的 displayName/badgeColor；按 cwd 缓存 |

增量索引：每文件记 `(size, mtime, parsed_offset)`；size 变大从 offset 续读；末尾半行不消费；size 变小则删该会话 fts 行后从 0 重建。

## 数据模型
```sql
CREATE TABLE sessions (sid TEXT PRIMARY KEY, project_key TEXT NOT NULL, cwd TEXT, git_branch TEXT,
  title TEXT, first_prompt TEXT, last_input_at INTEGER, prompt_count INTEGER DEFAULT 0,
  file_path TEXT NOT NULL, file_size INTEGER, file_mtime INTEGER, parsed_offset INTEGER DEFAULT 0);
CREATE INDEX sessions_last ON sessions(last_input_at DESC);
CREATE TABLE projects (key TEXT PRIMARY KEY, name TEXT, root TEXT, color TEXT);
CREATE TABLE cwd_cache (cwd TEXT PRIMARY KEY, project_key TEXT NOT NULL);
CREATE VIRTUAL TABLE msg_fts USING fts5(text, sid UNINDEXED, role UNINDEXED, ts UNINDEXED, tokenize='trigram');
```
搜索：`MATCH` 短语（双引号包裹，内部引号翻倍）按 rank 排；≥3 字走 fts，1–2 字回退 LIKE；fts 每条 ≤ 8 KB。

## API
`GET /`、`GET /healthz`、`GET /api/projects`、`GET /api/sessions?project=&live=&limit=`、`GET /api/search?q=&limit=`、`POST /api/focus/:sid`、`GET /focus?uri=orcatab://claude/<sid>`。契约以 `src/types.ts` 冻结（见工单）。

## 定位链路
sid 校验 → `~/.claude/sessions/*.json` 找 pid 且 `kill(pid,0)` 存活 → `ps -Eww -o command= -p <pid>` 取 `ORCA_TERMINAL_HANDLE` → `open -a Orca` + `orca terminal switch --terminal <h> --json` → switched。
无 handle：进程活着但不在 Orca 终端 → manual（不可再 resume 一份）；进程不在且 `orca worktree show --worktree path:<cwd>` 成功 → `orca terminal create --worktree path:<cwd> --command "claude --resume <sid>" --json` 再 switch → resumed；否则 manual（`cd <cwd> && claude --resume <sid>`）。
本机已验证：sessionId → pid → handle → switch 全程可用；handle 跨 Orca 升级仍有效。

## orcatab:// 注册（P3）
`osacompile` 生成 `~/Applications/OrcaTab.app`，PlistBuddy 加 `CFBundleURLSchemes=[orcatab]`，`lsregister -f`；handler 先 curl 服务 `/focus?uri=`，服务未起则 `bun src/focus.ts <uri>` 回退。

## UI
一屏：顶部搜索（`/` 聚焦），左栏项目（按最近会话倒序，带计数），右侧按项目分组、组内按最近输入倒序；每行：状态点（busy 琥珀 / waiting 红 / idle 绿 / offline 灰）、标题、worktree 名（与项目根不同时）、分支、相对时间、轮数、按钮「定位」（离线为「恢复」）与「复制链接」。搜索结果同结构 + 最多 3 条 ‹高亮› 片段。暗色跟随系统。

## 阶段
- P1 核心：索引 + API + 页面 + 在线定位 + pm2 配置。验收：冷启动 < 2 s；lumina 的 4 个 worktree 归一组；搜「课堂树」命中；定位当前活跃会话切到 tab。
- P2 增量与离线：fs.watch 增量、ETag、离线 resume。
- P3 链接与常驻：OrcaTab.app + install.sh + 复制链接；pm2 save。

## 风险
老会话无 ai-title → 首条 prompt；worktree 已删 → 启发式/孤儿组；trigram ≥ 3 字；scheme 仅 macOS；jsonl 格式随版本变 → parse fixture 测试兜底。
