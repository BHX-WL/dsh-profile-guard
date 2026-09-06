# dsh-profile-guard

CLI 直装路径的装机保险。

`guard` 是一个小型 CLI：在 **profile 之外** 保存一份健康状态快照，当插件安装弄崩宿主启动时自动回滚。它覆盖的是 dshmarket 与 dsh-desktop 都不保护的那条路径——通过 CLI 直接装进 profile（`dsh plugin add`、npm）。

纯 Node 脚本。不依赖 dsh-desktop，不改 dsh 宿主，也从不把自己装进 profile 的 bundles。

## 为什么需要

两次插件装崩事故——都发生在 CLI 直装路径——导致宿主启动失败、profile 被重置为默认 bundles；CLI 安装路径自身不留任何快照，恢复只能靠人肉重建崩溃前的 manifest。

## 安装

需要 Node >= 20。

**npm 全局安装** —— 安装后 `guard` 命令进入 PATH：

```sh
npm install -g dsh-profile-guard
```

**从 git clone 运行** —— 无需安装，直接经 Node 运行：

```sh
git clone <this-repository> dsh-profile-guard
cd dsh-profile-guard
node lib/cli.js check
```

两种入口等价：下面的每条 `guard <command>` 都可以在 clone 目录里换成 `node lib/cli.js <command>` 运行。

## 命令

每条命令都接受 `--profile <name>`（默认 `web`）。`remote` 会忽略它——它读取的是运行中的宿主，而非某个 profile。

| 命令 | 作用 |
| --- | --- |
| `guard boot [--profile <name>] [-- <dsh args>]` | 在 guard 保护下启动宿主：先快照当前状态，再启动宿主，启动成功则把快照标记为 `healthy`；若插件级失败弄崩启动，回滚到最近一份 healthy 快照并再拉一次宿主。 |
| `guard snapshot [--profile <name>] [--reason "<note>"]` | 手动快照当前 profile 状态。装插件之前调用。 |
| `guard list [--profile <name>]` | 列出快照：id、时间、原因、状态（`[healthy]` / `[pending]`）。 |
| `guard show <id> [--profile <name>]` | 查看某份快照详情：bundles、依赖、hash。 |
| `guard restore <id> [--no-auto-restart] [--profile <name>]` | 回滚到某份 `healthy` 快照。如 3080 端口有宿主在运行则将其停止；除非指定 `--no-auto-restart`，否则重新启动宿主。 |
| `guard check [--profile <name>]` | 只读健康检查。退出码 0 = 健康，1 = 发现问题。 |
| `guard watch [--profile <name>]` | 常驻自动快照：监听 `package.json` / `pnpm-lock.yaml`，变更时自动快照。Ctrl+C 或 SIGTERM 退出。 |
| `guard preflight <pkg> [--force]` | 安装前检查：拒绝生产依赖遮蔽宿主 @deepseek-ai 命名空间的包，以及宿主无法满足其 dsh engine 要求的包。退出码 0 = 安全，1 = 拒绝，`--force` 覆盖 core-shadow 检查。 |
| `guard install <pkg> [--force] [--no-boot]` | Preflight → 快照 → `dsh plugin add` → 激活：纯 insert 或 client-only 插件经 market toggle 免重启热挂；不支持的形状或 toggle 失败则回退启动验证（失败自动回滚）。一条命令，闭环完成。 |
| `guard hotmount <pkg> [--profile <name>]` | 对已装插件免重启触发热挂载——install 装后激活的独立命令形态。仅纯 insert 或 client-only 插件符合；无重启回退，不支持的形状或 toggle 失败会打印原因并退出 1。 |
| `guard remote [--json] [--lan] [--show-token]` | 打印运行中 dsh web 宿主可供手机访问的 URL：从 `host-last.log` 读取当前 launch token、验证后打印 Tailscale URL（LAN URL 作回退）。人类可读输出会脱敏 token；`--json` 为脚本携带完整 token。 |

不带参数运行 `guard`（或 `guard help`）会打印用法。

退出码：`boot` 成功 0（已在运行也算成功）/ 失败 1；`snapshot`、`list` 为 0；`show` 找到 0 / 未找到 1 / 用法错误 2；`restore` 成功 0 / 失败 1 / 用法错误 2；`check` 健康 0 / 不健康 1；`watch` 在 Ctrl+C / SIGTERM 时退 0；`preflight` 安全 0 / 拒绝 1 / 用法错误 2；`install` 成功 0 / 失败或拒绝 1 / 用法错误 2；`hotmount` 热挂成功 0 / 未装、形状拒绝或 toggle 失败 1 / 用法错误 2；`remote` 可用 URL 0 / 不可用 1（宿主日志缺失、无 token 或 token 过期、无可达地址）；未知命令退 2。

注：`guard preflight` 检查 core-shadow 与声明的 dsh engine 要求；peer 依赖兼容性属未来增强，暂不检查。

