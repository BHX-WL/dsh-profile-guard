# dsh-profile-guard preflight 实施计划（② 深度兼容预检门）

> **面向 Agent 执行者：** 必需子技能：使用 superpower-subagent-driven-development（推荐）或 superpower-executing-plans 按任务逐项执行本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 为 dsh-profile-guard 增加 `guard preflight <pkg>`（装前深度兼容检查，拒绝 prod deps 含 @deepseek-ai core 的包）与 `guard install <pkg>`（preflight → snapshot → dsh plugin add → boot 的闭环），并落实设计 §11.5 的宿主契约兼容性护栏。

**架构：** 纯 Node ESM 零第三方依赖扩展。新增 `lib/contract.js`（宿主契约常数集中 + env 覆写，兼容性护栏基座）、`lib/core-packages.js`（core 清单：静态 fallback + 动态宿主目录读取）、`lib/registry.js`（fetch npm manifest，网络层）、`lib/preflight.js`（判定纯函数，网络与判定分离）。修改 `lib/check.js`（CORE_NAMES 复用 core-packages 消除漂移）、`lib/cli.js`（preflight/install 两分支）。`guard install` 经 resolveDshBin spawn `plugin --profile web add <pkg>`（① host.js 已证可定位）后调 `bootOnce` 验证。

**技术栈：** Node ≥ 20（本机 v24.19.0），ESM，内置 node:test；宿主 core 0.1.2-rc.1；registry 默认腾讯镜像 `https://registry.npmmirror.com`（env `DSH_GUARD_REGISTRY` 可换）。

**规格：** `docs/design/2026-09-06-dsh-preflight-design.md`（v0.2，用户已复核同意，含 §11.5 兼容性护栏）。计划论证以规格为准，执行者需同时阅读设计文档与本节。

## 全局约束

- 项目根：`G:\deepseek\opensource\dsh-profile-guard`（独立 git 仓库，master @ ff4563a 含 ① 全部实现 + v0.2 设计文档；53 测试绿）。
- **兼容性护栏（设计 §11.5，用户特别要求，每个任务都须遵守）**：
  - lib 任何文件**不得 import 任何 @deepseek-ai/* 或 cordis 运行时包**（已审计现状满足；新增文件保持）。测试 `test/contract.test.js` 断言：扫描 lib/*.js import 语句无 @deepseek-ai 前缀。
  - 防御性读取：manifest/patch/宿主结构解析全部容错——读不到 `dsh.profile.bundles` 按空处理并 warn，绝不 throw；schema 未知字段保留原样写回。
  - 契约常数（C1 CLI 入口、C2 在线 marker、C5 boot 失败文本）集中在 `lib/contract.js` 单文件，支持 env 覆写；本计划新增代码一律引用 contract.js 而非裸字符串。
  - 任何内部异常被顶层 catch 捕获 → 打印可读错误 + 退出码，绝不裸 stack trace（cli.js main().catch 已存在，保持并扩展）。
- 零第三方运行时依赖；devDependencies 为空；package.json 无 dependencies 字段。
- 全部 ESM（"type": "module"）；Node ≥ 20。
- 测试命令：`node --test --test-isolation=none test/*.test.js`（本机沙箱需此 flag；npm test 脚本 = `node --test test/**/*.test.js` 保持不动）。
- 平台 Windows 代码跨平台（node:path join）；提交英文。
- 现有 53 测试全绿是基线；每个任务完成后全量必须全绿（计数按任务新增）。
- 测试隔离：网络层测试用本地 http server stub（不真连 registry）；判定层测试用 fixture manifest（纯本地）；**guard install 测试绝不真装包、绝不真拉/杀宿主**（spawn 分支注入或 dry）。
- DSH_HOME=数据根语义（无 .dsh 段）沿用 ①。
- 版本：package.json 0.1.0 → 0.2.0（README 命令表加 preflight/install）。

## 文件结构

```
dsh-profile-guard/
├── lib/
│   ├── contract.js          # 新建：C1/C2/C5 契约常数 + env 覆写读取（兼容性护栏基座）
│   ├── core-packages.js     # 新建：CORE_PACKAGES（静态 fallback + 动态宿主目录读取）
│   ├── registry.js          # 新建：fetchManifest(pkg, registry) 网络层（超时/404/version 解析）
│   ├── preflight.js         # 新建：preflight(pkg, {profile, registry, hostVersion, corePackages, installedPatches}) 纯函数判定
│   ├── check.js             # 修改：CORE_NAMES → 复用 core-packages.js（行为不变）
│   ├── cli.js               # 修改：preflight/install 两分支 + --force/--registry 解析
│   ├── boot.js / host.js / manifest.js / snapshot.js / probe.js / paths.js / rollback.js / report.js / watch.js / sentinel.js  # ① 已交付，仅 contract.js 常数替换触及（C2 marker、C5 文本）
└── test/
    ├── contract.test.js     # 新建：契约常数/env 覆写 + 零 import 扫描断言
    ├── core-packages.test.js# 新建
    ├── registry.test.js     # 新建：本地 http stub
    ├── preflight.test.js    # 新建：fixture 判定矩阵
    ├── cli.test.js          # 修改：preflight/install 安全用例
    └── (既有 9 个测试文件保持)
