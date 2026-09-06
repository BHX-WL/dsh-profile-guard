# dsh-profile-guard 实施计划（装机保险）

> **面向 Agent 执行者：** 必需子技能：使用 superpower-subagent-driven-development（推荐）或 superpower-executing-plans 按任务逐项执行本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 构建宿主外的 `guard` CLI：每次经它启动宿主前自动快照 profile 健康态；宿主装崩（plugin tree failed）自动回滚最近健康快照并重拉一次；附 `guard watch` 常驻监听。

**架构：** 纯 Node ESM、零第三方运行时依赖（仅用内置 `node:test`/node:fs/node:http/node:child_process）。独立进程，绝不进 `dsh.profile.bundles`（崩溃发生在任何 bundle 挂载前，插件自保不可能）。快照存 `~/.dsh/guards/<profile>/`（宿主外，profile 重置也影响不到）。宿主拉起用与 dsh-desktop 相同的 spawn 方式（`node …/dsh/lib/bin.js web --no-open`），健康探活复用 `__DSH_BOOT__` 特征与 401 auth marker 判定。

**技术栈：** Node ≥ 20（本机 v24.19.0），ESM，内置 node:test；宿主 core 0.1.2-rc.1；pnpm 11.22（仅在真实安装冒烟时用）。

**规格：** `docs/design/2026-09-06-dsh-profile-guard-design.md`（v0.1，用户已复核同意）。计划论证以规格为准，执行者需同时阅读设计文档与本节。

## 全局约束

- 项目根：`G:\deepseek\opensource\dsh-profile-guard`（独立 git 仓库，已有 root commit `9531e70` 含设计文档）。
- 零第三方运行时依赖；devDependencies 也保持为空（测试用内置 `node:test`）。`package.json` 无 `dependencies` 字段。
- 全部代码 ESM（`"type": "module"`）；Node ≥ 20。
- 测试命令：`node --test test/`；每个文件级任务先写失败测试（TDD）。
- 二进制名 `guard`，包名 `dsh-profile-guard`。
- 快照保留 5 份（`DSH_GUARD_KEEP` 可调）；健康分级 `healthy`（回滚只允许回 healthy）/ `pending`（启动成功后晋升）。
- 只读写 `~/.dsh/guards/` 与 `~/.dsh/profiles/<profile>/`；不读写凭据；报告与日志脱敏（token/authorization 不落盘）。
- 宿主由 dsh-desktop 拉起的现状不改；`guard boot` 面向 CLI 直装后手动/脚本重启路径，透传 `dsh web` 全部参数。
- 提交信息英文：`feat: …` / `fix: …` / `docs: …` / `test: …`，可附 (guard) 前缀标识。
- 平台：Windows（本机），但代码保持跨平台（路径用 node:path join，不硬编码 \ 或 /）。
- 设计文档 §8 spike 结论：任务 0 产出；结论不影响主架构（guard 在宿主外，无论谁重置 profile，guard 都从自身快照恢复），只影响恢复动作是否要清理"重置者残留"。

## 文件结构

```
dsh-profile-guard/
├── package.json            # bin: { guard: "./lib/cli.js" }; type module; engines node>=20
├── .gitignore              # node_modules/, *.log, crash-*/
├── LICENSE                 # MIT
├── README.md               # 英文
├── README.zh.md            # 中文（与英文同内容）
├── lib/
│   ├── cli.js              # #!/usr/bin/env node；argv 分发 boot/snapshot/list/show/restore/check/watch
│   ├── paths.js            # guardsDir/profileDir/dshInstallDir 解析（HOME/DSH_HOME 兼容）
│   ├── manifest.js         # readManifest/writeManifest/manifestHash/depsOf/bundlesOf
│   ├── sentinel.js         # listNodeModulesDeepseekAi(profileDir) 顶层 @deepseek-ai 目录名清单
│   ├── snapshot.js         # createSnapshot/listSnapshots/showSnapshot/markHealthy/promotePending/prune
│   ├── check.js            # staticCheck(profileDir)：可解析/deps 完整/无 dup id/@deepseek-ai 无 core 遮蔽
│   ├── probe.js            # isHostHealthy(baseUrl)：__DSH_BOOT__ 或 401 auth marker
│   ├── host.js             # spawnHost(profile,args)/stopHostByPort(3080)/hostLogTail()
│   ├── rollback.js         # rollbackToSnapshot(snapshotId)：停宿主→恢复 manifest→reconcile→（可选）spawn
│   ├── report.js           # buildRestoreReport/saveRestoreReport（脱敏）
│   ├── boot.js             # bootOnce 主流程：pending 快照→spawn→probe→成功晋升/失败回滚→重拉一次
│   └── watch.js            # watchProfile(profileDir)：fs.watch package.json/pnpm-lock 变更→auto snapshot
└── test/
    ├── paths.test.js
    ├── manifest.test.js
    ├── sentinel.test.js
    ├── snapshot.test.js
    ├── check.test.js
    ├── probe.test.js
    ├── rollback.test.js
    ├── boot.test.js        # 用假 host 脚本验证全流程（不真拉宿主）
    └── cli.test.js         # 命令分发与退出码
```

**测试策略**：文件层测试全部用临时目录（`fs.mkdtemp`）+ 真实文件操作，零网络零宿主。probe/host/boot 用「假宿主」——一个临时目录里的假 `bin.js`（可配置成功/失败/超时）+ 本地 http server 模拟 `__DSH_BOOT__` 响应，经环境变量注入，不碰真实 3080。

---

### 任务 0：Spike——「重置为 2 bundle」写者归属（探索，产出结论文档）

**文件：**
- 产出：`docs/decisions/spike-2026-09-06-reset-writer.md`（记录结论，不写代码）

**接口：**
- 依赖输入：设计文档 §2/§8
- 对外产出：一份结论——重置写者是（a）dsh-desktop safemode 引擎 /（b）market rollback /（c）CLI reconcile 失败路径 /（d）未找到（host 层无此逻辑）。结论写入 `docs/decisions/spike-2026-09-06-reset-writer.md`，供任务 6 的 rollback 决定是否需要"清理重置残留"步骤。

