---
title: Spike 结论——市场 toggle 桥（Origin header 是否够过 sameOrigin）
date: 2026-09-06
status: conclusion
category: decision
project: G:\deepseek\opensource\dsh-profile-guard
---

# Spike 结论：guard install 经市场 toggle 触发宿主内 hotMount（真机验证）

对应 ③ 设计 §11 开放问题 3：guard 在宿主外，market 在 127.0.0.1:3080；
sameOrigin 门比对 origin.host === host header——node fetch 带裸 `Origin` header 能否过门？
toggle 真实响应形状（activation 字段）？幂等性？决定 mount.js 的 header 构造。

## 真机验证方法（2026-09-06，安全第一）

探测目标选 **activation=live 的普通插件 `dsh-better-edit`**（bundle 层 live，非宿主基础设施）。
对已 live 包 POST toggle `{name, enabled:true}` 是幂等 no-op（源码：setPluginEnabled 中
`listHotMounts` 已含或 setEntryDisabled 已生效 → ok:true，不触发 hotMount/热切换）。
**未对任何宿主基础设施 / 未装包 / restart/disabled 包发 toggle。**

前置只读清单（GET /dsh-market/installed，200）：20 个已装插件全部有 activation 记录；
live 候选多个（dsh-better-edit / dsh-whale-widget / dsh-doublecheck…）；
`@yangzhe1991/dsh-code-review`、`dsh-checkpoint-rewind` 为 state=restart（不可碰）。

## 探针矩阵（全部 POST http://127.0.0.1:3080/dsh-market/toggle，body 同上，均对 live 包幂等）

| # | 请求头 | 结果 |
|---|---|---|
| 1 | content-type: json + `Origin: http://127.0.0.1:3080`（**无显式 Host**，node fetch 默认 Host=127.0.0.1:3080） | **200** `ok:true`，activation.state=live，restart:false |
| 2 | 同 1，重复一次 | **200**，响应与 #1 逐字段一致 → **幂等确认** |
| 3 | `Origin: http://127.0.0.1:3080` + 显式 `Host: 127.0.0.1:3080` | **200**（undici 允许设 Host，匹配时照样过门） |
| 4 | 仅 content-type，**无 Origin** | **403** `{"error":"untrusted origin"}` |
| 5 | `Origin: http://localhost:3080`（与 Host 127.0.0.1:3080 的 host 串不一致） | **403** `{"error":"untrusted origin"}` |

探测后复查：/installed 中 dsh-better-edit activation 仍 `{state:"live", hot:true, bundle:true}`，未发生任何状态变化。

## sameOrigin 实测结论（回答设计开放问题 3）

1. **裸 Origin header 够**：#1 仅带 `Origin: http://127.0.0.1:3080`、不加其它自定义 header（Host 由 fetch 默认推导为
   `127.0.0.1:3080`）即 200 过门。**无需显式 Host**。
2. **Origin 必须显式设置**：#4 证明 undici/node fetch **不会像浏览器那样自动带 Origin**——漏设即 403。
   mount.js 若忘设 Origin 必 403，这是本 spike 最重要的实现约束。
3. **host 串必须逐字符一致**：#5 证明 new URL(origin).host === host 是严格相等——`localhost` ≠ `127.0.0.1`
   （同样地 ::1 也不等），Origin 与请求 URL 的 host 必须同一字符串来源。显式加匹配 Host（#3）无害但非必需。
4. GET /installed 无 sameOrigin 门（本会话多次无 Origin GET 均 200）——只有 POST 变更路由要求 sameOrigin。

## toggle 幂等性确认

- 实测：#1/#2 两次相同请求响应逐字段一致；/installed 前后不变。
- 源码佐证（routes.ts setPluginEnabled）：`enabled=true` 时若 `listHotMounts().includes(name)` → `ok=true` 直接返回
  （不重挂）；否则 `setEntryDisabled(name,false)`（bundle 层已生效 → ok）；再否则才 `hotMount`。
  对已 live 包，全路径无热挂/热切副作用。幂等分支成立。
- **真实 guard 场景的对照**：刚 pnpm add 的纯 insert 新包不在 listHotMounts、也不是 live loader 条目 →
  toggle 会走真 hotMount（正是桥要的激活）。本 spike 刻意未触发该路径（安全约束），其行为由后续任务
  的本地 stub 测试矩阵覆盖（live/restart/403/404/非 JSON）。

