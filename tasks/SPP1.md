# Task SPP-1: OrcaTab 成为 Session Provider（实现 SPP v1）

## Context
- 仓库 `/Users/bb00/workspace/orcatab`（P1–P7 已合并，pm2 跑在 127.0.0.1:47831）。先读 `AGENTS.md`。约束同前：`~/.claude`/`~/.codex`/`~/.hermes` 只读；`src/` 禁止顶层 `await`（入口 `src/main.ts`）；禁止 `orca terminal *`、`open -a`、`pm2`、`git push`；开发/验收用临时数据目录 + 端口 47990–47997，**不要**碰 pm2 的 47831、不读写 `~/.orcatab/index.db`（除只读打开）。
- 目标：在现有 OrcaTab 之上**加法式**实现 `SPP v1`（Session Provider Protocol），让 OrcaTab 成为 Kaneo(kansession) 的会话证据提供方。契约见 `/Users/bb00/workspace/ideas/kansession/docs/SPP.md`（**只读参考，权威**）；本工单把要点冻结如下，冲突以本工单为准。
- 复用现有模块：`src/db.ts`(listSessions/search/getSession/msg_fts)、`src/live.ts`(getLiveMap 实时态)、`src/suggest.ts`(打分+reasons)、`src/focus.ts`(resolveFocus)、`src/server.ts`(路由装配)。**不改动这些模块的既有行为**，只在其上加 SPP 层。

## Requirements

### R1 新增 `src/spp.ts`（SPP 处理器，纯装配，复用现有能力）
所有响应 JSON，`Cache-Control: no-store`，时间为 epoch ms。`providerId` 常量 = `"orcatab"`。Session 对象形状：
```ts
interface SppSession { providerId:"orcatab"; sessionId:string; agent:Agent; title:string|null;
  contextPath:string|null; branch:string|null; lastActivityAt:number|null; messageCount:number;
  webUrl:string|null; actionUrl:string; }  // actionUrl = `orcatab://${agent}/${sid}`
```
由 `SessionRow` 映射：`sessionId=sid, title=displayTitle||null(实际用 title??firstPrompt 逻辑已在 displayTitle), contextPath=cwd, branch=branch, lastActivityAt=lastInputAt, messageCount=promptCount, webUrl=null(暂), actionUrl=orcatab://<agent>/<sid>`。导出纯函数 `toSppSession(row): SppSession` 便于单测。

### R2 端点（挂到 `src/server.ts`，前缀 `/spp/v1`）
- `GET /spp/v1/capabilities` → `{protocol:"spp/1.0", provider:{id:"orcatab",name:"OrcaTab",version:"1.0.0"}, agents:["claude","codex","hermes"], features:{search:true,suggest:true,status:true,action:true,progressDelta:true}}`。
- `GET /spp/v1/sessions?q=&context=&limit=&cursor=` →
  - `q` 非空 → 复用 `db.search(q, limit)`；否则 `db.listSessions({limit})`。`context` 非空时按 `cwd===context || projectKey 命中 context` 过滤（简单包含即可）。合并 live 非必需。
  - 返回 `{sessions: SppSession[], nextCursor:null}`（v1 不分页，cursor 恒 null；limit 默认 50 上限 200）。
- `POST /spp/v1/suggest` body `{task:{title,description?,projectName?,contextPath?}, exclude?:[{providerId,sessionId}], limit?}` →
  - **provider 侧排序（决策 B）**：复用 `src/suggest.ts` 的打分，但**种子来自 task**而非 goal：构造一个合成 goal `{name: [task.title, task.projectName].filter(Boolean).join(" ")}`，confirmed 传空数组，pool = `db.listSessions({limit:5000})`，excluded = task 里的 exclude 集（`agent/sid`；注意 exclude 用 providerId 但本 provider 只有 orcatab，比对 sid+agent。exclude 项里没有 agent → 需要按 sid 匹配；**决定**：exclude 用 `sessionId` 比对即可，忽略 providerId）。
  - 若 `task.contextPath` 非空，给"cwd/projectKey 命中 contextPath"的候选额外 +2（复用 suggest 里 project 信号的思路；可在合成 goal 之外加一个后处理加权，或扩展 suggestSessions 接一个 contextPath 参数——二选一，简单为准，写进报告）。
  - 返回 `{suggestions: (SppSession & {score:number, reasons:[{code,label}]})[]}`，取 suggest 结果映射为 SppSession + score + reasons，limit 默认 8。
- `POST /spp/v1/status` body `{refs:[{providerId,sessionId}], since?:number}` →
  - 每个 ref：`state` 来自 live（`getLiveMap().get(sid)?.status` → 映射 `busy→live, waiting→waiting, idle→idle, shell→idle`；不在 live map → `offline`；若会话在库但从未有输入且不在 live，也是 offline）。`lastActivityAt` 来自库 `getSession(agent,sid)?.lastInputAt`（ref 无 agent → 需要按 sid 找会话：加 `db.getSessionBySid(sid)` 只读查询，或遍历三 agent）。`newActivityCount`：`since` 提供时 = `SELECT count(*) FROM msg_fts WHERE sid=? AND role='user' AND ts > ?`（新增只读方法 `db.countUserActivitySince(sid, since)`；无 since → 省略该字段或 0）。`waitingFor` 来自 live 的 waitingFor。
  - 返回 `{statuses:[{providerId:"orcatab",sessionId,state,lastActivityAt,newActivityCount?,waitingFor}]}`。
  - ref 的 `providerId` 非 "orcatab" → 跳过该 ref（返回里不含）。
