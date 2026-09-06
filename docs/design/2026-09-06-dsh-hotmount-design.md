---
title: dsh-profile-guard hotmount 设计文档（③ CLI 路径免重启热挂载）
date: 2026-09-06
status: draft-for-user-review
version: 0.1
category: design
project: G:\deepseek\opensource\dsh-profile-guard
---

# dsh-profile-guard hotmount 设计文档（③ CLI 路径免重启热挂载）

## 1. 背景与问题

**定位**：用户"急需但市场缺/不适配/冲突插件"四件套之三。① 装后保险（guard boot/snapshot/restore）已交付；② 装前拦截 + install 闭环（guard preflight/install）已交付（v0.2）。③ 消除 CLI 直装路径的"装完必须重启"。

**痛点证据**：CLI 直装（`dsh plugin add`）装的纯 insert patch 插件只能重启生效；重启杀当前会话进程。市场 UI 路径（1.44 hot.js）已有免重启热挂载（loader Include 子树），但**未暴露给宿主外调用方**（hotMount 需宿主 ctx；HTTP 路由仅市场自身页面同源可用）。

## 2. 源码事实核查（2026-09-06，现场验证）

| 层 | 结论 | 出处 |
|---|---|---|
| 市场 hotMount | 宿主内免重启激活：读 `node_modules/<pkg>/cordis.patch.yml` → 纯 insert 行写 Include 子树 `.dsh-market/hot-N.yml`；含 config/表达式 → 拒（需重启）；client-only shim；boot 时 cleanHotDir 清场 | `dshmarket/lib/hot.js` |
| 市场 toggle 路由 | `POST /dsh-market/toggle {name, enabled}` → enabled 分支 = listHotMounts → setEntryDisabled(false) → **hotMount**；**无 agentsBusy 409 守卫**（install 路由有）；响应含 `activation: {name: verifyActivation(...)}`（live/restart 直接可读） | `dshmarket/lib/routes.js` |
| sameOrigin 门 | `request.headers.origin` + host 匹配；裸 fetch 无 Origin → 403 | `dshmarket/lib/http.js` |
| 宿主官方 API | dsh-host-plugin-inventory 仅只读 list，无激活入口 | `@deepseek-ai/dsh-host-plugin-inventory` |
| ①/② 现状 | guard install = preflight → 快照 → add → **强制重启验证**（runPostInstallVerify） | guard lib/cli.js |

**真空（精确）**：CLI 路径装纯 insert 插件免重启激活。桥 = 经 toggle 路由触发宿主内 hotMount（带 Origin header 过 sameOrigin——loopback 本地信任，toggle 无 shell 执行面，用户已确认接受）。

## 3. 目标与非目标

### 目标
1. `guard install` 装纯 insert patch 插件 → 尝试免重启热挂载；成功即 install ok（不重启）；
2. 热挂载不支持（含 config/表达式/client-only 无面/宿主不支持 include）或调用失败 → **降级现有强制重启验证**（② runPostInstallVerify 不变）——全自动分级：能热挂就热挂，不能就重启；
3. 激活确认：从 toggle 响应 `activation[name].state` 读 live/restart；
4. 兼容性护栏（用户要求，② §11.5 同款）：市场升级改路由/响应 → 403/404/解析失败 → **降级重启**，guard 绝不崩（S1 settleExit 已就位）；契约常数集中 env 可覆写。

### 非目标（明确不做）
- 不改 market/宿主源码、不打补丁（升级即丢前科）；
- 不复刻 Include 子树写入（A2 风险高：loader 是否 watch 未验证）；
- 不做主题热切换（themes.activateTheme 是市场主题页职责）；
- 不改变 ①/② 既有命令语义（install 的 dry/preflight/快照/回滚全保留）。

## 4. 命令面

`guard install` 内部行为升级（命令签名不变：`guard install <pkg> [--force] [--registry <url>] [--no-boot]`）：
```
preflight(通过?) → snapshot("preflight install <pkg>") → dsh plugin add(成功?)
  → 判定候选 patch 纯 insert?
     是 → POST toggle {name, enabled:true} (带 Origin/Host header)
           → 响应 activation[name].state === 'live'? → install ok (免重启, exit 0)
           → 非 live / 403 / 404 / 解析失败 / 网络错 → 降级重启验证
     否 → 降级重启验证 (② runPostInstallVerify 原逻辑)
  → 降级重启验证: runPostInstallVerify(宿主在跑先停 → bootOnce 强制验证, 装崩回滚)
```
新增 `guard hotmount <pkg>`（可选纯命令：仅对已装插件触发热挂载，供手动用）——若 CLI 复杂度允许，否则并入 install 不单列。

## 5. 热挂载判定（能否走 toggle 免重启）

| 候选包 patch 形态 | 走 toggle？ | 依据 |
|---|---|---|
| 纯 `- insert:` + `id/name` 行 | 是 | market parseSimplePatch 同款：仅纯 insert 可热挂 |
| 含 config 块/表达式/`disable` 等 | 否 → 重启 | hotMount 对非纯 insert 返 reason "仅支持纯 insert" |
| 无 bundle patch 且无 dsh.client | 否 → 重启 | hotMount 返 "没有可热挂载内容" |
| 无 bundle patch 但有 dsh.client | 是（shim） | hotMount client-only shim 路径 |

