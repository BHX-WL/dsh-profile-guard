# dsh-profile-guard hotmount 实施计划（③ CLI 路径免重启热挂载）

> **面向 Agent 执行者：** 必需子技能：使用 superpower-subagent-driven-development（推荐）或 superpower-executing-plans 按任务逐项执行本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** guard install 装纯 insert patch 插件时经市场 toggle 路由触发宿主内 hotMount 免重启激活；热挂载不支持/失败自动降级②的强制重启验证。全自动分级：能热挂就热挂，不能就重启。

**架构：** 纯 Node ESM 零依赖扩展。新增 `lib/mount.js`（tryHotMount：POST market toggle + Origin/Host header 过 sameOrigin + 读 activation state + 全错误降级）与纯 insert patch 判定（`lib/patch.js` 提炼自 preflight.patchInsertIds/check）。`lib/contract.js` 加 market 契约常数（路径/Origin/baseUrl，env 可覆写）。`lib/cli.js` install 分支在 plugin add 成功后插热挂载尝试，失败落回 runPostInstallVerify。兼容护栏沿用② §11.5（S1 settleExit、零耦合、降级不静默、env 覆写）。

**技术栈：** Node ≥ 20（本机 v24.19.0），ESM，内置 node:test；宿主 core 0.1.2-rc.1；dshmarket 1.44（toggle 路由作桥，仅 HTTP 不 import）。

**规格：** `docs/design/2026-09-06-dsh-hotmount-design.md`（v0.1，用户已复核同意）。计划论证以规格为准，执行者需同时阅读设计文档与本节。

## 全局约束

