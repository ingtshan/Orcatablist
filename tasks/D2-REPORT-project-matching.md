# D2 — provider 侧项目级匹配设计

> 本文只做设计，不包含实现。判断基于当前工作树中的 `src/spp.ts`、`src/suggest.ts`、`src/indexer.ts`、`src/db.ts`、`src/types.ts`、`src/projects.ts`，以及 kansession 的只读契约 `docs/SPP.md`。

## 1. 现状

OrcaTab 已经能通过 `GET /spp/v1/sessions?q=&context=&limit=` 列出/搜索会话，并通过 `POST /spp/v1/suggest` 接收 `task.contextPath` 后交给 `suggestSessions(..., { contextPath })` 排序；`toSppSession()` 也会把会话自己的 `row.cwd` 暴露为 `SppSession.contextPath`。但是 kansession 当前没有项目路径或仓库身份，因此实际请求没有 `contextPath`：provider 只能把任务标题和 `projectName` 合成 `syntheticGoal()`，再用项目名、分支、标题/首条 prompt 的 token 重叠猜测。当前索引的 `StoredSession`、`SessionRow` 和 SQLite `sessions` 表有 `cwd`、`worktreeRoot`、`projectKey`、`branch` 等字段；`projects` 表只有 `key/name/root/color`；所有这些层都没有 git remote 或规范化仓库身份。

## 2. 路线 A 的 provider 侧评估：kansession 送本地路径

### 今天能不能 work

能，但它现在是 best-effort，不是严格的项目身份匹配，而且有明确使用前提。

- `GET /spp/v1/sessions?context=<path>` 已经读取 `context` 并调用 `matchesContext(row, context)`；不需要改协议或 OrcaTab。
- `POST /spp/v1/suggest` 的 `parseTask()` 已接受 `task.contextPath`。`suggestions()` 从最多 5,000 条会话建池，再由 `suggestSessions()` 给上下文命中的会话加 `CONTEXT_SCORE = 2`，理由为 `同上下文 ...`。由于 `MINIMUM_SCORE = 2`，一个没有任何文字重叠的同上下文会话也能进入建议集。
- `src/projects.ts::resolveProjectKey()` 对存在的 Git 仓库运行 `git -C <cwd> rev-parse --path-format=absolute --git-common-dir`，把普通 clone 和 linked worktree 归到同一个 common-dir 项目 key。因此，kansession 如果送的是 provider 所在机器上的、无尾斜杠的 canonical 主仓库根路径，例如 `/Users/bb00/workspace/ideas/kansession`，当前 `projectKey.includes(context)` 通常会命中该仓库及其 worktree 会话。

### `projectKey.includes(context)` 不是可靠身份比较

`src/spp.ts::matchesContext()` 和 `src/suggest.ts::suggestSessions()` 都使用：

```ts
row.cwd === context || row.projectKey.includes(context)
```

它有以下失效场景：

1. **前缀/子串误命中。** `context=/repos/kaneo` 会命中 `/repos/kaneo-old`、`/repos/kaneo2`；`context=/Users/bb00/workspace` 会命中该目录下所有仓库。比较没有路径分隔符边界，也不是 equality。
2. **非规范路径漏命中。** `/repo/kaneo/`、带 `.`/`..` 的路径、symlink 路径、大小写别名，与索引里的 absolute/common-dir 路径未做同一套 normalization/realpath，可能指向同处却不相等也不互含。
3. **worktree 路径漏命中。** 会话的 `projectKey` 是主仓库 common-dir 根；若 kansession 送的是 linked worktree 根，而会话 `cwd` 是该 worktree 下的子目录，则 `cwd !== context` 且主仓库 `projectKey` 不包含 worktree 路径。索引已有 `row.worktreeRoot`，但 `matchesContext()` 完全没有使用它。
4. **非 Git/历史路径不稳定。** Git 解析失败时，`fallbackProject()` 可能把 `projectKey` 设成原 cwd，或设成 `orca-workspaces:<name>` 这种非路径 key。后者无法与绝对路径做包含比较；已删除 worktree 只有在 `mergeDeletedWorktreeProjects()` 的同目录命名启发式成功时才会被改写到存活仓库。
5. **先 limit、后 filter 会漏掉旧会话。** `handleSppRequest()` 先调用 `db.listSessions({ limit })` 或 `db.search(query, limit)`，再在内存里按 context 过滤。默认 limit 是 50、最大 200；在 880+ 会话中，一个项目的旧会话即使完全匹配，也可能已被全局 Top-N 截掉。当前 `nextCursor` 固定为 `null`，所以调用方无法继续翻页补齐。