```

---

### 任务 0：契约常数集中（lib/contract.js）——兼容性护栏基座

**文件：**
- 新建：`lib/contract.js`、`test/contract.test.js`
- 修改：`lib/probe.js`（C2 marker 引用）、`lib/boot.js`（C5 文本引用）

**接口：**
- 依赖输入：设计 §11.5 契约点清单；① 已交付 probe.js/boot.js 中的裸字符串
- 对外产出：
  - `contract.hostBootMarker()` → env `DSH_GUARD_BOOT_MARKER` || "__DSH_BOOT__"（C2）
  - `contract.hostAuthMarker()` → env `DSH_GUARD_AUTH_MARKER` || "authentic"（C2 401 marker）
  - `contract.pluginFailureTexts()` → env `DSH_GUARD_FAIL_TEXT`（逗号分隔）|| ["plugin tree failed","host preparation failed","Cannot find module","SyntaxError"]（C5）
  - `contract.pluginCliArgs()` → ["--profile"] 相关（C1 参数形状，install 用）
  - `contract.noOpenFlag()` → env `DSH_GUARD_NO_OPEN` || "--no-open"（C1）
  - `contract.checkHostContract(observed)` → [{name, ok, observed}]（契约探测汇总，供 guard check 输出 warn）
  - 零 import 断言（测试内扫描 lib/*.js 的 `from "…"` 无 @deepseek-ai 前缀）

- [ ] **步骤 1：编写失败测试**

```js
// test/contract.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as contract from "../lib/contract.js";

test("defaults match the shipped host contract", () => {
  assert.equal(contract.hostBootMarker(), "__DSH_BOOT__");
  assert.equal(contract.hostAuthMarker(), "authentic");
  assert.deepEqual(contract.pluginFailureTexts(), ["plugin tree failed", "host preparation failed", "Cannot find module", "SyntaxError"]);
  assert.equal(contract.noOpenFlag(), "--no-open");
});

test("env overrides take effect", () => {
  const saved = { ...process.env };
  try {
    process.env.DSH_GUARD_BOOT_MARKER = "NEW_MARKER";
    process.env.DSH_GUARD_FAIL_TEXT = "boom;kaboom";
    process.env.DSH_GUARD_NO_OPEN = "--headless";
    assert.equal(contract.hostBootMarker(), "NEW_MARKER");
    assert.deepEqual(contract.pluginFailureTexts(), ["boom", "kaboom"]);
    assert.equal(contract.noOpenFlag(), "--headless");
  } finally { for (const k of Object.keys(saved)) process.env[k] = saved[k]; }
});