- 项目根：`G:\deepseek\opensource\dsh-profile-guard`（master @ ea05ec8 含 ①/② 全部 + ③ 设计文档；95 测试绿）。
- **兼容护栏（用户特别要求，② §11.5 六条全沿用，每任务遵守）**：
  - lib 不得 import @deepseek-ai/* 或 cordis 运行时包；**不得 import dshmarket 任何模块**（桥只走 HTTP）。
  - 防御性读取：toggle 响应解析全容错（非 JSON/字段缺失 → degraded 不崩）。
  - 降级而非静默：任何热挂载失败打印原因（"hot-mount unavailable (reason); falling back to restart verification"）。
  - 契约常数集中 + env 覆写：新路由路径/Origin/baseUrl 全进 lib/contract.js（DSH_GUARD_MARKET_*）。
  - 防崩溃兜底：所有新 fetch 点遵守 S1 settleExit 纪律（exitCode + unref'd settle）；顶层 catch 可读错误。
- 零第三方运行时依赖；ESM；Node ≥ 20；测试命令 `node --test-isolation=none --test test/*.test.js`（run_code 通道跑含 cli；pwsh 沙箱 spawn EPERM）。
- 现有 95 测试全绿基线；每任务后全量全绿。
- 测试隔离：tryHotMount 测试用本地 http stub server（模拟 toggle 响应矩阵：live/restart/403/404/非 JSON）；**绝不真 POST 真实 3080 市场**；install 热挂载分支测试走 dry/seam。
- DSH_HOME=数据根语义沿用。
- 版本 0.2.0 → 0.3.0（README install 行更新说明分级激活）。

## 文件结构

```
dsh-profile-guard/
├── lib/
│   ├── patch.js        # 新建：纯 insert patch 判定（isPlainInsertPatch/canHotMountByShape）
│   ├── mount.js        # 新建：tryHotMount(pkg, {profile, baseUrl, origin, timeoutMs}) HTTP 桥
│   ├── contract.js     # 修改：marketTogglePath/marketOrigin/marketBaseUrl（env 覆写）
│   ├── cli.js          # 修改：install 分支热挂载接线 + 可选 guard hotmount 命令
│   └── (既有 15 个不动，除 contract/cli)
└── test/
    ├── patch.test.js   # 新建：纯 insert 判定矩阵
    ├── mount.test.js   # 新建：toggle 响应矩阵（本地 stub）
    ├── contract.test.js# 修改：market 契约常数默认/env 覆写
    ├── cli.test.js     # 修改：install 热挂载分支 dry 用例
    └── (其余保持)
```

---

### 任务 0：Spike——真机验证 toggle 桥（Origin header 是否够过 sameOrigin）

**文件：**
- 产出：`docs/decisions/spike-2026-09-06-toggle-bridge.md`（结论，不写生产代码）

**接口：**
- 依赖输入：设计 §11 开放问题 3；市场 http.js sameOrigin 源码（已读：origin.host === host）
- 对外产出：结论——node fetch 带 `Origin: http://127.0.0.1:3080` + 默认 Host header 能否过 sameOrigin？toggle 真实响应形状确认（activation 字段）。决定 mount.js 的 header 构造。

- [ ] **步骤 1：构造最小验证脚本（只读 + 一次无害 toggle 探测）**
  用 run_code 内 node fetch 对 `http://127.0.0.1:3080/dsh-market/toggle` 发 POST（body 用**已装无害插件**如 dsh-better-edit 的 name？**风险**：toggle 会真的 hotMount/热切换！——选**当前 disabled 的包**或构造只读探测：先 GET /dsh-market/installed 确认某包当前 state；若已 live 再 toggle enabled:true 是 no-op（setPluginEnabled 里 listHotMounts 已含 → ok:true 无副作用）。安全选择：对已 live 包发 enabled:true → 幂等 no-op。headers: Origin/Host/content-type。
  记录：状态码、响应体（activation 形状）、403 与否。

- [ ] **步骤 2：写结论文档并提交**
  `docs/decisions/spike-2026-09-06-toggle-bridge.md`：sameOrigin 实测结论、header 构造（Origin 必须、Host 默认是否匹配）、toggle 幂等性确认、风险与兜底（若 403 则 mount.js 需带完整 Origin + 明确 Host）。
  ```bash
  git add docs/decisions/spike-2026-09-06-toggle-bridge.md
  git commit -m "docs: spike conclusion on market toggle bridge (guard)"
  ```

---

### 任务 1：纯 insert patch 判定（lib/patch.js）

**文件：**
- 新建：`lib/patch.js`、`test/patch.test.js`

**接口：**
- 依赖输入：设计 §5 判定矩阵；preflight.js patchInsertIds/check.js 行式解析语义
- 对外产出：
  - `patch.readPatch(profileDir, pkg)` → 读 `node_modules/<pkg>/cordis.patch.yml` 文本 | null（缺失/不可读）
  - `patch.isPlainInsertPatch(patchText)` → boolean：仅含 `- insert:` 块 + `id:`/`name:` 行（行式校验，容忍空行/注释？**裁决**：market parseSimplePatch 只认 insert+id/name 行，其它内容行（config/表达式/- disable）→ false。空 patch/纯注释 → false（无内容可挂）。null → false。
  - `patch.declaresClientOnly(pkgDir)` → 读 package.json dsh.client 且无 dsh.bundle → true（client-only shim 可热挂）
  - `patch.canHotMountByShape(profileDir, pkg)` → { ok, reason? }：综合判定（纯 insert → ok；client-only → ok；其它 → ok:false + reason）

- [ ] **步骤 1：编写失败测试**

```js
// test/patch.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlainInsertPatch, declaresClientOnly, canHotMountByShape, readPatch } from "../lib/patch.js";

test("plain insert patch with id/name rows is hot-mountable", () => {
  const p = "- insert:
  id: 'better-edit'
  name: 'dsh-better-edit'
- insert:
  id: x
  name: y
";
  assert.equal(isPlainInsertPatch(p), true);
});
test("patch with config/expression rows is not plain insert", () => {
  const p = "- insert:
  name: x
- config:
  foo: bar
";
  assert.equal(isPlainInsertPatch(p), false);
});
test("patch with disable row is not plain insert", () => {
  const p = "- insert:
  name: x
- disable: something
";
  assert.equal(isPlainInsertPatch(p), false);
});
test("empty/null patch is not hot-mountable by insert", () => {
  assert.equal(isPlainInsertPatch(""), false);
  assert.equal(isPlainInsertPatch(null), false);
  assert.equal(isPlainInsertPatch("# only comments
"), false);
});
test("client-only package (dsh.client, no dsh.bundle) is hot-mountable by shim", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const dir = join(h, "node_modules", "some-ui");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "some-ui", dsh: { client: {} } }));
    assert.equal(declaresClientOnly(dir), true);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("canHotMountByShape returns ok for insert, false+reason otherwise", () => {
  const h = mkdtempSync(join(tmpdir(), "patch-h-")); try {
    const dir = join(h, "node_modules", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p" }));
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:
  name: p
");
    const ok = canHotMountByShape(h, "p");
    assert.equal(ok.ok, true);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试并确认失败**：`node --test --test-isolation=none test/patch.test.js` → FAIL module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/patch.js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function readPatch(profileDir, pkg) {
  const f = join(profileDir, "node_modules", pkg, "cordis.patch.yml");
  try { if (!existsSync(f)) return null; return readFileSync(f, "utf8"); } catch { return null; }
}

// Row-level check mirroring dshmarket's parseSimplePatch scope: only
// "- insert:" blocks with id/name rows qualify for hot-mount. Config blocks,
// disables, expressions, or any non-insert content row → false. Empty/whitespace
// only → false (nothing to mount). Comments (#) tolerated but empty result → false.
export function isPlainInsertPatch(patchText) {
  if (typeof patchText !== "string" || patchText.trim() === "") return false;
  let sawInsert = false;
  let inInsert = false;
  for (const rawLine of patchText.split(/?
/)) {
    const t = rawLine.trim();
    if (t === "" || t.startsWith("#")) continue;
    if (/^- insert:s*$/.test(t)) { inInsert = true; sawInsert = true; continue; }
    if (inInsert) {
      const m = /^(?:id|name):s*['"]?(@?[A-Za-z0-9._/-]+)['"]?s*$/.exec(t);
      if (m) { /* valid insert row */ continue; }
      if (/^- /.test(t) || /^[A-Za-z]/.test(t)) { inInsert = false; return false; } // new block or stray row
      continue;
    }
    return false; // non-insert content row outside a block
  }
  return sawInsert;
}

