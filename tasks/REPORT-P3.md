# REPORT-P3
文件：README.md — 54 行<br>public/index.html — 428 行
文件：scheme/handler.applescript — 6 行<br>scheme/install.sh — 30 行（755）<br>scheme/uninstall.sh — 12 行（755）
文件：test/db.test.ts — 127 行<br>test/server.test.ts — 118 行<br>tasks/REPORT-P3.md — 10 行
决定：安装脚本先定位仓库根再执行工单指定相对路径；bundle id 采用 set-or-add、URLTypes 仅缺失时添加，卸载时 app 不存在即成功退出；`src/focus.ts` 保持未改。
决定：基线代码的 SCHEMA_VERSION 已为 `"2"`，故把并发读测试中陈旧的硬编码 `"1"` 改为与当前 writer 值比较，仅修复测试断言，不改 DB 逻辑。
验收 1：`bash -n` PASS；handler 在两个临时 App 覆写编译 PASS；同一 PlistBuddy 操作实测得到 id `dev.local.orcatab`、name `OrcaTab`、scheme `orcatab`。
验收 2：`bun test` 53 pass / 0 fail / 162 expect；`bun x tsc --noEmit` exit 0；`git diff --check` PASS。
验收 3：README 表恰含四项，默认值 `47831` / `~/.claude` / `~/.orcatab` / `orca`，与 PLAN 和 config 一致；未运行 install/uninstall、lsregister、pm2、~/Applications osacompile 或 Orca 终端命令。
实现 commit：`PENDING`