若后续硬化路线 A，应删除子串语义：请求到来时只解析一次 context，用与 `resolveProjectKey()` 相同的规则得到 canonical `projectKey`，然后以 `row.projectKey === resolvedProjectKey` 为主；显式 worktree 根可与规范化后的 `row.worktreeRoot` 做 equality。只有非 Git 文件夹项目需要“后代路径”语义时，才使用 `candidate === root || candidate.startsWith(root + pathSeparator)` 的边界化判断，绝不能继续用裸 `includes()`。数据库查询也必须在 `ORDER BY/LIMIT` 之前按 project key 过滤。

### 零改动第一步能改善多少

如果 kansession 明天把准确的主仓库根路径同时送给列表请求的 `context` 和建议请求的 `task.contextPath`，OrcaTab 一行代码不改即可获得两点收益：项目列表的已返回部分会被硬过滤；建议里所有同项目会话至少拿到 2 分并越过最低门槛。收益主要是**召回明显提升**，不是精度彻底解决：`suggestSessions()` 只给同项目加 2 分，并未排除外项目；无关会话仍可能靠项目名 token（2）、feature branch token（3）和标题 token（最多 3）拿到 5–8 分并排在同项目的 2 分会话之前。这个零改动切片值得先吃，既能立即减少空结果，也能验证 kansession 的项目字段和请求链路；但 UI/文档应暂时把它视为“近期 best-effort”，不能承诺完整历史或零噪音。

## 3. 路线 B 的 provider 侧评估：kansession 送仓库身份

### 当前索引缺什么

真实字段链如下：

- `src/types.ts::ParsedEvent` 只可能给出 `cwd`、`branch`，没有 remote。
- `src/db.ts::StoredSession` 与 `src/types.ts::SessionRow` 存 `projectKey/cwd/worktreeRoot/branch`，没有 remote。
- SQLite `sessions` 表对应列是 `project_key/cwd/worktree_root/git_branch`；`projects` 表是 `key/name/root/color`；`cwd_cache` 只做 `cwd -> project_key`。
- `src/spp.ts::SppSession` 输出 `contextPath` 和 `branch`，没有仓库 URL/identity。

因此路线 B 不是只改一个 matcher：provider 必须先建立“本地项目 key -> 远端仓库身份”的索引。

### 解析时机与落库位置

**不能查询时现算。** 如果每次项目视图请求都对 880+ 会话逐条执行 `git remote get-url origin`，就是 O(session) 的 880+ 次子进程启动，并且同一仓库/worktree 会被重复解析。即便只按每次 5 ms 的乐观启动成本估算，串行也已超过 4 秒；错误路径还需要超时控制。它还会让一次只读 HTTP 查询依赖 880+ 个 cwd 当下仍存在。

推荐在索引/项目元数据阶段解析并落库，但按 **distinct `projectKey`** 去重：

1. `src/indexer.ts::indexFile()` 已先调用 `resolveProjectKey(cwd, projectDeps)`；在得到 `ProjectRecord` 后，调用一个项目级 `resolveProjectRepository(projectKey, usableCwd)`，而不是给每条 session 增加一次 Git 调用。
2. `src/projects.ts` 用 argv 数组运行 `git -C <usableCwd> remote get-url origin`，沿用现有 `GIT_TIMEOUT_MS` 和显式错误结果；不得经过 shell 字符串。
3. `src/db.ts` 的 `projects` 表增加可空的 `origin_url`（原始、用于诊断）和 `repo_identity`（规范化、用于 equality），并给 `repo_identity` 建普通索引。它不应是 UNIQUE：同一远端的多个本地 clone 应能共同匹配同一仓库项目。`sessions.project_key` 已提供 session 到 project 的关联，无需在 880+ session 行重复 remote。
4. 增加 `repo_checked_at` 或等价的失败缓存，区分“未检查”和“已检查但无 origin/目录失效”，避免每次 rescan 都重试同一失败项目。成功值可在项目元数据刷新或检测到 Git config 变化时重算。
5. 查询时只做 `sessions JOIN projects ON sessions.project_key = projects.key WHERE projects.repo_identity = ?`，不启动 Git 子进程。

