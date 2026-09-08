# REMOTE — 远程环境的会话

OrcaTab 目前是单机语义：索引读本机 `~/.claude`，live 状态问本机 Orca runtime，发送/跳转
只认本机终端 handle。但 Orca 本身管着多台机器（`orca environment list` 里的 orca server），
上面跑的会话对 OrcaTab 完全不可见。本文档定义把它们接进来的方式。

状态：设计定稿于 2026-08-31；M1（只读索引 + GUI 配置）、M2（远端 live/跳转/发送 + 回执放宽与
定点补拉）、M3（codex 源 + 时间窗）均已实现。与原设计的两处偏差见「实现偏差」一节。

## 已验证的事实（决定设计的）

1. **本地 runtime 对远程 worktree 只存壳。** `session.tabs.listAll` 打本地 runtime，
   远程 worktree 出现在 snapshot 列表里但 `tabs` 是空数组；`agentStatus` 和
   `providerSession.id` 只存在于远端 runtime。所以三个 live source（orca-tab /
   claude-pid / hermes-process）都天然看不见远程会话。
2. **RuntimeClient 有现成的远程通道。** CLI 的 `RuntimeClient` 第 4 个构造参数就是
   environment selector：`new RuntimeClient(undefined, t, null, "feibo2")` 直连远端
   runtime，返回的 tab 快照带完整 `agentStatus.state` + `providerSession.id`——正好是
   `createOrcaTabSource` 消费的形状。`orca terminal send/switch/list` 也都支持
   `--environment`。live 与操作路由层没有硬缺口，缺的只是把 environment 带在身上。
3. **索引器天生是游标增量的。** 每会话存 `parsedOffset`，每轮 = stat 列表 + 从 offset
   读尾巴（`readCompleteLines`），文件收缩才整体重建。它对数据源的完整契约就是
   `list()` + `read(path, offset)`。
4. **除索引器外没有任何代码读 JSONL 原文件。** 搜索、卡片、最近输入全走 SQLite
   （`sessions` + `msg_fts`）。所以「把远端文件镜像到本地」维护的是一份没有消费者的状态。
5. **量级。** 本机参照：`~/.claude/projects` 441MB / 224 个文件（24h 内活跃 56 个）、
   `~/.codex/sessions` 2.4GB。每轮全量拷贝不可行；一次全量 + 增量在 LAN 上很轻。
6. **ssh 凭据不能白捡。** `feibo1-ssh` 这类名字只存在于 Orca 自己的 ssh target 库里，
   本机 `~/.ssh/config` 没有这些 alias。OrcaTab 需要自己的 env → ssh 目标配置。
7. **回执链路依赖本地索引。** 发送确认读 `msg_fts` 里的用户输入证据
   （`session-send-evidence.ts`）。远端会话的证据要等下一轮拉取才落库。

## 方案取舍

前提：所有 orca 远程都保证本机 ssh 直连可达；不在远端开放任何服务端口。

| 方案 | 远端足迹 | 增量粒度 | 延迟 | 否决/保留理由 |
|---|---|---|---|---|
| A. rsync 镜像 | 无 | 文件级 | 轮询 | 否决：镜像文件没有消费者（事实 4），白复制 441MB+2.4GB×N 台 |
| **B. 免部署薄采集**（选定） | **零** | **字节级** | 轮询 | 契约正好贴索引器（事实 3）；脚本随调用走，无版本漂移 |
| C. 常驻 runner over ssh stdio | 单体二进制 + 版本管理 | 字节级 + watch 推送 | 秒级 | 保留为演进方向，与 B 共享 transport 抽象（见下） |
| D. 远端整套 OrcaTab + 隧道联邦 | bun + pm2 + 索引 | 就地 | 实时 | 否决：往同事/共享机装常驻服务是组织问题，收益现在用不上 |

对 C（studio / VS Code Remote server 式）说句公道话：IDE 走常驻 server 是因为交互密度高。
索引是低频批量拉，B 的每轮一个 exec 覆盖 90% 价值；C 真正的增量是推送延迟和远端 sqlite
查询能力（hermes 的库是 sqlite 不是追加 JSONL）。所以 C 不是对立方案，是 B 证明需求后的
升级——本地抽象 `RemoteTransport { list(), read(path, offset) }` 两者共用，升级只换 transport。

## 已拍板的决定

- 主方案 **B**；连接信息在 **GUI 配置**（不是环境变量）。
- v1 范围：**M1 只读索引先行**，远端发送/跳转（M2）另起一轮。¹
- 远端 agent 范围：**claude 先行**；codex 到 M3 带 `sinceDays` 窗口再上；hermes 依赖
  远端 sqlite，明确出圈（等 C 或远端 `sqlite3` CLI 方案）。