## 真实响应形状（#1 原文，200）

```json
{"ok":true,"name":"dsh-better-edit","enabled":true,"disabled":[],"live":[],
 "activation":{"dsh-better-edit":{"state":"live","reasons":["已热加载(bundle patch)/ live via its bundle patch"],"bundle":true,"hot":true}},
 "patchRows":["dsh-better-edit"],"patchWrite":{"ok":true,"reason":null},
 "carrier":[],"bundleSwitch":{"ok":true,"reason":null},"restart":false,"refresh":false}
```

- `activation[<name>].state` ∈ live | restart（本探测为 live）。**mount.js 应以
  `activation[name]?.state === 'live'` 为热挂成功信号**；`ok:true` 是 setPluginEnabled 结果，
  state 是 verifyActivation 对全部激活源（hot mount + bundle 层 + disabled 状态）的最终裁决，二者应同时读。
- `disabled` / `live` 是**全局列表**（live = listHotMounts()，本探测为空数组，佐证目标走 bundle 层而非市场热挂）。
- `restart:false`、`refresh:false`：本次无重启/无前端刷新要求。
- `patchWrite`/`bundleSwitch`：toggle 会持久化 patch 层 enabled 状态（幂等路径下为无变化写入）。

## mount.js 应采用的 header 构造（裁决）

- URL：`http://127.0.0.1:3080/dsh-market/toggle`（contract.js 的 marketBaseUrl + marketTogglePath，仅 loopback）。
- **必须**：`content-type: application/json`；`Origin: <baseUrl 的同源串>`（如 `http://127.0.0.1:3080`）。
- **Origin 必须由 baseUrl 同一字符串推导**（不许另配一个可能写成 localhost 的 Origin 常量）——否则 #5 的 403。
- Host：**不显式设置**（node fetch 默认由 URL 推导且与 Origin host 相等即过门；显式设置徒增一个可错点，
  且 #3 证明显式设只是无害非必需）。若实现层担心代理改写 Host，可显式加匹配 Host 作双保险（实测通过）。
- 成功判据：HTTP 200 且 `body.ok === true` 且 `body.activation?.[name]?.state === 'live'`；其余一律降级。

## 风险与兜底

1. **漏设 Origin → 403**（undici 不自动带）——契约常数集中 + 行为探测：403/404/形状不符 = 降级信号，走重启验证，不崩。
2. **host 串不一致（localhost/127.0.0.1/::1）→ 403**——Origin 从 baseUrl 推导，杜绝两处配置漂移。
3. **真实路径会真 hotMount**：guard 场景 toggle 目标为刚装新包（非本 spike 的 live 探测目标），hotMount 成败皆由
   路由返回（成功 state=live；失败 502 + `reason`）。本 spike 未触发，降级兜底沿用设计：`hot-mount unavailable (reason);
   falling back to restart verification`。
4. **409**：另一插件操作进行中（withMutationLock busy）——非桥错误，可短重试或直接降级。
5. **403 基础设施保护**：isProtectedModule（宿主基础设施名）拒 toggle——降级重启。400：未安装/市场自身名——不应对市场自身发。
6. **残余副作用（记录在案）**：任一过门 toggle 在锁内先 `pendingRollbacks.clear()`——即使幂等 enabled:true 也会清掉市场 UI
   挂起的回滚令牌。guard 流程自身无并发市场操作，影响极小；但若 guard 恰在市场 install/update 回滚窗口内运行会清掉其令牌。
7. **502**：setPluginEnabled ok=false（hotMount 失败/超时）→ reason 带原因 → 降级重启验证（设计意图：能热挂就热挂，不能就重启）。
8. 响应体解析全容错（非 JSON/字段缺失 → degraded 不崩），body 上限 4 KiB（本请求体远小于此）。

## 状态

- [x] 只读清单：GET /installed（200，20 插件全 activation）
- [x] 幂等 toggle 探测：#1/#2（200，响应一致，/installed 不变）
- [x] 反向验证：#4 无 Origin → 403；#5 localhost Origin → 403；#3 显式 Host → 200
- [x] 源码佐证：sameOrigin / toggle 路由 / setPluginEnabled 幂等分支（routes.ts、http.ts）
- [x] 结论文档已提交