这一设计把 cold index 的 remote 调用从 O(880+) 降到 O(本地项目数)，平时增量索引只处理新项目或需要刷新的项目。当前 `SCHEMA_VERSION = "7"` 的策略是在版本不符时删除并重建索引数据库；若实现通过 bump schema 完成，首次启动会全量重建。remote 解析仍必须按项目去重，否则 cold rebuild 会非常慢。

### worktree、已删除目录与失败语义

- **linked worktree：** `resolveProjectKey()` 已用 Git common dir 把它和主仓库合并。remote 应存项目级；从任一仍存在的 worktree cwd 执行 Git 均可，所有关联 session 通过同一个 `projectKey` 继承 identity。
- **cwd 是仓库子目录：** `git -C` 可从子目录读取仓库 config，索引时可直接使用该 cwd；不要假设 `projects.root` 一定是当前可进入的 worktree。
- **已删除 worktree：** 不应在查询时重试。若该 session 之后被 `mergeDeletedWorktreeProjects()` 改写到一个存活项目 key，它可通过 join 继承该项目的 identity；否则保持 `repo_identity = null`，不做猜测。
- **已有值后目录才删除：** 保留最后一次成功解析的 identity，并记录刷新失败；不要因为暂时不存在就把已知值清空。
- **全新数据库遇到历史已删目录：** provider 无法从当前字段恢复 remote。这是路线 B 的真实覆盖缺口；除非另建不会随可重建索引删除的 durable repo cache，否则只能返回“不匹配/未知”，不能根据目录名冒认。
- **没有 `origin`：** 记为已检查但 identity 为 null。是否尝试其他 remote 是产品策略，首版不应自动选择任意 remote，因为 fork/upstream 关系会变得含糊。

### 规范化规则

新增纯函数可命名为 `normalizeRepositoryIdentity(raw)`，输出只用于精确比较的 canonical identity。规则应是：

1. trim 输入；将 scp-like 的 `git@github.com:a/b.git` 拆成 host=`github.com`、path=`a/b.git`；其余使用 URL 解析处理 `https://`、`ssh://` 等形式。
2. 丢弃 scheme、userinfo、query、fragment；host 小写；只保留非默认端口。
3. path 去掉开头/结尾 `/` 和**一个**结尾 `.git`（大小写不敏感），压平重复 `/`；不做子串比较。
4. 对 `github.com`，owner/repo 均小写，要求恰好有 owner 与 repo，输出 `github.com/owner/repo`。因此下列三者完全相等：

   ```text
   git@github.com:a/b.git
   https://github.com/a/b.git
   https://github.com/a/b
   -> github.com/a/b
   ```

5. 对其他 host，host 小写但 path 默认保留大小写；GitLab 的 nested group path 也需完整保留。纯本地 path、`file:` remote、无法解析或缺 repo path 的输入返回 null，交由路线 A 处理。

匹配必须是 canonical identity 的 equality。不要用 URL 字符串 `includes()`，也不要仅按末尾 `owner/repo` 比较，否则不同 host 会串项目。

### 对 `SppSession` 契约的影响

路线 B **不必**让 `SppSession` 增加字段。kansession 已提供项目 repo，provider 只需用它筛选/排序，session 到 repo 的关系可以完全留在 provider 内部。这样 `toSppSession()` 和 session snapshot 契约不变。

