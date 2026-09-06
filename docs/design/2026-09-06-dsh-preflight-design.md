---
title: dsh-profile-guard preflight 设计文档（深度兼容预检门）
date: 2026-09-06
status: draft-for-user-review
version: 0.2
category: design
project: G:\deepseek\opensource\dsh-profile-guard
---

# dsh-profile-guard preflight 设计文档（② 深度兼容预检门）

## 1. 背景与问题

**定位**：用户"急需但市场缺/不适配/冲突插件"四件套之二。① 装机保险（guard boot/snapshot/restore）已交付：CLI 直装路径的**装后**快照与自动回滚。② 补同一路径的**装前**拦截——在 `dsh plugin add` 执行之前拒绝"装了必崩"的候选包。

**痛点证据**：
- tool-lens 事故（2026-09-05）：`@trench-xinxin/dsh-tool-lens` 把 `@deepseek-ai/dsh-tools` 等宿主 core 写进 prod `dependencies` → pnpm 从 npm 拉旧副本（`dsh-tools latest = 0.0.1-rc.1` vs 宿主 `0.1.2-rc.1`）进 profile node_modules → 遮蔽宿主注入 → plugin tree failed → profile 重置。
- dshmarket 1.44 的 `deriveHostCompatibility` 只查 `engines.dsh`/peer——**永远看不到 prod `dependencies` 里的 @deepseek-ai/* core**（已核实 routes.js/check.js）。CLI 直装路径无任何预检。

## 2. 源码事实核查（2026-09-06，现场验证）

| 层 | 结论 | 出处 |
|---|---|---|
| dsh CLI plugin | 薄 pnpm 转发器，无 preflight/hook 点；拦截只能在 CLI 之外做包装 | `dsh/lib/plugin-*.js` |
| dshmarket 1.44 | install/update 路由内置 `deriveHostCompatibility` 拒绝（engines/peer 面）+ `--force` 逃生口 + 装后 soft-incompatible 软检查；**不查 prod deps @deepseek-ai/*** | `profiles/web/node_modules/dshmarket/lib/routes.js`、`check.js` |
| market 核心包清单 | `corePackageNames(hostDir)` 从宿主安装目录读 @deepseek-ai/* 包名 | `dshmarket/lib/check.js` |
| npm registry | 腾讯镜像 `registry.npmmirror.com` 可 fetch manifest（已实测 dsh-better-edit/dsh-tools） | — |
| 宿主版本 | 0.1.2-rc.1（全局 `@deepseek-ai/dsh` package.json） | — |

**真空（精确）**：CLI 直装路径的**装前** prod-deps core 遮蔽检测。market UI 路径已自保（虽然判定面有盲区）；`guard install` 包装使 CLI 路径第一次拥有强制拦截。

## 3. 目标与非目标

### 目标
1. `guard preflight <pkg>`：装前读候选包 manifest，拒绝"装了必崩"的包（exit 1），`--force` 放行；
2. `guard install <pkg>`：preflight → snapshot（装前快照）→ 执行 `dsh plugin add` → `guard boot`（装后验证，失败自动回滚）——一次原子动作闭环；
3. 判定独立于 dshmarket（自带 core 包清单副本，dshmarket 升级不丢——②存在的理由）；
4. 全部离线可测（registry 层 stub，判定纯函数）。

### 非目标（明确不做）
- 不改 dsh CLI、不改 dshmarket、不打本地补丁（升级即丢前科）；
- 不重造 market 已有逻辑（engines/peer 判定可参考其语义，但实现自带）；
- 不做 ⚠️ soft-incompatible 软判定（保持 confirmed 强度，避免误伤生态）；
- 不改 ① 的既有命令/测试（preflight 是纯增量）。

## 4. 命令面

```
guard preflight <pkg> [--force] [--registry <url>]   # 纯检查：exit 0 通过 / 1 拒绝 / 2 用法错
guard install <pkg> [--force] [--registry <url>]     # 闭环：preflight → snapshot → dsh plugin add → guard boot
```

- `<pkg>` = npm 包名（`dsh-something`、`@scope/name`、`@scope/name@version`）；不支持 git spec（`github:` 等）——市场 UI 覆盖 git 源，CLI 预检专注 npm 源（tool-lens 即 npm 源）。
- `--force`：core 遮蔽命中仍放行（stderr 大字警告 + 打印风险），其余判定不可 force。
- `--registry`：默认 `https://registry.npmmirror.com`（中国区可用，KB 实锤）；可换官方 registry。
- `guard install` 的 snapshot reason = `preflight install <pkg>`。

## 5. preflight 判定（命中即 exit 1；仅 core 遮蔽可 --force）

| 检查 | 判定 | 依据 |
|---|---|---|
| **core 遮蔽**（主，唯一可 force） | prod `dependencies` 含任一宿主 core 包名 → 拒 | tool-lens 实锤；core 清单 = 自带副本（见 §6） |
| **host engines/peer** | `dsh.engines`/`engines.dsh` 声明存在且不满足宿主 0.1.2-rc.1 → 拒 | market deriveHostCompatibility 同款语义；仅 confirmed mismatch 拒，无声明放行 |
| **bundle patch 撞 id** | 候选包 cordis.patch.yml 的 insert id 与已装插件（profile cordis.patch.yml 合成）重复 → 拒 | dup loader entry id = boot 硬失败 |
| **registry 解析** | 包/版本不存在或 manifest 不可读 → exit 1 明确报错 | — |

**顺序**：registry 解析最先（后续检查需 manifest）→ core 遮蔽 → engines/peer → patch 撞 id。全部通过 exit 0，打印通过摘要。

## 6. 核心包清单（自带副本）

`lib/core-packages.js` 导出 `CORE_PACKAGES`（数组）：当前与宿主 0.1.2-rc.1 对齐的宿主注入命名空间包名：
`dsh-tools`、`dsh-util-values`、`cosmokit`、`schemastery`、`dsh-client-runtime`、`dsh-agent-presets`、`dsh-llm`、`dsh-session`、`dsh-agent`、`dsh-code-runtime`、`dsh-host-webserver` 等（以宿主安装目录 node_modules/@deepseek-ai 顶层为权威——preflight 运行时动态读 `resolveDshBin` 同源宿主目录，与 market `corePackageNames` 语义一致；静态清单作 fallback）。

判定 = 候选包 `dependencies`（不含 devDependencies/peerDependencies——pnpm 只 hoist prod deps）的 key 与 core 清单交集非空 → core-shadow。

## 7. 实现要点（文件级）

- 新建 `lib/registry.js`：`fetchManifest(pkg, registry)` → parsed manifest | throw（含 version 解析 `name@version`、404 处理、超时）；registry 经 env `DSH_GUARD_REGISTRY` 可换。
- 新建 `lib/preflight.js`：`preflight(pkg, { profile, registry, hostVersion, corePackages, installedPatches })` → `{ ok, verdicts: [{code, severity, message}], manifest }` 纯函数；网络层与判定层分离（测试注入 manifest 不联网）。
- 新建 `lib/core-packages.js`：core 清单（静态 fallback + 动态宿主目录读取）。
- 修改 `lib/check.js`：现有 `staticCheck` 的 CORE_NAMES 复用 core-packages.js（避免两处清单漂移；行为不变）。
- 修改 `lib/cli.js`：新增 preflight/install 两分支（argv 解析、--force/--registry、退出码 0/1/2）。
- `guard install` 流程：preflight(ok? 继续 : exit 1) → `snapshot(reason:"preflight install <pkg>")` → spawn 全局 dsh bin `plugin --profile <p> add <pkg>`（resolveDshBin 已证可定位；失败 → 报告 + 建议 `guard restore`）→ `bootOnce`（验证装后宿主健康；失败自动回滚为 ① 既有能力）。
- 测试：`test/preflight.test.js`（fixture manifest 覆盖判定矩阵：core-shadow/engines/dup-id/ok/force/404）、`test/registry.test.js`（本地 http server stub manifest）、`test/cli.test.js` 追加 preflight/install 安全用例（install 不真装——注入或跳过真 spawn 分支，注明）。

## 8. 安全与权限

- preflight 纯只读（fetch manifest + 读本地 profile/宿主目录）；
- install 涉及写 profile 与 spawn pnpm/dsh —— 运行时需 workspace-write/danger-full-access 批准（与 ① restore 同级）；
- 无凭据落盘；manifest 只读不缓存到磁盘（或仅内存）。

## 9. 与 ①/市场的关系

| 路径 | 装前拦截 | 装后保险 |
|---|---|---|
| market UI | dshmarket 1.44 deriveHostCompatibility（engines/peer 面） | market 快照/回滚 |
| dsh-desktop 工坊 | 桌面端 createBackup+op marker | 桌面端 restoreAndReport |
| **CLI 直装（guard install）** | **guard preflight（②，含 prod deps core 遮蔽面）** | **guard snapshot/boot/restore（①）** |

## 10. 发布

随 dsh-profile-guard 同一 npm 包发布（并入既有仓库/管线），README 命令表加 preflight/install 两行；版本 0.1.0 → 0.2.0（新能力 minor）。

## 11. 开放问题（待实现阶段定）

1. install 的 `dsh plugin add` spawn 失败语义：是否自动建议 restore（不自动执行，尊重用户）；
2. `bootOnce` 装后验证在无 healthy 快照时（全新 profile）的行为（沿用 ① 语义：不循环回滚）；
3. 是否支持 `guard install` 的 `--no-boot`（只装不验证）——默认真实验证，逃生口待用户需时加。

## 11.5 兼容性与官方破坏性更新防护（项目级硬约束，覆盖 ①+② 全部模块）

**要求来源**：用户复核规格时提出——官方（@deepseek-ai/dsh）破坏性更新后插件不得直接崩溃。

**审计结论（2026-09-06）**：guard 全部 lib 模块**零运行时 import 宿主包**（不 require/import 任何 @deepseek-ai/* 或 cordis 运行时）——官方升级导致 import 错配/SyntaxError 崩溃的路径天然不存在（tool-lens 事故正是宿主内插件的死法，guard 宿主外免疫）。但 guard 依赖 6 个**磁盘/CLI 契约点**，官方破坏性更新改这些点时，guard 不会崩而是**静默行为错**（更危险）：误判在线、快照写错位置、回滚不触发、preflight 漏检。

### 契约点清单（升级宿主时逐项核对）
| # | 契约点 | guard 用法 | 官方改动风险 |
|---|---|---|---|
| C1 | CLI 入口 `<dsh>/lib/bin.js web --no-open` | host.js spawnHost 拉宿主 | 入口路径/参数改名 |
| C2 | 在线 marker `__DSH_BOOT__` / 401 "authentic" | probe.js 判宿主在线 | marker 文本变化 → 误判离线/在线 |
| C3 | manifest schema `dsh.profile.bundles` + dependencies | snapshot/rollback/watch 读写 | schema 字段改名/移动 |
| C4 | cordis.patch.yml 顶层 `- insert:` + `name:` | check.js dup-id 检测 | patch 格式演进 |
| C5 | boot 失败文本 `plugin tree failed` 等 | boot.js isPluginFailure 触发回滚 | 错误措辞变化 → 回滚永不触发 |
| C6 | 宿主版本号语义（0.1.2-rc.1） | preflight engines/peer 比对 | 版本格式/频道变化 |

### 防护策略（每条落为代码要求，测试覆盖）
1. **防御性读取（所有 C3/C4）**：manifest/patch 解析全部容错——读不到 `dsh.profile.bundles` 按空处理并 warn，绝不 throw；schema 未知字段**保留原样写回**（不做破坏性重写）。已有 readManifest 返 null 语义，扩展：任何结构假设（`.dsh.profile` 存在）都经可选链 + 默认值。
2. **降级而非静默（C2/C5）**：`guard check` 增加"契约探测"段——启动时探测 6 个契约点，任何一点与预期不符 → 输出 `[warn] host contract C<n> changed: <observed>` 到报告/stderr，**绝不静默继续**。C5 失败文本探测不到时，boot 失败走保守路径：不自动回滚、打印"无法判定是否插件故障（宿主错误文本可能已变）"、提示用户看日志（宁可少自动回滚，不可误回滚）。
3. **契约常数集中 + 可覆写**：C1/C2/C5 的字符串常量集中到 `lib/contract.js` 单文件，支持 env 覆写（`DSH_GUARD_BOOT_MARKER`、`DSH_GUARD_FAIL_TEXT` 等），官方更新后无需改代码即可适配。
4. **版本门（C6）**：preflight engines 比对用宽容 semver（未知频道/预发布按"无声明放行"语义，不误杀）；宿主版本读不到 → 所有依赖版本的判定走"unknown → 不拒绝"（与 market 同款：absence of claim is not a verdict）。
5. **零运行时耦合硬约束**：lib 任何文件不得 import @deepseek-ai/* 运行时包（git hook/CI 检查可在测试中实现：扫描 lib/*.js 的 import 语句断言无 @deepseek-ai 前缀——已审计现状满足）。
6. **防崩溃兜底**：guard 任何内部异常（含读宿主文件 EACCES/格式崩坏）都被顶层 catch 捕获 → 打印可读错误 + 退出码，绝不裸 stack trace 退出；install/boot 在 preflight/快照失败时中止动作但不破坏 profile 现场（① 的 crash 备份兜底）。

### 测试要求
- `test/contract.test.js`：构造"宿主契约已变"的 fixture（改 marker 文本/改 manifest schema/改失败文本/无版本）→ 断言 guard 不崩、行为降级正确（warn 输出、不误回滚、不误拒绝）。
- 现有测试全部沿用（契约默认值下绿）；契约探测段为纯增量。

## 12. 后续待命（非本次范围）

- ③ 免重启热挂载 / 安全重启编排；
- ④ 手机远程稳定入口。