- host key：**`StrictHostKeyChecking=accept-new`**——首连自动记指纹，之后指纹变化即报错。¹
- 隐私：远端是同事的机器或共享机，索引别人 `~/.claude` 敏感——**按台、按 agent 显式 opt-in**，
  没有任何自动发现即索引。

¹ 按推荐默认落定，评审时可改。

## 名词

- **环境（environment）** — 一台 ssh 可达、跑着 orca server 的机器。名字与
  `orca environment list` 对齐，同时是 UI 上的机器徽章。本机是隐式环境 `local`。
- **游标（cursor）** — 某个会话文件已消费到的字节 offset，就是现有 `sessions.parsedOffset`，
  不新增状态。
- **transport** — 本地对「一个环境的数据源」的抽象：`list()` + `read(path, offset)`。
  M1 的实现是每轮一次 ssh exec；升 C 时换成常驻连接，索引侧代码不动。
- **探测（probe）** — GUI「测试连接」触发的一次体检：连通性、python3、目录 stat、
  文件数/总大小/预估首轮时长。探测即把 host key 以 accept-new 方式落库。

## 配置与持久化

环境配置进 **preferences 库**（`project_preferences` 同款纪律：GUI 可写状态与可重建的
索引库分开，索引库删了配置不丢）：

```sql
CREATE TABLE IF NOT EXISTS environments (
  name       TEXT PRIMARY KEY,   -- 对齐 orca environment 名
  ssh_user   TEXT NOT NULL,
  ssh_host   TEXT NOT NULL,      -- host 或 ~/.ssh/config alias
  ssh_port   INTEGER,            -- NULL = 22
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  agents     TEXT NOT NULL,      -- JSON: {"claude":true,"codex":{"sinceDays":90}}
  poll_ms    INTEGER NOT NULL DEFAULT 15000,
  updated_at INTEGER NOT NULL
);
```

保存即热生效：每个 enabled 环境一个独立轮询循环，配置变更只重启该环境的循环。
环境之间、环境与本地索引之间互不阻塞——某台 ssh 不可达只影响它自己的新鲜度。

## GUI

顶栏「环境」入口 → 抽屉：

- **列表**：状态点（绿 = 正常 / 黄 = 滞后超阈值 / 红 = 错误 / 灰 = 停用）、名称、
  `user@host`、上次同步、本轮增量字节。
- **添加/编辑**：名称下拉预填 `orca environment list` 候选（从 ws:// 地址猜 host 初值），
  补 ssh 用户名/端口；每 agent 开关；codex 窗口天数（M3）；轮询间隔。
- **测试连接**：保存前必点；探测结果直接渲染在表单里——这台机器能不能索引、
  要付多少代价，在保存前讲清楚。BatchMode 意味着只支持密钥/agent 认证，
  密码认证明确不支持，探测时报清楚。
- 会话卡：机器徽章；搜索加 env 过滤维度。

## 拉取协议（每轮）

脚本不落远端盘、不占 stdin——argv 装 base64 的脚本体，stdin 留给游标：

```
ssh -o BatchMode=yes -o ConnectTimeout=5 \
    -o ControlMaster=auto -o ControlPath=<data>/ssh-%C -o ControlPersist=60 \
    -o StrictHostKeyChecking=accept-new \
    [-p port] -- user@host \
    python3 -c "import base64;exec(base64.b64decode('<脚本体>'))"  < cursors.json
```

**请求**（stdin，JSON）：

```json
{ "claude": { "dir": "~/.claude/projects" },
  "cursors": { "<path>": <offset>, ... },
  "maxBytes": 8388608 }
```

**响应**（stdout，NDJSON 流）：

```
{"type":"list","agent":"claude","files":[{"path":...,"size":...,"mtime":...}, ...]}
{"type":"rebuild","path":...}                     ← 远端发现 size < cursor（文件收缩/重写）
{"type":"chunk","path":...,"offset":...,"data":"<base64>"}   ← 可多条
{"type":"done","truncated":false}
```

- 远端自己对比游标：`size > offset` 发 `[offset, size)`；`size < offset` 先发 `rebuild`
  再从 0 发。**单次往返，无二次协商。**
- 每轮总量 cap（默认 8MB），超出置 `truncated: true`，下轮从游标续。
  **首轮全量就是普通轮次的重复**（441MB ≈ LAN 上几十秒的几十个轮次），没有单独的
  bootstrap 通道。
- 本地消费保留行边界语义：按最后一个 `\n` 截断，游标只推进到换行处，半行留给下一轮
  ——与 `readCompleteLines` 完全同义。
- base64 有 33% 开销，LAN 上不值得为它引入二进制帧。

## 本地改动面

- **种子重构**：`SessionSource` 加可选 `read(info, offset)` hook，`indexFile` 优先走它。
  远端 claude 源 = transport 的 list/read + 复用现有 `parseLine`/`applyLines`，
  解析逻辑零复制。这一刀同时是升 C 的地基。
