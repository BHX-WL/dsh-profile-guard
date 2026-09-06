---
title: dsh-profile-guard remote 设计文档（④ 手机远程稳定入口）
date: 2026-09-07
status: draft
version: 0.1
category: design
project: G:\deepseek\opensource\dsh-profile-guard
---

# dsh-profile-guard remote 设计文档（④ 手机远程稳定入口）

## 1. 背景与问题

**定位**：用户"急需但市场缺/不适配/冲突插件"四件套之四。① 装机保险、② preflight、③ hotmount 已交付（v0.3.0）。④ 解决手机远程访问 DSH 的最后痛点：**每次宿主重启 launchToken 变化（进程内随机 32B 不落盘），需人肉从 host-last.log 挖最新 announce 行 + curl 验证 303**——KB 记载多次踩坑（选旧 token 401、host-last.log 含历史大量 announce）。

**最终可用形态**（KB 2026-09-05）：手机 Edge 桌面版网站访问 `http://<Tailscale IP>:3080/?token=<当前有效 token>`（Tailscale 在线即可全功能）。token 在任意网卡地址可兑换（与 Host 无关）。竖屏 bug 定性为 remote-web-ui 上游移动层问题，用桌面版规避（不重造 UI 层）。

## 2. 源码/现状事实（2026-09-07 现场验证）

| 事实 | 结论 |
|---|---|
| host-last.log | `%APPDATA%\dsh-desktop\host-last.log`，含 53 条 announce；取**末尾**含 `dsh web: http://127.0.0.1:3080/?token=` 的行即当前进程 token（已实测） |
| announce 格式 | `dsh web: http://127.0.0.1:3080/?token=XXX (LAN: http://<lan-ip>:3080/?token=XXX ...)` |
| token 验证 | `GET http://127.0.0.1:3080/?token=X` → 303 = 有效；401 = 旧进程 token（已实测 curl 法） |
| Tailscale | `tailscale ip -4` → 100.67.129.65（已实测可拿） |
| 市场方案 | 远程插件多（remote-web-ui/full-remote/qr 配对/tunnel 等）但均非"挖当前 stock token + 拼 URL + 验证"的 CLI；dsh-full-remote 3081 有转发 bug 弃用 |

**真空（精确）**：把"挖日志 → 取 token → 拼 Tailscale/LAN URL → 验证 303"固化为 guard 子命令，一次输出当前可用的手机访问 URL（含 token），附验证状态。宿主外 CLI（guard）正合适：零运行时耦合、已有 contract/HTTP 基建。

## 3. 目标与非目标

### 目标
1. `guard remote`：读 host-last.log → 取最新 announce token → curl 验证 303 → 输出当前可用访问 URL（Tailscale IP 优先，fallback LAN IP）+ 验证状态；
2. `guard remote --json`：结构化输出（token 可另取、URL、状态、时间）供脚本/客户端用；
3. 兼容护栏沿用（§11.5）：契约常数 env 可覆写（log 路径/端口）、容错不崩（log 缺失/token 无效 → 明确报错）、零耦合；
4. 离线可测（log 路径/URL/验证注入，测试用本地 stub 验证 303）。

### 非目标（明确不做）
- 不重造 UI 层/竖屏适配（remote-web-ui 上游问题，桌面版规避已够）；
- 不做 QR 生成/配对/隧道（市场已有 remote-qr-button 等，且④ 核心是 token URL 即开即用）；
- 不启动/管理 tailscale serve（用户已有形态；guard remote 只读现状输出 URL）；
- 不改 market/remote-web-ui/dsh-full-remote。

## 4. 命令面

```
guard remote [--json] [--lan]          # 输出当前可用手机访问 URL（Tailscale 优先）
```
- 无参数：人类可读（多行：URL、token、验证状态、时间）
- `--json`：`{ ok, url, tailscaleUrl?, lanUrl?, token, verified, at, logFile }`
- `--lan`：只用 LAN IP（Tailscale 不可用时）

## 5. 实现要点

### token 提取（lib/remote.js 或 contract 扩展）
- log 路径：`%APPDATA%\dsh-desktop\host-last.log`（env `DSH_GUARD_HOST_LOG` 可覆写；读不到 → 报"host log not found at <path>；dsh-desktop 未运行？"）；
- 解析：逐行找含 `dsh web: http://127.0.0.1:3080/?token=` 的**最后**一行 → 提取 token + 可选 LAN IP；
- 兼容：announce 可能有 `(LAN: http://<ip>:<port>/?token=...)` 变体 → 解析 tailscale/lan 两 URL。

### 验证（lib/probe.js 扩展或 remote.js 内）
- `GET http://127.0.0.1:3080/?token=X` → 303/200 = valid；401/其他 = invalid（沿用 probeBase 语义，加 follow 或读 statusCode）；
- 验证失败 → 提示"token stale — host restarted? 重新运行 guard remote"。

### URL 构造
- Tailscale IP：`tailscale ip -4`（spawn；失败 → 仅 LAN URL）；
- LAN IP：announce 的 LAN URL 或本机网卡探测（简化：取 announce 内 LAN IP，announce 无则报"请用 --lan 或检查网络"）；
- URL = `http://<ip>:3080/?token=<token>`。

### 文件级
- `lib/remote.js`：`readHostLog(logPath)`/`extractAnnounce(text)`/`buildRemoteInfo({logPath, tailscaleCmd, verify})` → `{ ok, url, token, verified, tailscaleUrl?, lanUrl?, error? }` 纯函数可注入；
- `lib/contract.js`：`hostLogPath()`（env `DSH_GUARD_HOST_LOG` || 默认 %APPDATA%\dsh-desktop\host-last.log）、`remotePort()`（env `DSH_GUARD_PORT` || 3080）；
- `lib/cli.js`：case "remote"（--json/--lan）；
- 验证 HTTP 复用 `probeBase` 或 probe.js 加 `fetchStatus`。

## 6. 兼容护栏（沿用 §11.5 六条）
1. 防御性读取：log 缺失/解析失败/token 无效 → 结构化 error 不崩；
2. 降级不静默：tailscale 失败 → 明确"tailscale unavailable, using LAN"；
3. 契约常数集中 + env 覆写：hostLogPath/remotePort；
4. 版本宽容：不依赖宿主版本判定；
5. 零运行时耦合：新 lib 仅 node:fs/path/child_process + ./contract；
6. 防崩溃：顶层 catch 可读错误。

## 7. 安全
- token 是敏感值：`--json` 输出含 token（脚本用），人类可读模式默认**不打印完整 token**（打前 6 位 + ...，除非 `--show-token`）；日志只读不写；
- 只读本地文件 + 一次本地 HTTP 验证 + tailscale ip 只读命令；无网络外发。

## 8. 发布
随 dsh-profile-guard（0.3.0 → 0.4.0 minor）；README 加 remote 命令 + 安全说明（token 不落盘、--json 含 token 慎用）。

## 9. 开放问题（实现阶段定）
1. tailscale ip spawn 跨平台（Windows tailscale.exe 在 PATH？实测本机可）——失败降级 LAN；
2. announce 无 LAN IP 时的本机网卡探测（简化：报错提示 --lan 需网络检查，或读 announce LAN；实现阶段按实测）；
3. `--json` token 是否默认含（安全 vs 脚本便利）——默认含但文档警示，人类模式脱敏。

## 10. 后续（非本次）
无（四件套完成）；peerDependencies 检查、checkHostContract live 观测点为既有未来项。