export function declaresClientOnly(pkgDir) {
  try {
    const m = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    return m?.dsh?.client !== undefined && m?.dsh?.bundle === undefined;
  } catch { return false; }
}

export function canHotMountByShape(profileDir, pkg) {
  const patch = readPatch(profileDir, pkg);
  if (patch !== null && isPlainInsertPatch(patch)) return { ok: true, via: "insert" };
  const pkgDir = join(profileDir, "node_modules", pkg);
  if (declaresClientOnly(pkgDir)) return { ok: true, via: "client-shim" };
  if (patch === null) return { ok: false, reason: "no bundle patch and no dsh.client surface — nothing to hot-mount" };
  return { ok: false, reason: "bundle patch is not plain inserts (config/expression rows); hot-mount only supports plain inserts — restart required" };
}
```

- [ ] **步骤 4：运行测试并确认通过** → 6 tests PASS

- [ ] **步骤 5：提交** `feat: plain-insert patch and client-only hot-mount shape checks (guard)`

---

### 任务 2：契约常数扩展（lib/contract.js）

**文件：**
- 修改：`lib/contract.js`、`test/contract.test.js`

**接口：**
- 依赖输入：设计 §6 契约常数；① contract.js 既有 getter 模式
- 对外产出：
  - `contract.marketTogglePath()` → env `DSH_GUARD_MARKET_TOGGLE_PATH` || "/dsh-market/toggle"
  - `contract.marketBaseUrl()` → env `DSH_GUARD_MARKET_BASE` || "http://127.0.0.1:3080"（剥尾斜杠）
  - `contract.marketOrigin()` → env `DSH_GUARD_MARKET_ORIGIN` || marketBaseUrl()
  - 既有 getter 不动

- [ ] **步骤 1：测试**（追加 contract.test.js）：默认值断言 + env 覆写断言（设 DSH_GUARD_MARKET_BASE/TOGGLE_PATH/ORIGIN → 生效；finally 清理——--test-isolation=none 共享进程教训）

- [ ] **步骤 2：RED → 实现 → GREEN → 全量**
  实现三个 getter（envStr 模式同款，baseUrl 剥尾斜杠）。全量 95+3 绿。

- [ ] **步骤 3：提交** `feat: market bridge contract constants with env overrides (guard)`

---

### 任务 3：tryHotMount HTTP 桥（lib/mount.js）

**文件：**
- 新建：`lib/mount.js`、`test/mount.test.js`

**接口：**
- 依赖输入：任务 2 contract 常数；设计 §6 tryHotMount 描述；S1 settleExit 纪律
- 对外产出：`mount.tryHotMount(pkg, { profileDir, baseUrl, origin, timeoutMs = 8000 })` → `{ ok, state?, reason?, degraded }`
  - POST `${baseUrl}${togglePath}` body `{name: pkg, enabled: true}`；headers `Origin: origin`、`content-type: application/json`（Host 由 fetch 自动带 baseUrl host）
  - 200 + `activation[pkg].state === "live"` → ok:true
  - 200 + 其它 state / 200 无 activation 字段 / 403 / 404 / 网络错 / 非 JSON → ok:false degraded:true + reason（绝不 throw 出）
  - AbortController 超时

- [ ] **步骤 1：测试**（test/mount.test.js，本地 http stub server 模拟响应矩阵）：
  - live 响应 → ok:true state:live
  - restart 响应 → ok:false degraded:true reason 含 restart
  - 403 → ok:false degraded:true reason 含 untrusted/403
  - 404（路由变）→ ok:false degraded:true
  - 非 JSON → ok:false degraded:true
  - 超时（stall server + timeoutMs 300）→ ok:false degraded:true reason 含 timeout
  - 断言请求：method POST、body {name,enabled:true}、Origin header 值

- [ ] **步骤 2：RED → 实现 → GREEN → 全量**（95+7 绿）
  实现用全局 fetch + AbortController；所有错误路径 catch 返 degraded，绝不 throw。

- [ ] **步骤 3：提交** `feat: tryHotMount market-toggle HTTP bridge with full degradation (guard)`

---

### 任务 4：install 分支热挂载接线（lib/cli.js）

**文件：**
- 修改：`lib/cli.js`、`test/cli.test.js`

**接口：**
- 依赖输入：任务 1 patch、任务 3 mount、② install 既有 preflight/snapshot/runPostInstallVerify
- 对外产出：install 生产分支 add 成功后：
  1. `canHotMountByShape(profileDir(profile), pkg)` → ok 则 tryHotMount
  2. tryHotMount ok → stdout "install ok (hot-mounted <pkg>, snapshot <id>)" exit 0（免重启）
  3. tryHotMount degraded / shape 不支持 → stderr 打印降级原因 → 落回 runPostInstallVerify（② 原逻辑：在跑先停→bootOnce 强制验证）
  4. dry 模式不变（不真热挂）；`--no-boot` 语义保留（既不加热挂也不重启验证？**裁决**：--no-boot 时跳过热挂与重启验证（用户显式只要装）——README 已述）

- [ ] **步骤 1：测试**（追加 cli.test.js，seam 注入）：
  - dry 模式 install 不变（既有用例绿）
  - 生产热挂分支：注入 fake canHotMountByShape→ok + fake tryHotMount→{ok:true} → 断言 install ok (hot-mounted)（不调 runPostInstallVerify）——经 seam（cli.js 需可注入 mount/patch——**裁决**：cli.js 顶部 import 后，测试用模块级替换或 env gate `DSH_GUARD_DRY_INSTALL=1` 已有 + 新增 `DSH_GUARD_DRY_HOTMOUNT=1` 打印 would-hot-mount；以能 dry 测试为准，注明）
  - 热挂失败降级：注入 fake tryHotMount→{ok:false,degraded:true} → 断言走 runPostInstallVerify（fake boot）
  - shape 不支持：注入 fake canHotMountByShape→{ok:false} → 断言直接 runPostInstallVerify

- [ ] **步骤 2：RED → 实现 → GREEN → 全量**
  cli.js install 分支改造：add 成功后插入热挂段（shape 判定 + tryHotMount + 成功出口 + 降级落回）；新增 `DSH_GUARD_DRY_HOTMOUNT` env gate 供 dry 测试；runPostInstallVerify 保持原逻辑为降级路径。

- [ ] **步骤 3：提交** `feat: install hot-mounts plain-insert plugins with restart fallback (guard)`

---

### 任务 5：guard hotmount 单列命令（开放问题 1 裁决：做）

**文件：**
- 修改：`lib/cli.js`、`test/cli.test.js`

**接口：**
- 依赖输入：任务 1/3
- 对外产出：`guard hotmount <pkg> [--profile <name>]`：对已装插件尝试热挂载——shape 判定 → tryHotMount → exit 0 (hot-mounted) / 1 (degraded+reason / 未装) / 2 (用法)。供手动触发与调试。

- [ ] **步骤 1：测试**（追加）：已装纯 insert + fake tryHotMount ok → 0；degraded → 1；缺 pkg → 2；未装（readPatch null + 无 node_modules）→ 1 reason

- [ ] **步骤 2：实现 → GREEN → 全量**
  cli.js 加 case "hotmount"（复用 mount/patch；USAGE 更新）。

- [ ] **步骤 3：提交** `feat: guard hotmount command for manual activation (guard)`

---

### 任务 6：README + 版本 0.3.0 + 全量回归

**文件：**
- 修改：`package.json`（0.2.0 → 0.3.0）、`README.md`、`README.zh.md`

**接口：**
- 依赖输入：全部前序任务
- 对外产出：可发布 v0.3.0；README install 行说明分级激活（纯 insert 免重启热挂，其余自动重启验证）+ hotmount 命令 + 新 env 键 + 兼容护栏摘要更新

- [ ] **步骤 1：** package.json version 0.3.0；README 双语同步（install 行 + hotmount 命令行 + Host contract 段补 market bridge env 键 DSH_GUARD_MARKET_*；双语 code span 程序化校验）

- [ ] **步骤 2：** 全量回归 `node --test-isolation=none --test test/*.test.js` 全绿（约 95+新增）

- [ ] **步骤 3：** 提交 `chore: v0.3.0 with hot-mount install path (guard)`；报告

---

## 自检记录（计划作者填写）

- **规格覆盖度**：§4 命令面（install 分级 + hotmount 单列）→ 任务 4/5；§5 判定矩阵 → 任务 1；§6 实现要点（mount/contract/cli）→ 任务 2/3/4；§7 安全 → 全局约束（loopback only、degraded 不崩）；§8 兼容护栏六条 → 任务 2（env 覆写）+ 全局约束逐任务；§10 发布 → 任务 6。§11 开放问题：1 → 任务 5 做；2 → 任务 1 新 lib/patch.js；3 → 任务 0 spike。
- **占位符扫描**：无 TODO/TBD；每步含代码/命令。
- **类型一致性**：`canHotMountByShape(profileDir,pkg)→{ok,reason?,via?}` 任务 1/4/5 一致；`tryHotMount(pkg,{profileDir,baseUrl,origin,timeoutMs})→{ok,state?,reason?,degraded}` 任务 3/4/5 一致；contract getter 任务 2/3 一致。
- **已知风险**：任务 4 install 热挂分支 dry 测试需 seam/env gate（DSH_GUARD_DRY_HOTMOUNT）——以能 dry 测试为准；真实 toggle 403 由任务 0 spike 定 header 构造；S1 settleExit 纪律覆盖新 fetch（任务 3 复用 cli settleExit 模式或 mount 内自管）。
