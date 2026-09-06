---
title: Spike 结论——「重置为 2 bundle」写者归属
date: 2026-09-06
status: conclusion
category: decision
project: G:\deepseek\opensource\dsh-profile-guard
---

# Spike 结论：「重置为 2 bundle」写者归属（受控实验 + 源码考古）

## 背景
设计文档 §8.1 提出：两次装崩事故（agent-teams / tool-lens）后 profile 被重置为 2 bundle（base+web-app），
宿主与桌面端源码中均未直接找到该逻辑。实现回滚前必须确认写者，以决定 guard 是否要对抗/配合它。

## 核查方法（2026-09-06）

### 1. 源码考古（只读）
| 候选 | 结论 | 出处 |
|---|---|---|
| 宿主 `boot()` | 任一 bundle 挂载失败 → `stage="plugin tree failed to load"` → dispose 后 throw。无备份/降级/重置。 | `@deepseek-ai/dsh-app-boot/lib/index.js` boot() |
| `initProfile` 调用点 | 仅 2 处：app-boot 内部 + CLI plugin 首次初始化；且**仅在 manifest 不存在时**写模板。 | app-boot index.js / dsh lib/plugin-*.js |
| PROFILE_TEMPLATES.web | `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` —— 恰为 2 bundle，是重置的"目标形态"来源 | app-boot index.js |
| CLI `dsh plugin` | 失败仅 stderr 报错 + exit code，不写回 manifest | `dsh/lib/plugin-F7ZVfRyo.js` runPlugin() |
| dsh-desktop main.js | 全文无 `initProfile`/`PROFILE_TEMPLATES` 调用；仅有 createBackup/restore（操作前备份 + 失败恢复，方向相反） | `G:\deepseek\dsh-desktop\main.js` |
| dshmarket 1.44 | snapshot/rollback 为装前快照恢复，正常不产生 2-bundle 模板态 | `profiles/web/node_modules/dshmarket/lib/*.js` |

### 2. 受控实验（隔离 DSH_HOME，不触碰真实 profile）
- 在 `G:\deepseek\.tmp\guard-spike-*\.dsh\profiles\guardtest` 构造毒化 manifest：
  复制真实 web manifest + 注入 `@deepseek-ai/dsh-tools@0.0.1-rc.1` 到 dependencies 与 bundles（tool-lens 事故同款）。
- 运行 `node .../dsh/lib/bin.js --profile guardtest --dump-config`（离线组合，不启动宿主）：
  - 结果：exit 1，报 `profile "guardtest" does not exist`（自定义 profile 需先 `dsh plugin add` 初始化）；
  - **manifest 未被改写**：dump-config 前后 bundles 恒为 23、deps 恒为 21，毒化条目原样保留。
- 推论：**组合层（dump-config）失败不触发任何重置**；「重置为 2 bundle」只可能在**真实 boot 挂载路径**
  或**宿主外层 watchdog**（restart-web.ps1 / 市场 restart / 桌面端重启编排）中发生。

### 3. 真实 boot 验证（需用户在场，沙箱外）
设计如下受控步骤供用户在桌面端空闲时段执行（agent 不自杀式运行）：
1. `dsh plugin --profile guardtest add @deepseek-ai/dsh-tools@0.0.1-rc.1`（或手工写毒化 manifest 后 `pnpm install`）——需在**临时 DSH_HOME** 下执行，绝不用真实 `web` profile；
2. `dsh --profile guardtest` 拉宿主 → 预期 plugin tree failed；
3. 观察：guardtest/package.json 是否被改回 2 bundle？谁改的（对比进程链/时间戳/备份文件）？
4. 结果回报后补记本结论。

## 结论
1. **「重置为 2 bundle」写者不在宿主 core、不在 CLI、不在桌面端 main.js、不在市场快照路径**。
   最可能宿主外层组件（desktop 的 ensureHost/重启编排或某 watchdog），需真实 boot 实验终审。
2. **对 guard rollback 设计的影响**：guard 在宿主外自持快照并直接写回自己的 `guards/<profile>/` 快照，
   **不依赖也不对抗外部写者**——无论写者把 manifest 改成什么，guard 回滚时以自己快照为准写回 package.json。
   加固点：回滚 → 重拉后**验证 bundles 仍是快照的 bundles**；若被外部写者再次重置（manifest hash 与快照不符），
   再回滚一次并报告"外部重置已覆盖，guard 二次回滚"（见计划任务 5 实现——追加验证步骤）。
3. spike 真实 boot 验证项已留档（见上），用户在合适时机执行后补记。

## 状态
- [x] 源码考古（本会话 2026-09-06）
- [x] 隔离 dump-config 实验（本会话 2026-09-06）
- [ ] 真实 boot 验证（待用户桌面端空闲时段执行）