只有当 kansession 明确要展示 provider 认出的 remote、把它缓存到 evidence snapshot，或从任意 session 反推项目时，才增加可选的 `repository`/`repoUrl` 字段。SPP 规则允许客户端忽略未知字段，所以这是向后兼容的新增；但它仍然是契约改动，需要更新 `docs/SPP.md`、`SppSession`、mapping fixture 与版本/能力说明，不能把它当实现细节偷偷加入。

## 4. 端点

### 路线 A：保留现有 `GET /spp/v1/sessions`

协议形状已经够用，不需要 `POST /project-sessions`。应继续使用：

```text
GET /spp/v1/sessions?context=<provider-local-path>&q=<optional>&limit=<n>&cursor=<optional>
```

但要把现有实现从“全局 `ORDER BY/LIMIT` 后内存 filter”改成“先解析 project key，再由 `OrcaDatabase.listSessions()`/`search()` 在 SQL 中按项目筛选，最后 `ORDER BY/LIMIT`”。否则它只适合作为近期候选列表，不是完整项目视图。若用户要求超过 200 条的完整历史，还需在**同一个端点**实现已存在于契约形状里的 cursor；这仍不构成新增项目端点的理由。

### 路线 B：扩展同一端点与 suggest 输入

同样不需要新的 `POST /spp/v1/project-sessions`；它会重复 sessions 的列表、搜索、limit/cursor 和响应模型。最小、正交的扩展是：

```text
GET /spp/v1/sessions?repoUrl=<url-or-git-remote>&q=&limit=&cursor=

POST /spp/v1/suggest
{
  "task": {
    "title": "...",
    "projectName": "...",
    "contextPath": "...",
    "repoUrl": "git@github.com:a/b.git"
  }
}
```

`repoUrl` 是外部输入，provider 内部先规范化为 `repo_identity`。如果同时传 `contextPath` 与 `repoUrl`，应让两者解析后指向同一项目；已确认冲突时返回 400，而不是悄悄选一个或把结果并集化。

这是向后兼容的 SPP v1 新增，但仍需能力协商。建议仿照最近的 `features.lookup`，在 capabilities 增加：

```json
{ "features": { "repositoryContext": true } }
```

kansession 只有看到该位为 true 才发送/依赖 `repoUrl`。原因是旧 provider 会忽略未知 query/task 字段；如果客户端未经 capability gate 就发送 `repoUrl`，旧 provider 可能返回未过滤的全局会话，形成比报错更危险的假匹配。旧调用不送新字段时行为保持不变，endpoint path 和 `protocol: "spp/1.0"` 均无需变化。

## 5. 排序噪音

### 当前算法与默认分支保护

`src/suggest.ts` 当前常量是：项目 token 2 分、feature branch token 3 分、context 2 分、标题/首 prompt 最多 3 分、最低入选 2 分。`tokens()` 把长度至少 3 的 Latin word 和中文相邻二元组等权处理，没有文档频率；所以 `agent` 这种高频词与稀有项目词同值。

默认分支保护已经在两个分支路径都生效：`discriminatingBranch()` 排除 null、`HEAD`，并大小写不敏感地排除精确名称 `main/master/develop/dev/trunk/release`；无论是“与已确认会话同分支”还是“新任务标题与分支 token 重叠”，这些分支都不加 3 分。它解决的是**精确默认分支名**，没有解决项目名/标题里的 `agent`，也不会识别 `refs/heads/main`、`origin/main` 之类带前缀形式。

### IDF / 文档频率降权

在 `suggestions()` 已加载的 pool 上做一遍预处理即可，不需要 FTS 查询或新表：

