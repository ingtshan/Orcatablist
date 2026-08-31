# TBP — Task Board Protocol v1

SPP 的镜像。`docs/SPP.md`（在 kansession 仓库）定义「别人怎么问 OrcaTab 要会话」；
TBP 定义「OrcaTab 怎么把一个想法交给一块任务板」。两条协议合起来是一个闭环：

```
OrcaTab ──TBP.capture──▶ kansession（任务落到项目板上）
   ▲                          │
   └────────SPP.suggest───────┘   同一个 session 在板子那边成为 task 的证据
```

TBP **不是** HTTP 协议——它是 OrcaTab 进程内的一个 TypeScript 接口（`src/boards/board.ts`）。
适配器把它翻译成各自的后端：`local` 写 OrcaTab 自己的 SQLite，`kansession` 打 HTTP。
之所以不做成 HTTP：OrcaTab 是调用方，多一层 HTTP 只是把适配器挪到另一个进程里，
不产生任何解耦收益。SPP 走 HTTP 是因为 provider 必须留在本机、而调用方在别处。

## 名词

- **Task Board（任务板）** — 一个知道「任务」宇宙的后端。第一批适配器：`local`（OrcaTab 自带）、
  `kansession`（Kaneo fork）。换 Linear / GitHub Issues 只需要新增一个适配器文件，
  不改 OrcaTab 任何其他代码。
- **Capture（捕捉）** — 从一个 session 出发新建一个任务。这是 v1 唯一的写操作。
- **Queue（待落地队列）** — 挂在某个 session 上、状态还没进入 final 列的任务。
  UI 上叫「待落地」：想法已经被记下来了，但还没变成这个会话里的一次真实输入。
- **Binding（项目绑定）** — OrcaTab 的 `projectKey` → `(boardId, boardProjectId)`。
  一个仓库绑一次，之后这个仓库下所有会话的捕捉都进同一个板子项目。

## OrcaTab 持久化什么

**只有链接。** 和 kansession 只存 `task_evidence` 是同一条纪律：

```sql
session_tasks(agent, sid, board_id, task_id, title, status, status_kind, url,
              project_id, number, created_at, updated_at)   -- PK (agent,sid,board_id,task_id)
project_boards(project_key, board_id, board_project_id, board_project_name, updated_at)
```

`title/status/url` 是**快照**：板子离线时队列照常显示，标题可能是旧的。
任务的真实状态永远在板子那边；OrcaTab 从不声称自己是任务的权威。
唯一的例外是 `local` 适配器——它自己就是那个板子，任务表 `local_tasks` 是它的权威存储。

## 接口

```ts
interface TaskBoard {
  readonly id: string;                    // 稳定标识，进 session_tasks.board_id
  readonly name: string;                  // UI 显示名
  readonly kind: "local" | "kansession";  // 适配器类型
  capabilities(): BoardFeatures;          // 同步；不探网络
  listProjects(): Promise<BoardProject[]>;
  capture(input: CaptureInput): Promise<BoardTask>;
  lookup(taskIds: string[]): Promise<Map<string, BoardTask>>;
  backlink?(taskId: string, ref: SessionRef): Promise<void>;
}

interface BoardFeatures { projects: boolean; capture: boolean; lookup: boolean; backlink: boolean }
interface BoardProject { id: string; name: string; url: string | null }
interface BoardTask {
  boardId: string; taskId: string; projectId: string;
  title: string; status: string; statusKind: "open" | "done";
  number: string | null;      // 板子的人类可读编号，如 KAN-12
  url: string | null;         // 「打开」按钮的目标；板子没有 web UI 时为 null
}
interface CaptureInput { projectId: string; title: string; description?: string }
interface SessionRef { providerId: string; sessionId: string; agent: string }
```

### 错误

- `BoardOfflineError` — 连不上（超时、DNS、连接拒绝）。调用方降级：显示快照，不报错。
- `BoardRequestError` — 板子答了但不是 2xx，或返回体不可解析。带 `status`。
  捕捉时这是硬失败（想法没落到任何地方，必须让用户知道）；刷新时是软失败。

### backlink 是能力位，不是必选

`backlink()` 存在时，OrcaTab 在捕捉成功后**尽力**调一次，把这个 session 作为证据挂到刚建的
task 上（kansession 侧就是 `POST /api/agent-session/link`）。失败只记日志，不回滚捕捉——
任务已经建好了，证据链是加分项。这样一次捕捉在两边都留痕：OrcaTab 的会话卡上有队列项，
kansession 的任务时间线上有一条 `session_linked`。

## v1 故意没有的东西

按「在真实需求里逐渐长出来」的原则，下面这些都等到有需求再加，别提前设计：

| 缺的 | 什么需求会把它拉出来 |
|---|---|
| `updateStatus()` / 完成任务 | 「落地」动作：把队列项发进会话后推到 in-progress |
| `search()` / 挂载已有任务 | 把板子上已存在的任务拖到某个 session 上 |
| 分页 / cursor | 单个 session 的队列超过一屏 |
| webhook / 推送 | 队列要实时反映别人在板子上的改动（现在靠读时刷新） |
| 多 workspace | 一个 kansession 实例里跨 workspace 捕捉 |

## 配置

```
ORCATAB_BOARDS='[{"id":"kansession","name":"kansession","kind":"kansession",
                  "baseUrl":"http://127.0.0.1:1337","webUrl":"http://localhost:5173",
                  "apiKey":"<kansession Settings → Account → Developer 里签发>"}]'
```

不配就只有 `local`，捕捉照常可用（写进 `~/.orcatab/boards.db`）。
`apiKey` 走 `x-api-key` 头。默认板子 = 配置里的第一个；没配就是 `local`。

## 适配器：kansession

| TBP | kansession HTTP |
|---|---|
| `listProjects()` | `GET /api/project` → `{id,name,slug,workspaceId}`；`url` 由 `webUrl` + workspaceId + id 拼 |
| `capture()` | `GET /api/column/{projectId}` 取第一列的 slug 作 status，再 `POST /api/task/{projectId}` |
| `lookup()` | 逐个 `GET /api/task/{id}`（v1 没有批量端点）；404 视为任务已删，链接一并清掉 |
| `backlink()` | `POST /api/agent-session/link` `{taskId, providerId:"orcatab", sessionId}`（不带 snapshot，让 kansession 反过来走 SPP `/spp/v1/sessions/orcatab/{sid}` 自己取——这正是 SPP 加 lookup 端点的原因） |
| `statusKind` | 任务的 `status` slug 落在该项目 `isFinal` 的列里 → `done`，否则 `open`；列表缓存 60 s |