test("no lib file imports a @deepseek-ai runtime package (zero runtime coupling)", () => {
  const libDir = join(fileURLToPath(new URL("..", import.meta.url)), "lib");
  const offenders = [];
  for (const f of readdirSync(libDir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(join(libDir, f), "utf8");
    for (const m of src.matchAll(/from ["']([^"']+)["']/g)) {
      if (m[1].startsWith("@deepseek-ai/") || m[1].startsWith("cordis")) offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("checkHostContract reports mismatches without throwing", () => {
  const r = contract.checkHostContract({ bootMarker: "NOPE" });
  assert.ok(Array.isArray(r));
  assert.ok(r.some((x) => x.name === "C2-boot-marker" && x.ok === false && x.observed === "NOPE"));
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test --test-isolation=none test/contract.test.js`
  预期：FAIL——`Cannot find module '../lib/contract.js'`

- [ ] **步骤 3：编写最小实现**

```js
// lib/contract.js
// Host contract constants, centralized and env-overridable (design §11.5).
// The guard is host-external and imports no @deepseek-ai runtime; these are
// the disk/CLI contract points that a breaking official update could change.
// Each getter reads its env override first, so adapting to a new host release
// never requires a code change.
const envStr = (key, dflt) => {
  const v = process.env[key];
  return typeof v === "string" && v.trim() !== "" ? v : dflt;
};

export function hostBootMarker() { return envStr("DSH_GUARD_BOOT_MARKER", "__DSH_BOOT__"); }         // C2 online marker
export function hostAuthMarker() { return envStr("DSH_GUARD_AUTH_MARKER", "authentic"); }           // C2 401 marker
export function noOpenFlag() { return envStr("DSH_GUARD_NO_OPEN", "--no-open"); }                    // C1 host launch arg
export function pluginFailureTexts() {                                                               // C5 boot-failure detection
  const raw = envStr("DSH_GUARD_FAIL_TEXT", "");
  if (raw) return raw.split(";").map((s) => s.trim()).filter(Boolean);
  return ["plugin tree failed", "host preparation failed", "Cannot find module", "SyntaxError"];
}
export function pluginSubcommand() { return "plugin"; }                                              // C1 dsh plugin shape
export function profileFlag() { return "--profile"; }                                                // C1
export function addCommand() { return "add"; }                                                       // C1

/** Probe-style contract report: each entry { name, ok, observed, expected? }.
 *  Host-structure reads that fail to match surface here as warnings, never crashes. */
export function checkHostContract(observed = {}) {
  const out = [];
  const probe = (name, got, expected) => out.push({ name, ok: got === expected, observed: got, ...(expected !== undefined ? { expected } : {}) });
  probe("C2-boot-marker", observed.bootMarker ?? hostBootMarker(), hostBootMarker());
  probe("C2-auth-marker", observed.authMarker ?? hostAuthMarker(), hostAuthMarker());
  probe("C5-fail-texts", Array.isArray(observed.failTexts) ? observed.failTexts.join("|") : (observed.failText ?? ""), pluginFailureTexts().join("|"));
  return out;
}
```

- [ ] **步骤 4：改造 probe.js / boot.js 引用裸字符串为 contract 函数 + 跑全量**
  修改 `lib/probe.js`：`d.includes("__DSH_BOOT__")` → `d.includes(contract.hostBootMarker())`；401 marker `d.includes("authentic")` → `d.includes(contract.hostAuthMarker())`。import `* as contract from "./contract.js"`。
  修改 `lib/boot.js`：`isPluginFailure` 正则的文本源改为 `contract.pluginFailureTexts()` 动态构造（`new RegExp(texts.map(escape).join("|"), "i")`）；spawnHost 的 "--no-open" → `contract.noOpenFlag()`。
  运行：`node --test --test-isolation=none test/*.test.js`
  预期：全绿（53 + contract 4 = 57）——既有 probe/boot 测试默认值下不受影响。

- [ ] **步骤 5：提交**
  ```bash
  git add lib/contract.js lib/probe.js lib/boot.js test/contract.test.js
  git commit -m "feat: centralize host contract constants with env overrides (guard)"
  ```

---

### 任务 1：core 包清单共享（lib/core-packages.js + check.js 复用）

**文件：**
- 新建：`lib/core-packages.js`、`test/core-packages.test.js`
- 修改：`lib/check.js`（CORE_NAMES → 复用）

**接口：**
- 依赖输入：① check.js 内 CORE_NAMES（6 项硬编码）；设计 §6 core 清单策略
- 对外产出：`corePackages.staticList()` → 数组（静态 fallback）；`corePackages.fromHost(dshInstallDir)` → 动态读宿主 node_modules/@deepseek-ai 顶层目录名（失败返 null）；`corePackages.resolve(profileDir?)` → 动态优先、静态兜底

- [ ] **步骤 1：编写失败测试**

```js
// test/core-packages.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticList, fromHost, resolve } from "../lib/core-packages.js";

test("staticList is non-empty and includes dsh-tools", () => {
  const l = staticList();
  assert.ok(l.includes("dsh-tools"));
  assert.ok(l.includes("cosmokit"));
});

test("fromHost reads top-level @deepseek-ai dirs of a dsh install", () => {
  const h = mkdtempSync(join(tmpdir(), "core-h-"));
  try {
    const fake = join(h, "node_modules", "@deepseek-ai");
    mkdirSync(join(fake, "dsh-tools"), { recursive: true });
    mkdirSync(join(fake, "cosmokit"), { recursive: true });
    mkdirSync(join(fake, "some-plugin"), { recursive: true }); // non-core still listed? design: only dirs, filter dotfiles
    const l = fromHost(h);
    assert.ok(l.includes("dsh-tools"));
    assert.ok(l.includes("some-plugin")); // host namespace listing is authoritative
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("resolve falls back to static when host dir missing", () => {
  const l = resolve("C:/nonexistent-dsh-install");
  assert.ok(l.includes("dsh-tools"));
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test --test-isolation=none test/core-packages.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/core-packages.js
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Static fallback aligned with host 0.1.2-rc.1 (design §6). fromHost() is the
// authoritative source when a dsh install is found; this list only guarantees
// preflight still works without one (missing host → conservative).
export function staticList() {
  return ["dsh-tools", "dsh-util-values", "cosmokit", "schemastery", "dsh-client-runtime", "dsh-agent-presets", "dsh-llm", "dsh-session", "dsh-agent", "dsh-code-runtime", "dsh-host-webserver", "dsh-base", "dsh-web-app", "dsh-headless"];
}

/** Read the host namespace from a dsh install directory (the anchor that
 *  resolveDshBin uses). Returns null when the directory is missing/unreadable
 *  so callers can fall back to staticList(). */
export function fromHost(dshInstallDir) {
  try {
    const dir = join(dshInstallDir, "node_modules", "@deepseek-ai");
    if (!existsSync(dir)) return null;
    return readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  } catch { return null; }
}

export function resolve(dshInstallDir) {
  return fromHost(dshInstallDir) ?? staticList();
}
```

- [ ] **步骤 4：改造 check.js 复用 core-packages（行为不变）+ 全量**
  修改 `lib/check.js`：删除本地 CORE_NAMES 常量，`import { staticList } from "./core-packages.js"`，判断处用 `staticList().includes(name)`（保持 ① check 语义：静态清单即可——装后检查不需动态宿主目录）。跑全量确认 57+3=60 绿。

- [ ] **步骤 5：提交**
  ```bash
  git add lib/core-packages.js lib/check.js test/core-packages.test.js
  git commit -m "feat: share core package list across check and preflight (guard)"
  ```

---

### 任务 2：registry 网络层（lib/registry.js）

**文件：**
- 新建：`lib/registry.js`、`test/registry.test.js`

**接口：**
- 依赖输入：设计 §5 registry 解析最先；§7 fetchManifest 描述
- 对外产出：`registry.defaultRegistry()` → env `DSH_GUARD_REGISTRY` || "https://registry.npmmirror.com"；`registry.parsePkgSpec(spec)` → {name, version?} | throw（校验 npm 名）；`registry.fetchManifest(pkg, { registry, timeoutMs = 10000 })` → parsed manifest | throw（404/网络/超时含可读错误）
  - npm 包名规则：`dsh-xxx` 或 `@scope/name`；spec 支持 `name` / `name@version` / `@scope/name@version`。registry URL 拼 `/${scoped}`（@scope 需 encodeURIComponent 整段）再 `/latest`（无版本）或 `/${version}`。

- [ ] **步骤 1：编写失败测试（本地 http stub server）**

```js
// test/registry.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parsePkgSpec, fetchManifest } from "../lib/registry.js";

test("parsePkgSpec accepts plain, scoped, and versioned specs", () => {
  assert.deepEqual(parsePkgSpec("dsh-better-edit"), { name: "dsh-better-edit" });
  assert.deepEqual(parsePkgSpec("dsh-better-edit@0.6.3"), { name: "dsh-better-edit", version: "0.6.3" });
  assert.deepEqual(parsePkgSpec("@scope/name@1.2.3"), { name: "@scope/name", version: "1.2.3" });
  assert.throws(() => parsePkgSpec("github:owner/repo"), /unsupported/i);
  assert.throws(() => parsePkgSpec(""), /invalid/i);
});

test("fetchManifest returns parsed manifest for latest", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/dsh-better-edit/latest") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: "dsh-better-edit", version: "0.6.3", dependencies: { diff: "^5.0.0" } }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    const m = await fetchManifest("dsh-better-edit", { registry: `http://127.0.0.1:${port}`, timeoutMs: 3000 });
    assert.equal(m.version, "0.6.3");
    assert.ok(m.dependencies.diff);
  } finally { srv.close(); }
});

test("fetchManifest 404 throws readable error", async () => {
  const srv = createServer((req, res) => { res.statusCode = 404; res.end("{}"); });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    await assert.rejects(fetchManifest("ghost-pkg", { registry: `http://127.0.0.1:${port}`, timeoutMs: 3000 }), /not found|404|no such/i);
  } finally { srv.close(); }
});

test("fetchManifest times out with readable error", async () => {
  const srv = createServer(() => { /* never respond */ });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  try {
    await assert.rejects(fetchManifest("slow-pkg", { registry: `http://127.0.0.1:${port}`, timeoutMs: 300 }), /timeout|timed out/i);
  } finally { srv.close(); }
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test --test-isolation=none test/registry.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/registry.js
export function defaultRegistry() {
  const v = process.env.DSH_GUARD_REGISTRY;
  return typeof v === "string" && v.trim() !== "" ? v.replace(//+$/, "") : "https://registry.npmmirror.com";
}

export function parsePkgSpec(spec) {
  const s = String(spec || "").trim();
  if (!s) throw new Error("guard: empty package spec");
  if (/^(github:|git+|https?:|file:|link:|..?/)/.test(s)) throw new Error(`guard: unsupported package spec ${s} (npm registry names only)`);
  let name = s; let version;
  const at = s.lastIndexOf("@");
  if (at > 0 && s[at - 1] !== "/") { name = s.slice(0, at); version = s.slice(at + 1); }
  const scoped = name.startsWith("@") ? name.split("/").length === 2 : !name.includes("/");
  if (!scoped) throw new Error(`guard: invalid npm package name ${name}`);
  return version ? { name, version } : { name };
}

function encodePkgName(name) {
  // @scope/name needs the whole thing encoded for a registry path segment
  return name.startsWith("@") ? encodeURIComponent(name) : name;
}

export async function fetchManifest(pkg, { registry = defaultRegistry(), timeoutMs = 10000 } = {}) {
  const { name, version } = typeof pkg === "string" ? parsePkgSpec(pkg) : pkg;
  const base = registry.replace(//+$/, "");
  const url = `${base}/${encodePkgName(name)}${version ? "/" + encodeURIComponent(version) : "/latest"}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`guard: registry ${res.status} for ${name}${version ? "@" + version : ""} (${url})`);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`guard: registry fetch timed out after ${timeoutMs}ms for ${name} (${url})`);
    if (e.message?.startsWith("guard:")) throw e;
    throw new Error(`guard: registry fetch failed for ${name}: ${e.message}`);
  } finally { clearTimeout(timer); }
}
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test --test-isolation=none test/registry.test.js`
  预期：PASS（4 tests）

- [ ] **步骤 5：提交**
  ```bash
  git add lib/registry.js test/registry.test.js
  git commit -m "feat: npm registry manifest fetch with spec parsing (guard)"
  ```

---

### 任务 3：preflight 判定纯函数（lib/preflight.js）

**文件：**
- 新建：`lib/preflight.js`、`test/preflight.test.js`

**接口：**
- 依赖输入：设计 §5 判定矩阵；任务 1 core-packages、任务 2 registry（fetch 在调用方/install 流程做，判定层纯函数收 manifest）
- 对外产出：
  - `preflight.checkManifest(manifest, { hostVersion, corePackages, installedInsertIds, profileBundles })` → `{ ok, verdicts: [{code, severity, message, forceable?}] }` 纯函数（不联网、不读盘——全部输入由调用方注入）
  - verdict codes: `core-shadow`（error，forceable）/`host-incompatible`（error，not forceable）/`dup-insert-id`（error，not forceable）/`ok`
  - `preflight.run(pkgSpec, { registry, profile, hostVersion, dshInstallDir })` → 高层编排：fetchManifest → 读本地 installed insert ids（profile cordis.patch.yml）→ checkManifest → `{ ok, verdicts, manifest, spec }`（此函数可联网；判定核心在 checkManifest 供纯测）
  - `preflight.manifestInsertIds(manifest)` → 候选包 bundle patch 的 insert id 列表（manifest 里 `dsh.bundle.patch` 指向的 cordis.patch.yml 无法离线读——npm 包 tarball 内文件需下载。**简化裁决**：只检测 manifest 级可判项；patch 撞 id 检测降级为"候选包声明 dsh.bundle.patch 时，与已装 insert id 清单做 name 级比对"——若无法取 patch 内容则记 warn 不拒。实现见下。）

- [ ] **步骤 1：编写失败测试（fixture manifest 纯函数矩阵）**

```js
// test/preflight.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { checkManifest } from "../lib/preflight.js";

const base = { name: "pkg-x", version: "1.0.0", dependencies: {} };
const corePkgs = ["dsh-tools", "cosmokit"];
const hostVersion = "0.1.2-rc.1";

test("clean manifest passes", () => {
  const r = checkManifest({ ...base, dependencies: { diff: "^5.0.0" } }, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, true);
  assert.equal(r.verdicts.length, 0);
});

test("core shadow in prod dependencies fails and is forceable", () => {
  const r = checkManifest({ ...base, dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } }, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, false);
  const v = r.verdicts.find((x) => x.code === "core-shadow");
  assert.ok(v);
  assert.equal(v.forceable, true);
});

test("host engines mismatch fails and is not forceable", () => {
  const r = checkManifest({ ...base, dsh: { engines: { dsh: ">=1.0.0" } } }, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, false);
  const v = r.verdicts.find((x) => x.code === "host-incompatible");
  assert.ok(v);
  assert.equal(v.forceable, false);
});

test("no engines declaration passes (absence of claim is not a verdict)", () => {
  const r = checkManifest(base, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, true);
});

test("dup insert id against installed patches fails", () => {
  const r = checkManifest(
    { ...base, dsh: { bundle: { patch: "./cordis.patch.yml" } } },
    { hostVersion, corePackages: corePkgs, candidatePatchText: "- insert:\n  name: better-edit\n", installedInsertIds: ["better-edit"] }
  );
  assert.equal(r.ok, false);
  assert.ok(r.verdicts.find((x) => x.code === "dup-insert-id"));
});

test("devDependencies core is ignored (pnpm hoists prod only)", () => {
  const r = checkManifest({ ...base, devDependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } }, { hostVersion, corePackages: corePkgs });
  assert.equal(r.ok, true);
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test --test-isolation=none test/preflight.test.js`
  预期：FAIL——module not found

- [ ] **步骤 3：编写最小实现**

```js
// lib/preflight.js
import { staticList } from "./core-packages.js";

// Version range check without a semver dependency: accept "x.y.z", "x.y.z-rc.n",
// ">=x.y.z", "x.y.z || x.y.z2". We only need "does the declared range admit the
// host version" — implement the common prefix/rangeset cases and treat anything
// unparseable as "no claim" (pass). Host version unreadable → unknown → pass.
function rangeAdmits(range, hostVersion) {
  if (!range || !hostVersion) return true;
  const hostParts = hostVersion.match(/^(d+).(d+).(d+)/);
  if (!hostParts) return true; // unparseable host version → no verdict
  const [_, hmaj, hmin, hpat] = hostParts.map((x, i) => (i === 0 ? x : Number(x)));
  // split on || and pass if any alternative admits
  for (const alt of String(range).split("||").map((s) => s.trim())) {
    if (altAdmits(alt, hmaj, hmin, hpat)) return true;
  }
  return false;
}
function altAdmits(alt, hmaj, hmin, hpat) {
  const m = alt.match(/^([<>=~^]*)s*v?(d+).(d+)(?:.(d+))?/);
  if (!m) return true; // unparseable alternative → treat as open
  const op = m[1] || "";
  const maj = Number(m[2]); const min = Number(m[3]); const pat = m[4] !== undefined ? Number(m[4]) : 0;
  const cmp = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
  const cMaj = cmp(hmaj, maj); const cMin = cMaj !== 0 ? cMaj : cmp(hmin, min); const cPatch = cMin !== 0 ? cMin : cmp(hpat, pat);
  const c = cPatch;
  if (op === ">=") return c >= 0; if (op === ">") return c > 0; if (op === "<") return c < 0; if (op === "<=") return c <= 0;
  if (op === "^") return hmaj === maj && c >= 0 && (hmaj > 0 ? true : hmin >= min);
  if (op === "~") return hmaj === maj && hmin === min && c >= 0;
  return c === 0; // exact
}

function patchInsertIds(patchText) {
  const ids = []; let inInsert = false;
  for (const line of String(patchText || "").split(/?
/)) {
    const t = line.trim();
    if (/^- insert:s*$/.test(t)) { inInsert = true; continue; }
    if (!inInsert) continue;
    const m = /^name:s*['"]?(@?[A-Za-z0-9._/-]+)['"]?s*$/.exec(t);
    if (m) ids.push(m[1]);
  }
  return ids;
}

export function checkManifest(manifest, { hostVersion, corePackages = staticList(), installedInsertIds = [], candidatePatchText } = {}) {
  const verdicts = [];
  const deps = Object.keys(manifest?.dependencies ?? {});
  const coreDeps = deps.filter((d) => d.startsWith("@deepseek-ai/") && corePackages.includes(d.slice("@deepseek-ai/".length)));
  if (coreDeps.length) {
    verdicts.push({ code: "core-shadow", severity: "error", forceable: true, message: `prod dependency ${coreDeps.join(", ")} shadows the host @deepseek-ai namespace (tool-lens incident shape) — refusing` });
  }
  const engine = manifest?.dsh?.engines?.dsh ?? manifest?.engines?.dsh;
  if (engine && !rangeAdmits(engine, hostVersion)) {
    verdicts.push({ code: "host-incompatible", severity: "error", forceable: false, message: `declares dsh engine ${engine}; host is ${hostVersion || "unknown'}` });
  }
  if (manifest?.dsh?.bundle?.patch && installedInsertIds.length) {
    // candidate patch content is unavailable offline; when provided (downloaded),
    // compare its insert ids against installed ones. Otherwise warn-only (no block).
    if (candidatePatchText !== undefined) {
      const cand = patchInsertIds(candidatePatchText);
      const dup = cand.filter((id) => installedInsertIds.includes(id));
      if (dup.length) verdicts.push({ code: "dup-insert-id", severity: "error", forceable: false, message: `insert id(s) ${dup.join(", ")} already mounted by an installed plugin` });
    } else {
      verdicts.push({ code: "patch-unverified", severity: "warn", forceable: true, message: "declares a bundle patch; could not verify insert-id collisions offline" });
    }
  }
  return { ok: verdicts.every((v) => v.severity !== "error"), verdicts };
}
```

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test --test-isolation=none test/preflight.test.js`
  预期：PASS（6 tests）

- [ ] **步骤 5：提交**
  ```bash
  git add lib/preflight.js test/preflight.test.js
  git commit -m "feat: preflight manifest verdict engine (core-shadow / engines / dup-id) (guard)"
  ```

---

### 任务 4：CLI preflight 子命令

**文件：**
- 修改：`lib/cli.js`（preflight 分支 + --force/--registry 解析）
- 修改：`test/cli.test.js`（preflight 安全用例）

**接口：**
- 依赖输入：任务 2 registry、任务 3 preflight；① cli.js 既有 parse
- 对外产出：`guard preflight <pkg> [--force] [--registry <url>]` → exit 0 通过（打印通过摘要）/ exit 1 拒绝（打印 verdicts + 建议）/ exit 2 用法错。hostVersion 从全局 dsh package.json 读（resolveDshBin 同源）；corePackages 从宿主目录 resolve；installedInsertIds 从 profile cordis.patch.yml 读（check.js 已实现解析，提取为共享或本地重复最小逻辑——**裁决**：复用 check.js 的解析逻辑导出 `readPatchInsertIds(profileDir)`，check.js 与 cli 共用）。

- [ ] **步骤 1：编写失败测试**

```js
// test/cli.test.js (append)
test("preflight rejects a core-shadow package with exit 1", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-pf-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    writeFileSync(join(dir, "cordis.patch.yml"), "- insert:
  name: existing
");
    // serve a fake registry manifest with a core-shadow dep
    const srv = createServer((req, res) => {
      if (req.url === "/evil-pkg/latest") { res.end(JSON.stringify({ name: "evil-pkg", version: "1.0.0", dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["preflight", "evil-pkg", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /core-shadow|shadows the host/i);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("preflight --force passes a core-shadow package with warning", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-pf2-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const srv = createServer((req, res) => {
      if (req.url === "/evil-pkg/latest") { res.end(JSON.stringify({ name: "evil-pkg", version: "1.0.0", dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["preflight", "evil-pkg", "--force", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h });
      assert.equal(r.code, 0);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("preflight without pkg exits 2", async () => {
  const r = await run(["preflight"], {});
  assert.equal(r.code, 2);
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test --test-isolation=none test/cli.test.js`
  预期：FAIL——preflight 未实现（unknown command exit 2 或 parse 问题）

- [ ] **步骤 3：编写最小实现（cli.js 追加分支 + check.js 导出 readPatchInsertIds）**
  在 `lib/check.js` 导出 `readPatchInsertIds(profileDir)`（复用 dup-id 扫描逻辑，返 id 数组）；`lib/cli.js` 增加 case "preflight"：parse pkg（rest[0]）→ 读 hostVersion（resolveDshBin 目录的 package.json）→ fetchManifest → checkManifest → 非 force 且 !ok → stderr 逐条 verdict + exit 1；force → warn + exit 0；ok → stdout 摘要 + exit 0。

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test --test-isolation=none test/cli.test.js` + 全量
  预期：cli 全绿 + 全量 60+3=63 绿

- [ ] **步骤 5：提交**
  ```bash
  git add lib/cli.js lib/check.js test/cli.test.js
  git commit -m "feat: guard preflight command with --force escape hatch (guard)"
  ```

---

### 任务 5：guard install 闭环

**文件：**
- 修改：`lib/cli.js`（install 分支）
- 修改：`test/cli.test.js`（install dry 用例——不真装）

**接口：**
- 依赖输入：① snapshot/bootOnce、任务 3 preflight、resolveDshBin
- 对外产出：`guard install <pkg> [--force] [--registry <url>] [--no-boot]`：
  1. preflight（拒绝 → exit 1，不装）
  2. `snapshot(reason:"preflight install <pkg>")`（① createSnapshot healthy:false）
  3. spawn 全局 dsh bin `plugin --profile <p> add <pkg>`（resolveDshBin 定位；spawn 失败/非 0 → 打印错误 + 提示 `guard restore <latest>`，exit 1）
  4. `--no-boot` 缺省时 `bootOnce(profile, [], {})`（装后验证；失败自动回滚为 ① 能力）
  5. 成功 → exit 0 打印 install ok + 快照 id

- [ ] **步骤 1：编写失败测试（dry：install 分支在 pnpm spawn 前短路——注入 env `DSH_GUARD_DRY_INSTALL=1` 时只走 preflight+快照并打印 dry 摘要，不真 spawn）**

```js
// test/cli.test.js (append)
test("install runs preflight and snapshot but does not spawn in dry mode", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-in-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const srv = createServer((req, res) => {
      if (req.url === "/good-pkg/latest") { res.end(JSON.stringify({ name: "good-pkg", version: "1.0.0", dependencies: { diff: "^5.0.0" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["install", "good-pkg", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h, DSH_GUARD_DRY_INSTALL: "1" });
      assert.equal(r.code, 0);
      assert.match(r.stdout, /dry/i);
      // a snapshot was created
      const snaps = readdirSync(join(h, "guards", "web")).filter((n) => n !== "crash");
      assert.ok(snaps.length >= 1);
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("install rejects a core-shadow package before snapshotting", async () => {
  const h = mkdtempSync(join(tmpdir(), "guard-cli-in2-")); try {
    const dir = join(h, "profiles", "web"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const srv = createServer((req, res) => {
      if (req.url === "/evil-pkg/latest") { res.end(JSON.stringify({ name: "evil-pkg", version: "1.0.0", dependencies: { "@deepseek-ai/dsh-tools": "0.0.1-rc.1" } })); }
      else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise((r) => srv.listen(0, r)); const port = srv.address().port;
    try {
      const r = await run(["install", "evil-pkg", "--profile", "web", "--registry", `http://127.0.0.1:${port}`], { DSH_HOME: h, DSH_GUARD_DRY_INSTALL: "1" });
      assert.equal(r.code, 1);
      const guards = join(h, "guards", "web");
      const snaps = fs.existsSync(guards) ? readdirSync(guards).filter((n) => n !== "crash") : [];
      assert.equal(snaps.length, 0); // refused before any snapshot
    } finally { srv.close(); }
  } finally { rmSync(h, { recursive: true, force: true }); }
});
```

- [ ] **步骤 2：运行测试并确认失败**
  运行：`node --test --test-isolation=none test/cli.test.js`
  预期：FAIL——install 未实现

- [ ] **步骤 3：编写最小实现（cli.js case "install"）**
  dry env `DSH_GUARD_DRY_INSTALL=1` 时：preflight → createSnapshot → 打印 `[dry] would run: dsh plugin --profile <p> add <pkg>` + `install dry ok (snapshot <id>)` → exit 0。非 dry：preflight 通过 → snapshot → spawn resolveDshBin 的 `plugin --profile <p> add <pkg>`（node 包装，捕获 exit code；失败打印 + 提示 restore）→ 非 --no-boot 时 bootOnce。**真实 spawn 分支仅生产可达（同 ① rollback autoRestart 口径，测试用 dry env 覆盖逻辑，真实 install 留给用户冒烟）。**

- [ ] **步骤 4：运行测试并确认通过**
  运行：`node --test --test-isolation=none test/cli.test.js` + 全量
  预期：cli 全绿 + 全量绿

- [ ] **步骤 5：提交**
  ```bash
  git add lib/cli.js test/cli.test.js
  git commit -m "feat: guard install closed loop with dry mode (guard)"
  ```

---

### 任务 6：README 更新 + 版本 + 全量回归

**文件：**
- 修改：`package.json`（0.1.0 → 0.2.0）
- 修改：`README.md`、`README.zh.md`（命令表加 preflight/install 两行 + 兼容性说明）

**接口：**
- 依赖输入：全部前序任务
- 对外产出：可发布 v0.2.0；双语 README 含新命令与宿主契约兼容说明

- [ ] **步骤 1：更新 package.json version 0.2.0 + README 双语命令表**
  README 命令表追加：
  | `guard preflight <pkg> [--force]` | Check a package before installing: refuses packages whose prod dependencies shadow the host @deepseek-ai namespace, or whose dsh engine/peer requirements the host cannot meet. Exit 0 = safe, 1 = refused, `--force` overrides the core-shadow check. |
  | `guard install <pkg> [--force] [--no-boot]` | Preflight → snapshot → `dsh plugin add` → boot verification (auto-rollback on failure). One command, closed loop. |
  加"Host contract compatibility"段（§11.5 用户可见摘要：zero runtime coupling、contract constants env-overridable、no silent degradation）。

- [ ] **步骤 2：真实冒烟（沙箱外，标注给用户）**
  ```bash
  node lib/cli.js preflight dsh-better-edit --profile web
  # 预期：exit 0（无 core 遮蔽、engines 满足或无声明）
  node lib/cli.js preflight @deepseek-ai/dsh-tools --profile web
  # 预期：exit 1 core-shadow（它本身是 core 包被当插件装）
  node lib/cli.js install <某安全包> --profile web   # 真实安装，需用户空闲时段
  ```

- [ ] **步骤 3：全量回归 + 提交**
  ```bash
  node --test-isolation=none --test test/*.test.js   # 全绿
  git add package.json README.md README.zh.md
  git commit -m "chore: v0.2.0 with preflight and install commands (guard)"
  ```

---

## 自检记录（计划作者填写）

- **规格覆盖度**：§4 命令面 preflight/install → 任务 4/5；§5 判定矩阵 4 项 → 任务 3（registry 解析=任务 2 fetch 层；core-shadow=任务 3；engines/peer=任务 3 rangeAdmits；patch 撞 id=任务 3 + 离线降级 warn）；§6 core 清单 → 任务 1；§7 文件级 → 任务 1-5；§9 安全 → 全局约束（install dry/批准）；§10 发布 → 任务 6；§11.5 兼容护栏 → 任务 0（contract.js）+ 全局约束逐任务。
- **占位符扫描**：无 TODO/TBD；每步含代码/命令。
- **类型一致性**：`checkManifest(manifest, {hostVersion, corePackages, installedInsertIds, candidatePatchText})` 任务 3/4 一致；`fetchManifest(pkg, {registry, timeoutMs})` 任务 2/4/5 一致；`parsePkgSpec` 单源；`readPatchInsertIds(profileDir)` 任务 4 从 check.js 导出供 cli；core-packages `staticList/fromHost/resolve` 任务 1/3/4 一致。
- **已知风险**：install 真实 spawn 分支 dry 不覆盖（同 ① rollback 口径，留用户冒烟）；preflight 联网需 registry 可达（测试 stub 本地）；patch 撞 id 离线降级 warn 不 block（设计 §5 与实现折中，已注裁决）。