## 手机远程访问

`guard remote` 打印运行中的 dsh 宿主可供手机打开网页 UI 的 URL。它读取宿主 announce 日志，取**最后**一行带 launch token 的行（`dsh web: http://127.0.0.1:3080/?token=...`），对运行中的宿主验证 token（HTTP 303/200 = 有效；401 = 宿主已重启、token 过期），然后打印 Tailscale URL——Tailscale 不可用（`tailscale ip -4` 失败）时回退到 LAN announce URL。

- `--lan` — 只打印 LAN announce URL：跳过 Tailscale 探测。
- `--show-token` — 打印完整 launch token（人类可读输出会脱敏：前 6 位加 `...`）。
- `--json` — 机器可读输出（ok、url、tailscaleUrl、lanUrl、token、verified、at、logFile）。`token` 字段携带完整 token，因此不要把这部分输出贴进聊天或日志。
- `remote` 不需要 profile，也不写任何东西：一次日志读取 + 一次 loopback HTTP 验证请求，全部留在本机。

日志路径、端口与 Tailscale 命令都是可 env 覆写的契约点：`DSH_GUARD_HOST_LOG`（默认 `%APPDATA%\dsh-desktop\host-last.log`）、`DSH_GUARD_PORT`（默认 `3080`）、`DSH_GUARD_TAILSCALE_CMD`（默认 `tailscale`）。

退出码：`remote` 0 = 已打印可用 URL；1 = 不可用（宿主日志缺失、无 announce token、token 过期、无可达地址）。

宿主运行时可以对真实环境试一次：

```sh
guard remote --lan
guard remote
guard remote --json
```

## 快照

快照存放在 dsh **数据根** 下，与 `profiles/` 平级：

```text
$DSH_HOME/guards/<profile>/<snapshot-id>/
```

`DSH_HOME` 即 dsh 数据根——包含 `profiles/` 与 `guards/` 的目录。未设置时 guard 使用 `<home>/.dsh`（Windows 上如 `C:\Users\<you>\.dsh`），因此默认位置是 `~/.dsh/guards/<profile>/`。

每份快照目录包含 profile 的 `package.json` 副本（dependencies + `dsh.profile.bundles`）、`sentinel.json`（`node_modules/@deepseek-ai` 顶层清单，core 遮蔽哨兵）与 `meta.json`（id、createdAt、reason、dshVersion、healthy、hash）。不整备 `node_modules`——`pnpm install` 可重建。

- **在 profile 之外**：快照放在 `guards/`（`profiles/` 的兄弟目录），profile 被重置也碰不到它们。
- **两级状态**：`pending` 表示刚记录、尚未验证；`healthy` 表示该状态下宿主曾成功启动。`restore` 只允许回滚到 `healthy` 快照。
- **保留策略**：滚动保留最近 5 份；设 `DSH_GUARD_KEEP` 可调整。
- 发生回滚时，先把当前（坏）状态备份到 `$DSH_HOME/guards/<profile>/crash/`，并把一份中文恢复报告写到 `$DSH_HOME/guards/<profile>/`（`restore-report-<timestamp>.md`，另有 `last-report.md`）。

## 与 dshmarket / dsh-desktop 的关系

三者各保各的安装路径，互不重叠：

| 路径 | 由谁保护 |
| --- | --- |
| dshmarket UI / 市场安装 | dshmarket 自带的快照、回滚与深度兼容检查 |
| dsh-desktop 工坊操作 | dsh-desktop 自带的每次操作前备份 + 重启失败自动恢复 |
| **CLI 直装**（`dsh plugin add`、npm 装进 profile） | **`guard`** —— 本工具 |

`guard` 只读写 `$DSH_HOME/guards/<profile>/` 与该 profile 自己的 `package.json`，从不碰 dshmarket 或 dsh-desktop 的状态，三者并存互不干扰。

## 宿主契约兼容性

guard 运行在 dsh 宿主**之外**：lib 任何文件都不 import 宿主运行时包，因此官方宿主更新不会像弄崩宿主内插件那样、通过 import 错配弄崩 guard。guard 真正依赖的是一小组磁盘/CLI 契约点：宿主启动 marker、启动失败文本、`dsh plugin` CLI 形态、profile manifest schema。三条规则保证这些契约点不会静默失效：

