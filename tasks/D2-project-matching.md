# D2 — 设计调研：provider 侧的项目级匹配

**这是设计任务，不是实现任务。你不许改任何源码。**
交付物是一份设计文档 + 一次 `worker_done` 汇报。方案定下来之前不落地——这是用户的明确要求。

## 背景（先读，别重新发明）

OrcaTab 是 **SPP（Session Provider Protocol v1）的参考实现**，为 kansession（一个 Kaneo fork）
提供 agent 会话数据。协议实现在 `src/spp.ts`，排序在 `src/suggest.ts`，契约文档在
kansession 仓库的 `~/workspace/ideas/kansession/docs/SPP.md`（只读，别改那个仓库的任何东西）。

核心哲学（已锁定）：**匹配逻辑归 provider**。kansession 送一个任务/项目的描述过来，
provider 决定哪些会话相关。kansession 不该知道匹配是怎么做的。

**已确认的事实，不需要你再查**：
- `matchesContext(row, context)` = `row.cwd === context || row.projectKey.includes(context)`
- `suggestSessions(...)` 接受 `options.contextPath`，命中时加 `project` 理由并加分
- **但 kansession 至今从不送 `contextPath`** —— 它那边的 Project 上根本没有仓库或路径字段
- 于是排序只能靠标题/项目名的词重叠，噪音极大（真实观测：一堆无关会话因为
  「项目含 agent / 分支含 agent / 标题含 agent」都拿到 5-6 分）

## 用户要什么（原话）

> 项目视图，把 orcatab 扩展成侧边栏，然后项目加上 github 或者项目路径，能匹配上的就行。

kansession 那边会给项目加上「我在哪」的信息。**你这边要回答：provider 拿到这个信息后怎么用，
以及需不需要动协议。**

## 你要回答的问题

### 1. 两条耦合路线的 provider 侧代价

- **A · kansession 送本地路径**（如 `/Users/bb00/workspace/ideas/kansession`）。
  今天就能work吗？`?context=` 和 `suggest` 的 `contextPath` 已经支持。
  但 `matchesContext` 用的是 `projectKey.includes(context)`——**这个子串匹配靠谱吗？
  会不会误命中？**（例如一个路径是另一个的前缀）说清楚它的失效场景。
- **B · kansession 送仓库身份**（GitHub URL 或 git remote，如 `github.com/ingtshan/kansession`）。
  provider 需要知道每个会话属于哪个仓库。查实：
  - 索引器（`src/indexer.ts` / `src/db.ts` / `src/types.ts`）现在存了会话的哪些字段？
    有 `cwd`、`branch`、`projectKey`——有没有 remote？
  - 从会话的 `cwd` 解析 `git remote get-url origin` 的代价是多少？
    **注意这里的规模：本机 880+ 个会话。** 是在索引时解析并落库，还是查询时现算？
    worktree 和已删除目录怎么办？
  - 需要怎样的规范化才能让 `git@github.com:a/b.git`、`https://github.com/a/b.git`、
    `https://github.com/a/b` 三者匹配上？
  - 这会让 `SppSession` 多一个字段吗？那是**契约改动**（向后兼容的新增，但仍是改动）。

### 2. 需不需要新的 SPP 端点

kansession 要在项目视图里展示「属于这个项目的会话」。查实：

- `GET /spp/v1/sessions?context=<path>&limit=` 够用吗？
- 如果走路线 B，需要 `?repoUrl=` 这样的新参数，还是一个项目级的 `POST /spp/v1/project-sessions`？
- **能不加就不加。** 要加就必须说明现有端点为什么不够，以及新增如何保持向后兼容
  （参考 `features.lookup` 那个能力位的做法——那是最近刚加的先例，
  见 `src/spp.ts` 的 capabilities 和 `GET /spp/v1/sessions/{providerId}/{sessionId}`）。

### 3. 顺带：排序噪音怎么治

这是 kansession 板子上的独立任务，但和本设计同源。`src/suggest.ts` 里通用 token
（`agent`、默认分支名等）过度匹配。查实并提方案：

- 加 IDF / 文档频率降权：在整个会话池里高频出现的 token 权重压低。代价多大？在哪算？
- 有了可靠的项目上下文之后，词重叠是不是就该大幅降权、甚至只作为同项目内的次级排序？
- 默认分支的保护已经有了——它现在做到什么程度？

### 4. 增量路径

给出最小第一步：如果 kansession 明天就开始送 `contextPath`，**你这边一行不改**能有多大改善？
先吃掉这一步值不值？

## OWNER LIST

**你只能新建这一个文件**：`tasks/D2-REPORT-project-matching.md`

（注意：不要写成 `tasks/D2-project-matching.md`——那是本工单自己，覆盖它会毁掉你的任务书。）

**其余一切都是只读**。这个工作树里有**未提交的改动**（SPP lookup 端点、以及另一份 UI 相关的
并行工作）。你碰任何源码都会污染它们。

- 不许改任何 `.ts` / `.html` / `.json`
- 不许 `git add` / `commit` / `checkout` / `stash` / `restore`
- 不许 `pm2 restart`——那个 provider 正在给一个活的 kansession 实例供数据
- 不许跑测试、不许起服务（这是纸面设计）
- **不许改 `~/workspace/ideas/kansession` 里的任何东西**（那是另一个仓库，另有 worker 在做）
  ——但可以只读地看它的 `docs/SPP.md`
- 只读命令随便用：`cat` / `sed -n` / `rg` / `git log` / `git diff`

## 文档要求

用中文写。结构：

1. **现状**（一段：provider 已经能答什么，kansession 又实际送了什么）
2. **路线 A 的 provider 侧评估** —— 今天能work吗？`projectKey.includes()` 的失效场景
3. **路线 B 的 provider 侧评估** —— 索引改动、remote 解析代价（按 880+ 会话算）、规范化、契约影响
4. **端点** —— 现有的够不够，不够的话加什么、怎么保持兼容
5. **排序噪音** —— 具体方案和代价
6. **你的推荐** —— 明确说倾向哪条以及为什么
7. **留给用户/master 的开放问题** —— 只列真正需要拍板的

写具体：引用真实文件路径、真实函数名、真实字段名。不要写「可能需要调整索引逻辑」这种话。

## 规则

- **不实现**。一行产品代码都不要写。
- 拿不准就 `ask`，别猜。
- 用 `worker_done` 汇报，正文里给出：你的推荐（一两句）+ 开放问题清单。
  这份汇报会直接进到 master 与用户的讨论里。