**判定实现**：guard 自带纯 insert 解析（lib/contract 或 preflight 扩展）——读已装 `node_modules/<pkg>/cordis.patch.yml`，逐行校验仅 `- insert:`/`id:`/`name:` 形态（与 market parseSimplePatch 语义对齐，实现自带不依赖 market——零耦合纪律）。**兜底**：判定为纯 insert 但 toggle 实际返回 reason（非纯 insert 被拒）→ 降级重启，判定错误不致命。

## 6. 实现要点（文件级）

- 新建 `lib/mount.js`：`tryHotMount(pkg, { profile, baseUrl, origin, timeoutMs })` → `{ ok, state?, reason?, degraded? }`
  - POST `${baseUrl}/dsh-market/toggle` body `{name: pkg, enabled: true}`，headers `Origin: ${origin}`、`Host: ${origin host}`、content-type json
  - 读响应 `activation[pkg].state`（live → ok；restart/其它 → ok:false degraded:true + reason）
  - 403（untrusted origin）/404（路由变）/网络错/非 JSON → ok:false degraded:true（降级重启，绝不崩）
  - 复用② S1 settleExit 纪律（fetch 后 exit 用 exitCode+settle）
- 修改 `lib/cli.js` install 分支：add 成功后 → 判纯 insert？ → tryHotMount 成功 → 免重启 exit 0；否则 → 现有 runPostInstallVerify
- 契约常数扩展 `lib/contract.js`：`marketTogglePath()`（env `DSH_GUARD_MARKET_TOGGLE_PATH` || "/dsh-market/toggle"）、`marketOrigin()`（env `DSH_GUARD_MARKET_ORIGIN` || "http://127.0.0.1:3080"）、`marketBaseUrl()`（env `DSH_GUARD_MARKET_BASE` || "http://127.0.0.1:3080"）——官方/市场升级改路径或端口，env 即可适配不崩
- 纯 insert 判定：`lib/patch.js`（从 preflight.patchInsertIds/check 逻辑提炼）或复用——计划阶段定归属

## 7. 安全与权限

- tryHotMount 只读本地 profile + 一次 loopback POST（toggle 无 shell 执行面，仅热挂载/热切换）；
- Origin/Host header 仅用于过市场 sameOrigin 门（loopback 本地信任，与桌面端同源模型一致——用户已确认接受）；绝不外发到非 loopback 地址（baseUrl 仅 127.0.0.1）；
- 热挂载失败降级重启 = ② 既有安全路径（快照/回滚保留）；
- 无凭据落盘；不新增第三方依赖。

## 8. 兼容性护栏（用户要求，沿用 ② §11.5 全部六条）

1. **防御性读取**：toggle 响应解析全容错（非 JSON/字段缺失 → degraded 不崩）；
2. **降级而非静默**：任何热挂载失败路径都打印降级原因（"hot-mount unavailable (reason); falling back to restart verification"）——用户可见；
3. **契约常数集中 + env 覆写**：market 路由路径/Origin/baseUrl 全进 contract.js（DSH_GUARD_MARKET_*）；
4. **版本宽容**：不依赖市场版本号判定（行为探测：403/404/响应形状 = 降级信号）；
5. **零运行时耦合**：lib 仍不 import @deepseek-ai/*（contract 测试持续断言）；不 import market 任何模块；
6. **防崩溃兜底**：S1 settleExit 纪律覆盖新 fetch 点；顶层 catch 可读错误。

## 9. 与 ①/②/市场的关系

| 路径 | 装前 | 装中 | 激活 | 装后保险 |
|---|---|---|---|---|
| market UI | deriveHostCompatibility | pnpm add | **hotMount 免重启**（宿主内） | 快照/回滚 |
| guard install（升级后） | preflight(②) | add | **toggle→hotMount 免重启**（纯 insert）/ 重启(②) | snapshot/boot/restore(①) |
| 裸 dsh plugin add | 无 | add | **重启**（现状，③消除） | 无 |

## 10. 发布

随 dsh-profile-guard（0.2.0 → 0.3.0 minor）；README install 行更新说明"纯 insert 插件免重启激活，其余自动重启验证"；新增 env 键文档。

## 11. 开放问题（待实现阶段定）

1. `guard hotmount <pkg>` 单列命令是否做（并入 install 的最小范围 vs 单独暴露手动触发）；
2. 纯 insert 判定函数归属（新 lib/patch.js vs 复用 preflight 内部）——计划阶段定；
3. toggle 403 在真实宿主是否出现（Origin header 构造是否够）——需一次真机冒烟验证（guard 在宿主外，market 在 3080；sameOrigin 比对 origin.host === host header——node fetch 设 Origin 头应可过，但 host header 默认 127.0.0.1:3080 与 origin http://127.0.0.1:3080 匹配；真机验证兜底）。

## 12. 后续待命（非本次范围）

- ④ 手机远程稳定入口；
- peerDependencies 检查（② 列为未来增强）。
