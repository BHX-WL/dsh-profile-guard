---
title: dsh-profile-guard 设计文档（装机保险）
date: 2026-09-06
status: draft-for-user-review
version: 0.1
category: design
project: G:\deepseek\opensource\dsh-profile-guard
---

# dsh-profile-guard 设计文档（装机保险）

## 1. 背景与问题

**用户目标**：写出「我们现在急需但插件市场没有/不适配/冲突」的插件。本插件是四件套的第一个（其余三个待命：深度兼容预检门、免重启热挂载、手机远程稳定入口）。

**痛点证据（知识库实锤）**：
- 2026-09-05 两次插件装崩事故：
  1. `@nanmicoder/dsh-agent-teams` → 宿主启动抛 `TypeError` → profile 自动重置为 2 bundle；
  2. `@trench-xinxin/dsh-tool-lens` 经 `dsh plugin add` 直装（8 插件一批）→ 把 `@deepseek-ai/dsh-tools` 等写进 prod deps → pnpm 从 npm 拉旧副本遮蔽宿主 core → plugin tree failed → profile 再次重置为 2 bundle。
- 恢复全靠人肉：从 zstd 会话存档挖崩溃前 manifest 重建。工具链（market install / desktop 工坊）都有保险，**唯独 CLI 直装路径裸奔**，而两次事故走的正是这条路。

## 2. 源码事实核查（2026-09-06，逐条现场验证）

| 层 | 结论 | 出处 |
|---|---|---|
| 宿主 boot | `boot()` 挂载任一 bundle 失败 → `stage="plugin tree failed to load"` → dispose 后 throw。宿主自身**不备份、不降级、不重置**。崩溃发生在任何 bundle 激活之前。 | `@deepseek-ai/dsh-app-boot/lib/index.js` |
| dsh CLI plugin | 薄 pnpm 转发器（`spawnSync("pnpm", args)`），装完仅 `reconcilePlugins` 重写 bundles。**无快照、无回滚、无预检**。 | `@deepseek-ai/dsh/lib/plugin-*.js`、`lib/bin.js` |
| dsh-desktop | 工坊路径每次操作前 `createBackup`（排除 node_modules，含 deps/bundles/app 哈希）+ `writeOpMarker` + 重启失败 `restoreAndReport` 自动恢复 + EADDRINUSE 智能跳过。**成熟，勿重造**。 | `G:\deepseek\dsh-desktop\main.js` |
| dshmarket 1.44 | 自带快照/回滚（`snapshot.js`/`presets.js`）、深层兼容检查（含 @deepseek-ai core 遮蔽检测，即 tool-lens 事故模式）。**市场 UI 路径已被上游补齐**。 | `profiles/web/node_modules/dshmarket/lib/*.js` |
| 「重置为 2 bundle」写者 | **宿主与桌面端源码均无此逻辑**；`package.json.bak-reset` 为人工保留现场 → **列为 spike 项**，实现前用受控实验确认。 | — |

**结论：真空只有一处——CLI 直装路径。** 快照必须由宿主外的独立组件承担。

## 3. 目标与非目标

### 目标
1. 每次「经 guard 启动宿主」前自动快照当前 profile 健康态；
2. 宿主启动失败（plugin tree failed / host preparation failed）时，自动回滚到**最近一个健康快照**并**自动重拉宿主一次**；
3. 输出可读报告（恢复前 bundles → 恢复后 bundles、崩溃原因、快照 id），中文为主；
4. 纯 CLI / Node 脚本，不依赖 dsh-desktop；可发布为通用开源工具；
5. 提供 `guard watch`（A2）作为辅助：常驻监听 package.json 变更，及时留档。

### 非目标（明确不做，避免与既有体系冲突）
- 不重复 dshmarket 的快照/回滚（市场 UI 路径已自保）；
- 不重复 dsh-desktop 工坊备份链（工坊路径已自保）；
- 不把自身装进 profile 的 `dsh.profile.bundles`——崩溃发生在任何 bundle 挂载前，插件自保不可能，必须宿主外；
- 不改宿主源码、不打 dshmarket 本地补丁（升级即丢，前科）；
- 不做装前兼容判定（那是②深度预检门的工作）。

## 4. 命令面（A1 主 + A2 辅助）

```
guard boot [--profile web] [-- dsh 参数...]    # 启动宿主：快照→拉起→健康探活→失败回滚→自动重拉一次
guard snapshot [--reason "安装 xxx"]           # 手动快照（纪律化：装插件前调用）
guard list                                     # 快照列表（id/时间/原因/是否 healthy）
guard show <id>                                # 快照详情（bundles/deps/哨兵清单）
guard restore <id> [--no-auto-restart]         # 手动回滚到某快照
guard check                                    # 预检当前 profile 健康度（只读）
guard watch [--profile web]                    # A2：常驻监听，检测变更自动快照
```

## 5. 快照设计

**位置**：`~/.dsh/guards/<profile>/`（与 profiles/ 平级，宿主外；不受 profile 重置影响）。

**内容（轻量，用户已确认）**：
- `package.json` 全文（含 dependencies 与 dsh.profile.bundles）；
- deps 清单（顶层 keys）+ bundles 清单；
- `node_modules/@deepseek-ai` 顶层目录清单 —— **@deepseek-ai core 遮蔽哨兵**（tool-lens 事故核心：npm 旧副本进 profile node_modules 遮蔽宿主注入）；
- 快照元数据：createdAt / reason / dshVersion / healthy 标记 / manifest 哈希。