- `GET /spp/v1/sessions/{providerId}/{sessionId}/action` →
  - providerId≠"orcatab" → 404。用 `resolveFocus(agent, sid, deps, {dryRun:true})`（需先按 sid 定位 agent；同上 getSessionBySid）。映射：`switched→{kind:"switch",url:"orcatab://<agent>/<sid>",command:null,label:"回到 Orca tab"}`；`resumed→{kind:"resume",url:"orcatab://<agent>/<sid>",command:null,label:"在 Orca 恢复会话"}`；`manual→{kind:"manual",url:null,command,label:"手动恢复"}`。
  - 会话找不到 → 404 `{error}`。

### R3 `src/db.ts` 只读新增（不改既有）
- `getSessionBySid(sid): SessionRow | null`（`SELECT * FROM sessions WHERE sid=? LIMIT 1`，跨 agent；用于 ref 无 agent 时定位）。
- `countUserActivitySince(sid, since): number`（`SELECT count(*) FROM msg_fts WHERE sid=? AND role='user' AND ts > ?`）。

### R4 CORS / 访问
- SPP 端点加一个宽松 CORS 响应头（`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET,POST,OPTIONS`, `Access-Control-Allow-Headers: content-type`）并处理 `OPTIONS` 预检返回 204——因为 kansession 未来可能浏览器侧直连；但 v1 主要是 kansession **服务端**调用，无 CORS 也行，加上更稳。仅对 `/spp/*` 加。
- 仍只监听 127.0.0.1。

### R5 测试（`bun test`，新文件 lines ≥ 80%，不回归旧的）
- `spp` 映射：`toSppSession` 字段正确；suggest 映射带 score/reasons；status state 映射（busy→live 等）与 newActivityCount。
- `db` 新方法：getSessionBySid、countUserActivitySince（临时库插数据验证）。
- server：`/spp/v1/capabilities`、`/sessions`(q 与非 q)、`/suggest`(返回排序+reasons)、`/status`(state+delta)、`/action`(switch/resume/manual 三态)、坏 providerId → 404、OPTIONS → 204。

### R6 提交
`git add -A && git commit -m "feat: SPP v1 — OrcaTab as a Session Provider (capabilities/sessions/suggest/status/action)"`。不要 push。

## Constraints
- 纯加法：不改 `db/live/suggest/focus/server` 既有行为（server 只新增路由分支）。允许新增 `src/spp.ts`、`test/spp.test.ts`、db 只读方法。
- `~/.claude`/`~/.codex`/`~/.hermes` 只读；不碰 pm2/47831；开发验收用临时数据目录 + 47996。

## Acceptance（全通过；数字写进报告）
1. `bun x tsc --noEmit` exit 0；`bun test` 全绿；新文件 lines ≥ 80%。
2. 冒烟（真实只读数据，端口 47996，临时数据目录）：
   ```bash
   D=$(mktemp -d); ORCATAB_PORT=47996 ORCATAB_DATA_DIR=$D bun run src/main.ts >$D/log 2>&1 & sleep 13
   B=http://127.0.0.1:47996
   curl -sf $B/spp/v1/capabilities | jq -c '{protocol,agents,features}'                     # protocol spp/1.0, 3 agents, features 全 true
   curl -sf "$B/spp/v1/sessions?limit=3" | jq '.sessions|length'                              # 3；每项含 providerId/sessionId/agent/actionUrl
   curl -sf "$B/spp/v1/sessions?q=orcatab&limit=5" | jq '.sessions|length'                     # ≥1
   curl -sf -XPOST $B/spp/v1/suggest -H 'content-type: application/json' \
     -d '{"task":{"title":"OrcaTab 多 agent","projectName":"orcatab","contextPath":"/Users/bb00/workspace/orcatab"},"limit":5}' \
     | jq '{n:(.suggestions|length), top:[.suggestions[0]|{score,agent,reasons:[.reasons[].label]}]}'   # n>0，带 score+reasons
   SID=$(curl -sf "$B/spp/v1/sessions?limit=1" | jq -r '.sessions[0].sessionId')
   curl -sf -XPOST $B/spp/v1/status -H 'content-type: application/json' \
     -d "{\"refs\":[{\"providerId\":\"orcatab\",\"sessionId\":\"$SID\"}],\"since\":1780000000000}" \
     | jq '.statuses[0]|{state,newActivityCount}'                                              # state 合法, newActivityCount 数字
   AG=$(curl -sf "$B/spp/v1/sessions?limit=1" | jq -r '.sessions[0].agent')
   curl -sf "$B/spp/v1/sessions/orcatab/$SID/action" | jq '{kind,url}'                          # kind∈switch/resume/manual, url=orcatab://...
   curl -s -o /dev/null -w '%{http_code}' -XOPTIONS $B/spp/v1/sessions                          # 204
   curl -s -o /dev/null -w '%{http_code}' "$B/spp/v1/sessions/notaprovider/x/action"            # 404
   kill %1
   ```
3. `git status --porcelain` 为空。

## Deliverable
`tasks/REPORT-SPP1.md`（≤ 12 行）：新增/改动文件（行数）、自行拍板的决定、验收 1–3 实际数字、commit hash。BLOCKED 规则同前。
