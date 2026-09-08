# OrcaTab

Claude Code 会话面板：按项目聚合、最近输入倒序、零 token 摘要、`orcatab://claude/<sid>` 一键回到 Orca 的 tab、中文全文搜索。

![OrcaTab Web GUI 脱敏演示：项目聚合、会话状态、多 Agent 标签与快捷操作](assets/orcatab-webgui.png)

> 截图使用纯虚构演示数据，不包含真实会话、用户身份或本机路径。

## 本地运行

需要 macOS 与 `/opt/homebrew/bin/bun`。服务只监听本机回环地址：

```sh
bun run src/main.ts
```

打开 http://127.0.0.1:47831。检查改动使用：

```sh
bun x tsc --noEmit
bun test
```

## Monitor 内发送输入

悬停会话卡片会打开 Monitor 预览；点击卡片会 pin 当前会话，并在存在回复框时自动聚焦，避免移向
输入框时被其他卡片的 hover 切走。再次点击同一卡片，或点击 Monitor 标题栏的 pin 按钮，可解除
pin；点击另一张卡片则把 pin 切换过去。Orca 报告为 `done`（已就绪、等待用户输入）的在线会话会在
Monitor 最底部显示输入框：
回车即通过 `orca terminal send --terminal <handle> --text <text> --enter` 送进该会话，不必先跳转。
用户输入按正常聊天顺序从旧到新展示，打开时定位到最底部 latest；向上滚到顶部会自动加载并缓存
更早历史，不再需要手动点击“加载更多”。

- 每个有索引输入的 session 卡片都用同一状态行展示 latest user input；处理完成后稳定为打钩，不再消失。
- 悬浮或吸附的 Monitor 遮挡聚焦看板时，看板会在 Monitor 两侧生成避让滚动余量；滚到任一端都能让
  内容完全移出遮挡。横向滚动条固定在浏览器下边缘并与看板双向同步；关闭或移开 Monitor 后自动撤销。
- 只有 `done` 会出现输入框；`waiting`（工具权限确认）等状态一律不发。
- 只收单行文本，不接受换行与控制字符——`--enter` 是逐字键入语义，换行会在 TUI 里变成提前提交。
- 发送前会用 Monitor 当前会话的 handle / 状态与服务端最新快照比对，不一致返回 409 并提示刷新。
- 发出后统一读取该 session 的完整 latest user input，与发送队列文本精确比较；不依赖 agent 类型、
  `working` 事件或时间容差。20 秒内仍不相同会标为「传达未确认」，但后续 latest 变为相同仍可恢复确认。
- 卡片保留「复制上次输入」，方便在失败或未确认时取回原文重发。
- 写操作校验 `Sec-Fetch-Site` / `Origin`，只接受同源请求。

输入状态按下表从上到下匹配，前面的规则优先：

| 优先级 | Send 状态 | Session 原始状态 | 展示 | 含义 |
|---|---|---|---|---|
| 1 | `failed` | 任意 | 红色感叹号 · 传达失败 | input 没有送达 |
| 1 | `stalled` | 任意 | 红色感叹号 · 传达未确认 | 超时仍无法确认送达 |
| 2 | 任意 | `working` / `busy` | 原进行中样式 · spinner · 进行中 | session 正在处理 input |
| 3 | `pending` | 除 `working` / `busy` 外 | 灰色 clock · 发送中 | 队列文本尚未等于 latest input |
| 4 | `confirmed` / 无活动发送 | 其他任意状态 | 绿色 check · 已处理 | latest input 已匹配或 session 已结束处理 |

“其他任意状态”包括 `done`、`waiting`、`blocked`、`idle`、`shell`、`error`、`unknown`、离线/无
live 状态，以及未来出现的未知状态字符串；若命中更高优先级的发送失败或 pending，仍以前面的规则为准。

## 挂在会话上的想法队列

会话卡上的「＋想法」把一句话直接变成任务板上的一个任务，并挂回这个会话——想法不打断心流地
落到板子上，卡片上留一条「待落地」，等有空再落地。

- 任务真身在**任务板**上；OrcaTab 只存链接和一份快照（`~/.orcatab/boards.db`），
  板子离线时队列照常显示，只是标题可能是旧的。
- 一个仓库第一次捕捉时选一次任务板项目，之后这个仓库下所有会话都记住它。
  卡片上的项目名可以点开重选。