- **身份加环境维度**：`(agent, sid)` → `(env, agent, sid)`，`env = 'local'` 默认值保持
  现有行为不变。波及 `sessions`/`msg_fts` 加列、`session-identity`、live map 键、
  send store 键、routes 参数（缺省 local 向后兼容）。sid 是 UUID，跨机碰撞不设防。
- **项目解析 env 感知**：`resolveProjectKey`/`resolveWorktreeRoot` 对远端 cwd 不做本地
  stat/git 探测；projectKey 按 env 命名空间隔离。
- **回执放宽 + 定点补拉**（M2）：远端会话确认超时放宽为 `poll_ms + 余量`；send 成功后
  对该会话文件立即补拉一次（就是一次单文件游标读）。

## 安全

- 不提供自由文本 ssh 参数——那是命令注入面。host 校验字符集、拒绝 `-` 开头，
  拼命令固定选项集，目标放在 `--` 之后。要跳板/特殊密钥/代理的场景，用户在
  `~/.ssh/config` 建 alias，host 填 alias 名：灵活性走 ssh 自己的机制，OrcaTab 不重造。
- 写操作沿用现有同源校验（`Sec-Fetch-Site` / `Origin`）；环境增删改是写操作。
- 远端脚本只读（stat + ranged read），不写远端任何文件。

## 分期（全部已交付）

- **M1**：种子重构 + environments 表 + transport + 远端 claude 源 + GUI 配置/状态。
  交付：远端会话带完整标题/最近输入/全文搜索出现在面板，含机器徽章与 env 过滤。纯只读。
- **M2**：远端 live 检测（每启用环境一个 `orca-tab@<env>` live source，直连远端 runtime 的
  `session.tabs.listAll`，随 GUI 保存热增删）+ focus/send 按 `--environment` 路由 + 回执放宽
  （远端确认超时 60s）与定点补拉（send 成功即 kick 该环境的拉取轮）。
  交付：远端会话有实时状态点，可跳转、可回车发输入，回执照常打钩。
- **M3**：codex 源 + `sinceDays` 窗口（默认 90 天）。codex 的 rollout 与 claude 的 JSONL 走同
  一条游标通道、共享每轮预算；线程标题的 `session_index.jsonl` 作为辅助文件按 stat 变化整体
  回传一次。GUI 表单按 agent 勾选、配窗口天数。
- **升 C 的触发条件**（满足其一再动）：轮询延迟不满足实际使用；需要 hermes（远端 sqlite）；
  轮询 exec 成本在环境数量增长后可观。

## 实现偏差

- **远程跳转必须显式携带 clients 导航意图**（根因证据见 `tasks/REMOTE-JUMP-BUG.REPORT.md`，
  由 codex worker 逆向 app bundle 定位）：外部 RPC 客户端调 `session.tabs.activate` 时
  `navigation` 默认为 `caller`——只改调用方自己的选择态、快照 `follow=false`，渲染器仅在
  `navigationIntent === "follow"` 时才采纳活动 tab，所以"状态变了、UI 不动"。`terminal
  switch`（`terminal.focus`）则只把 `ui:focusTerminal` 投递给绑定该 runtime 的本机窗口，
  打远端不会送达本地渲染器。修复：对远端 runtime 依次调 `session.tabs.activate {worktree:
  "id:<key>", tabId, navigation:"clients", notifyClients:true, intent:"user"}` 与
  `worktree.activate {navigation:"clients", notifyClients:true}`——前者让工作区视图跟随目标
  tab，后者让 app 自行打开/前置该工作区；tab 先于 worktree 发布以规避异步刷新竞态。缺
  worktree 键时退回 `terminal switch --environment`。
- **远端死会话不做远程 resume**：原 M2 设想过 `terminal create --environment` 把死会话在远端
  拉起；实现改为返回 `ssh <dest> -t 'cd <cwd> && <agent> --resume <sid>'` 让用户显式执行——
  从面板一键在别人的机器上起进程，越权面大于便利。
- **远端 codex 身份取自文件名**：本地 codex 源会读首行 `session_meta` 校验 rollout id 与
  session id 的一致性；远端逐文件读首行每轮都要付费，故直接取 rollout 文件名尾部的 uuid。
  分叉 rollout（id 不一致）的罕见场景下，远端身份是 rollout id 而非真 session id。

## 开放问题

- `orcatab://claude/<sid>` 与「复制命令」对远端会话的语义（复制成
  `ssh <dest> -t 'cd <cwd> && claude --resume <sid>'`？）——M2 一并定。
- Orca runtime ws 若暴露读远端文件的 RPC，可整体替代 ssh 通道；私有 API 漂移风险大，
  只作备选调研，不挡 M1。
- 远端机器 python3 缺失（无 CLT）的降级：探测报错即可，暂不做 shell 兜底。
