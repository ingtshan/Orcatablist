# OrcaTab

Claude Code 会话面板：按项目聚合、最近输入倒序、零 token 摘要、`orcatab://claude/<sid>` 一键回到 Orca 的 tab、中文全文搜索。

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

详细设计与数据契约见 [`docs/PLAN.md`](docs/PLAN.md)。