- 「移除」只解除与这个会话的关联，不删除板子上的任务。
- 接 kansession 时，捕捉成功后还会反向调它的 `POST /api/agent-session/link`，
  把这个会话作为证据挂到刚建的任务上——于是同一次捕捉在两边都留痕。反写失败不影响任务本身。

不配任何任务板也能用：默认落到 OrcaTab 自带的本地板子，项目就是 OrcaTab 自己的项目列表。
接外部板子用 `ORCATAB_BOARDS`：

```sh
export ORCATAB_BOARDS='[{"id":"kansession","name":"kansession","kind":"kansession",
  "baseUrl":"http://127.0.0.1:1337","webUrl":"http://localhost:5173","apiKey":"<API key>"}]'
```

`apiKey` 在 kansession 的 Settings → Account → Developer 里签发，走 `x-api-key`。
kansession 的项目按 workspace 分域：这把 key 只能看到一个 workspace 时会自动发现，看到多个则报错
要求补一个 `"workspaceId"` —— 把想法投进错的 workspace 比多一行配置糟糕得多。
接口契约与新增适配器的写法见 [`docs/TBP.md`](docs/TBP.md)。

## 远程环境（其他机器上的会话）

顶栏「环境」里添加一台 ssh 可达、跑着 orca server 的机器（名称对齐 `orca environment list`），
OrcaTab 会通过 ssh 增量索引它的 claude / codex 会话：每轮一次 ssh exec，脚本经 argv 注入远端
python3、游标走 stdin，按字节只回传新增内容——远端零部署、不开端口、纯只读。

- 保存前先「测试连接」：连通性、python3、claude/codex 目录规模与预估首轮轮次一次讲清。
- 远程会话带机器徽章出现在会话/搜索/聚焦里；项目按 `名称 @环境` 命名空间隔离。
- 实时状态直连远端 runtime（每启用环境一个 `orca-tab@<env>` live source）；在线会话可
  一键跳转（`terminal switch --environment`）、`done` 时可回车发输入（send 同路由）。
  远端回执确认放宽到 60s，且发送成功立即补拉一轮，通常几秒内打钩。
- 不在线的远程会话不会被远程拉起：「跳转/恢复」给出 `ssh … --resume` 命令由你显式执行。
- codex 按 `sinceDays` 时间窗索引（默认 90 天），线程标题来自远端 `session_index.jsonl`。
- 只支持密钥/agent 认证（BatchMode）；首连 host key 按 accept-new 记录，之后变化即报错。
- 隐私：索引读取目标机器上该用户的会话转录，按台、按 agent 显式 opt-in。

设计取舍与协议细节见 [`docs/REMOTE.md`](docs/REMOTE.md)。

## 注册 orcatab://

在仓库根目录运行安装脚本，它会生成 `~/Applications/OrcaTab.app` 并注册 URL scheme：

```sh
bash scheme/install.sh
open "orcatab://claude/<sid>"
```

链接会优先请求本机 OrcaTab 服务；服务不可用时，handler 会调用 Bun CLI 回退。页面的「复制链接」得到 `orcatab://claude/<sid>`，「复制命令」得到 `claude --resume <sid>`。卸载使用：

```sh
bash scheme/uninstall.sh
```

## pm2 托管

进程入口固定为 `src/main.ts`。启动并保存开机恢复配置：

```sh
pm2 start ecosystem.config.cjs && pm2 save
```

日志写入 `~/.orcatab/logs/`。配置变更后由维护者重启进程。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `ORCATAB_PORT` | `47831` | 本机 HTTP 服务端口 |
| `ORCATAB_CLAUDE_DIR` | `~/.claude` | Claude Code 只读数据目录 |
| `ORCATAB_DATA_DIR` | `~/.orcatab` | SQLite 索引数据目录 |
| `ORCATAB_ORCA_BIN` | `orca` | Orca CLI 可执行文件名或路径 |
| `ORCATAB_BOARDS` | 空 | 任务板适配器配置（JSON 数组），见 `docs/TBP.md` |
| `ORCATAB_ORCHESTRATION_DB` | `~/Library/Application Support/orca/orchestration.db` | Orca 编排状态（只读），用于把被指派的会话折叠到协调者下 |

详细设计与数据契约见 [`docs/PLAN.md`](docs/PLAN.md)。