**不整备 node_modules**（pnpm install 可重建；与桌面端同策略；快照轻、秒级完成）。

**保留策略**：滚动保留最近 **5** 份（环境变量 `DSH_GUARD_KEEP` 可调）。快照分两类：
- `healthy`（= 该状态下宿主成功启动过）——回滚只允许回到 healthy 快照；
- `pending`（= guard boot 启动前刚拍的当前态，尚未验证）——启动成功后晋升 healthy。

**写盘原子性**：写临时目录 → 校验 → rename 到位，防半截快照。

## 6. 启动与回滚语义（guard boot）

```
guard boot:
  1. 检查 ~/.dsh/guards/<profile>/ 是否有 pending 快照未结算（上次崩溃现场）
  2. 读当前 package.json → 若与最近快照 manifest 哈希不同，先拍 pending 快照
  3. 拉起宿主（spawn dsh web --no-open 同款，等价桌面端 hostLaunchSpec）
  4. 健康探活：HTTP 探测（__DSH_BOOT__ 特征 / 401 auth marker）+ 宿主日志无 "plugin tree failed" 
  5a. 成功 → 将 pending 快照标记 healthy；继续驻留转发日志（同桌面端做法）
  5b. 失败（日志含 plugin tree failed 等）→ 进入回滚：
      - 跳过条件：EADDRINUSE（端口被旧进程占，非插件问题，桌面端同款判断）
      - 取最近 healthy 快照 → 停宿主 → 恢复 package.json（manifest 全文写回）
        → 执行 reconcile（bundles 与依赖同步）→ 重拉宿主一次
      - 重拉成功 → 报告「已回滚到快照 X 并重启成功」
      - 重拉仍失败 → 停在健康态 + 写 restore-report（不无限重试）
  6. 任何恢复动作前先备份「当前坏态」到 guards/<profile>/crash-<ts>/（防误判丢现场，
     呼应 .bak-reset 教训：人肉恢复时曾有备份缺失问题）
```

**失败报告（restore-report.md）**：恢复前 bundles → 恢复后 bundles、崩溃原因（host 日志 tail）、回滚的快照 id、发生时间。中文。

## 7. 健康判定（guard check，只读）

- 静态：
  1. package.json 可解析，dependencies 完整；
  2. bundles 中每项能 resolve（`exportsPatch` 同款判定：包存在且声明 dsh.bundle.patch）；
  3. 无 duplicate loader entry id（复刻 dshmarket conflictingEntryIds 行式解析 cordis.patch.yml insert）；
  4. `node_modules/@deepseek-ai` 顶层无 core 遮蔽（与宿主 core 版本比对）。
- 动态（可选 `--boot`）：拉起宿主做真实启动验证。

## 8. Spike 项（实现前必须确认）

1. **「重置为 2 bundle」写者归属**：受控实验——故意装一个坏 bundle → 重启 → 观察谁把 package.json 写成 2 bundle。决定 guard 要不要对抗/配合它。
2. **guard boot 与宿主进程关系**：桌面端当前由 dsh-desktop 拉起（`dsh-desktop.exe` → `node .../dsh/lib/bin.js web --no-open`）。CLI 直装后手动重启宿主的真实操作路径是「用户跑 restart-web.ps1 / 市场 restart 端点」——guard boot 需能替代这条路径（透传 dsh web 全部参数）。

## 9. 安全与权限

- 只读写 `~/.dsh/guards/` 与 `~/.dsh/profiles/<profile>/package.json`；
- 快照内不含凭据/密钥；报告脱敏（token、authorization 头不落盘，同桌面端 M5 约定）；
- 恢复涉及写 profile 与 pnpm install —— 运行时需 workspace-write/danger-full-access 批准；
- 不做任何网络外联（纯本地工具）。

## 10. 发布计划（复用既有管线）

- 目录：`G:\deepseek\opensource\dsh-profile-guard`（独立 git 仓库，已 init）；
- 包名：`dsh-profile-guard`，二进制 `guard`；
- LICENSE MIT + README.md / README.zh.md + `keywords: [dsh-plugin]` + FUNDING.yml；
- 发布源：GitHub + Gitee 镜像（与 dsh-approval-reminder 同管线：本地 push gitee → 镜像同步 GitHub）；
- npm 发布与否待定（scope 决策：dsh-approval-reminder 用 `@dsh-external` 内部分发，本次可对比评估）。

## 11. 开放问题（待用户/实现阶段定）

1. spike 结论（§8.1）可能改变回滚触发设计；
2. `guard boot` 与现有 restart-web.ps1 的关系：替代 or 共存（实现时提供 `guard boot` 直接透传，restart 脚本可改为调用 guard）；
3. watch（A2）常驻形态：独立进程 or 由任务计划/宿主 automation 拉起。

## 12. 后续待命（非本次范围）

- ② 深度兼容预检门：@deepseek-ai core 遮蔽的**装前**拦截（dshmarket 升级不丢的独立实现）；
- ③ 免重启热挂载 / 安全重启编排（市场 hot.js 已有雏形，评估差距）；
- ④ 手机远程稳定入口（token 一键取 + 竖屏适配）。
