# dsh-profile-guard remote 实施计划（④ 手机远程稳定入口）

> **面向 Agent 执行者：** 使用 superpower-subagent-driven-development 逐项执行。步骤用复选框跟踪。

**目标：** guard remote 子命令——读 host-last.log 取最新 announce token → 验证 303 → 输出当前可用手机访问 URL（Tailscale 优先），免人肉挖日志。

**架构：** 纯 Node ESM 零依赖扩展。新增 lib/remote.js（readHostLog/extractAnnounce/buildRemoteInfo 纯函数可注入）；lib/contract.js 加 hostLogPath/remotePort（env 覆写）；lib/cli.js 加 case "remote"（--json/--lan/--show-token）；probe.js 加 fetchStatus（验证 303/401）。

**技术栈：** Node ≥ 20（本机 v24.19.0），ESM，node:test；host core 0.1.2-rc.1；tailscale ip 只读调用。

**规格：** docs/design/2026-09-07-dsh-remote-design.md（v0.1）。计划论证以规格为准。

## 全局约束
- 项目根 G:\deepseek\opensource\dsh-profile-guard（master @ cf1928a 含①②③ + ④ 设计；129 测试绿）。
- 兼容护栏 §11.5 六条沿用（每任务）：零 @deepseek-ai/cordis import（contract.test 扫描持续断言）；防御性读取容错不崩；降级不静默；契约常数 env 覆写；S1 settleExit 纪律（remote fetch 后 exit 用 settleExit）；顶层 catch 可读错误。
- 零第三方依赖；ESM；Node ≥ 20；测试 `node --test-isolation=none --test test/*.test.js`（run_code 通道）。
- 现有 129 测试全绿基线；每任务后全量全绿。
- 测试隔离：remote 测试用注入 log 文本 + 本地 stub 验证 303/401 + fake tailscale（绝不动真实 host-last.log/tailscale/3080）。
- 人类可读模式 token 脱敏（前 6 + ...）；--json 含 token（文档警示）；--show-token 才全显。
- 版本 0.3.0 → 0.4.0。

## 文件结构
```
lib/remote.js       # 新建：readHostLog/extractAnnounce/buildRemoteInfo
lib/contract.js     # 修改：hostLogPath/remotePort
lib/probe.js        # 修改：fetchStatus（验证 303）
lib/cli.js          # 修改：case "remote"
test/remote.test.js # 新建
test/contract.test.js / test/probe.test.js / test/cli.test.js  # 修改
```

---

### 任务 0：lib/remote.js 核心（token 提取 + URL 构造纯函数）

**文件：** 新建 lib/remote.js、test/remote.test.js

**接口：**
- `readHostLog(logPath)` → 文本 | null（缺失/不可读 null）
- `extractAnnounce(text)` → { token, lanUrl? } | null（取**末尾**含 `dsh web: http://127.0.0.1:PORT/?token=` 行；解析 token 与可选 `(LAN: http://ip:port/?token=...)`）
- `buildRemoteInfo({ logText, tailscaleIp, port, verify })` → { ok, url, token, verified, tailscaleUrl?, lanUrl?, error? } 纯函数（verify 注入：status 303→true）
  - tailscaleIp 有 → url=tailscaleUrl；否则 lanUrl（extractAnnounce 的 LAN）→ url=lanUrl；都无 → ok:false error
  - token 缺失 → ok:false error "no announce token found"
  - verify 注入 false → verified:false + error 提示（不 ok:false——URL 仍给但标注 stale？**裁决**：verified:false 时 ok:false + error"token stale, host restarted?"——手机需要有效 token，stale 即不可用）

**测试：** 注入 fixture log 文本（多条 announce 取末条、无 token 行、LAN 变体、空/缺失）；verify 注入 303→verified / 401→ok:false；tailscaleIp 有/无。6-8 用例。

### 任务 1：contract + probe 扩展

**文件：** 修改 lib/contract.js、lib/probe.js + 各自 test

**接口：**
- contract.hostLogPath() → env DSH_GUARD_HOST_LOG || "%APPDATA%\dsh-desktop\host-last.log"（process.env.APPDATA 解析）
- contract.remotePort() → env DSH_GUARD_PORT || 3080
- probe.fetchStatus(url, timeoutMs) → Promise<number|null>（GET 返回 statusCode；网络错 null；复用 probeBase 语义）

**测试：** contract 默认/env 覆写；probe.fetchStatus 本地 stub 200/303/404/拒连→null。

### 任务 2：cli remote 命令

**文件：** 修改 lib/cli.js、test/cli.test.js

**接口：** case "remote"：读 hostLogPath → extractAnnounce → buildRemoteInfo（tailscale ip spawn 真实但 try/catch；verify=fetchStatus 303）→ 输出（人类可读脱敏 / --json 全量 / --lan 强制 LAN）；--show-token 全显；settleExit。exit 0 可用 / 1 不可用。

**测试：** 人类模式脱敏（token 前 6）；--json 含 token；--show-token 全显；tailscale 失败降级 LAN（注入）；token stale → exit 1 + 提示；缺 log → exit 1。本地 stub 验证。

### 任务 3：README + v0.4.0 + 回归

**文件：** package.json/README.md/README.zh.md

**接口：** version 0.4.0；README 加 remote 命令 + 安全说明（token 脱敏/--json 警示）；双语 code span 校验；全量 129+新 绿。

## 自检记录
- 规格覆盖：§4 命令面→T2；§5 token 提取/验证/URL→T0/T1；§6 护栏→全局约束；§7 安全（脱敏/只读）→T2/约束；§8 发布→T3；§9 开放问题→T0/T2 裁决（tailscale 失败降级 LAN；announce 无 LAN 报错提示；--json 含 token 文档警示）。
- 占位符：无 TODO/TBD。
- 类型：buildRemoteInfo 返回形状 T0/T2 一致；fetchStatus T1/T2 一致；extractAnnounce T0/T2 一致。