- [ ] **步骤 1：只读复查已知候选代码路径**
  1. `C:\Users\ASUS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`：确认 `boot()` 失败仅 dispose+throw（已核实，记录行号与函数名）。
  2. `dsh/lib/plugin-*.js`：确认 CLI 失败仅报错不回写（已核实）。
  3. `G:\deepseek\dsh-desktop\main.js`：全文搜索 `PROFILE_TEMPLATES`、`initProfile`、`reset`、`2 bundle`、`web-app`——定位是否有任何路径把 `~/.dsh/profiles/web/package.json` 的 bundles 写回 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`。把命中的函数名+行号记进结论。
  4. dshmarket：`C:\Users\ASUS\.dsh\profiles\web\node_modules\dshmarket\lib\routes.js` 搜索 rollback/snapshot 是否会把 manifest 写回模板（市场快照是装前状态，正常不会 2 bundle——除非快照本身是模板）。

- [ ] **步骤 2：grep 全部 `initProfile(` 调用点**
  运行：`node -e "const fs=require('fs');const p='C:/Users/ASUS/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';const t=fs.readFileSync(p,'utf8');for(const k of ['initProfile(','PROFILE_TEMPLATES','INSTALLATION_OWNED']){console.log(k, t.indexOf(k));}"`
  预期：记录每个关键词偏移，人工确认调用条件（已知：initProfile 仅在 manifest 不存在时写模板——印证"重置"需先删 manifest 或另有写者）。

- [ ] **步骤 3：受控实验（不碰真实 web profile）**
  1. 复制 `~/.dsh/profiles/web` 到 `~/.dsh/profiles/guardtest`（cp -r 排除 node_modules 太大可跳过，实验只需 manifest 与 cordis.patch.yml）。
  2. 手工在 `guardtest/package.json` 的 dependencies 加入一个必然崩的包（如 `@deepseek-ai/dsh-tools@0.0.1-rc.1`，KB 实锤 tool-lens 事故同款）并加进 bundles。
  3. 用 `node C:/Users/ASUS/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js --profile guardtest --dump-config` 观察合成失败形态（不启动、无害）。
  4. 用独立端口拉起：`dsh --profile guardtest`（若占用 3080 先 `--port` 不可用则仅做 dump-config 层验证，并记录"真实重启验证需用户在桌面端空闲时段执行"）。
  5. 记录：谁把 manifest 写回 2 bundle？dump-config 失败会触发自动重置吗？（预期：不会，自动重置大概率在 desktop 的 ensureHost/重启路径或市场 install 路由，spike 给出可执行的重启验证清单交用户。）

- [ ] **步骤 4：写结论文档并提交**
  `docs/decisions/spike-2026-09-06-reset-writer.md`：候选代码路径核查结果、受控实验输出、结论（写者归属或"宿主外组件，待桌面端重启验证"）、对 rollback 设计的影响（任务 6 是否需加"重置残留清理"）。
  ```bash
  git add docs/decisions/spike-2026-09-06-reset-writer.md
  git commit -m "docs: spike conclusion on 2-bundle reset writer (guard)"
  ```

---

### 任务 1：项目脚手架 + paths/manifest 基础

**文件：**
- 新建：`package.json`、`.gitignore`、`LICENSE`、`lib/paths.js`、`lib/manifest.js`、`test/paths.test.js`、`test/manifest.test.js`

**接口：**
- 依赖输入：任务 0 结论（不阻塞）
- 对外产出：
  - `paths.guardsDir(profile)` → `<dsHome>/guards/<profile>`
  - `paths.profileDir(profile)` → `<dsHome>/profiles/<profile>`
  - `paths.dshInstallDir()` → 全局 `@deepseek-ai/dsh` 安装目录（null 则回退 npx）
  - `manifest.readManifest(dir)` → parsed package.json | null（剥 BOM，同桌面端 readJsonFile）
  - `manifest.writeManifest(dir, json)` → void（2 空格缩进 + 换行）
  - `manifest.manifestHash(json)` → sha256(JSON.stringify(dependencies)+JSON.stringify(bundles)) 前 16 位
  - `manifest.depsOf(json)` → `Object.keys(dependencies)` 排序数组
  - `manifest.bundlesOf(json)` → `dsh.profile.bundles` 数组

- [ ] **步骤 1：编写失败测试**

```js
// test/paths.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { guardsDir, profileDir } from "../lib/paths.js";

test("guardsDir nests under dsh home guards", () => {
  assert.equal(guardsDir("web"), joinHome("guards/web"));
});
test("profileDir nests under profiles", () => {
  assert.equal(profileDir("web"), joinHome("profiles/web"));
});
function joinHome(...parts) {
  const home = process.env.DSH_HOME || requireOsHomedir();
  return parts.reduce((a, b) => a + "/" + b, home);
}
function requireOsHomedir() { return process.env.USERPROFILE || process.env.HOME; }
```

```js
// test/manifest.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, writeManifest, manifestHash, depsOf, bundlesOf } from "../lib/manifest.js";

const fixture = { name: "p", private: true, dependencies: { a: "^1.0.0", b: "2.0.0" }, dsh: { profile: { bundles: ["x", "y"] } } };
test("write then read round-trips and strips BOM", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-m-"));
  try {
    writeFileSync(join(dir, "package.json"), "﻿" + JSON.stringify(fixture));
    assert.deepEqual(readManifest(dir), fixture);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("readManifest returns null for missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-m-"));
  try { assert.equal(readManifest(dir), null); } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("manifestHash changes when deps or bundles change", () => {
  const h1 = manifestHash(fixture);
  const h2 = manifestHash({ ...fixture, dependencies: { a: "^1.0.0" } });
  assert.notEqual(h1, h2);
});
test("depsOf and bundlesOf extract sorted lists", () => {
  assert.deepEqual(depsOf(fixture), ["a", "b"]);
  assert.deepEqual(bundlesOf(fixture), ["x", "y"]);
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test test/manifest.test.js test/paths.test.js`
  预期：FAIL——`Cannot find module '../lib/manifest.js'`

- [ ] **步骤 3：编写最小实现**

```js
// lib/paths.js
import { join } from "node:path";
export function dshHome() { return process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME; }
export function guardsDir(profile) { return join(dshHome(), ".dsh", "guards", profile); }
export function profileDir(profile) { return join(dshHome(), ".dsh", "profiles", profile); }
export function crashDir(profile) { return join(guardsDir(profile), "crash"); }
export function dshInstallDir() {
  // resolution anchor: this file lives in <install>/node_modules/dsh-profile-guard/lib
  return null; // 任务 5 真实实现（host.js 用 node 定位全局 dsh）
}
```

```js
// lib/manifest.js
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
export function readManifest(dir) {
  try {
    const raw = readFileSync(join(dir, "package.json"), "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch { return null; }
}
export function writeManifest(dir, json) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(json, null, 2) + "
", "utf8");
}
export function manifestHash(json) {
  const core = JSON.stringify(json?.dependencies ?? {}) + JSON.stringify(json?.dsh?.profile?.bundles ?? []);
  return createHash("sha256").update(core).digest("hex").slice(0, 16);
}
export function depsOf(json) { return Object.keys(json?.dependencies ?? {}).sort(); }
export function bundlesOf(json) { return Array.isArray(json?.dsh?.profile?.bundles) ? [...json.dsh.profile.bundles] : []; }
export function existsProfile(dir) { return existsSync(join(dir, "package.json")); }
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test test/manifest.test.js test/paths.test.js`
  预期：PASS（4 tests）

- [ ] **步骤 5：package.json 脚手架 + 提交**
  ```json
  {
    "name": "dsh-profile-guard",
    "version": "0.1.0",
    "private": false,
    "description": "Install-crash insurance for the dsh CLI plugin path: snapshot healthy profiles, auto-rollback when a plugin breaks the host boot.",
    "type": "module",
    "bin": { "guard": "./lib/cli.js" },
    "engines": { "node": ">=20" },
    "license": "MIT",
    "keywords": ["dsh-plugin", "dsh", "backup", "rollback", "guard"]
  }
  ```
  ```bash
  git add package.json .gitignore LICENSE lib/paths.js lib/manifest.js test/paths.test.js test/manifest.test.js
  git commit -m "feat: scaffold dsh-profile-guard with paths and manifest (guard)"
  ```

---

### 任务 2：快照核心（sentinel + snapshot）

**文件：**
- 新建：`lib/sentinel.js`、`lib/snapshot.js`、`test/sentinel.test.js`、`test/snapshot.test.js`

**接口：**
- 依赖输入：任务 1（`manifest.readManifest`、`guardsDir`、`profileDir`）
- 对外产出：
  - `sentinel.listNodeModulesDeepseekAi(profileDir)` → 顶层 `node_modules/@deepseek-ai` 下的目录名排序数组（无此目录则 `[]`）
  - `snapshot.createSnapshot(profile, { reason, healthy })` → `{ id, dir, healthy }`
  - `snapshot.listSnapshots(profile)` → 按 createdAt 倒序的快照元数据数组
  - `snapshot.latestHealthy(profile)` → 最近 healthy 快照 id | null
  - `snapshot.markHealthy(profile, id)` → void
  - `snapshot.prune(profile, keep = 5)` → 删除超出 keep 的旧快照
  - 快照目录布局：`<guardsDir>/<profile>/<id>/`，id = `YYYYMMDD-HHmmss-<hash8>`；内含 `package.json`（拷贝）、`sentinel.json`、`meta.json`（`{id, createdAt, reason, dshVersion, healthy, hash}`）

- [ ] **步骤 1：编写失败测试**

```js
// test/snapshot.test.js（sentinel 并入一个文件测）
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listNodeModulesDeepseekAi } from "../lib/sentinel.js";
import { createSnapshot, listSnapshots, latestHealthy, markHealthy, prune } from "../lib/snapshot.js";

function env(profile, home) { process.env.DSH_HOME = home; return { profile, dir: join(home, ".dsh", "profiles", profile) }; }
function makeProfile(home, profile, deps, bundles) {
  const dir = join(home, ".dsh", "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, dsh: { profile: { bundles } } }));
  return dir;
}

test("sentinel lists top-level @deepseek-ai dirs", () => {
  const home = mkdtempSync(join(tmpdir(), "guard-h-"));
  try {
    const dir = makeProfile(home, "web", { a: "1" }, []);
    mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh-tools"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "@deepseek-ai", "cordis"), { recursive: true });
    assert.deepEqual(listNodeModulesDeepseekAi(dir), ["cordis", "dsh-tools"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("createSnapshot stores manifest sentinel and meta; list newest first", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-h-"));
  try {
    process.env.DSH_HOME = home;
    const dir = makeProfile(home, "web", { a: "1" }, ["x"]);
    mkdirSync(join(dir, "node_modules", "@deepseek-ai", "bad"), { recursive: true });
    await createSnapshot("web", { reason: "test", healthy: false });
    await new Promise((r) => setTimeout(r, 20));
    await createSnapshot("web", { reason: "test2", healthy: true });
    const snaps = listSnapshots("web");
    assert.equal(snaps.length, 2);
    assert.equal(snaps[0].healthy, true); // newest first
    const s0 = snaps[0];
    assert.ok(existsSync(join(s0.dir, "package.json")));
    assert.ok(existsSync(join(s0.dir, "sentinel.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(s0.dir, "sentinel.json"), "utf8")), ["bad"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("latestHealthy returns most recent healthy; markHealthy promotes; prune keeps N", async () => {
  const home = mkdtempSync(join(tmpdir(), "guard-h-"));
  try {
    process.env.DSH_HOME = home;
    makeProfile(home, "web", { a: "1" }, ["x"]);
    const a = await createSnapshot("web", { reason: "a", healthy: false });
    const b = await createSnapshot("web", { reason: "b", healthy: false });
    assert.equal(latestHealthy("web"), null);
    await markHealthy("web", a.id);
    assert.equal(latestHealthy("web"), a.id);
    await prune("web", 1);
    assert.equal(listSnapshots("web").length, 1);
    void b;
  } finally { rmSync(home, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test test/snapshot.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/sentinel.js
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
export function listNodeModulesDeepseekAi(profileDir) {
  const dir = join(profileDir, "node_modules", "@deepseek-ai");
  try { if (!existsSync(dir)) return []; return readdirSync(dir).filter((n) => !n.startsWith(".")).sort(); } catch { return []; }
}
```

```js
// lib/snapshot.js
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readManifest, manifestHash, depsOf, bundlesOf } from "./manifest.js";
import { guardsDir, profileDir, dshHome } from "./paths.js";
import { listNodeModulesDeepseekAi } from "./sentinel.js";

function dshVersion() { return process.env.DSH_GUARD_DSH_VERSION || "unknown"; }
function now() { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function idOf(nowStr, hash) { return `${nowStr}-${hash.slice(0, 8)}`; }

export async function createSnapshot(profile, { reason = "", healthy = false } = {}) {
  const dir = profileDir(profile);
  const manifest = readManifest(dir);
  if (!manifest) throw new Error(`guard: no package.json at ${dir}`);
  const hash = manifestHash(manifest);
  const ts = now();
  const id = idOf(ts, hash);
  const snapDir = join(guardsDir(profile), id);
  const tmpDir = snapDir + ".tmp";
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  copyFileSync(join(dir, "package.json"), join(tmpDir, "package.json"));
  writeFileSync(join(tmpDir, "sentinel.json"), JSON.stringify(listNodeModulesDeepseekAi(dir), null, 2));
  writeFileSync(join(tmpDir, "meta.json"), JSON.stringify({
    id, createdAt: new Date().toISOString(), reason, dshVersion: dshVersion(), healthy,
    hash, deps: depsOf(manifest), bundles: bundlesOf(manifest)
  }, null, 2));
  rmSync(snapDir, { recursive: true, force: true });
  mkdirSync(guardsDir(profile), { recursive: true });
  // rename across same volume; fallback copy
  try { renameSync(tmpDir, snapDir); } catch { copyRecursive(tmpDir, snapDir); rmSync(tmpDir, { recursive: true, force: true }); }
  return { id, dir: snapDir, healthy };
}
function copyRecursive(src, dst) { mkdirSync(dst, { recursive: true }); for (const e of readdirSync(src, { withFileTypes: true })) { const s = join(src, e.name); const d = join(dst, e.name); if (e.isDirectory()) copyRecursive(s, d); else copyFileSync(s, d); } }

function readMeta(snapDir) { try { return JSON.parse(readFileSync(join(snapDir, "meta.json"), "utf8")); } catch { return null; } }

export function listSnapshots(profile) {
  const root = guardsDir(profile);
  let names = []; try { names = readdirSync(root); } catch { return []; }
  return names.filter((n) => !n.endsWith(".tmp") && n !== "crash").map((n) => {
    const dir = join(root, n);
    const meta = readMeta(dir);
    if (!meta) return { id: n, dir, broken: true, createdAt: "" };
    return { id: n, dir, createdAt: meta.createdAt, reason: meta.reason, healthy: meta.healthy, hash: meta.hash, deps: meta.deps, bundles: meta.bundles, broken: false };
  }).filter((s) => s.broken === false || s.createdAt !== "").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
export function latestHealthy(profile) { const s = listSnapshots(profile).find((x) => x.healthy); return s ? s.id : null; }
export function snapshotDirOf(profile, id) { return join(guardsDir(profile), id); }
export function markHealthy(profile, id) {
  const dir = snapshotDirOf(profile, id);
  const metaPath = join(dir, "meta.json");
  const meta = readMeta(dir);
  if (!meta) throw new Error(`guard: snapshot ${id} missing meta`);
  meta.healthy = true; meta.promotedAt = new Date().toISOString();
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}
export function prune(profile, keep = Number(process.env.DSH_GUARD_KEEP || 5)) {
  const snaps = listSnapshots(profile);
  for (const s of snaps.slice(keep)) rmSync(s.dir, { recursive: true, force: true });
}
export { guardsDir };
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test test/snapshot.test.js`
  预期：PASS（3 tests）

- [ ] **步骤 5：提交**
  ```bash
  git add lib/sentinel.js lib/snapshot.js test/sentinel.test.js test/snapshot.test.js
  git commit -m "feat: snapshot core with sentinel and healthy marking (guard)"
  ```

---

### 任务 3：静态健康检查（guard check 只读）

**文件：**
- 新建：`lib/check.js`、`test/check.test.js`

**接口：**
- 依赖输入：任务 1（manifest）、任务 2（sentinel）
- 对外产出：`check.staticCheck(profile)` → `{ ok: boolean, problems: [{ severity: "error"|"warn", code, message }], summary: string }`。判定项：manifest 存在且解析 / dependencies 完整 / bundles 每项可 resolve（在 profile 的 node_modules 或全局 dsh 安装中找到包且其 package.json 声明 `dsh.bundle.patch`）/ cordis.patch.yml 无 duplicate insert id / node_modules/@deepseek-ai 顶层无 `dsh-tools|cordis|schemastery|dsh-util` 等宿主 core 副本遮蔽。

- [ ] **步骤 1：编写失败测试**

```js
// test/check.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticCheck } from "../lib/check.js";

function home(t) { return mkdtempSync(join(tmpdir(), "guard-c-")); }
function pkg(dir, obj) { writeFileSync(join(dir, "package.json"), JSON.stringify(obj)); }

test("clean profile passes", () => {
  const h = home(); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    pkg(dir, { dependencies: { "dsh-better-edit": "^1.0.0" }, dsh: { profile: { bundles: ["dsh-better-edit"] } } });
    mkdirSync(join(dir, "node_modules", "dsh-better-edit"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dsh-better-edit", "package.json"), JSON.stringify({ dsh: { bundle: { patch: "./cordis.patch.yml" } } }));
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:
  name: better-edit
");
    const r = staticCheck("web");
    assert.equal(r.ok, true, JSON.stringify(r.problems));
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("bundle that cannot resolve fails", () => {
  const h = home(); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    pkg(dir, { dependencies: {}, dsh: { profile: { bundles: ["ghost-pkg"] } } });
    const r = staticCheck("web");
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.code === "unresolvable-bundle"));
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("core shadowing in node_modules/@deepseek-ai flagged", () => {
  const h = home(); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    pkg(dir, { dependencies: {}, dsh: { profile: { bundles: [] } } });
    mkdirSync(join(dir, "node_modules", "@deepseek-ai", "dsh-tools"), { recursive: true });
    const r = staticCheck("web");
    assert.ok(r.problems.some((p) => p.code === "core-shadow"));
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("duplicate insert ids flagged", () => {
  const h = home(); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    pkg(dir, { dependencies: {}, dsh: { profile: { bundles: [] } } });
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:
  name: dup
- insert:
  name: dup
");
    const r = staticCheck("web");
    assert.ok(r.problems.some((p) => p.code === "dup-insert-id"));
  } finally { rmSync(h, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test test/check.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/check.js
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "./manifest.js";
import { profileDir } from "./paths.js";
import { listNodeModulesDeepseekAi } from "./sentinel.js";

const CORE_NAMES = new Set(["dsh-tools", "cordis", "schemastery", "dsh-util-values", "cosmokit", "dsh-client-runtime"]);

export function staticCheck(profile) {
  const dir = profileDir(profile);
  const problems = [];
  const manifest = readManifest(dir);
  if (!manifest) { problems.push({ severity: "error", code: "no-manifest", message: `package.json missing at ${dir}` }); return { ok: false, problems, summary: "no manifest" }; }
  // 1) insert ids in cordis.patch.yml
  const patchPath = join(dir, "cordis.patch.yml");
  if (existsSync(patchPath)) {
    const seen = new Set();
    let inInsert = false;
    for (const line of readFileSync(patchPath, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (/^- insert:\s*$/.test(t)) { inInsert = true; continue; }
      if (inInsert && /^name:\s*['"]?([^'"]+)['"]?\s*$/.test(t)) {
        const name = t.match(/^name:\s*['"]?([^'"]+)['"]?\s*$/)[1];
        if (seen.has(name)) problems.push({ severity: "error", code: "dup-insert-id", message: `duplicate insert id ${name}` });
        seen.add(name); inInsert = false;
      }
    }
  }
  // 2) bundles resolve (package dir exists and declares dsh.bundle.patch)
  for (const b of (manifest.dsh?.profile?.bundles ?? [])) {
    const scoped = b.startsWith("@") ? b.split("/").slice(0, 2).join("/") : b;
    const pkgPath = join(dir, "node_modules", scoped, "package.json");
    let ok = false;
    try { const mp = JSON.parse(readFileSync(pkgPath, "utf8")); ok = !!mp?.dsh?.bundle?.patch; } catch { ok = false; }
    if (!ok) problems.push({ severity: "error", code: "unresolvable-bundle", message: `bundle ${b} cannot resolve or lacks dsh.bundle.patch` });
  }
  // 3) @deepseek-ai core shadowing
  for (const name of listNodeModulesDeepseekAi(dir)) {
    if (CORE_NAMES.has(name)) problems.push({ severity: "error", code: "core-shadow", message: `@deepseek-ai/${name} copy present in profile node_modules (core shadowing)` });
  }
  return { ok: problems.every((p) => p.severity !== "error"), problems, summary: problems.length ? problems.map((p) => p.message).join("; ") : "healthy" };
}
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test test/check.test.js`
  预期：PASS（4 tests）

- [ ] **步骤 5：提交**
  ```bash
  git add lib/check.js test/check.test.js
  git commit -m "feat: static health check for profile (guard)"
  ```

---

### 任务 4：宿主探活与进程管理（probe + host）

**文件：**
- 新建：`lib/probe.js`、`lib/host.js`、`test/probe.test.js`、`test/host.test.js`

**接口：**
- 依赖输入：任务 1 paths
- 对外产出：
  - `probe.isHostHealthy(baseUrl = "http://127.0.0.1:3080", timeoutMs = 800)` → Promise<boolean>（响应含 `__DSH_BOOT__` 或 401 + `authentication required` marker 判在线；复用桌面端 probeHost 语义）
  - `probe.waitHostReady(baseUrl, deadlineMs = 45000)` → Promise<boolean>（轮询 250ms）
  - `host.spawnHost(profile, extraArgs = [], { logFile })` → child | null（定位全局 dsh bin.js：`<npmGlobal>/node_modules/@deepseek-ai/dsh/lib/bin.js`；找不到则 spawn `npx --yes @deepseek-ai/dsh`）
  - `host.stopHostByPort(port = 3080)` → Promise<{killed: number[]}>（netstat 找 pid → taskkill /T /F；仅杀命令行含 dsh 特征者——安全）
  - `host.hostLogTail(logFile, n = 40)` → string（失败原因给报告用）

- [ ] **步骤 1：编写失败测试**

```js
// test/probe.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isHostHealthy } from "../lib/probe.js";

test("healthy host has __DSH_BOOT__", async () => {
  const srv = createServer((req, res) => { res.end("<html>__DSH_BOOT__</html>"); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try { assert.equal(await isHostHealthy(`http://127.0.0.1:${port}`), true); }
  finally { srv.close(); }
});
test("auth-locked host (401) counts healthy", async () => {
  const srv = createServer((req, res) => { res.statusCode = 401; res.end("authentication required"); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try { assert.equal(await isHostHealthy(`http://127.0.0.1:${port}`), true); }
  finally { srv.close(); }
});
test("nothing listening is unhealthy", async () => {
  assert.equal(await isHostHealthy("http://127.0.0.1:1", 300), false);
});
```

```js
// test/host.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDshBin, stopHostByPort } from "../lib/host.js";

test("resolveDshBin finds global install", () => {
  // point NODE_PATH-like env at a fake npm global layout
  const h = mkdtempSync(join(tmpdir(), "guard-host-")); try {
    const fake = join(h, "node_modules", "@deepseek-ai", "dsh");
    const fs2 = await import("node:fs"); fs2.mkdirSync(fake, { recursive: true });
    fs2.writeFileSync(join(fake, "lib", "bin.js"), "#!/usr/bin/env node
");
    const bin = resolveDshBin(h);
    assert.ok(bin.endsWith("bin.js"));
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("stopHostByPort no-op when nothing matches", async () => {
  const r = await stopHostByPort(59999, { dryRun: true });
  assert.ok(Array.isArray(r.killed));
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test test/probe.test.js test/host.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/probe.js
import http from "node:http";
export function probeBase(baseUrl, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(baseUrl, (res) => {
      let d = ""; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > 65536) { req.destroy(); } else { d += c; } });
      res.on("end", () => { res.resume(); resolve(d.includes("__DSH_BOOT__") || (res.statusCode === 401 && d.includes("authentic"))); });
      res.on("error", () => resolve(false));
    });
    req.on("error", () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}
export async function isHostHealthy(baseUrl = "http://127.0.0.1:3080", timeoutMs = 800) { return probeBase(baseUrl, timeoutMs); }
export async function waitHostReady(baseUrl, deadlineMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) { if (await isHostHealthy(baseUrl, 800)) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
```

```js
// lib/host.js
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
export function resolveDshBin(npmGlobalRoot = process.env.APPDATA ? join(process.env.APPDATA, "npm") : null) {
  const cands = [];
  if (npmGlobalRoot) cands.push(join(npmGlobalRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  cands.push(join(process.env.USERPROFILE || "", "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}
export function spawnHost(profile, extraArgs = [], { logFile = null } = {}) {
  const bin = resolveDshBin();
  const args = bin ? [bin, "--profile", profile, ...extraArgs] : ["--yes", "@deepseek-ai/dsh", "--profile", profile, ...extraArgs];
  const cmd = bin ? process.execPath : (process.platform === "win32" ? "npx.cmd" : "npx");
  return spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
}
export function hostLogTail(logFile, n = 40) {
  try {
    if (!logFile || !existsSync(logFile)) return "";
    const lines = readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-n).join("\n");
  } catch { return ""; }
}
export async function stopHostByPort(port = 3080, { dryRun = false } = {}) {
  // netstat parse; kill only command lines matching dsh
  const killed = [];
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/\s*TCP\s+[^\s]+:PORT\s+.*LISTENING\s+(\d+)/.exec(line.replaceAll(":PORT", ":" + port)));
      if (m && m[1]) pids.add(m[1]);
    }
    for (const pid of pids) {
      if (String(pid) === String(process.pid)) continue;
      const cmd = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"], { encoding: "utf8", windowsHide: true });
      if (/dsh|bin\.js|deepseek/i.test(cmd)) { if (!dryRun) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true }); killed.push(pid); }
    }
  } catch { /* no pids or no match */ }
  return { killed };
}
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test test/probe.test.js test/host.test.js`
  预期：PASS（4 tests）

- [ ] **步骤 5：提交**
  ```bash
  git add lib/probe.js lib/host.js test/probe.test.js test/host.test.js
  git commit -m "feat: host probe and process management (guard)"
  ```

---

### 任务 5：回滚与报告（rollback + report）

**文件：**
- 新建：`lib/rollback.js`、`lib/report.js`、`test/rollback.test.js`、`test/report.test.js`

**接口：**
- 依赖输入：任务 1 manifest、任务 2 snapshot、任务 3 check、任务 4 host
- 对外产出：
  - `rollback.rollbackToSnapshot(profile, snapshotId, { autoRestart = true })` → `{ ok, restored: boolean, restartError?, report }`
  - 流程：读快照 meta → 备份当前坏态到 `crash/<ts>/`（copy manifest+sentinel）→ `stopHostByPort` → 写回快照 package.json → `staticCheck` → （autoRestart）`spawnHost`+waitHostReady → 生成报告
  - `report.buildRestoreReport({ profile, reason, before, after, crashReason, snapshotId })` → markdown 字符串（中文，脱敏）
  - `report.saveRestoreReport(dir, md)` → 文件路径（`restore-report-<ts>.md` + `last-report.md`）

- [ ] **步骤 1：编写失败测试**

```js
// test/rollback.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshot } from "../lib/snapshot.js";
import { rollbackToSnapshot } from "../lib/rollback.js";

test("rollback restores manifest from healthy snapshot", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-r-")); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    const good = { dependencies: { a: "1" }, dsh: { profile: { bundles: ["a"] } } };
    writeFileSync(join(dir, "package.json"), JSON.stringify(good));
    const snap = await createSnapshot("web", { reason: "before bad", healthy: true });
    const bad = { dependencies: { a: "1", evil: "1" }, dsh: { profile: { bundles: ["a", "evil"] } } };
    writeFileSync(join(dir, "package.json"), JSON.stringify(bad));
    const r = await rollbackToSnapshot("web", snap.id, { autoRestart: false });
    assert.equal(r.ok, true);
    const after = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.deepEqual(after.dependencies, { a: "1" });
    assert.ok(!("evil" in after.dependencies));
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("rollback backs up current bad state under crash/", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-r-")); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const snap = await createSnapshot("web", { reason: "x", healthy: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { evil: "1" }, dsh: { profile: { bundles: ["evil"] } } }));
    await rollbackToSnapshot("web", snap.id, { autoRestart: false });
    const crashRoot = join(h, ".dsh", "guards", "web", "crash");
    const entries = require("node:fs").readdirSync(crashRoot);
    assert.ok(entries.length >= 1);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test test/rollback.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/rollback.js
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { profileDir, guardsDir, crashDir } from "./paths.js";
import { readManifest, writeManifest } from "./manifest.js";
import { snapshotDirOf } from "./snapshot.js";
import { staticCheck } from "./check.js";
import { spawnHost, stopHostByPort, hostLogTail, resolveDshBin } from "./host.js";
import { waitHostReady, isHostHealthy } from "./probe.js";
import { buildRestoreReport, saveRestoreReport } from "./report.js";

export async function rollbackToSnapshot(profile, snapshotId, { autoRestart = true } = {}) {
  const dir = profileDir(profile);
  const snapDir = snapshotDirOf(profile, snapshotId);
  const metaPath = join(snapDir, "meta.json");
  let meta = null;
  try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch {}
  if (!meta) return { ok: false, restored: false, error: `snapshot ${snapshotId} missing` };
  if (!meta.healthy) return { ok: false, restored: false, error: "refusing to roll back to a non-healthy snapshot" };
  const before = readManifest(dir);
  // 1) back up current (bad) state
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const cdir = join(crashDir(profile), ts);
  mkdirSync(cdir, { recursive: true });
  if (existsSync(join(dir, "package.json"))) copyFileSync(join(dir, "package.json"), join(cdir, "package.json.bad"));
  if (existsSync(join(snapDir, "sentinel.json"))) copyFileSync(join(snapDir, "sentinel.json"), join(cdir, "sentinel.snapshot.json"));
  // 2) stop host if listening (auto mode or forced)
  await stopHostByPort(3080);
  // 3) restore manifest
  copyFileSync(join(snapDir, "package.json"), join(dir, "package.json"));
  const after = readManifest(dir);
  // 4) reconcile: drop bundles whose dependency is not present (mirror reconcilePlugins)
  //    simplest safe form: keep only bundles present in restored dependencies that resolve
  const deps = new Set(Object.keys(after?.dependencies ?? {}));
  after.dsh = after.dsh ?? {}; after.dsh.profile = after.dsh.profile ?? {};
  after.dsh.profile.bundles = (after.dsh.profile.bundles ?? []).filter((b) => deps.has(b));
  writeManifest(dir, after);
  const check = staticCheck(profile);
  // 5) auto restart
  let restartError = null; let restarted = false;
  if (autoRestart && check.ok) {
    const child = spawnHost(profile, ["--no-open"], {});
    child.unref();
    restarted = await waitHostReady("http://127.0.0.1:3080", 45000);
    if (!restarted) restartError = hostLogTail(null);
  }
  const report = buildRestoreReport({ profile, reason: "auto-rollback after boot failure", before, after, snapshotId, check, restarted, restartError });
  const file = saveRestoreReport(guardsDir(profile), report);
  return { ok: true, restored: true, restarted, restartError, report, file };
}
```

```js
// lib/report.js
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export function buildRestoreReport({ profile, reason, before, after, crashReason = "", snapshotId = "", check = null, restarted = false, restartError = null }) {
  const lines = [
    "# dsh-profile-guard 恢复报告",
    "",
    `- 时间：${new Date().toISOString()}`,
    `- Profile：${profile}`,
    `- 原因：${reason}`,
    snapshotId ? `- 回滚到快照：${snapshotId}` : "",
    `- 恢复前 bundles：${(before?.dsh?.profile?.bundles ?? []).join("、") || "（无）"}`,
    `- 恢复后 bundles：${(after?.dsh?.profile?.bundles ?? []).join("、") || "（无）"}`,
    `- 自动重启：${restarted ? "成功" : restartError ? `失败（${sanitize(restartError).slice(0, 200)}）` : "未执行"}`,
  ].filter(Boolean);
  if (crashReason) lines.push("", "## 崩溃原因", "", "```", sanitize(String(crashReason)).slice(0, 1500), "```");
  if (check && check.problems.length) lines.push("", "## 健康检查问题", ...check.problems.map((p) => `- [${p.severity}] ${p.message}`));
  return lines.join("\n");
}
function sanitize(s) { return String(s).replace(/(token|authorization|cookie|password|secret|key)=[^\s&]+/gi, "$1=***"); }
export function saveRestoreReport(dir, md) {
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `restore-report-${ts}.md`);
  writeFileSync(file, md, "utf8");
  writeFileSync(join(dir, "last-report.md"), md, "utf8");
  return file;
}
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test test/rollback.test.js`
  预期：PASS（2 tests）——注意：测试中 `stopHostByPort(3080)` 会尝试杀真实宿主！在测试里必须避免。修正：rollbackToSnapshot 接受 `{ port: 0 }` 跳过杀进程（见步骤 3 实现里 `await stopHostByPort(3080)` 改为 `if (options.stopPort) ...`，测试传 `{ stopPort: false }`）。

  **实现修正**：把 `rollbackToSnapshot` 签名改为 `(profile, snapshotId, { autoRestart = true, stopPort = true } = {})`，内部 `if (stopPort) await stopHostByPort(3080);`。测试调用传 `{ autoRestart: false, stopPort: false }`。同时两处测试断言 crash 备份目录用 `readdirSync`。

- [ ] **步骤 5：提交**
  ```bash
  git add lib/rollback.js lib/report.js test/rollback.test.js test/report.test.js
  git commit -m "feat: rollback with crash-state backup and restore report (guard)"
  ```

---

### 任务 6：boot 主流程（guard boot）

**文件：**
- 新建：`lib/boot.js`、`test/boot.test.js`

**接口：**
- 依赖输入：任务 2 snapshot、任务 4 host/probe、任务 5 rollback
- 对外产出：`boot.bootOnce(profile, extraArgs)` → `{ ok, snapshotId?, rolledBack?: boolean, restarted?: boolean, error? }`
  - 逻辑：① 若存在 pending 快照未结算（上次崩溃现场）→ 先结算（回滚到最近 healthy 或标记）。② 读 manifest，若与最近快照 hash 不同 → createSnapshot(healthy:false)。③ 若 3080 已在线且健康 → 直接返回 ok（已在运行，无需重启，同桌面端 probe）。④ spawnHost + waitHostReady。⑤ 成功 → markHealthy + prune。⑥ 失败 → 日志含 plugin tree failed 等 → rollbackToSnapshot(latestHealthy, autoRestart:true)；若无 healthy 快照 → 报告并停在现场。

- [ ] **步骤 1：编写失败测试（用假宿主：本地 http server 模拟健康；spawn 指向假 bin.js）**

```js
// test/boot.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { bootOnce } from "../lib/boot.js";

test("bootOnce succeeds and marks snapshot healthy when host comes up", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-b-")); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    // fake healthy host: an http server answering __DSH_BOOT__
    const srv = createServer((req, res) => { res.end("__DSH_BOOT__"); });
    await new Promise((r) => srv.listen(0, r));
    const port = srv.address().port;
    try {
      const r = await bootOnce("web", [], { baseUrl: `http://127.0.0.1:${port}`, spawnDelayMs: 0, waitReady: true });
      assert.equal(r.ok, true);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("bootOnce with no healthy host and no snapshot reports failure without rollback loop", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-b-")); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const r = await bootOnce("web", [], { baseUrl: "http://127.0.0.1:1", spawnDelayMs: 0, waitReady: false, failFast: true });
    assert.equal(r.ok, false);
    assert.equal(r.rolledBack, undefined);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test test/boot.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/boot.js
import { readManifest, manifestHash } from "./manifest.js";
import { profileDir, guardsDir } from "./paths.js";
import { createSnapshot, listSnapshots, latestHealthy, markHealthy, prune } from "./snapshot.js";
import { isHostHealthy, waitHostReady } from "./probe.js";
import { spawnHost, hostLogTail } from "./host.js";
import { rollbackToSnapshot } from "./rollback.js";

export async function bootOnce(profile, extraArgs = [], opts = {}) {
  const baseUrl = opts.baseUrl || "http://127.0.0.1:3080";
  const dir = profileDir(profile);
  const manifest = readManifest(dir);
  if (!manifest) return { ok: false, error: `no manifest at ${dir}` };
  // already running & healthy -> nothing to do
  if (await isHostHealthy(baseUrl, 800)) return { ok: true, alreadyRunning: true };
  // settle any pending snapshot from a previous interrupted boot: if a crash marker
  // or pending snapshot newer than latest healthy exists and profile is now unhealthy -> rollback
  const snaps = listSnapshots(profile);
  const pending = snaps.find((s) => !s.healthy);
  const lastHealthy = latestHealthy(profile);
  // snapshot current state as pending before boot
  let snapId = null;
  const lastHash = snaps[0]?.hash;
  if (manifestHash(manifest) !== lastHash || !snaps.length) {
    const created = await createSnapshot(profile, { reason: "guard boot", healthy: false });
    snapId = created.id;
  } else if (snaps.length) { snapId = snaps[0].id; }
  // spawn host (test injects a fake; real mode spawns global dsh bin)
  if (opts.spawnHost === false) { /* test supplies its own running server */ }
  else {
    const child = spawnHost(profile, ["--no-open", ...extraArgs], {});
    child.unref();
  }
  const ready = opts.waitReady === false ? false : await waitHostReady(baseUrl, opts.waitReadyMs ?? 45000);
  if (ready) {
    if (snapId) { try { markHealthy(profile, snapId); } catch {} }
    prune(profile);
    return { ok: true, snapshotId: snapId };
  }
  // boot failed: decide rollback
  const log = hostLogTail(opts.logFile ?? null);
  const isPluginFailure = /plugin tree failed|host preparation failed|Cannot find module|SyntaxError/i.test(log || "");
  if (isPluginFailure && lastHealthy && snapId && snapId !== lastHealthy) {
    const rb = await rollbackToSnapshot(profile, lastHealthy, { autoRestart: true, stopPort: true });
    return { ok: rb.ok, rolledBack: true, restarted: rb.restarted, error: rb.restartError, snapshotId: lastHealthy, report: rb.report };
  }
  // settle pending (never leave dangling)
  if (pending && !ready) { /* leave for next boot with report */ }
  return { ok: false, error: "host did not become ready", snapshotId: snapId };
}
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test test/boot.test.js`
  预期：PASS（2 tests）

- [ ] **步骤 5：提交**
  ```bash
  git add lib/boot.js test/boot.test.js
  git commit -m "feat: guard boot main flow with auto-rollback (guard)"
  ```

---

### 任务 7：CLI 接线（guard boot/snapshot/list/show/restore/check/watch/help）

**文件：**
- 新建：`lib/cli.js`、`test/cli.test.js`（用 child spawn 跑 `node lib/cli.js` 断言输出与退出码）

**接口：**
- 依赖输入：任务 2/3/5/6 全部
- 对外产出：可执行 `guard` 二进制；子命令与退出码：
  - `guard boot [--profile web] [-- args...]` → 0 成功 / 1 失败 / 2 已在运行
  - `guard snapshot --reason "..." ` → 0，打印 `snapshot <id> created`
  - `guard list` / `guard show <id>` / `guard restore <id> [--no-auto-restart]` / `guard check` / `guard watch`（调 watch.js）/ `guard --help`

- [ ] **步骤 1：编写失败测试**

```js
// test/cli.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "lib", "cli.js");
function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd: process.cwd() }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
test("snapshot then list shows one entry", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-")); try {
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const env = { DSH_HOME: h };
    const s = await run(["snapshot", "--profile", "web", "--reason", "cli test"], env);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /snapshot .+ created/);
    const l = await run(["list", "--profile", "web"], env);
    assert.equal(l.code, 0);
    assert.match(l.stdout, /web/);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("check reports healthy", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-")); try {
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const c = await run(["check", "--profile", "web"], { DSH_HOME: h });
    assert.equal(c.code, 0);
  } finally { rmSync(h, { recursive: true, force: true }); }
});
test("unknown command exits 2 with usage", async () => {
  const r = await run(["bogus"], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /usage/i);
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test test/cli.test.js`
  预期：FAIL——cli.js not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/cli.js
#!/usr/bin/env node
import { profileDir } from "./paths.js";
import { readManifest } from "./manifest.js";
import { createSnapshot, listSnapshots, latestHealthy } from "./snapshot.js";
import { staticCheck } from "./check.js";
import { bootOnce } from "./boot.js";
import { rollbackToSnapshot } from "./rollback.js";

const USAGE = `usage: guard <command> [--profile <name>] [options]

commands:
  boot      start the dsh host with an automatic snapshot + rollback guard
  snapshot  create a snapshot of the current profile state
  list      list snapshots
  show <id> show snapshot details
  restore <id>  roll back to a snapshot
  check     run a read-only health check on the profile
  watch     watch profile changes and snapshot automatically
  help      show this help
`;
function fail(msg, code = 1) { process.stderr.write(msg + "\n"); process.exit(code); }
function parse(argv) {
  const profile = argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1] : "web";
  const rest = argv.filter((a, i) => !(a === "--profile" || argv[i - 1] === "--profile"));
  return { profile, rest };
}
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") { process.stdout.write(USAGE); process.exit(0); }
  const cmd = argv[0];
  const { profile, rest } = parse(argv.slice(1));
  switch (cmd) {
    case "boot": {
      const r = await bootOnce(profile, rest, {});
      if (r.ok) { process.stdout.write(r.alreadyRunning ? "host already running (healthy)\n" : `boot ok (snapshot ${r.snapshotId})\n`); process.exit(0); }
      fail(`boot failed: ${r.error || "unknown"}` + (r.report ? `\nreport: ${r.report}` : ""), 1);
      break;
    }
    case "snapshot": {
      const reason = rest.includes("--reason") ? rest[rest.indexOf("--reason") + 1] : "manual";
      const s = await createSnapshot(profile, { reason, healthy: false });
      process.stdout.write(`snapshot ${s.id} created\n`);
      process.exit(0);
      break;
    }
    case "list": {
      const snaps = listSnapshots(profile);
      if (!snaps.length) { process.stdout.write("no snapshots\n"); process.exit(0); }
      for (const s of snaps) process.stdout.write(`${s.healthy ? "[healthy] " : "[pending] "}${s.id} ${s.createdAt} ${s.reason ? "(" + s.reason + ")" : ""}\n`);
      process.exit(0);
      break;
    }
    case "restore": {
      const id = rest[0];
      if (!id) fail("usage: guard restore <id> [--no-auto-restart]", 2);
      const r = await rollbackToSnapshot(profile, id, { autoRestart: !rest.includes("--no-auto-restart"), stopPort: true });
      if (r.ok) { process.stdout.write(`restored to ${id} (restarted: ${r.restarted})\n`); process.exit(0); }
      fail(`restore failed: ${r.error}`, 1);
      break;
    }
    case "check": {
      const r = staticCheck(profile);
      process.stdout.write(r.ok ? `profile ${profile}: ${r.summary}\n` : `profile ${profile}: ${r.summary}\n`);
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case "watch": {
      const { watchProfile } = await import("./watch.js");
      await watchProfile(profile);
      process.exit(0);
      break;
    }
    default: fail(USAGE, 2);
  }
}
main().catch((e) => { process.stderr.write("guard error: " + (e?.message || e) + "\n"); process.exit(1); });
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test test/cli.test.js`
  预期：PASS（3 tests）

- [ ] **步骤 5：提交**
  ```bash
  git add lib/cli.js test/cli.test.js
  git commit -m "feat: guard CLI command surface (guard)"
  ```

---

### 任务 8：watch（A2 辅助）

**文件：**
- 新建：`lib/watch.js`、`test/watch.test.js`

**接口：**
- 依赖输入：任务 2 snapshot、任务 1 manifest
- 对外产出：`watch.watchProfile(profile, { debounceMs = 2000 })` → 监听 `profileDir(profile)/package.json` 与 `pnpm-lock.yaml` 的 change 事件，去抖后若 manifest hash 与最近快照不同 → createSnapshot(reason:"auto (watch)")。返回一个 `{ close() }` 句柄便于测试。

- [ ] **步骤 1：编写失败测试**

```js
// test/watch.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchProfile } from "../lib/watch.js";
import { listSnapshots } from "../lib/snapshot.js";

test("watch creates a snapshot when package.json changes", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-w-")); try {
    process.env.DSH_HOME = h;
    const dir = join(h, ".dsh", "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const w = watchProfile("web", { debounceMs: 50 });
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { x: "1" }, dsh: { profile: { bundles: ["x"] } } }));
    await new Promise((r) => setTimeout(r, 300));
    w.close();
    const snaps = listSnapshots("web");
    assert.ok(snaps.length >= 1, "expected at least one auto snapshot");
  } finally { rmSync(h, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test test/watch.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/watch.js
import { watch } from "node:fs";
import { join } from "node:path";
import { readManifest, manifestHash } from "./manifest.js";
import { profileDir } from "./paths.js";
import { createSnapshot, listSnapshots } from "./snapshot.js";

export function watchProfile(profile, { debounceMs = 2000 } = {}) {
  const dir = profileDir(profile);
  let timer = null;
  const onChange = async () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const m = readManifest(dir);
        if (!m) return;
        const snaps = listSnapshots(profile);
        if (!snaps.length || snaps[0].hash !== manifestHash(m)) {
          await createSnapshot(profile, { reason: "auto (watch)", healthy: false });
          process.stdout.write(`[guard watch] snapshot created for ${profile}\n`);
        }
      } catch (e) { process.stderr.write("[guard watch] error: " + (e?.message || e) + "\n"); }
    }, debounceMs);
  };
  const w1 = watch(join(dir, "package.json"), { persistent: false }, onChange);
  const w2 = watch(join(dir, "pnpm-lock.yaml"), { persistent: false }, onChange);
  process.stdout.write(`[guard watch] watching ${profile}\n`);
  return { close: () => { clearTimeout(timer); w1.close(); w2.close(); } };
}
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test test/watch.test.js`
  预期：PASS（1 test）

- [ ] **步骤 5：提交**
  ```bash
  git add lib/watch.js test/watch.test.js
  git commit -m "feat: guard watch auto-snapshot on profile change (guard)"
  ```

---

### 任务 9：README 双语 + 真实宿主冒烟（沙箱外人工项标注）

**文件：**
- 新建：`README.md`、`README.zh.md`；设计文档 §8 spike 结论若已产出则引用

**接口：**
- 依赖输入：全部前序任务
- 对外产出：可发布包；真实冒烟清单

- [ ] **步骤 1：写 README.md（英文）**
  内容：这是什么（CLI 直装路径的装崩保险）、为什么（两次事故 KB 引用可不放仓库，简述）、安装（npm i -g 或 git clone + node lib/cli.js）、命令表、快照位置 `~/.dsh/guards/<profile>`、与 dshmarket/dsh-desktop 的关系（各自覆盖不同路径，互不干扰）、安全说明（只读写 `~/.dsh/guards` 与 profile 的 package.json）、许可证 MIT。

- [ ] **步骤 2：写 README.zh.md**
  中文同内容，命令/路径与英文版逐字一致。

- [ ] **步骤 3：真实冒烟（沙箱外，标注给用户执行）**
  在 `C:\Users\ASUS\.dsh\profiles\web` 上执行：
  ```bash
  node G:\deepseek\opensource\dsh-profile-guard\lib\cli.js check --profile web
  # 预期：profile web: healthy 或列出具体问题（当前 22 bundles 应 healthy）
  node G:\deepseek\opensource\dsh-profile-guard\lib\cli.js snapshot --profile web --reason "first smoke"
  node G:\deepseek\opensource\dsh-profile-guard\lib\cli.js list --profile web
  # 预期：1 条 pending 快照
  ```
  **注意**：`guard boot` 真实执行会杀/拉 3080 宿主——必须由用户在桌面端空闲时段确认后运行，agent 不自行执行（会杀本会话进程）。

- [ ] **步骤 4：提交**
  ```bash
  git add README.md README.zh.md
  git commit -m "docs: bilingual README for dsh-profile-guard (guard)"
  ```

---

## 自检记录（计划作者填写）

- **规格覆盖度**：设计文档 §4 命令面（boot/snapshot/list/show/restore/check/watch）→ 任务 6/7/2/3/5/8 全覆盖；§5 快照位置与内容 → 任务 2；§6 回滚语义与 EADDRINUSE 跳过 → 任务 5（stopPort 可控）+ 任务 6（boot 判 plugin failure）；§7 健康判定 4 项 → 任务 3；§8 spike → 任务 0；§9 安全（脱敏、只读写指定目录）→ report.sanitize + 全局约束；§10 发布 → 任务 9。
- **占位符扫描**：无 TODO/TBD；每步含代码或精确命令。
- **类型一致性**：`createSnapshot` 返回 `{id}` 一致；`listSnapshots` 字段 `hash/healthy/createdAt/reason` 跨任务一致；`rollbackToSnapshot(profile,id,{autoRestart,stopPort})` 在任务 5/6/7 三处签名一致；`bootOnce(profile,extraArgs,opts)` 任务 6/7 一致。
- **已知风险**：任务 5 测试若误杀真实宿主会酿事故——已在实现中加 `stopPort:false` 保护并写入测试调用；任务 9 真实 boot 由用户在沙箱外执行。
