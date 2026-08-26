SPP-1：PASS
文件：src/spp.ts 251 行；src/db.ts 264 行；src/suggest.ts 114 行；src/server.ts 300 行。
文件：test/spp.test.ts 233 行；tasks/REPORT-SPP1.md 10 行。
按 R6 纳入开工基线改动：README.md 58 行；public/index.html 825 行；src/types.ts 38 行；src/worktree-focus.ts 58 行；test/server.test.ts 313 行；test/worktree-focus.test.ts 68 行；assets/orcatab-webgui.png 181532 bytes（PNG 无文本行）。
决定：suggestSessions 增加可选 contextPath；命中 cwd（精确）或 projectKey（包含）加 2 分并使用 project reason，使仅上下文命中候选可过原有 2 分门槛，旧调用不变。
决定：exclude 按 sessionId 跨 providerId 排除；status 无 since 时省略 delta；action 始终 dryRun，manual 的 url=null；cursor v1 忽略。
验收1：bun x tsc --noEmit exit 0；bun test 104 pass/0 fail/415 expect；src/spp.ts lines 98.87%（总 lines 97.12%）。
验收2：真实源临时库索引 865 sessions；list=3；q=orcatab=4；suggest n=5/top score=6；status=offline/delta=3；action=resume；OPTIONS=204；坏 provider=404。
验收3：最终 git status --porcelain=0 行；未触碰 pm2/47831，47996 smoke 进程已终止。
实现 commit：28393882543a1502324e2d0f529dea5914f746ec