1. 每个 session 构成一个 document；把 `finalProjectSegment(projectKey)`、规范化后的非默认 branch、`displayTitle`、`firstPrompt` 各自 tokenize，同一 token 在一条 session 内只计一次。
2. 计算 `df(token)`，并使用平滑权重，例如 `idf = ln((N + 1) / (df + 1)) + 1`。评分时由匹配 token 的 IDF 决定贡献，并继续保留每类信号的 cap；高频 `agent` 会自然接近最低权重，稀有项目/功能词保留高权重。
3. 项目字段最好按 unique `projectKey` 统计 project-token DF，而不是按 session 数统计，否则“活跃项目有很多会话”会被误当成“项目词缺乏区分度”；标题/branch 则按 session DF。
4. 预处理与评分都是 O(N × 平均 token 数)，内存 O(词表)。当前 880+、上限 5,000 的池很小，单请求现算的代价远低于 Git 子进程；实现时可先在 `src/suggest.ts` 一次性构建并复用 row token sets，避免两遍重复 tokenize。若实际 profile 显示 suggest 高频，再按 `db.getListVersion()` 缓存统计；相关标题、projectKey、branch 变化都会推动 list version。

不要先维护一个不断膨胀的手写 stop-word 表；保留现有默认分支黑名单作为结构规则，通用词交给 DF。为了不让浮点公式破坏现有 API，可继续输出 number score，reasons 标签展示命中的最高 IDF token；具体阈值应以已观测噪音样本做回归 fixture。

### 有可靠项目上下文后的排序层级

可靠的 `contextPath -> projectKey` 或 `repoUrl -> repo_identity` 不应只值 2 分。显式项目身份存在且成功解析时，provider 应先**硬筛选同项目 pool**，再在同项目内用 exact feature branch、IDF 后的标题/首 prompt、最近活动时间排序；项目身份是 eligibility，不是可被三个 `agent` token 抵消的小额加分。只有请求完全没有项目身份时，才走全局 IDF heuristic。显式字段格式无效应返回 400；格式有效但没有匹配 session 应返回空集，绝不能退化成全局噪音。旧调用未提供任何身份时则保留现有行为，保证兼容。

## 6. 推荐

我明确倾向 **A 作为现在的第一条路线**：OrcaTab 和 kansession 当前是同机本地集成，SPP 已有 `context`/`contextPath`，kansession 只需开始发送准确的 canonical 主仓库根路径，就能零 provider 改动先获得明显召回收益，并验证项目视图链路。

推荐增量顺序：

1. **立即、OrcaTab 零改动：** kansession 保存并发送 provider-local canonical repo root；列表先用 `context`（临时可请求 `limit=200`），建议用 `task.contextPath`。接受 best-effort 边界。
2. **provider 的第一项实现再议：** 不改协议，只把 A 的裸 `includes()` 改成 canonical project equality，把项目过滤下推到 SQL 的 LIMIT 之前，并让可靠 context 成为 suggest 的 pool gate；同时加入前缀冲突、nested cwd、worktree 与 pre-limit 漏数的回归测试。
3. **确有跨机器/多 clone 需求时再做 B：** 项目级索引 `origin_url/repo_identity`，扩展 `repoUrl` 输入与 `features.repositoryContext`。不要一开始就给 `SppSession` 加字段，也不要新增 project-sessions endpoint。
4. **无可靠上下文的兜底：** 在全局建议中加入 DF/IDF；它是降噪层，不替代项目身份。

B 的长期身份更稳定、可跨本地目录移动，但它同时引入 schema/reindex、Git 元数据刷新、历史已删目录缺口、URL normalization 和协议能力位。当前先付这些成本，不如先兑现 A 已经存在的能力。

## 7. 留给用户/master 的开放问题

1. **部署边界：** kansession 与每个 OrcaTab provider 是否保证共享同一台机器、同一套绝对路径？若答案是否，A 只能是临时优化，B 就是长期必选而非可选。
2. **项目视图完整性：** UI 要“最近若干条”还是“可翻完全部历史”？前者可保留 limit；后者必须实现 cursor，当前默认 50/最大 200 且 `nextCursor=null` 不满足。
3. **仓库分组语义：** 若两个本地 clone 有同一个 origin，它们是否应显示为同一个 kansession 项目的会话？本文按“是”设计；若用户认为 clone 是不同工作空间，路线 B 还需一个 repo identity + local clone identity 的复合键。
4. **双字段冲突：** kansession 若同时保存 path 与 repo URL，二者不一致时是否接受本文建议的 fail-closed（400/不匹配），还是指定 repo URL 或 path 为唯一权威？这需要在两端实现前拍板。