- **零运行时耦合。** lib 任何文件都不 import 任何 `@deepseek-ai/*` 模块。guard 只从外部读宿主——解析已安装的 dsh bin、读取其版本、读取 profile manifest。宿主缺失或不可读时，guard 降级为仍能在本地证实的检查，并把宿主版本如实报告为 unknown，绝不猜测。
- **契约常数可用 env 覆写。** marker 与失败文本常量集中在单一模块 `lib/contract.js`，每个都能用环境变量覆写——`DSH_GUARD_BOOT_MARKER`、`DSH_GUARD_AUTH_MARKER`、`DSH_GUARD_NO_OPEN`、`DSH_GUARD_FAIL_TEXT`。官方更新改了某个 marker 或失败文本时，适配只是改配置，不是改代码。market 热挂 toggle 的键在同一模块、同样可用 env 覆写——`DSH_GUARD_MARKET_BASE`、`DSH_GUARD_MARKET_TOGGLE_PATH`、`DSH_GUARD_MARKET_ORIGIN`。
- **绝不静默降级。** guard 从不在无法确认的契约点上猜测：读不到的 profile manifest 被如实报告为问题，绝不当成健康；启动日志中找不到任何已知插件失败文本的启动失败**不会**自动回滚——guard 报告失败但不回滚（错误回滚比漏掉回滚更糟）；preflight 的每条警告与拒绝都会打印，绝不吞掉。

## 安全说明

- `guard` 只读写 `$DSH_HOME/guards/` 与目标 profile 的 `package.json`，其余一律只读。
- 快照与报告不含凭据：恢复报告的自由文本字段在落盘前会脱敏（token、authorization 头、cookie、密码）。
- `guard` 停宿主时只杀 3080 端口上命令行带 dsh 特征（`dsh`、`bin.js`、`deepseek`）的进程——绝不误杀占用该端口的无关进程。
- `guard boot` 与 `guard restore` 会停止并重新启动你的**真实** dsh 宿主（3080 端口）。只在你能接受一次宿主重启的时段运行——例如桌面端空闲时段——绝不要在宿主自身服务的会话里运行。
- 全部保持在本机、不做任何外部网络请求——唯独 `guard preflight` 与 `guard install` 例外：这两条会从 npm registry 拉取包 manifest（`guard install` 还会执行 `dsh plugin add` 下载并安装该包）。热挂只走 loopback：`guard install` 可能向本机 dsh-market toggle（`http://127.0.0.1:3080`）POST 以免重启激活纯 insert 或 client-only 插件，`guard hotmount` 按需做同样的事。
- `guard remote` 在人类可读输出中会脱敏 launch token（前 6 位加 `...`）；只有 `--show-token` 与 `--json` 会显示完整 token，因此不要把这类输出贴进聊天或日志。它只读：一次宿主日志读取、一次 loopback HTTP 验证、一次只读的 `tailscale ip -4` 探测——无外部网络请求，也不写任何东西。

## 测试

```sh
npm test
```

`npm test` 运行 `node --test test/**/*.test.js`。所有测试都用临时 `DSH_HOME`，绝不触碰真实 profile。

## 冒烟测试（验证安装）

在宿主空闲时对真实 profile 执行：

```sh
guard check --profile web
guard snapshot --profile web --reason "first smoke"
guard list --profile web
guard preflight dsh-better-edit --profile web
guard preflight @deepseek-ai/dsh-tools --profile web
guard hotmount dsh-better-edit --profile web
```

`guard check` 会打印 `profile web: healthy`，或列出发现的具体问题；`guard snapshot` 打印它创建的 id；`guard list` 随后显示这份快照为 `[pending]`、备注 `(first smoke)`。

`guard preflight` 在安装任何东西之前，把包对照宿主做一次检查：`guard preflight dsh-better-edit --profile web` 会打印 `guard: preflight ok for dsh-better-edit (host <version>)` 并退出 0（其生产依赖不遮蔽宿主 `@deepseek-ai` 命名空间，dsh engine 要求宿主能满足或未声明任何要求）；`guard preflight @deepseek-ai/dsh-tools --profile web` 退出 1——`@deepseek-ai/dsh-tools` 本身是 core 包，把它当插件安装会遮蔽宿主 `@deepseek-ai` 命名空间。

`guard hotmount dsh-better-edit --profile web` 对真实 market 执行热挂 toggle：market 接受时 guard 打印 `hot-mounted dsh-better-edit` 并退出 0；插件未安装或其形状既非纯 insert 也非 client-only 时，以原因退出 1（stderr）。对已处于 live 的插件重复 toggle 是幂等 no-op，因此在真实 profile 上试这条命令是安全的——但它确实会向本机 market（`127.0.0.1:3080`）POST，请在桌面端空闲时段运行。想不发请求只看效果，可在命令前加 `DSH_GUARD_DRY_HOTMOUNT=1`：它会打印 `[dry] would hot-mount dsh-better-edit`。

`guard install <pkg>` 与 `guard boot` 刻意不列在这里：`guard install` 会真实执行 `dsh plugin add` 并安装该包，随后激活它——纯 insert 或 client-only 插件经 market toggle 免重启热挂，不支持的形状则做启动验证（可能停止并重启你的真实宿主）；`guard boot` 顾名思义会重启宿主。请在桌面端空闲时段亲自运行，绝不要在宿主自身服务的会话里运行。

## 许可证

MIT
