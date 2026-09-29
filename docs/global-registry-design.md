# 全局事件、方法与定时任务注册层设计

> 本文是 `docs/global-registry-roadmap.md` 的专项设计产出，逐条回答该路线图的 7 个问题。
> **本文主体只做设计与清点，不含实现代码。** §8.2 的迁移步骤是唯一例外：它们标明进度，落地的步骤（S1 / S2 / S3 / S4 / S5 / S6 / S7 / S8 / S9 / S10a / S10b / S10c / S10d / S11a / S11b / S11c）只同步"实际形态与设计的差异"，实现本身在源码里。
> 最后核对：2026-09-28（对应工作区状态：`agent/` 分层与 `prompt-catalog.ts` 统一静态文本已完成；**S0–S9 全部落地**，设计阶段的目标已交付完毕；**S10+ 全部落地**——S10a（`stopPriceFeed` + 同 URL 早退 bug + 启动点收进 `start()`）、S10b（`stopJmcomicQueue` + 把 `initJmcomicQueue` 移出构造函数）、S10c（OneBot 重连句柄）、S10d（删兜底事件总线 + `emit` 改必填）均已落地；**S11a–S11c 亦已落地**——S11a（`SIGTERM` + 幂等关停）、S11b（端点热生效经配置保存触发）、S11c（长期任务**执行清单** `src/web/runtime/lifecycle.ts`）。**"注册层本身仍未实现"这句话到此作废，改口径见 §0.1。**）**同日的另一次改动**：`web/` 按功能与层级搬进子目录（纯搬运，见 §7.6 与 §9.5 第 25 项），本文因此把八个文件的路径回填成新位置——映射表与口径说明在 §7.6。

## 0. 摘要与结论

先说结论，细节在后文：

1. **注册层不能是"一个对象"。** `scripts/check-layers.mjs:83-91` 禁止 `T3 → T4`（`agent → web`）等一切反向依赖，而事件生产者分散在 `agent`(3)、`llm`(1)、`qq`(1)。因此必须拆成**词表（`core`，人人可引用）+ 运行时扇出（`web`，组装根）**两半。这是本设计的第一条硬约束，决定了后面所有形态。
2. **事件层**：用一张封闭的 `AppEventMap`（`事件名 → 载荷类型`）替代今天 12 个字符串事件名与 `unknown` 载荷；顺带解决 `status` 一名两用、`session-end` 四种形状两个历史包袱，并把一条**从未通电**的 `session-update` 通道接对（**S7 已落地**；原始发现见 §3.4 三：生产者发裸串、包装层与 UI 都要求对象，三方从未对齐）。
3. **"方法注册"在本仓库的正确形态是端口（结构性接口），不是运行时分发表。**（**S8 已落地**：`src/agent/runtime/control-port.ts`，`Orchestrator implements` 它，`src/web/` 与 Electron 只依赖这个接口；配套只作文档的 `METHOD_CATALOG`。）仓库里仅有的三处字符串键分发（工具分发、OneBot `call`、HTTP 路由）全是**外部契约**，必须原样保留。为业务方法建字符串注册表恰好是路线图明令禁止的事。
4. **长期任务用"描述符表"**：**6 个**真长期任务各一行，写清 owner / 开关来源 / 配置刷新方式 / 停止入口 / 是否 unref / `conformance` / 清理方式。（**S9 已落地**：`src/web/runtime/tasks.ts` 的 `LONG_TERM_TASKS`。）表是**纯数据，不触发 start/stop，更不包装 `setTimeout` 全局**，且局部计时器不进表（有反向断言守）。其中 4 行在 S9 时**做不到**被真正接管（见 §6.3），只能如实标注为后续工作——因为接管它们要先动启动/退出流程，而那是本阶段的禁止项。**S10+ 解禁后逐行翻正：S10a 已收下 `price.feed`（`partial` → `full`），S10b 已收下两个 jmcomic（cleanup → `full`、worker 如实留 `partial`：停不掉**正在跑**的那一次下载），S10c 已收下 `onebot.reconnect`（`partial` → `full`）——至此 6 行全部有摸得到的启停入口。**
   > ⚠️ 本节原先写"7 个"，是照 §6.3 的表行数数的；那张表第 7 行 `wake.debounce` 自己标着"排除"，真任务是 6 个（§6.1 已更正）。
5. **迁移按渐进式设计**（§8）：S0–S9 每步独立可验证、可回滚；唯一的线上协议改名是把 `status` 拆成 `config-applied` / `orchestrator-pause` 两个名字（**已在 S4 落地**），单独占一步。
6. **一处实测纠正（S10d 已闭合）**：`orchestrator.ts` 原先的兜底事件总线在生产路径上是死代码，但 **8 个测试构造点（`t-orch` 5、`t-orch2` 1、`t-panel` 1、`t-ports` 1）全都不传 `emit`**，而 `tsconfig` 排除了 `tests/`，`.mjs` 不受 `tsc` 管。S10d 删掉它、把 `OrchestratorDependencies.emit` 改成**必填**，并给 8 个构造点补上 `emit`；守护落在 `tests/t-ports.mjs` 第 1c 段的文本扫描（§5.6 有实测数字上的更正：会"当场炸"的不止 1 个，但**真正纯静默的确实是 `t-ports.mjs` 自己那一个**）。

### 0.1 注册层 = 四件产物的合称（S11c 起的口径）

路线图与 `AGENTS.md` 长期写着"**注册层本身仍未实现**"。到 S11c 为止，这句话已经不成立了——但它成立的方式不是"造出了那个对象"，而是**四件各管一段的产物合起来**构成了注册层：

| 腿 | 产物 | 形态 | 管什么 |
|---|---|---|---|
| 事件 | `src/core/events.ts`（`EVENTS` + `AppEventMap`） | 封闭词表 + 载荷类型（**编译期**，S1–S7） | 有哪些事件、载荷是什么 |
| 方法 | `src/agent/runtime/control-port.ts`（`AgentControlPort`） | 结构性接口（**编译期**，S8） | 跨模块能调哪些方法 |
| 任务**描述** | `src/web/runtime/tasks.ts`（`LONG_TERM_TASKS`） | 纯数据表（S9） | 有哪些长期任务、谁开谁停、`conformance` |
| 任务**执行** | `src/web/runtime/lifecycle.ts`（`LIFECYCLE`） | 有序的**直接调用**清单（S11c） | 谁按什么顺序装起来、拆下来 |

这是本设计 §0 第 1 条（"注册层不能是一个对象"）的最终落法：**四件产物没有一件是注册表**，合起来才是。前三条腿都在编译期或文档层生效，唯一带运行期行为的是执行清单——而它刻意做成"函数引用的有序数组"，**不是**按名字分发的表（§5.2 已论证仓库里只有三处字符串键分发，且全是外部契约）。

**这张表里没有"统一注册入口"是设计结论，不是遗漏。** 任何试图把四者收进一个 `registry.register(...)` 的做法都会立刻撞上两条禁令：跨层反向依赖（词表必须在 `core`，而 `web` 是唯一装配根）与字符串式动态调用。§5.4 已把这条路连同理由写死。

## 1. 背景、范围与禁止项

### 1.1 为什么现在只做设计

路线图（`docs/global-registry-roadmap.md`）把这件事整体延期，并写死前提：**先回答完 7 个设计问题，本阶段不新增注册表代码**。理由充分——今天 `src/` 里根本没有注册层的影子，但事件、计时器、生命周期三件事都已经在按各自的习惯生长：

- 事件是散布的 `emit('字符串', payload)`，载荷是 `unknown`；
- 长期任务各自持有 `setInterval` / 自续 `setTimeout` 句柄，启停入口有的有、有的没有；
- 启动与退出顺序没有任何一处文档描述，只能读 `createApp()` 与 `app.stop()` 反推。

在这个状态下直接写注册层，一定会先把上述混乱固化进新接口。所以先把事实盘清楚。

### 1.2 范围

本文回答路线图的 7 问（§2–§9 逐条对应），并产出三份可直接使用的清单：事件全表（附录 A）、计时器全表（附录 B）、死代码登记（附录 C）。

用户已确认的三项口径，本文全程遵守：

- **只产出设计与清点，不改任何运行时代码。**
- **迁移策略按渐进式设计**：新接口与现有 `emit` / 计时器并存、逐个消费者迁移、每步可回滚。
- **SnowLuma 入站只包装现有已解析结果**，不动 `src/qq` 的原始报文解析。

### 1.3 路线图明令禁止（本阶段，也只在设计里"预告"而不执行）

- 不新增事件或方法注册表实现；
- 不替换现有事件总线（`createEventBus()` 保留）；
- 不修改 SnowLuma 入站事件处理；
- 不移动或统一现有定时器生命周期；
- 不修改应用启动、配置刷新或退出流程；
- 不为业务方法增加字符串注册或运行时热替换机制。

§8 的迁移步骤 S1–S9 里，**没有任何一步触碰后三条**；凡是必须触碰的（§6.3 的三行任务），一律登记为 S10+ 之后的后续工作，不进本次迁移序列。

> **S10+ 的解禁范围（附条件）**：第 4、5 条（"不移动或统一现有定时器生命周期"、"不修改应用启动、配置刷新或退出流程"）在 S10+ 阶段**有条件解除**——只允许为"让长期任务能被显式启停"而改动它们，且每步必须带：① 一条计时器句柄或接线的守护；② 证伪探针。**其余四条仍然有效**（尤其"不替换现有事件总线"：删的是 `Orchestrator` 的**兜底**，`createEventBus()` 本体保留）。解除的**不**包括"把长期任务收进一个按名字分发的运行时注册表"——那仍然是路线图的禁令。
>
> **S11c 落在这个解禁范围的哪个位置**：它动的是"启动/退出流程"（第 5 条），依据正是上面那句"只为让长期任务能被显式启停"。**它没有越过第 6 条**：`LIFECYCLE` 不是字符串式注册表，判据是 §0.1 的三条可机检性质（函数引用 / `id` 只作元数据 / import 不启动任何东西），`tests/t-lifecycle.mjs` 第 3 段逐条钉住。第 6 条禁止的是"**按名字查表调用**与**运行时热替换**"，本步两者都没有——因此 S11 不需要再解除任何一条禁令。

## 2. 现状盘点 A：入站事件（回答 Q1）

### 2.1 现状

入站只有一个入口：`OneBotClient` 收到 WS 帧后回调 `onEvent`，`handleOneBotEvent` 里用**链式字符串判断**分派：

> 📍 **位置已漂移（S11 之后的 web 模块整理）**：这段逻辑今天在 `src/web/onebot/ingest.ts` 的 `createIngest()` 里，入口改名 `handle()`，并连同白名单判断、`atNameCache`、引用预览、合并转发展开与拍一拍一起搬出了组装根——`app.ts` 只剩 `onEvent: (event) => ingest.handle(event)…` 一行接线。**判断结构与行为一字未动**，但下面摘录的行号是设计期的（`handleOneBotEvent` 当时在 `app.ts:603-617`），今天在 `ingest.ts:214-228`。

```ts
// 设计期摘录：src/web/app.ts:603-617（现状，仅摘录判断分支）
if (event.post_type === 'message' || event.post_type === 'message_sent') {
  if (String(event.user_id ?? sender.user_id ?? '') === onebot.selfId) return;   // 自己发的
  if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', ...);
  if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', ...);
  return;
}
if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
  return ingestPoke(event);
}
// meta/心跳等事件忽略
```

覆盖情况：**群消息、私聊消息、自己发的消息（`message_sent`）、戳一戳**。以下今天**静默丢弃**：

| 丢弃对象 | 位置 | 后果 |
|---|---|---|
| 其余 notice（撤回、运气王、群管理变动等） | `src/web/onebot/ingest.ts:227` 的兜底注释 | 无任何记录，排查时看不出"收到过但没处理" |
| meta 事件（心跳等） | 同上 | 同上 |
| WS 帧 JSON 解析失败 | `src/qq/onebot.ts:111` | `catch { return; }`，不记日志 |
| 非对象 JSON | `src/qq/onebot.ts:112` | 同上 |

### 2.2 版本差异的既有防御点（设计要沿用，不要重造）

`src/qq/onebot.ts` 里已经积累了一批"不同 OneBot 实现/不同版本形状不一致"的处理，这是本次设计要**继承**而不是推翻的资产：

| 防御点 | 位置 | 处理方式 |
|---|---|---|
| 转发消息 id 字段 | `onebot.ts:247-268` | `id` 与 `message_id` 双形状取一 |
| 群公告动作名与响应 | `onebot.ts:285-337` | `get_group_notice` → `_get_group_notice` 动作名回退；三种响应形状 |
| 戳一戳动作名 | `onebot.ts:212-219` | `send_poke` → `group_poke` / `friend_poke` 回退 |
| 时间戳单位 | `onebot.ts:324-325` | 秒 / 毫秒归一 |
| 消息段转文本 | `onebot.ts:354-403` | `segmentsToText` |
| 卡片段解析 | `onebot.ts:539-608` | `parseCardSegment` |
| 令牌分离 | `onebot.ts:32-35` | WS 与 HTTP 可配不同令牌，`httpToken` 缺省沿用 `accessToken` |

### 2.3 设计结论

**入站层的目标是"给已解析结果加一层内部事件类型"，不是重建解析。** 三条边界：

1. **只包装，不重解析。** 新增的入站事件类型承载的是 `ingestMessage` / `ingestPoke` 之前那个已经被 `handleOneBotEvent` 窄化过的结构，不改变 `src/qq` 对原始报文的任何处理。路线图的"不修改 SnowLuma 入站事件处理"按此理解执行：**分派判断本身不动**，只是把"落进 `ingestMessage` 的那一步"变成一个类型化事件。
2. **版本差异留在 `src/qq`。** 上表那些回退逻辑属于协议适配，不该上浮成事件层的责任——事件层拿到的必须是已归一化的结果。
3. **丢弃要变成"有记录的忽略"。** 今天静默丢弃的几类（其余 notice / meta / 解析失败的帧）在迁移步骤里**不要求新增处理**，但设计上应预留一个统一的"未识别入站事件"出口，让它们至少能被记录一次。这一条**建议但不属于本次迁移必做项**（涉及 `src/qq` 与 `app.ts` 的行为变化，需要单独评估），列在 §10 待定问题里。

**本次不改动**：`handleOneBotEvent` 的判断链保留原样。S1–S9 中没有一步动它。

## 3. 现状盘点 B：内部事件总线与 12 个事件（回答 Q2 的前半）

### 3.1 总线是空转的

`createEventBus()`（`src/core/util.ts:160-179`）是一个朴素的 `Map<string, Set<Listener>>`：`on(type: string, fn)` 返回取消函数（`:165-170`），`emit(type: string, payload: unknown)` 逐个调用并隔离异常（`:171-177`，单个监听器抛错只打日志）。

**关键事实：服务端没有任何一处调用 `bus.on()`。** 组装根在 `src/web/app.ts:55` 调 `bus.emit(type, payload)` 之后，**真正的投递是紧接着的 SSE 写帧循环**（`app.ts:58`）。也就是说：

- 今天的"事件总线"实际是 **SSE 广播通道**，总线对象只是个空转的装饰；
- 任何把**业务行为**挂在 `on()` 上的设计，在当前代码里都是 no-op，直到有消费者为止；
- 迁移期间**不得把正确性挂在 `on()` 上**——这是硬约束，不只是风格建议。

### 3.2 设计期的 12 个事件名、61 个发射点

清点命令与结果（本文写作时的实测）：

```bash
grep -rnE "emit\??\.?\(['\"]" src/   # 61 —— 带字面事件名的发射调用（含 vision-scan.ts 的 2 处 emit?.）
grep -rn "emit(" src/                # 72 行命中，差额是类型声明、注释、4 处转发包装与 1 处 bus.emit 透传
```

即 **61 个真实发射点、12 个事件名**。分名统计见附录 A（逐名计数已与源码核对一致）。发射点分布：

> ⚠️ 本节是**设计期的清点快照**，保留它是因为迁移步骤（§8.2）与附录 A 都引用这些计数。S4 落地后上面那条命令返回 **0 行**（61 处字面量已全部换成常量）；要复现 61 这个数，请按 §9.5 第 7 条的方式回到 `HEAD` 上跑。发射点**总数**不变（59 处换成常量 + 2 处换成新常量），所以下表与附录 A 的计数仍然成立；只有**事件名**从 12 个变成 13 个（`'status'` → `'config-applied'` + `'orchestrator-pause'`，§4.6）。
>
> ⚠️⚠️ **这条"总数不变"到 S11d 作废。** S11d 删掉了 `vision-scan` 那 **5 个发射点**（整个事件从词表删除），所以**今天的真实发射点总数是 56、事件名是 12**。下表与附录 A 对应的行已就地标注为已删；其余各行的计数不受影响（S11d 一个别的发射点都没动）。要复现"56"，`grep -rnE "emit\??\.?\(" src/` 数带事件名的调用即可——S3 之后它们全是 `EVENTS.*`，不再是字面量，所以第 141 行那条命令在今天返回 0 行。

> ⚠️⚠️⚠️ **`src/web/app.ts` 那一行在 S11 之后的 web 模块整理里被拆成三行**（点数总和不变，10 → 3 + 5 + 2）：`snowluma-*` 的 5 个点随 `web/onebot/snowluma.ts`（SnowLuma 控制器）走，`chat-update` 的 2 个点随 `web/onebot/ingest.ts`（入站摄取）走，组装根只剩 `sticker-update`、`onebot-status`、`config-applied` 三个。**总数仍是 56**，逐文件核对命令：`grep -rnE "emit\??\.?\(\s*EVENTS\." src/ | sed 's/^src\///' | awk -F: '{print $1}' | sort | uniq -c`。

| 文件 | 点数 | 主要事件 |
|---|---|---|
| `src/agent/runtime/wake-scheduler.ts` | 16 | `chat-update`(6)、`session-update`(5)、`session-end`(3)、`session-start`(2) |
| `src/web/routes/memory.ts` | 8 | `memory-update` |
| `src/agent/runtime/agent-runner.ts` | 6 | `session-update`(5)、`session-end` |
| `src/web/routes/chats.ts` | 5 | `chat-update` |
| `src/web/onebot/snowluma.ts` | 5 | `snowluma-status`(4)、`snowluma-log` |
| ~~`src/llm/vision-scan.ts` + `src/web/routes/providers.ts`~~ | ~~5~~ | ~~`vision-scan`~~ —— **S11d 已删**，5 个发射点全部移除（§3.5、附录 C） |
| `src/web/routes/stickers.ts` | 4 | `sticker-update` |
| `src/agent/tools/shared.ts` | 3 | `session-update`(2)、`feedback` |
| `src/web/app.ts` | 3 | `sticker-update`、`onebot-status`、`config-applied` |
| `src/agent/maintenance/history-compactor.ts` | 2 | `chat-update` |
| `src/web/onebot/ingest.ts` | 2 | `chat-update` |
| `src/web/routes/system.ts` | 1 | `chat-update` |
| `src/agent/runtime/orchestrator.ts` | 1 | `status` |

另有 4 处**转发包装**（把 `emit` 原样传给子模块，不产生新事件）：`orchestrator.ts:85/112/132`、`agent-runner.ts:164`；以及 1 处透传 `app.ts:55` 的 `bus.emit`。

### 3.3 载荷全是 `unknown`，`emit` 依赖的注入类型也全是字符串

~~同一个松散签名 `(event: string, payload?: unknown) => unknown` 出现在 7 处：~~ **已在 S6 全部换成 `AppEmit`**（见 §4.3），下面是当时的清点：

| 位置 | 归属 |
|---|---|
| `src/agent/runtime/orchestrator.ts:41` | `Orchestrator.emit` 字段 |
| `src/agent/runtime/wake-scheduler.ts:29` | `WakeSchedulerDependencies` |
| `src/agent/runtime/agent-runner.ts:47` | `AgentRunnerHost` |
| `src/agent/maintenance/history-compactor.ts:16` | `HistoryCompactorDependencies` |
| `src/agent/maintenance/memory-consolidator.ts:33` | `MemoryConsolidator` 依赖 |
| `src/agent/shared/types.ts:36`（`ToolContext.emit`）与 `:81`（`OrchestratorDependencies.emit`） | 工具上下文 / 编排器依赖 |
| `src/web/types.ts:30`（`AppContext.emit`）与 `:65`（`AppHandle.emit`） | 路由上下文 / 应用句柄 |

（`src/web/types.ts:30` 与 `:65` 是同名不同对象的两个声明。）

唯一已经存在的"事件名 → 类型"映射是 `src/agent/shared/types.ts:106-110`（**S11d 已删除该接口**，下面是当时的形态，留作反面教材）：

```ts
export interface AgentEventMap {
  state: Record<string, unknown>;
  session: Record<string, unknown>;
  [event: string]: unknown;     // ← 就是这一行让 keyof 退化成 string
}
```

名字和风格可以复用，**索引签名必须去掉**——留着它，新增/改名事件永远不会报错，强类型映射等于没做。**S11d 的收口方式是直接删掉这个空壳**（它全仓无使用者，已被 `AppEventMap` 取代），而不是保留它当注释：留着一个"名字很像、又谁都不引用"的映射，只会让人抄错那一个。⚠️ 删除之后 `core/events.ts` 的注释里**还会**提到 `AgentEventMap`——那是有意的反面教材引用，所以扫"这个名字在 `src/` 是否绝迹"的断言必须先 `stripComments()`。

### 3.4 三个历史包袱

**（一）`status` 一名两用。** ~~两个不兼容的载荷共用同一个名字：~~ **已在 S4 拆开**（见 §4.6），下面是当时的清点：

- `src/web/app.ts:711`：`emit('status', { configUpdated: true })`（配置保存后）
- `src/agent/runtime/orchestrator.ts:284`：`emit('status', { paused, pauseReason })`（暂停/恢复）

UI 侧两处都只是调 `refreshStatus()`，所以"同名"今天没有炸——但这是巧合，不是设计。

**（二）`session-end` 四种形状。** ~~四处载荷字段各不相同：~~ **已在 S5 收敛**（见 §4.5），下面是当时的清点：

| 位置 | 载荷 | 语义 |
|---|---|---|
| `agent-runner.ts:332-339` | `{ sessionId, chatKey, status, sent: number, finishReason, usage }` | 真正跑过一轮后收尾（`status` 由 `:330` 决定：`error` / `done` / `noreply`） |
| `wake-scheduler.ts:366-371` | `{ sessionId, chatKey, status: 'discarded', discarded: true }` | 档位判定"这次不响应"，会话被 `discard` 掉（`#discardWaiting`） |
| `wake-scheduler.ts:382` | `{ sessionId, chatKey, status, error }` | `#finishWaiting`：等待中的会话被中止（暂停/未设模型/无未读等） |
| `wake-scheduler.ts:567` | `{ sessionId, chatKey, status: 'error', error }` | 运行路径抛错 |

注意 `agent-runner` 那条的 `sent` 是**数字**（已发送条数），而 SSE 投影里 `sent` 是**数组**（`app.ts:290`）——同名异物，是改名 `sentCount` 的直接理由。

**（三）`session-update` 是一条**从来没通过电**的通道（比"形状不统一"严重得多）。** 12 个发射点发的都是**裸字符串** `session.id`（如 `wake-scheduler.ts:313`、`agent-runner.ts:134`）——这是 **S7 之前**的状态，已落地修复，本段保留原文以记录当时的判断依据：

```ts
emit('session-update', session.id);          // agent-runner.ts:134 等 12 处
```

而 `src/web/app.ts:267-296` 的包装函数要求**对象载荷**才会去回读会话：

```ts
// src/web/app.ts:267（S1 之前的现状）
if (type === 'session-update' && isRecord(payload) && payload.sessionId) {
  const s = sessions?.peek(String(payload.sessionId));
  if (s) line = `event: ${type}\ndata: ${JSON.stringify({ sessionId, chatKey, startedAt, status,
    waitUntil, activity, webSearchCount, rounds, usage, trigger, triggerSummary, messages,
    sent, finishReason, error, endedAt })}\n\n`;
}
```

`isRecord('abc')` 为 `false`，所以这条分支**永远不会进**。前端 `ui/js/main.js:240-244` 也守了同一道门：

```ts
es.addEventListener('session-update', (ev) => {
  const data = JSON.parse(ev.data);
  const id = data.sessionId;      // 裸串 "abc" 取不到 sessionId
  if (!id) return;                // → 直接返回
```

结论：**`session-update` 的 SSE 帧今天从生产者到消费者全程无效**。面板的会话详情实际靠 `ui/js/views/sessions.js:136-142` 的 `startListPoller()` 主轮询拉 HTTP，SSE 侧真正起作用的只有 `session-start` / `session-end`（它们在 `main.js:229` / `:277` 触发一次 `loadSessions()`）。

顺带一提，`ui/js/main.js:210` 的 HTTP 详情合并处写着"sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推"，说明**代码里已经认定这条通道是通着的**，只是没有测试或使用者能证伪它。

**这不是回归**，已用 git 核实：初始提交 `d34a8f0:src/app.js:233` 写的是 `payload?.sessionId`，对字符串同样取不到值；`git log -S` 也找不到任何一个提交发过对象载荷。也就是说这条富投影**自初始提交起就没被执行过一次**。

这条发现改变了 S7 的性质：它不是"把 12 处裸串改成 `{ sessionId }` 的无害载荷统一"，而是**激活一条从未上线的通道**——激活后 UI 才会真正开始吃 SSE 快照，届时 `patch` 合并逻辑（`main.js:246-266`，尤其 `sent`/`finishReason` 的"后端给了才写"）会第一次被真实数据跑到，而 `main.js:210` 那处"patch 优先"也会第一次真的生效。所以 S7 必须**单独一步、单独验证**，并且要人工确认真机上面板在 SSE 与轮询双写下的表现（见 §10 待定第 2 条）。

> **S7 落地后的补充（通道已通电）**：12 个发射点改成 `emit(EVENTS.sessionUpdate, { sessionId })`，`AppEventMap['session-update']` 同步翻回 `{ sessionId: string }`，于是上面这条分支**第一次真的被执行**。上面那段"结论"保留原文——它记录的是 S7 之前的事实，也是"为什么这一步必须单独走"的理由。
>
> 落地时新增的守护在 `tests/t-events.mjs` 第 6 段（§9.3）：真起 `Orchestrator` 跑一轮，把每条 `session-update` 载荷**在 emit 当刻**喂给真投影函数 `projectSse`，断言吐出来的是**富帧**（含 `messages`/`status`）而不是退化的 `data: "sess-x"`。只断言"载荷是对象"是不够的——那只证明形状，证明不了通道通；上面这个缺陷正是形状对、接线错的产物。反过来说，"把投影入口条件改回去"这类回归 `npm run typecheck` **完全管不到**（改完照样编译通过），只有这条断言会红。
>
> 一个仍未被验证的细节：帧依赖 emit 时刻的 `sessions.peek()`，取不到会话就退回原样 payload。今天是**理论兜底**——12 个发射点都在会话还活着或已落盘时触发，而 `peek()` 在内存里找不到时会**回读会话文件**（`sessions.ts` 的 `peek`），所以"已回收"并不等于 `peek` 返回 `null`；真的返回 `null` 只剩"会话被 `discard` 删档"这一种情形，而那一路发的是 `session-end`。但万一发生，帧会变成 `{"sessionId":"x"}` 而**不是**裸串——UI 会拿它当 patch 合并，用 `undefined`/`[]`/`0` 覆盖面板那一行，直到 4s 轮询拉回来。这条路径没有套件能覆盖，属真机冒烟项（§10 待定第 2 条）。

这段投影**藏在闭包里**，后果是它只能被 `t-smoke.mjs` 那种端到端套件间接覆盖，无法单测——S1 就是把它抽出来。

### 3.5 无消费者项（必须显式裁决，不许"顺手统一"）

| 事件 | 生产者 | 消费者 | 现状 |
|---|---|---|---|
| `session-update` | 12 个发射点（§3.2） | UI 有一个监听（`main.js:240`） | **S7 之前整条通道无效**：生产者发裸串、包装层要求对象、UI 也要求对象（§3.4 三），SSE 帧照发但没人能用。**S7 已通电**：三方对齐到 `{ sessionId }` |
| ~~`vision-scan`~~ | ~~`providers.ts:156/158/159`、`vision-scan.ts:160/170`~~ | ~~**无**~~ | **S11d 已删**。5 个发射点全部进虚空；`vision-scan.ts:14` 曾为此专门定义了 `ScanEmit` 类型（S6 已删除，改用 `AppEmit`）。裁决方式是**删事件**而不是补消费者——能力已由 HTTP 提供（`POST /api/vision/scan` 的 202 + `GET /api/vision/results` 的 `scanning`），为一个空转事件造面板需求是本末倒置 |
| ~~`memory-update` 的自动路径~~ | ~~`MemoryConsolidator` 注入的 `emit`（`memory-consolidator.ts:33`）~~ | 面板有监听 | **S11d 已删**。该 `emit` 从未被调用，所以"自动记忆整理"对 UI 完全静默；只有 `routes/memory.ts` 的手动触发会发事件。**自动路径今天仍然静默，这是如实标注而不是遗留 bug**：真要让它说话，得给 `MemoryConsolidator` 加真实的 `emit` 调用点并重新登记进 `TYPED_FILES`——那是一个有意的动作，不是"把注入点加回去" |

两条建议（**两条都在 S11d 裁决完毕，§10 待定 7 已关闭**）：`vision-scan` 要么补一个面板消费者，要么从词表删除 —— **选了删**（能力已由 HTTP 提供，补消费者等于为一个空转事件造需求）；`MemoryConsolidator` 的 `emit` 要么接上（自动整理开始时发 `phase: 'consolidate-start'`，与手动路径统一），要么删掉这个注入点——保留一个永不调用的依赖是最坏选项，它让"整理中"这个状态的来源看起来有两个 —— **选了删**（它从未被调用过，接上要先决定"自动整理要不要对面板可见"这个产品问题，那是一个独立的有意动作）。

`session-update` 与上面两条性质不同：它有明确用途（面板实时详情）且代码齐全，只是**接线从未对齐**。处理办法是 S7 把它接上，而不是删掉；但正因为一接上就会改变面板的数据来源，它单独占了一步并单独冒烟（§8.2、§10）。**S7 已按"接上"落地**（没有采纳"删掉死通道"那条替代路线），所以它不再是待裁决项。

### 3.6 两套并行注册机制（设计要保留，不搬上总线）

`OneBotClient.statusListeners`（`src/qq/onebot.ts:28`，`onStatus` 在 `:48-51`，`#setStatus` 在 `:53-59`）与 `StickerManager.onChange`（`src/stickers/sticker-manager.ts:13`、`:31`、`#changed` 在 `:51-53`）各自维护一套回调集合，然后在组装根被适配成事件（`app.ts:329`、`app.ts:318`）。

**不要把它们合并进事件总线。** 它们存在的意义正是让 `qq/`(1) 与 `stickers/`(2) 不必依赖应用事件词表；而词表按 §4.1 要落在 `core`(0)——把这两个回调改成"发事件"虽然方向合法（向下引用），但会**把两个领域的对外契约反过来绑死在应用事件名上**，等于用注册层收窄了两个本可独立复用的模块。

**边界写成一句话：管理者暴露回调，注册层只拥有词表，组装根负责适配。** 适配点仍留在 `app.ts:318/329`。

## 4. 设计 A：类型化事件层（回答 Q2）

### 4.1 骨架约束：为什么词表必须放 `core/`

`scripts/check-layers.mjs` 的层级是 `core`=0 → `llm/chat/qq/media`=1 → `stickers`=2 → `agent`=3 → `web`=4，规则在 `:83-91`：

```js
// scripts/check-layers.mjs:83-91
const sourceLevel = LEVEL.get(sourceDomain);
const targetLevel = LEVEL.get(targetDomain);
if (targetLevel > sourceLevel) {                      // ← 反向依赖，直接失败
  errors.push(`${sourceRel} -> ${targetRel}: T${sourceLevel} 不得反向依赖 T${targetLevel}`);
  continue;
}
if (sourceLevel === 1 && targetLevel === 1 && !T1_ALLOW.has(`${sourceRel} -> ${targetRel}`)) {
  errors.push(...);                                    // ← T1 互引需要精确白名单
}
```

而 `T1_ALLOW` 是**空集**（`:16-17`）。

结论：事件生产者分散在 `agent`(3)、`llm`(1)、`qq`(1)，如果有任何一个"统一注册表"对象住在 `web`(4)，它自己就会让 `agent → web` 的反向依赖成立——`check-layers.mjs` 立刻红。**所以词表必须落在 `core`(0)，人人可向下引用。**

代价是明确的：`core` 不能引用任何上层类型，所以**载荷只能用基础类型**（string / number / boolean / null / 数组 / 普通对象 / 可辨识联合）。盘点结果：12 个事件的载荷今天都已经满足或可以满足——当初需要改造的两处（`session-update` 的瘦事件 §4.4、`session-end` 的形状收敛 §4.5）**都已分别随 S5 与 S7 落地**。

### 4.2 事件词表与载荷类型（S2 已落地）

**唯一来源是 `src/core/events.ts`**——本文不再复制它的全文，只留骨架与实现期的修正记录：

```ts
export const EVENTS = { chatUpdate: 'chat-update', /* … */ orchestratorPause: 'orchestrator-pause' } as const;
export type AppEventName = (typeof EVENTS)[keyof typeof EVENTS];

export interface AppEventMap {          // 刻意不写索引签名
  'chat-update': string;                 // chatKey | '*'
  'session-update': { sessionId: string };   // 瘦事件；S6 曾如实记成 string，S7 随发射点一起翻回（见修正表）
  'session-start': SessionStartPayload;
  'session-end': SessionEndPayload;
  'memory-update': MemoryUpdatePayload;
  'sticker-update': StickerUpdatePayload;
  // 'vision-scan': VisionScanPayload;   ← S11d 已删（零消费者；词表、载荷、5 个发射点一起走）
  'onebot-status': OneBotStatusPayload;
  'snowluma-status': SnowlumaStatusPayload;
  'snowluma-log': SnowlumaLogPayload;
  'feedback': FeedbackPayload;
  'config-applied': ConfigAppliedPayload;
  'orchestrator-pause': OrchestratorPausePayload;
}

export type AppEmit = <K extends AppEventName>(event: K, payload: AppEventMap[K]) => void;
export type AppOn = <K extends AppEventName>(event: K, fn: (payload: AppEventMap[K]) => void) => () => void;
```

`EVENTS` 里没有 `'status'`（§4.6 拆名）；`config-applied` / `orchestrator-pause` 在 S4 之前没有生产者，S4 之后各自接上了一个。

**实现期对着发射点核出的四处修正**（下面这些原稿是清点时的推测，落地时以代码为准）：

| 项 | 原稿 | 事实 |
|---|---|---|
| `snowluma-log` 的载荷 | 待定 | `{ at, stream, text }`，`app.ts:136-141` 的 `pushSnowlumaLog` 就是这个形状（附录 A 写的"日志行"是简写，不是裸串） |
| `SnowlumaStatusPayload.pid` | `number \| null` | 必须可选：未启动时发 `null`，而 `child.pid` 的类型是 `number \| undefined`，写死 `number \| null` 会让那两处发射点编译不过 |
| `MemoryUpdatePayload` | 只有 `chatKey / phase / userIds / error` | `consolidate-done` 会展开 `consolidateMemoryForChat` 的返回值（`routes/memory.ts:84`），所以还要有 `ok / note / changed / results / skipped / failed`。UI 只读 `note`（`main.js:307`），`results` 等是 agent 层领域对象，`core` 里只能记成 `unknown[]` |
| `SessionEndStatus` | 待枚举（原 §10 待定 1） | **已枚举完**：`'done' \| 'noreply' \| 'error' \| 'aborted' \| 'discarded'`。`agent-runner.ts:330` 只在 `done/noreply/error` 里挑，`#finishWaiting` 的 8 个调用点全部传 `'aborted'`，`discarded` 只来自 `#discardWaiting`（`wake-scheduler.ts:362-371`） |
| `SessionEndPayload.error` / `.finishReason` | `string \| null` | **S5 放宽为 `unknown`**。来源 `SessionRecord.error` / `.finishReason`（`chat/types.ts:68-69`）本身就是 `unknown`，运行时的真实取值确实只有 string 与 null——但写"理想形状"会让三个发射点编译不过（实测：`s.error \|\| null` 推成 `{} \| null`、出错路径直接是 `unknown`），于是 S6 会被迫在那儿加 `as` 断言。按本文件"只写事实，不写理想形状"的既有口径放宽。同款处理见 `SessionStartPayload.status` 与 `FeedbackPayload.level` |
| `AppEventMap['session-update']` | `{ sessionId: string }` | **S6 一度改成 `string`，S7 已翻回 `{ sessionId: string }`。** S2 登记的是**设计目标**（§4.4 的瘦事件），但 12 个发射点当时实际发的是**裸字符串**。S6 把注入类型翻成 `AppEmit` 的那一刻编译器把这 12 处全部点出来（实测恰好 12 条 `TS2345`）——要让 S6 保持"纯类型、零行为变化"，类型就得如实描述当时的线上载荷。写成 `string \| { sessionId }` 联合会让"新发射点误发裸串"也能通过，等于把刚换来的护栏还回去。**S7 在同一笔改动里改了 12 处发射点并翻回类型**（`string` 与 `{ sessionId }` 是 S6↔S7 的接缝，必须同时改；§8.2、§9.5 第 11 项） |

**另加了编译期护栏**：`EVENTS` 与 `AppEventMap` 必须双向对齐——往词表加了名字却忘了登记载荷、或加了载荷却忘了加常量，`npm run check` 都会报 `Type 'false' does not satisfy the constraint 'true'`（`EveryEventNameHasPayload` / `EveryPayloadHasEventName`，两个断言都实测过会红）。这样"新增事件必须显式登记"不靠人自觉，也不需要额外套件守。

### 4.3 怎么用（不替换总线）

- **总线保留。** `createEventBus()`（`core/util.ts:160-179`）不动，`bus.emit(type, payload)` 在包装函数里原样调用。
- **类型只加在注入函数上。** §3.3 表里的 7 处 `(event: string, payload?: unknown) => unknown` 改为 `AppEmit`；组装根在 `app.ts:264` 把包装函数标注为 `const emit: AppEmit = (type, payload) => { ... }`，生产者从此在编译期被检查。

  **S6 已落地**，实际是 **13 处标注、落在 9 个文件**（比 S0 清点的"7 处"多，因为清点按"签名出现在几个文件"数，落地要逐处标）：`history-compactor` / `memory-consolidator` / `agent-runner`(2：`AgentRunnerHost` + 传给 `ToolContext` 的那个箭头) / `orchestrator` / `wake-scheduler`(2：依赖 + 字段) / `shared/types`(2：`ToolContext` + `OrchestratorDependencies`) / `web/types`(2：`AppContext` + `AppHandle`) / `vision-scan`(1：删掉 `ScanEmit` 别名改用 `AppEmit`) / `app.ts`(1：实现处标注)。另有 3 处**转发包装**（`orchestrator.ts` 把 `emit` 转给三个子模块）靠上下文推断，不写显式标注——它们转发的是同一个 `AppEmit`，写出来只是噪音。

  ⚠️ **S11d 之后这两个数都变了。按 `t-events.mjs` 的判定规则实测：今天只剩 `TYPED_FILES` 那 7 个文件、10 处标注行。**（上一条的"13 处 / 9 个文件"是 S6 时**人工读出来**的数，它把 `agent-runner.ts:166` 那处**从未标注过**的箭头转发也算成了一处；套件的判定是"同一行同时含 `emit` 与 `AppEmit`"，那一行只有前者，所以按同一规则回数 S6 当时是 12 处——"处"这个数在两处口径不同，**以文件集合为准**。）删掉的是 `memory-consolidator` 的 `emit` 依赖与 `vision-scan` 的 `emit?` 参数，两处都不存在了，所以 `TYPED_FILES` 必须同步删掉这两个文件名。**这是 S11d 最容易漏的红**：那份清单是**对称**的，"少了"与"多了"都会报，报出来的是**文件名**而不是运行错误，容易被人当成测试噪音（§9.5 第 21 项②是实测）。
- `AppOn` 可以后续在同一个 `createEventBus()` 之上加一层薄包装（零行为变化），但不是本次迁移的必做项。

### 4.4 SSE 投影独立化：`session-update` 保持瘦事件

把 `app.ts:267-296` 的序列化抽成 `src/web/http/event-projector.ts` 的**纯函数**（只读依赖、不做 IO，因此可单测）。设计形态：

```ts
// src/web/http/event-projector.ts
export function projectSse(type: string, payload: unknown, deps?: { sessions?: SessionPeekSource | null }): string;
export function projectSessionUpdate(sessionId: string, sessions?: SessionPeekSource | null): string | null;
export function writeSse(clients: Iterable<ServerResponse>, line: string): void;
```

唯一读取依赖是结构化接口 `SessionPeekSource`（就是 `peek(id)`），不是 `SessionRegistry` 类——测试传对象字面量即可，不为这一步引入任何 `instanceof` 或运行期校验（原因见 §3.3 末）。

**S1 的实现口径（已落地）**：S1 的契约是"纯重构、帧逐字节不变"，所以投影**逐字照搬**了原闭包，包括 `session-update` 那个 `isRecord(payload) && payload.sessionId` 的入口条件。也就是说 §3.4（三）描述的"分支不可达"在 S1 之后**依然不可达**——这是有意的：先让可测性到手，再在 S7 单独决定要不要激活、以及激活后 UI 怎么表现。**这个决定已在 S7 做出：选择激活，不删。** 此后投影的富帧分支从"不可达"变成"每条 `session-update` 都走"，而 `t-sse-project.mjs` 钉的两侧从"今天的事实 vs S7 之后的事实"变成一条**真实路径 + 一条兜底路径**（裸串走通用帧这件事本身没变——投影函数一个字没改，仍然只对对象载荷做富投影；变的是生产者从此发对象）。所以那个套件**当时不需要翻面**，真正需要新增守护的是"通道确实通了"，落在 `t-events.mjs` 第 6 段（§9.3）。

**为什么 `session-update` 不改"载荷即线格"**：那需要 12 个发射点各自构造 `{ sent, finishReason, usage, messages, waitUntil, … }`，等于把 `SessionRegistry` 的读模型搬进 `agent/`，并让每个生产者都要知道面板想看什么。保持"瘦事件 + 读模型投影"才有单一职责。

代价（列入 §10）：SSE 帧依赖 **emit 时刻**的 `sessions.peek()`。会话若已被回收则退回原样 payload——这正是 S1 之前 `app.ts:296` 的行为，所以不是新增风险，但要写进文档备查。S7 之后这一路的前提变得更窄了：`peek()` 在内存里找不到会**回读会话文件**，所以"已回收"并不等于取不到；真的取不到只剩"被 `discard` 删档"，而那一路不发 `session-update`。退回的形状也不再是裸串，而是 `{"sessionId":"x"}` —— UI 仍会当 patch 合并，细节见 §3.4（三）末的 S7 补充。

**S6 的一个发现：`session-update` 的"目标类型"和"今天的载荷"是两回事，这个差异会在 S6 炸出来。** §4.2 里 `AppEventMap['session-update']` 一直写的是 `{ sessionId: string }`（设计目标），但 12 个发射点发的是**裸字符串**。S6 把注入类型翻成 `AppEmit` 的瞬间，编译器把这 12 处全部点出来——`Argument of type 'string' is not assignable to parameter of type '{ sessionId: string; }'`，**恰好 12 条**（5 个在 `agent-runner`、5 个在 `wake-scheduler`、2 个在 `tools/shared`，与附录 A 的点数一致）。

于是 S6 面前只有三条路：① 把类型改成今天的事实（`string`），S7 连同发射点一起翻成 `{ sessionId }`；② 在 S6 里顺手把 12 处改掉——那就是把 S7 并进 S6，而 §3.4（三）已经论证 S7 会**激活一条从未上线的通道**、必须单独一步并真机冒烟；③ 写成 `string | { sessionId }` 联合。

**选①**，理由就是本文件反复用的那条口径：*只写事实，不写理想形状*。S6 的定义是"纯类型、零行为变化、可单独回滚"（§8.2），所以类型必须如实描述今天的线上载荷；联合（③）看似两全，实则让"新发射点误发裸串"也能编译通过，把 S6 刚换来的护栏又还回去一半。

### 4.5 `session-end` 收敛（S5 已落地）

四种形状（§3.4 二）合并成 §4.2 的 `SessionEndPayload`：

- `sessionId` / `chatKey` / `status` 必填；
- `agent-runner.ts:336` 的 `sent: number` → `sentCount`（消除与 SSE `sent: array` 的同名异物）；
- 保留 `discarded: true` 标记（`#discardWaiting` 的语义是"压根没开始"，与 `status: 'aborted'` 的"开始了但没成"是两回事——`sessions.ts:174-184` 的注释专门解释了这一点）；
- `SessionEndStatus` 的字面量集合：`sessions.ts:58` 的注释给出记录态为 `waiting | running | done | noreply | error | aborted`；**`discarded` 是事件独有态**——`sessions.discard()`（`:185-198`）直接把会话从索引删掉，从不写进 `s.status`。这个不对称必须在类型里体现，不能按会话记录字段来抄。调用点已在 S2 枚举完，集合定为 `'done' | 'noreply' | 'error' | 'aborted' | 'discarded'`（详见 §4.2 的修正表）。

**落地时的实际形态**：

- `sent` → `sentCount`：只有 `agent-runner` 一处发这个字段，改完**全仓没有任何读方**受影响的说法也验证过了——UI 的 `session-end` 处理器只读 `data.sessionId`（`ui/js/main.js:277-289`），`t-vision-log.mjs` 与 `harness.readArchivedSession` 也只读 `sessionId`（§10 待定 4 由此关闭）。
- `#finishWaiting(sessionId, status: string, …)` 的参数收成 `SessionEndStatus`：今天 8 个调用点全部传 `'aborted'`（`npm run typecheck` 通过即为证据）。这是**边界收窄，不是行为变化**；实测把某个调用点改成拼错的 `'abort'` 会报 `TS2345: Argument of type '"abort"' is not assignable to parameter of type 'SessionEndStatus'`。
- `SessionEndPayload.error` / `.finishReason` 由 `string | null` **放宽为 `unknown`**，理由见 §4.2 修正表的最后一行。

**"四个形状都符合一个接口"是实测过的，不是读代码读出来的。** S5 时 `emit` 的注入类型仍是 `(event: string, payload?: unknown) => unknown`（S6 才翻 `AppEmit`），编译器管不到发射点，所以用了两步验证：

1. **编译期探测（一次性，已还原）**：把四处 `this.emit(EVENTS.sessionEnd, {…})` 临时改写成 `const _probe: SessionEndPayload = {…}`（同时删掉 emit 调用），`tsc --noEmit` 报出**恰好三处**不满足，且都指向同一对字段——`error`（`s.error || null` 推成 `{} | null`）与 `finishReason`（`unknown`）。放宽这两个字段后四处全部通过（退出码 0），随后删除探测代码。`#discardWaiting` 那处**一次都没报错**，说明它的形状原本就对。
2. **运行期断言（永久，落在 `tests/t-events.mjs`）**：真起 `Orchestrator` + 假模型端点，跑出 `done` / `noreply` / `aborted` 三种真实载荷，断言每条都有 `sessionId`（字符串非空）、`chatKey`（字符串）、`status` ∈ 五个字面量、字段集合不超出 `SessionEndPayload`、**没有 `sent` 键**、`sentCount` 出现时是数字。覆盖不到 `error` 与 `discarded`（前者要触发重试、后者依赖档位判定说"不响应"，都不稳），由上面的编译期探测兜住。

**另一个必须写进文档的事实**：`sessions.finish()`（`sessions.ts:150-172`）会 `current.delete(id)`（`:155`）。所以 `session-end` 的载荷必须**自包含**——事件发出后再 `peek(id)` 一定是 `null`。这决定了 `session-end` 不能像 `session-update` 那样走"瘦事件 + 回读"的路子，必须把字段带全。

### 4.6 `status` 拆名（S4 已落地）

`app.ts:711` → `config-applied`，`orchestrator.ts:284` → `orchestrator-pause`。这是**全案唯一的线上协议改名**，所以单独占一步迁移（S4）、单独可回滚。UI 侧今天两个场景都只是调 `refreshStatus()`（`ui/js/main.js:351` 附近），加一个监听即可，行为不变。

**落地后的实际形态**：`ui/js/main.js` 那一条 `es.addEventListener('status', …)` 换成两条各接各的 `config-applied` / `orchestrator-pause`，处理函数仍是同一个 `refreshStatus()`，所以面板行为逐字不变。改名是否还有 UI 之外的消费者——全仓搜过了，**没有**（唯一命中就是 `ui/js/main.js:351`），§10 待定 3 由此关闭。

这次改名暴露的真实风险是"**只改一边**"：发射端在 TS 常量表里改名、订阅端还是在 `ui/js` 里裸写字符串，改漏了帧照发、面板却再也不刷新，而且**不报任何错**（`t-sse-project.mjs` 只钉 `session-update` 的帧形状，`t-smoke.mjs` 不读 SSE）。所以 S4 在 `t-panel-wiring.mjs` 里加了一条**跨边界比对**：把 `core/events.ts` 的词表解析出来，断言"UI 订阅的每个名字都在词表里"——这条以后任何一端改名都会红。两条新断言都用"把 UI 改回 `'status'`"实测过会红。

### 4.7 设计要点小结

| 事项 | 决定 | 理由 |
|---|---|---|
| 词表位置 | `src/core/events.ts` | 层级 0 才能被所有生产者引用（§4.1） |
| 载荷类型 | 只用基础类型 | 同上 |
| 索引签名 | 去掉 | 留着等于没有强类型（§3.3） |
| 总线 | 保留 `createEventBus()` | 路线图禁止替换 |
| `session-update` | 瘦事件 + 投影回读 | 不把会话读模型塞进 `agent`（§4.4） |
| `session-end` | 自包含载荷 | `finish()` 会删会话，回读必空（§4.5） |
| SSE 投影 | 抽成纯函数 | 今天只能端到端覆盖（§4.4） |
| `onStatus` / `onChange` | 保留为领域回调 | 避免把领域契约绑死在应用事件名上（§3.6） |
| `on()` | 不承载业务正确性 | 服务端零消费者（§3.1） |

## 5. 设计 B：方法注册边界（回答 Q3）

### 5.1 今天的接线方式是注入具体类实例

`createApp()` 是唯一的组合根：它 new 出全部具体类，用**依赖对象**传给彼此，路由拿一个类型化的 `AppContext` 直引（`src/web/types.ts:23-45`）。**S11 之后的 web 模块整理没有改变这一点**：`AppContext` 里那些"控制台侧"的成员（`buildStatus`/`sanitizeConfig`/`getSnowlumaLogs`/三个 SnowLuma 适配器）今天由 `src/web/http/console.ts` 的 `createConsole()` 组装，但组装动作仍由 `createApp()` 发起，`console.ts` 拿到的是一份显式的 `ConsoleDeps`（§7.6）。摘要是：

```ts
// src/web/types.ts:23-45（摘要，S6 / S8 之后的实际状态）
export interface AppContext {
  store: ChatStore; memory: MemoryStore; sessions: SessionRegistry;
  onebot: OneBotClient; sender: SendQueue; stickers: StickerManager;
  orchestrator: AgentControlPort;   // S8 前是 Orchestrator（具体类）
  emit: AppEmit;                    // S6 前是 (type: string, payload: unknown) => void
  getConfig(): AppConfig; updateConfig(patch): AppConfig;
  launchSnowluma(): Promise<unknown>; stopSnowluma(): boolean; snowlumaStatus(): SnowlumaStatus;
  buildStatus(): Promise<unknown>; getSnowlumaLogs(): unknown[];
  openSnowlumaFolder(): Reply; openSnowlumaWebui(): Reply;
  buildUsageStats(...): Record<string, unknown>; buildUsageBreakdown(...): Record<string, unknown>;
  sanitizeConfig(config): unknown; applyConfigPatch(patch): AppConfig;
}
```

注意这一行两处都已被上一步替换：`orchestrator` 的类型（S8，见 §5.3）和 `emit` 的签名（S6，见 §4.2）。**`AppContext` 是"跨模块面"的事实清单**——S8 判断端口该收什么，靠的就是把 `ctx.orchestrator.X` 在整个 `src/web/` 与 `electron/` 里的出现点扫一遍（见 §5.3）。

`Orchestrator`（`src/agent/runtime/orchestrator.ts`）是薄门面：它自己几乎不做事，把调用转给 `WakeScheduler` / `HistoryCompactor` / `MemoryConsolidator` / `ProactiveController`（构造在 `:85-149`），并把这些子模块的状态 **getter 或字段直引** 暴露出去（`this.wakeTimers = this.scheduler.wakeTimers` 等，`:121-128`）。

### 5.2 仓库里只有三处字符串键分发，且全是外部契约

| 分发 | 位置 | 键来自 | 为什么必须保留 |
|---|---|---|---|
| 工具分发 | `src/agent/tools/shared.ts:739-777`（`selectTools` / `executeTool`） | **模型**选定的工具名 | 是 LLM 线协议；且 `tests/t-agent-structure.mjs` 锁死了工具名与顺序 |
| OneBot 动作 | `src/qq/onebot.ts:139` 的 `call(action, params)` | OneBot 协议 | 外部协议本身 |
| HTTP 路由 | `src/web/http/router.ts` 的 `matchRoute` / `dispatchRoute` | URL | 本身已经是**类型化**的 `Route[]` 表，无需改造 |

（`MemoryStore` 里的 category 字符串，如 `src/chat/memory.ts:235`/`:443`，是**数据键**不是分发，不在讨论范围。）

### 5.3 结论：端口（结构性接口），不是注册表（**S8 已落地**）

**"哪些核心方法允许注册"这个问题在本仓库的诚实答案是：不需要注册，只需要把跨模块入口固化成端口。**

今天全 `src/` 只有这一处 `implements`（S8 引入），类型基本是名义的，只有少数结构性形状（`OneBotSender` / `ChatStoreWriter` 在 `src/qq/sender.ts:11,16`；`ToolContext` / `ToolDefinition` 在 `src/agent/shared/types.ts:15,22`；`AgentRunnerHost` 在 `agent-runner.ts:37`；`WakeSchedulerDependencies` / `OrchestratorDependencies` 在 `shared/types.ts:74-83`）。把 `Orchestrator` 的对外面写成一个显式端口，正是延续这个既有姿势：

```ts
// src/agent/runtime/control-port.ts（S8 已落地的实际内容，此处略去注释）
export interface AgentControlPort {
  onIncoming(chatKey: string, entry: ChatMessage | null): void;
  forceWake(chatKey: string): boolean;
  markChatSeen(chatKey: string): number;
  chatState(chatKey: string): ChatRuntimeState | null;
  reloadWindow(chatKey: string): void;
  drainBacklogAfterResume(): void;
  compactChat(chatKey: string, options?: { force?: boolean }): Promise<CompactChatResult>;
  consolidateMemoryForChat(chatKey: string, options?: { userIds?: unknown[] | null; force?: boolean }): Promise<ConsolidateMemoryResult>;
  getChatName(groupId: string | number): Promise<string>;
  startProactiveLoop(): void; stopProactiveLoop(): void;
  startCompactLoop(): void; stopCompactLoop(): void;
  setPaused(paused: boolean, reason?: string): void;
  abortAll(): Promise<void>;
  statusSummary(): Record<string, unknown>;
  readonly paused: boolean;          // ← 设计稿漏了这 4 个，落地时才发现（见下）
  readonly pauseReason: string | null;
  readonly compacting: Set<string>;
  readonly consolidating: Set<string>;
}
// class Orchestrator implements AgentControlPort { … }   ← orchestrator.ts:37
```

**落地时与设计稿的三处出入**（都记在这里，别再照设计稿重推）：

1. **漏了 4 个只读状态字段**。设计稿只列了 16 个方法，但 `src/web/` 读 `paused` / `pauseReason` / `compacting` / `consolidating` 做展示（`routes/system.ts`、`routes/chats.ts`、`routes/memory.ts`），`electron/main.js` 也读 `paused`。不把它们写进端口，`AppContext.orchestrator` 就没法从具体类改成接口——端口会白建。写成 `readonly` 是**对读方的约束**（要改状态走 `setPaused` / `abortAll`）；`consolidating.add()/.delete()` 是 Set 内容操作，`readonly` 属性不拦它。
2. **`METHOD_CATALOG` 的键改成裸方法名**（`compactChat:` 而不是设计稿里的 `'orchestrator.compactChat':`）。因为要能用一个**从接口本身推导**的类型做键集约束：

   ```ts
   export type AgentControlMethod = {
     [K in keyof AgentControlPort]: AgentControlPort[K] extends (...args: never[]) => unknown ? K : never;
   }[keyof AgentControlPort];
   export const METHOD_CATALOG = { … } as const satisfies Record<AgentControlMethod, { owner: string; description: string }>;
   ```
   带点号的键没法这样约束。这个推导的失败模式是**响亮**的：漏登记一个方法、多写一个不存在的方法、或往端口加了方法却没更新表，`tsc` 当场报错（四个方向实测都会红，见 §9.5 第 12 项）。
3. **`compactChat` / `consolidateMemoryForChat` 的返回类型从 `unknown` 改成实名接口** `CompactChatResult` / `ConsolidateMemoryResult`。设计稿写 `unknown` 是为了留余地，但那样 `routes/chats.ts:17` 读 `.ok`、`routes/memory.ts:84` 展开结果时会立刻编译不过（实测：4 个既有错误）。按"类型只写事实"的既有口径，接口里只声明**读方真正读的字段**，实现返回更宽的对象不会报错。

配套那张只作文档/遥测用的常量表（**不参与运行时分发**）已落地，`owner` 写**实际实现该方法的下层模块**（Orchestrator 是薄门面，绝大多数方法只是转调），不是门面所在文件：

```ts
export const METHOD_CATALOG = {
  compactChat: { owner: 'src/agent/maintenance/history-compactor.ts', description: '压缩指定会话的历史（摘要入档 + 原文冷归档）' }
  // …共 16 项，测试断言每个 owner 都是仓库里真实存在的文件
} as const satisfies Record<AgentControlMethod, { owner: string; description: string }>;
```

**为什么这条约束不能只靠编译器**（S8 唯一的真陷阱）：`implements AgentControlPort` 是**唯一**把类和端口绑在一起的东西，而 **`orchestrator.ts:37` 那一行删掉之后不报任何错**——`AppContext.orchestrator` 仍是端口类型，真的 `Orchestrator` 结构上仍然满足它，`tsc` 全绿，端口就此静默退化成一份没人校验的注释（实测见 §9.5 第 12 项证伪 E-正）。所以 `tests/t-ports.mjs` 第 1 段必须**文本扫描**那一行。同一套件第 1b 段还要把"下面这份手工清单"与接口的实际成员对账——没有它的话，"往端口加一个没人用的成员"会全绿地溜过去（证伪 B）。

### 5.4 明确排除（连同理由，写进文档以免将来有人再提）

| 排除对象 | 理由 |
|---|---|
| 工具分发（`selectTools`/`executeTool`） | 键由模型选定，是线协议；注册化会破坏 `t-agent-structure.mjs` 锁定的工具名与顺序 |
| `OneBotClient.call` | OneBot 协议 |
| HTTP 路由 | 已经是类型化表，注册层只会重复它 |
| `MemoryStore` category 字符串 | 数据键，不是分发 |
| 业务方法的字符串注册 / 运行时热替换 | 路线图明令禁止；且与仓库的严格 TS 姿态相反 |

### 5.5 测试构造策略是硬约束

`t-orch.mjs:19-27` 与 `t-vision-log.mjs:38-46` 建的是**部分真实图**：真 `ChatStore` / `SessionRegistry` / `SendQueue` / `Orchestrator`，但 `onebot` / `memory` / `stickers` 用**普通对象字面量**充当（`t-orch.mjs:21-25`）。它们不是 `instanceof` 任何东西。

**所以注册层不得引入任何 `instanceof` 检查、`Symbol` 品牌或运行期校验。** 端口只用 `implements`（类）与 `satisfies`（假货）在编译期检查，运行期零成本。这条不是偏好——引入运行期校验会当场打碎这两个套件。

### 5.6 `emit` 兜底总线（**已删除**）

原先 `orchestrator.ts` 的构造函数里有这么一行：

```ts
this.emit = typeof emit === 'function' ? emit : ((bus) => bus.emit.bind(bus))(createEventBus());
```

生产路径上 `emit` 一定被传入，所以这行是死代码。**但 `tests/` 里 8 个 `new Orchestrator(...)` 全都不传 `emit`**，因此这行当时承担着让那些套件能跑起来的职责。

结论：**"生产死代码"不等于"可以删"。** 删除必须排在测试改造之后（S6 不删，S10d 再删）。

**S10+ 的实测细化（数字上修正了这一段的乐观程度）**：不传 `emit` 的构造点一共 **8 个**（`t-orch.mjs` 5 处、`t-orch2.mjs:24`、`t-panel.mjs:59`、`t-ports.mjs:126`）。原先估计"只有 `t-panel.mjs:59` 会真的红"，**实测偏乐观**：`t-orch.mjs` 的实例在第一条 `orc.scheduleWake(key)`（`:39`）就走进 `WakeScheduler` 的 `emit`，报 `TypeError: this.emit is not a function` —— 也就是说这批实例**一旦被使用就会炸**，不是"删掉也全绿"。真正**纯静默**的是 `t-ports.mjs:126` 自己那一个：它只做 `typeof orc[n] === 'function'` 检查和 4 个只读字段的形状检查，从不调用会 `emit` 的方法，**没有守护它就全绿**（证伪探针 P5 实测：撤回它的 `emit` 之后 11 条断言里只有 1c 那条红，其余 10 条全绿）。

而 `tsconfig.json` 显式排除了 `tests/`，`.mjs` 永远不受 `tsc` 管。所以"忘改其中一个调用点"是**纯静默失效**，S10d 的守护是 `tests/t-ports.mjs` 第 1c 段：逐个 `new Orchestrator(\s*{` 取实参对象（花括号配对，跳过字符串字面量），断言里面必有 `emit`。另有一条源码文本断言钉住 `orchestrator.ts` 不再引用 `createEventBus`（总线本体保留在 `core/util.ts`，`app.ts` 照旧用它——路线图禁替换总线，删的只是这一处兜底）。

**落地形态（S10d）**：`OrchestratorDependencies.emit` 从 `emit?: AppEmit | null` 改成 **`emit: AppEmit`**（`src/agent/shared/types.ts`），构造函数签名去掉 `= null` 默认值，赋值行变成 `this.emit = emit;`，`createEventBus` 的 import 删除。**`src/` 侧因此受编译期管**（漏传直接 `tsc` 报错，实测探针 P4：只把类型退回可选、不动实现，`tsc` 立刻失败）；`tests/` 侧只能靠上面那条文本扫描。

## 6. 设计 C：长期任务注册表（回答 Q4）

### 6.1 分界线：什么算长期任务

`grep -rn "setInterval\|setTimeout" src/ electron/` 命中 37 行，其中 11 行是类型声明（如 `timer: ReturnType<typeof setTimeout> | null`，见 `proactive-controller.ts:16`、`history-compactor.ts:23`、`jmcomic.ts:101-102`/`255-256`、`wake-scheduler.ts:48`、`orchestrator.ts:45`/`:150`/`:154`）或 getter，**真正的调度调用点 26 处**（`src/` 25 处 + `electron/main.js:131`）。其中只有 **9 处属于 6 个长期任务**，其余 **17 处**是请求作用域局部计时器（完整清单见附录 B）。

> **⚠️ S11d 之后："17 处局部计时器"变成 16 处**——`core/config.ts` 的 `scheduleConfigSave` 被删（它是零调用者的死代码，见附录 C）。**长期任务的 9 处一点没动**，所以上面那个 26 也随之变成 25。附录 B 的表与脚注已同步。

> **⚠️ 计数更正（S9 落地时发现）**：本节与附录 B 原先写的"7 个长期任务"是**照 §6.3 的表行数数出来的**，而那张表的第 7 行 `wake.debounce` 自己标着"**排除**（算局部计时器）"——真任务是 **6 个**（9 个调度点 = 冒泡 2 + 压缩 2 + 价格 1 + jmcomic 2 + 重连 2）。`wake.debounce` 按本节的分界线是局部计时器，落地时它**不是表的一行**，而是 `tests/t-tasks.mjs` 的**反向断言目标**（见 §9.3）。附录 B 已同步。

分界线定义：**生命周期是否长于一次请求或一次会话**。局部计时器（LLM 超时、重试退避、限速等待、DNS 超时、启动期端口轮询、单次扫图 flush 等）明确排除在注册层之外——这是路线图 `需要覆盖的对象` 一节的最后一条要求。

### 6.2 描述符形态（**S9 已落地**，与实际形态的差异见下）

设计稿建议的形态：

```ts
// 建议：类型放 core（人人可引用）；具体任务表放 web（组装根，因为它引用所有领域）。
export interface LongTermTask {
  id: string; owner: string; label: string;
  configRefresh: 'each-tick' | 'on-apply';
  unref: boolean; holdsProcessWhilePending?: boolean;
  enabledBy(cfg: AppConfig): boolean; start(): void; stop(): void; isRunning(): boolean;
  conformance: 'full' | 'partial' | 'none';
}
```

**落地形态**（`src/web/runtime/tasks.ts`，6 行）：

```ts
export interface TaskEntry { on: 'Orchestrator' | 'OneBotClient' | 'price-feed' | 'jmcomic'; kind: 'method' | 'export'; name: string }
export interface TaskEnablement { path: string; kind: 'boolean' | 'non-empty' }   // enabledBy 数据化
export interface LongTermTask {
  id: string; owner: string; label: string;
  enabledBy: TaskEnablement | null;
  configRefresh: 'each-tick' | 'on-apply' | 'not-applicable';
  unref: boolean; holdsProcessWhilePending?: boolean;
  start: TaskEntry | null;              // null = 没有独立入口，只能靠构造函数副作用启动
  stop: TaskEntry | null;               // null = 没有任何停止入口
  stopCancelsPending: boolean;          // 设计稿没有这个字段（区分 partial 的两种成因）
  conformance: 'full' | 'partial' | 'none';
  note: string;                         // 必须写明"为什么只能是这个 conformance"
}
export const LONG_TERM_TASKS: LongTermTask[] = [ /* 6 行 */ ];
```

四处与设计稿的差异，都是落地时才暴露的：

1. **`start` / `stop` 存的是入口的*名字*，不是函数引用。** 两个理由：① 6 行里有 4 行**根本没有可引用的 start/stop**（见 §6.4），函数引用只能用占位符撒谎；② 存函数引用时，"断言表与现实一致"会退化成"断言我写进去的函数是个函数"——**自己验自己**。存名字之后，`tests/t-tasks.mjs` 能拿名字到真对象 / 真模块上解析，表就没法撒谎。
2. **类型与表都在 `src/web/runtime/tasks.ts`，没有拆到 `core`。** 设计稿"表放 web 因为它引用所有领域"的理由在落地形态下不成立——纯数据表**零 import**。此时把类型放 `core` 只会造出一个只有 `web` 一个消费者的公共类型。将来若真有下层模块要自述（如 `price-feed` 自己声明描述符），再把类型搬到 `core`，搬之前不必付这个成本。
3. **`enabledBy` 从函数改成 `{ path, kind }` 数据**：套件可以拿 `path` 到真实配置里取值，核对它存在、且类型与 `kind` 相符。函数形式没法机检（总不能为了断言去调它）。
4. **新增 `stopCancelsPending`**：`partial` 有两种成因——没有 stop（`price.feed`），和 **stop 在但取消不掉已经在等待中的那一次**（`onebot.reconnect` 在 S10c 之前就是这样：`close()` 只置 `#closedByUs`，两处重连 `setTimeout` 句柄没存）。没有这个字段，后者只能靠 `note` 口头说明，而 `conformance` 是套件要按规则验的。**S10c 之后，"取消不掉等待中的那一次"这一种成因在表里已经绝迹**（`onebot.reconnect` → `full`），剩下的唯一一个 `partial` 是另一种意义上的"停不掉"：`jmcomic.worker` 停不掉**正在执行**的那一次下载——`stopCancelsPending` 回答不了那个问题，所以它写在 `note` 里、并在 §6.3 的 `conformance` 列如实标注。

两个设计决定不变（落地时严格遵守）：

1. **表是纯数据，不触发 start/stop。** 这样新增的套件能断言"表与现实一致"而**不改变运行行为**——否则一张会在 import 时拉起任务表就是新的副作用源。`tests/t-tasks.mjs` 有一条断言扫 `tasks.ts` 自身，确保它里面没有调度调用、也没调用任何一个启动函数。
2. **绝不包装 `setTimeout` / `setInterval` 全局。** 那样会静默吞掉 §6.1 排除掉的那 17 个局部计时器，把"排除清单"变成谎言。这条要作为**反模式**明确写进文档。

#### 6.2.1 描述侧与执行侧的分工（**S11c 已落地**）

S9 交付的是**描述侧**：`LONG_TERM_TASKS` 回答"有哪些长期任务、谁开谁停、`conformance` 是什么"。它**不回答"谁按什么顺序把它们装起来"**——那一半在 S9 之后仍散落在 `app.start()` / `app.stop()` 的六对硬编码调用里，而那种写法**删一行、加一行、调换两行都不会有任何编译错误**（S10a–c 每步都在这个形态上加东西，越加越难核对）。

S11c 补上**执行侧**：`src/web/runtime/lifecycle.ts` 的 `LIFECYCLE`。两者是互补的，不是重复的：

| | `web/runtime/tasks.ts`（描述侧） | `web/runtime/lifecycle.ts`（执行侧） |
|---|---|---|
| 回答 | 有哪些任务、谁开谁停、`conformance` | **谁按什么顺序**装起来、拆下来 |
| 形态 | 纯数据表；入口存**名字** | 有序数组；`start`/`stop` 存**函数引用** |
| 谁读它 | 只有 `tests/t-tasks.mjs` | `app.start()` / `app.stop()`（经 `startLifecycle`/`stopLifecycle`） |
| 守卫 | `tests/t-tasks.mjs` | `tests/t-lifecycle.mjs` 第 2/3 段 |

三点值得记下：

1. **两边各写一份 id 字面量，靠套件对账。** `lifecycle.ts` **不 import `tasks.ts`**——一旦 import，运行期就多了一层"读表才知道装什么"的间接，而那正是被禁的注册表形态（`t-tasks.mjs` 另有一条"`src/` 除定义处外无人引用 `LONG_TERM_TASKS`"的断言）。对账落在 `tests/t-lifecycle.mjs` 第 2 段：两边 id 集合必须相等、无重复、每个 id 恰好被一条 entry 覆盖。**因此"表里加一行"从 S11c 起是一个要动两处的动作**，只改一处会被套件拦下。
2. **一个 entry 可以覆盖多个 id，反过来不行。** `jmcomic.cleanup` 与 `jmcomic.worker` 合成**一条** entry：清理定时器与 worker 由同一次 `initJmcomicQueue` 拉起，拆成两条会把同一个入口调两遍。**注意这里的理由（S11c 实测更正）**：规划时写的"拆开会造出两个 interval、`t-timers.mjs` 的'恰好 2'当场红"**是错的**——`startCleanupTimer()` 有 `if (cleanupTimer) return;` 的护栏（`media/jmcomic.ts:151`），`runWorker` 也有单 worker 护栏，实测把 entry 拆成两条后 `t-timers.mjs` **41 条断言全绿**。真正拦下它的是本步新加的登记式断言（它能看见 `jmcomic.initialize` 跑了两次），而不是计时器套件。合并依然是对的形态——理由是"一条 entry 代表一次真实的装配动作"，只是这个理由**不能用行为故障来背书**。
3. **执行清单不参与配置刷新。** `applyConfigPatch` 那条路径**不接清单**：当前 8 条 entry 里有 5 条是 `ALWAYS`，走清单会误调 `onebot.connect()`（重连整条链路）、`initJmcomicQueue()` 与转写启动检查，以及搜图 worker 的预热（它有 `imageSource.enabled` 闸门兜着，但配置保存本来只该刷新真正支持热刷新的能力）。理由写在 `lifecycle.ts` 头部。


### 6.3 任务映射表（**S9 已落地为 `LONG_TERM_TASKS`**）

`conformance` 列是本文最重要的产出之一——它如实标注了"今天能不能被真正接管"。**下表是 S9 清点（+ 视频转写）时的快照，不是当前任务清单**：S9 清点时有 6 个任务，视频转写接入后新增 `transcription.worker`，所以表里 8 行中有 7 行是任务，最后一行 `wake.debounce` 是清点时的"排除"写法，落地表里没有它（它是 `tests/t-tasks.mjs` 的反向断言目标，见 §9.3）。**此后新增的任务（`hot-search.daily-broadcast`、`image-source.pic-worker`）不往这张表里加行**——它们的形态与"一行一个计时器"不匹配（前者由 `node-cron` 持句柄，后者持有的是**子进程**而非计时器）；当前任务数与 `conformance` 分布看**附录 B 末尾的增量说明**（当前 9 行，只有 `jmcomic.worker` 是 `partial`）。

| id | 归属 / 位置 | 开关来源 | 配置刷新 | unref | 今天的停止入口 | conformance |
|---|---|---|---|---|---|---|
| `proactive.bubble` | `ProactiveController`（`agent/maintenance/proactive-controller.ts`），owner = `Orchestrator.proactive` | `proactive.enabled`（`app.ts:851` / `:708`） | `each-tick`（`:23` 每 tick `getConfig()`） | **否**（`:28`/`:37` 无 `.unref?.()`） | `stop()`（`:40-43`）/ `abortAll` | **full** |
| `compact.sweep` | `HistoryCompactor`（`agent/maintenance/history-compactor.ts`），owner = `Orchestrator.historyCompactor` | `compact.enabled`（`app.ts:853` / `:709`） | `each-tick`（`:30`） | 是（`:33`/`:38` 有 `.unref?.()`） | `stopCompactLoop()`（`:41-44`）/ `abortAll` | **full** |
| `price.feed` | 模块级单例（`llm/price-feed.ts`） | `api.priceRemoteUrl` 非空 | `on-apply`（`initPriceFeed` 在 `app.start()` 与 `applyConfigPatch` 里被调用；**S10a 修掉了"同 URL 早退却已清掉 timer"那个静默停摆**） | 是（`:218`） | **`stopPriceFeed()`**（S10a 新增，接线进 `app.stop()`） | **full**（S10a 起） |
| `jmcomic.cleanup` | 模块级（`media/jmcomic.ts`） | 无条件（随 `app.start()`） | 不适用 | 是（`:156`） | **`stopJmcomicQueue()`**（S10b 新增，接线进 `app.stop()`） | **full**（S10b 起） |
| `jmcomic.worker` | 模块级（`media/jmcomic.ts`） | 隐式（有待办即跑） | 不适用 | **有待办时否**（`:405` 无 unref） | **`stopJmcomicQueue()`**（同上） | **partial**（S10b 起：停得掉"下一次唤醒"，停不掉**正在跑**的那一次下载） |
| `transcription.worker` | `VideoTranscriptionQueue`（`media/video-transcription.ts`） | 无条件装配；入队时检查 `transcription.enabled` 与云配置 | 每次入队重读配置 | 有待办时否 | `stop()`（清 wake、取消当前任务并等待收尾） | **full** |
| `onebot.reconnect` | `OneBotClient`（`qq/onebot.ts`） | 无条件（连接断开即重连） | 不适用（改 URL 需重连） | 等待期间否（`#scheduleReconnect` 里**刻意不 unref**） | `close()`（置 `#closedByUs` + `#cancelReconnect()`）；**S10c 起 `#reconnectTimer` 存了句柄，取消得掉待触发的那一次** | **full**（S10c 起） |
| `wake.debounce` | `WakeScheduler.wakeTimers`（`agent/runtime/wake-scheduler.ts:48`） | 每条消息 | 不适用 | 不适用 | 按会话清理 + `abortPending()` | **排除**（算局部计时器） |

细节补充：

- **`proactive.bubble` 未 unref 是否故意？** 今天没有注释说明。`HistoryCompactor` 那边有明确注释（`orchestrator.ts:263-264`：`区别：补上了 unref()（姿态同 price-feed.js）—— 巡检是纯维护任务`），说明"不 unref"是有意识的选择而非疏忽，但**为什么冒泡要钉住进程**没有写下来。列入 §10 待定 5——改动它会改变进程退出语义，必须先定性再动手。
- ~~**`jmcomic.cleanup` / `jmcomic.worker` 的启动是构造函数副作用**~~ **S10b 已改掉**：原先 `Orchestrator` 构造时调 `initJmcomicQueue`（`orchestrator.ts:75`），后者做四件事（`jmcomic.ts:436-441`）：绑定运行时、`loadJobs()`、`startCleanupTimer()`、`void runWorker()`；`startCleanupTimer`（`:152-157`）首次还会立刻跑一次清理。现在调用点搬到了 `app.start()`，与 `initPriceFeed` 并列；`app.stop()` 里在 `onebot.close()` **之前**调 `stopJmcomicQueue()`。**当时 `conformance: 'none'` 的含义就是"没有任何停止入口，也没有'注册'的概念"**——两步都已补上。
- **`stopJmcomicQueue()` 的三处语义**（S10b 落地，都是有意选的）：① **只置空 `runtime`，不新增 `stopped` 标志位** —— `runtime` 早就是"队列挂在活着的 app 上"的既有语义，用标志位会让 stop 之后的一次 `enqueueJmcomicDownload` "只入库不干活"（工具回复"已加入队列"而队列永远不动）；置空 runtime 保留了既有不变量：再来一次 enqueue 会重新拉起队列。代价是"stop 可被一次 enqueue 撤销"——而 stop 只在退出路径上调用，那时 `abortAll()` 已跑完、不会再产生新的模型轮次。② **不清 `jobs`**：队列是持久化的，清了会丢用户已提交的下载任务。③ **不中断正在跑的那一次下载**：Python 子进程句柄是 `runPython` 的 promise 局部变量，模块外拿不到；`runtime` 置空后那次下载的收尾会退化成空操作（各处都是 `runtime?.`），结果不会发出去 —— 这就是 `jmcomic.worker` 只能标 `partial` 的原因。
- **`scheduleNextWake()` 开头那句 `if (!runtime) return` 是"停得住"的关键**（S10b）：`runWorker` 的 `finally` 会无条件调它，所以"下载途中停队列"时它本来会立刻排一个新 wake timer **把队列自己复活**。`tests/t-timers.mjs` 第 2 段真跑一次 worker（stub 的 `onebot.call` 一被调到就停队列再抛错）来钉这条。同一段里 `while (runtime && (job = nextRunnableJob()))` 的 `runtime &&` 是**第二道闸门，但它没有守护**（实测：删掉它套件全绿，见 §9.5 第 15 项）——要观察到差别需要夹具里同时有可跑的 A（在它的上传回调里停队列）与可跑的 B，而 B 会过继给后面的真起 app 段去碰真 onebot。
- **`jmcomic.worker` 的未 unref 已定性（S10b）：是刻意的**（"有待办时别让进程退出，否则任务丢失"）。本步**不动 unref 策略**，补上的是它缺的另一半——stop 之后不再排新 wake。§10 待定 6 由此关闭。
- **⚠️ `price.feed` 那个"同 URL 早退"是个真 bug，S10a 才修**。原实现（`price-feed.ts:184`）是**先无条件 `clearInterval` 再判早退**：`if (timer) { clearInterval(timer); timer = null; }` 在前，`if (status.url === url && status.enabled) return;` 在后。于是**第二次带着同一个 URL 调用它**（`applyConfigPatch` → `initPriceFeed`，**任何一次 UI 保存配置都会走到**）会清掉定时器然后直接 return，**不重建** → 小时级刷新从此永久停摆，而状态页只看得到一个越来越旧的 `fetchedAt`，没有任何报错。S9 的 `conformance: 'partial'` 与那句"配置保存时重新 init 会先清掉旧 timer，所以**能换 URL**"其实描述的就是这个 bug 的一面。修法是**把清理挪到早退之后**（`stopPriceFeed()` 承担清理），早退条件再显式带上 `&& timer`（表达"enabled ⟺ 定时器活着"这条不变量）。教训与 §9.5 第 12 项同源：**"形状看着对"的代码会瞒过所有人**——早退看着像幂等，实际是停摆。
- **`onebot.reconnect`（S10c 已接管）**：原先 `connect()` 置 `#closedByUs = false` 后进循环，两处重连调度都是**裸 `setTimeout`，句柄没存**。设计稿当时把后果写成"`close()` 取消不掉已经在等待中的那一次"——**那只是表症，实测把这个病看得更清楚**：① 句柄没存也没 unref，那个定时器会**把事件循环钉住最多 `RECONNECT_MIN_MS`**（影响退出语义）；② 更要紧的是 `connect()` / `reconnect()` 也清不掉它 —— 迟到的定时器会再进 `#connectLoop` **建第二个 WebSocket 覆盖 `this.socket`**，而调用方刚作废旧 socket 的动作反而被漏掉，那个 socket 从此再也没人关（**连接泄漏**，`reconnect()` 原有的注释描述的正是这个病的另一面）。S10c 的落地形态：新增私有字段 `#reconnectTimer:55`（**非 null ⟺ 有一次重连排定待触发**，回调里先置 null 再进循环）、`#scheduleReconnect():74`（**先清旧、再存新**）、`#cancelReconnect():83`；两处排定（`:126` 建 socket 失败、`:155` close 事件）改为调 `#scheduleReconnect()`；`close():167` / `connect():90` / `reconnect():99` 三处都调 `#cancelReconnect()`。**刻意不 unref**——保留"有重连待办时钉住进程"的语义。`#connectLoop:115` 的 `#closedByUs` 早退**保留**，但它现在只是**第二道闸门**（第一道是"根本不再排定"），注释已写明。`RECONNECT_MIN_MS = 3000`（`:14`）仍是硬编码，这是**有意选择**：本机回环上 3s 常量足够，做指数退避会改掉重连的可观察行为（现有断言只钉首跳，退避的后半段无人测）。原先并列的 `RECONNECT_MAX_MS = 30000`（`:15`）**零引用**，**S11b 已删**（附录 C），原位留两行注释说明为什么不做退避——死常量留着会让人以为重连有上限。
- **⚠️ 上表的行号是清点时的快照**，S3–S8 的改动让一部分漂移了（`wake-scheduler.ts`、`history-compactor.ts`、`app.ts`、`vision-scan.ts`、`routes/chats.ts` 等；完整对照表见附录 B 的说明）。**稳定的键是 `owner` 与 `id`，不是行号**；查证时按内容找，别按行号跳。
- **落地形态**：S9 的 `LONG_TERM_TASKS` 原为 6 行，视频转写接入后为 7 行（上表除 `wake.debounce` 外全部落在表里；**今天 9 行**——又接入 `hot-search.daily-broadcast` 与 `image-source.pic-worker`，见附录 B 末尾的增量说明）。`owner` 写**实际持有计时器的模块**，不是 `Orchestrator` 这个门面（同 `METHOD_CATALOG` 的写法：`startProactiveLoop` 只是转调 `ProactiveController`）。`conformance` 的判定规则（`full ⇒ start && stop && stopCancelsPending`；`partial ⇒ (start && !stop) || (stop && !stopCancelsPending)`；`none ⇒ !start`）写在 `tasks.ts` 头部注释里，`tests/t-tasks.mjs` 按**同一条规则**断言——改规则要同时改两处。

### 6.4 列得出但接管不了的，登记为后续工作

以下四项**必须**先改启动/退出/配置刷新流程才能被真正接管，而那是 S9 及之前的禁止项。所以它们在文档里只作为**后续工作清单**存在，不得写成"已具备的能力"。S10+ 解禁后逐项落地（**S10a 已收下第 1 项，S10b 已收下第 2 项，S10c 已收下第 3 项的前半**）：

1. ✅ **S10a 已完成** —— `price.feed` 需要新增 `export function stopPriceFeed()`，并在 `app.stop()` 里调用。实际落地：`stopPriceFeed()` 清定时器 + 置 `status.enabled = false`（保留 `url` 与最后一次快照）；`app.start()` 里 `initPriceFeed(...)`、`app.stop()` 里在 `abortAll()` 之后、`onebot.close()` 之前 `stopPriceFeed()`。
2. ✅ **S10b 已完成** —— 新增 `export function stopJmcomicQueue()`（置空 `runtime` + 清 `cleanupTimer` / `wakeTimer`，**不清 `jobs`**），`initJmcomicQueue` 从 `Orchestrator` 构造函数搬到 `app.start()`、`stopJmcomicQueue()` 接线进 `app.stop()`（在 `onebot.close()` 之前）；补上 `scheduleNextWake()` 的 `!runtime` 早退与 `runWorker` 的 `while (runtime && …)`。`jmcomic.cleanup` → `full`，`jmcomic.worker` → `partial`（停不掉正在跑的那一次下载）。worker 的 unref 策略**已定性为刻意保持**（§6.3 细节补充）。
3. ✅ **前半项 S10c 已完成** —— `onebot.ts` 新增 `#reconnectTimer` / `#scheduleReconnect()` / `#cancelReconnect()`，两处排定改走它、`close()`/`connect()`/`reconnect()` 三处都取消待触发的那一次；`onebot.reconnect` → `full`（顺带修掉 `connect()`/`reconnect()` 的**连接泄漏**路径，实证比设计稿写的更值：§6.3 细节）。✅ **后半项 S11b 已完成** —— `OneBotClient.applyEndpoint(next)` 比较四个端点字段（`undefined` = 不碰、别的值走与构造函数同一份归一化、返回 `true ⟺ 有字段真的变了`），`applyConfigPatch` 在该值为真时 `onebot.reconnect()`；`start()` 的端点覆写也改走它，于是实例端点字段只剩一个写入口（`applyTokens` 是 401 轮换路径上的刻意例外）。**语义上仍是 §7.3 那一行，但缺口已关闭**——详见 §7.3 与 §8.2。
4. `proactive.bubble` 的 unref 策略需要定性。（**本阶段不做**，保持 §10 待定 5）

**S9 落地时这四项逐条写进了对应行的 `note`**（"接管它需要做什么"），并由套件反向钉住其中两条："`price.feed` 标 partial 是因为没有 `stopPriceFeed`"与"两个 jmcomic 标 none 是因为没有 `stopJmcomicQueue`"是**实名双向断言**——将来真补上了这两个导出，断言会变红，提醒把 `conformance` 一起升级，而不是留着一份过期的标注。**S10a 已经吃过这条设计的一次红利**：补上导出后 `tests/t-tasks.mjs` 的第 ⑦ 段当场变红，逼着把 `conformance` 从 `partial` 升到 `full`（见 §9.5 第 14 项）。

## 7. 生命周期语义（回答 Q5）

### 7.1 注册顺序

今天的"注册"是**构造顺序**，事实依据是 `createApp()` 与 `app.start()`（行号随 web 模块整理而变，见 §7.6 的位置对账）：

```
createApp()
  ├─ config / 事件总线 / SSE 客户端集合
  ├─ 【模块加载期副作用】src/web/app.ts 顶部的 top-level await（undici dispatcher）
  ├─ createSnowlumaController()  ← web/onebot/snowluma.ts（只建状态，不拉子进程）
  ├─ ChatStore → MemoryStore → SessionRegistry
  ├─ OneBotClient（带 onEvent 回调 → 转发给 ingest.handle）
  ├─ StickerManager（带 onChange 回调）
  ├─ SendQueue
  ├─ Orchestrator  ← 【S10b 起构造期不再有副作用；原先在这里触发 jmcomic 队列】
  ├─ onebot.onStatus(...) 状态监听
  ├─ createTokenBridge() + watch()
  └─ createIngest()  ← web/onebot/ingest.ts（只建状态，入站其实由 onEvent 驱动）

start()
  ├─ 端口扫描（basePort 起 +10 逐个试）
  ├─ 可选拉起 SnowLuma 子进程并轮询端口（最多 20s）
  ├─ 从 SnowLuma 配置同步令牌
  └─ await startLifecycle(deps)   ← 【S11c 起这六行收进 `web/runtime/lifecycle.ts` 的清单】
       onebot.connect() → 按开关 startProactiveLoop / startCompactLoop
       → initPriceFeed() → initJmcomicQueue() → transcription.start()

stop()
  ├─ await orchestrator.abortAll()          ← 不在清单里：它管的是中止在跑的会话
  ├─ await stopLifecycle(deps)              ← 清单**逆序**：转写 → jmcomic → 价格表 → 压缩 → 冒泡 → **onebot.close()**
  ├─ server.close()
  └─ stopSnowluma()
```

**S11c 之后，"长期任务在 `app.start()` 启动、在 `app.stop()` 停止"从约定变成结构性质**：启动点只剩 `startLifecycle()` 一处（清单顺序），停止点只剩 `stopLifecycle()` 一处（清单逆序），`app.ts` 自己不再出现任何一个任务入口的调用——`tests/t-lifecycle.mjs` 第 3 段会扫这两段函数体钉住它。

**逆序带来两条自动成立的顺序约束**（原先靠注释和记性）：

- 设计稿 §7.4 的"关停顺序 = 启动顺序的逆序"；
- "停长期任务必须排在 `onebot.close()` 之前"——`onebot.reconnect` 排在清单**第一位**，逆序之后 `onebot.close()` 就是**最后一个**被调的。

**与 S11c 之前唯一的顺序差异**：原先 `stopPriceFeed()` 在 `stopJmcomicQueue()` 之前，逆序后调换。两者互不依赖，属**可观察但良性**的变化（已记入 §8.2 与真机冒烟清单）。

**构造期副作用：只剩一处**（undici dispatcher 的 top-level await）——它是模块 import 就产生全局效果的那类。jmcomic 队列原先也在这里（S10b 已搬走）。设计文档要求：**任何未来接入注册层的任务，都不得通过模块加载或构造函数副作用启动**，必须在 `start()` 里显式注册。这条原先解释了为什么 jmcomic 两项是 `conformance: 'none'`；S10b 之后它已经是**现行规则**，不再是缺口。

**S10a/S10b 的落地把这条要求变成了规则**：`initPriceFeed` 原先在 `createApp()` 里启动（**它不违规**——`createApp` 是显式调用而非 import 副作用——但它违背了"启动点只有一个"这个更省事的口径），`initJmcomicQueue` 原先在 `Orchestrator` 构造函数里（**这是真违规**）。现在两者都与 proactive / compact 并列落在 `start()`。于是规则可以写成一句话：**长期任务在 `app.start()` 启动、在 `app.stop()` 停止**。安全性依据：`createApp()` 的 5 个调用点（`web/server.ts`、`electron/main.js`、`t-smoke`/`t-admin`/`t-panel`/`t-window-http`）全部在紧接着的下一行调 `start()`，所以搬动不改变任何真实路径的行为；唯一差别是 `start()` 中途失败（端口占用等）时这些任务不再启动——这是**要的**。

### 7.2 异常隔离

- **事件总线已经隔离了**：`core/util.ts:174-176` 逐个监听器 `try/catch`，单个出错只打日志，不影响其他监听器与生产者。这条要保留。
- **任务的 tick 也各自 catch**：`proactive-controller.ts:28`/`:37` 用 `tick().catch(() => {})`；`history-compactor.ts:32`/`:37` 同；`price-feed.ts:211`/`:216` 全链 `.catch(() => {})`，并在 `:195-197` 注释里写明"这个模块绝不允许以任何方式影响主程序"。
- **缺口**：`onebot.ts:113` 的 `this.onEvent(event)` 有 try/catch，但 `:111` 的 JSON 解析失败是静默 return（§2.1）。异常"不炸"做到了，"看得见"没做到。

### 7.3 配置刷新语义

`applyConfigPatch`（`app.ts:677-696`）是配置生效的唯一出口，**S11b 起**重应用 **5 件事**：

```ts
updateConfig(patch); store.setMaxPerChat(...);
if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
if (next.compact?.enabled) orchestrator.startCompactLoop(); else orchestrator.stopCompactLoop();
initPriceFeed(next.api?.priceRemoteUrl || '');
if (onebot.applyEndpoint({ wsUrl, httpUrl, accessToken, httpToken })) onebot.reconnect();  // ← S11b
emit(EVENTS.configApplied, { configUpdated: true });
```

**已知缺口（设计要正面回答，不能只描述现状）**：

| 缺口 | 后果 |
|---|---|
| ~~`snowluma.wsUrl` / `httpUrl` / `token` 变更**不触发重连**~~ ✅ **S11b 已关闭** | 曾经改了地址必须重启应用；现在 `applyEndpoint` 比较四个字段，**真的变了才** `reconnect()`（见下） |
| `server.port` 变更 | 需重启（端口在 `start()` 里已绑定） |
| 长期任务间隔多为硬编码（price-feed 的 `TICK_MS`、jmcomic 的 `CACHE_CLEANUP_CHECK_MS`、onebot 的 `RECONNECT_MIN_MS`） | 只有冒泡与压缩读配置（`proactive.checkIntervalMin/MaxMs`、`compact.checkIntervalMs`） |

设计上的取向：**任务的 `configRefresh` 字段就是为回答这个问题而存在的**——`each-tick` 的任务（冒泡、压缩）天然支持热改；`on-apply` 的任务（价格表）靠 `applyConfigPatch` 重建定时器；jmcomic 与 onebot 重连与配置无关（`not-applicable`）。除 `server.port` 与硬编码间隔外，**缺口已在 S11b 收口**。

**S11b 的比较语义**（写这段是为了让后来者别把它退化成"每次保存都断连"）：`applyEndpoint(next)` 的规则有三条，全部有断言——

1. `undefined` = **不碰这个字段**（所以 `applyConfigPatch` 只传 `next.snowluma` 里真实存在的键时不会误清）；
2. 其余值走**与构造函数同一份**归一化（`normalizeWsUrl` / `normalizeHttpUrl`，`onebot.ts:25-26`）。共用不是为了少写两行：只要归一化规则在比较的那一侧另写一份，`http://127.0.0.1:3000/` 与 `http://127.0.0.1:3000` 就会被判成变更，**用户每保存一次设置就断一次连接**；
3. 返回 `true ⟺ 四个字段里至少一个真的变了` —— `applyConfigPatch` **只在这个值为真时**才 `reconnect()`。

**`''` 的语义按字段分开，这是对最初方案的一处有意偏离**：方案原文写的是"四个字段一视同仁，`''` = 真的清空"。实测 `ui/js/views/settings/save.js:276` 会把用户清空的 wsUrl **原样存成 `''`**（不会被钳到默认值），照方案实现就会让 `onebot.wsUrl = ''` → `new WebSocket('')` 抛错 → 落进 3s 重连循环里空转。所以落地形态是**沿用构造函数的逐字段强制**：空 URL 回落默认值（构造函数本来就表示不了"空地址"），空 token 是真的清空（清掉 token 是有意义的操作）。这样启动与配置刷新两条路径的端点语义完全对称。

`applyEndpoint` **只改实例字段：不重连、不发事件、不动已建的 socket**（`t-timers.mjs` 第 5 段有一条单元断言钉死"调它不会建 socket"）——重连是调用方的决定。唯一不走它的是 `applyTokens`（`:348-356`，401 轮换路径上必须先写 token 再无条件重连），**刻意保留并已注明**。

### 7.4 关闭顺序与退出语义

`app.stop()`（`app.ts:841-857`）：

```
orchestrator.abortAll()   → 清 wake.debounce / proactive / compact
stopLifecycle()           → 【S11c】清单**逆序**遍历：jmcomic → 价格表 → 压缩 → 冒泡 → onebot.close()
                              （逐个 `await`，且**不按 `enabled` 过滤**——启动时开着、退出时配置已被改关的
                                任务仍然活着，用当前配置去判要不要停会把它漏在后台）
server.close()
stopSnowluma()
```

**`abortAll()` 刻意不进清单**：它的主职责是中止**在跑的会话**，不是任务启停。代价是 proactive / compact 会被停两次（`abortAll()` 一次、清单一次）——两者的 stop 都是幂等的（只清句柄置 `null`），S11c 落地时逐条核过，`app.ts` 的注释也写明了。

**不在 `stop()` 里的**：**S10c 之后一个都没有了**。`price.feed` 自 **S10a 起**、两个 jmcomic 任务自 **S10b 起**、`onebot.reconnect` 自 **S10c 起**都在 `stop()` 里；前两组都排在 `onebot.close()` 之前，而 `onebot.reconnect` 的停止入口**就是** `onebot.close()` 本身（它的 owner 与宿主同一个对象）。jmcomic cleanup 已 unref，所以"没 stop"不会阻止进程退出；jmcomic worker 有待办、onebot 有重连待办时会钉住进程——前者在 §10 待定 6 里已定性（刻意保持），后者是 S10c 有意保留的语义（不 unref）。

**S10a 定的停止顺序**（后续步骤沿用）：`await abortAll()` → 各长期任务的 `stop*()` → `onebot.close()` → `server.close()` → `stopSnowluma()`。**任务必须在 `onebot.close()` 之前停**：jmcomic worker 的上传阶段要调 `onebot.call(...)`，先关传输会把在途上传打断成半死状态。**S11c 起这条不再靠人记**：清单第一位是 `onebot.reconnect`（其停止入口就是 `onebot.close()`），逆序遍历让它成为**最后一个**被调的——`tests/t-lifecycle.mjs` 第 3 段有一条断言直接钉"`onebot.close()` 是逆序里最后一个"。

进程入口与退出：

- Electron：`electron/main.js` 单实例锁 → `whenReady` → 动态 import `dist/web/app.js` → `createApp()` → `start()` → 建窗 → 托盘；`before-quit` → **等 `stop()` 落地** → 再 `app.quit()` 放行（**S11e**，见下）。
- 无头：`src/web/server.ts` 经 `createShutdown()`（**S11a 新增 `src/web/runtime/shutdown.ts`**）同时处理 **`SIGINT` 与 `SIGTERM`**，另有 `unhandledRejection` / `uncaughtException` 兜底。

**S11a 落地的三条退出语义**（`shutdown.ts`，守护是 `tests/t-lifecycle.mjs` 第 1 段）：

| 语义 | 落地后的实现 |
|---|---|
| **只关停一次** | `shuttingDown` 在 `await deps.stop()` **之前**置位，所以关停还没跑完时再来的信号也不会重入——重复关停会把长期任务停两遍、把 `server.close()` 调两次 |
| **重复信号是催命符** | 第二个及以后的信号立即 `exit(1)`（先打一行日志）。没有这一条的话，`stop()` 一旦挂住（在途上传、SSE 长连接、某个模块级单例都可能）除了杀进程没有别的出路，而无头入口正是"反复按 Ctrl-C"的场景 |
| **`stop()` 抛错也要退** | 老写法 `await app.stop()` 抛错会落到 `server.ts` 的 `unhandledRejection` 上，而那里只 `console.error`、**不退出**——进程就此挂住。现在 catch 下来交给 `onError` 报告，然后照常退出 |

**为什么单独一个模块**：`server.ts` 是**带副作用的入口**（import 即建 app、起服务、装信号处理器），套件没法 import 它来验行为，而"连按两次 Ctrl-C 会不会关停两次"恰恰只有真跑一遍才看得见——先例是 S1 抽 `web/http/event-projector.ts`。接线事实（两个信号、都走同一个处理器名）因此只能靠**文本扫描**守，而且**非文本不可**：Windows 下 `SIGTERM` 事实上送不到子进程的处理器，行为级的信号测试不可靠（§9.4）。

**S11a 修掉的一处真缺陷**：老写法在 `stop()` 抛错时既退出不了、也报不出来（只有一行 `console.error`）。这不算"顺手优化"，是"退出路径上唯一一处抛错就挂住"的地方。

**S11e：桌面端的退出同样要等关停落地**（守护是 `tests/t-lifecycle.mjs` 第 5 段）。S11e 之前 `before-quit` 里是 `try { core?.stop(); } catch {}`——**同步调用、不 await**，Electron 不等它就去拆窗口与进程：`app.stop()` 那条链（中止在跑的会话、停长期任务、关 OneBot、关 server）走到一半就没了，在途的 QQ 上传与内存里的整理结果被切断，关停日志也来不及打。这和无头入口是同一个毛病（S11a 修的就是它），只是机制不同：Electron 要先用 `event.preventDefault()` 拦下这次退出，等关停完再自己 `app.quit()` 一次。

三条不变量，都是"缺了就挂"而不是风格问题：

| 不变量 | 缺了会怎样 |
|---|---|
| `quitting = true` 在 `preventDefault()` **之前** | 退出期间窗口的 `close` 事件会先到，此时 `quitting` 还是 `false` → 关窗处理器 `preventDefault()` + 缩托盘，把退出挂住 |
| `stopping` 守卫（第二次进入直接 `return`） | 我们自己那次 `app.quit()` 会再次触发 `before-quit`，没有守卫就**拦下自己** → 死循环 |
| `.finally(() => app.quit())` | `preventDefault()` 拦下之后没人再退 → 应用**永远停在那里不退**（比"关停没做完"更明显，但同样只有文本看得见） |

另外关停放在 `.then(() => core.stop())` 里而不是直接求值 `Promise.resolve(core.stop())`：后者一旦在**实参求值阶段**同步抛错，异常就逃出了这个处理器，后面的 `.catch` 接不住——而 S11a 那条"`stop()` 抛错也要退"正是为了这种情形。

**这一段只能靠文本守**：`electron/main.js` 是带副作用的入口（import 即抢单实例锁、建窗口、装托盘），Node 里 import 不了；而"退出会不会挂住"要真起 Electron 才看得见（§9.4）。顺带说明一条**没被守住的**：`if (!core) return;` 删掉也不会红——`core` 为 null 时 `.then(() => core.stop())` 抛 `TypeError` 被 `.catch` 接住，`.finally` 照常 `app.quit()`，只是日志里多一行；它的作用只是"核心没起来过就别白等一轮"。

设计取向：注册层未来的 `stop()` 必须是**幂等且可重复调用**的（今天 `ProactiveController.stop()`（`:40-43`）与 `HistoryCompactor.stopCompactLoop()`（`:41-44`）已经是：先判空再清句柄；**S11a 起 `shutdown.ts` 又把"同一次退出只关停一遍"提到了编排层**）；并且**关停顺序 = 注册顺序的逆序**，以保证依赖关系不被破坏。

> **S11c 已把这条从"设计取向"变成结构性质**：`stopLifecycle()` 就是 `[...LIFECYCLE].reverse()` 上的一次 `for...of`，`app.stop()` 里不再有任何一条任务停止调用——想违反逆序，只能改 `lifecycle.ts` 里的遍历方向，而那会被行为断言当场抓住。在此之前它是"写进设计即为其确立"的约定，靠读代码维持。

### 7.5 重复注册

今天靠"`start()` 开头先 `stop()`"保证幂等（`proactive-controller.ts:21`、`history-compactor.ts:28`），且 `initPriceFeed` 用"同 URL **且定时器还活着**"（`status.url === url && status.enabled && timer`）避免同 URL 重复拉起。设计取向：注册层沿用同样的"**先停后起、同参幂等**"约定，而不是引入引用计数或句柄去重——后者在没有实际需求时只会增加状态。

> **S10a 的修正**：原实现是 `if (status.url === url && status.enabled) return;`，而清理定时器的那行在它**之前**——于是"同参幂等"实际变成了"同参停摆"（§6.3 细节补充里的那个真 bug）。**"先停后起"与"同参幂等"这两条放在一起时必须注意顺序**：先停，再判要不要起；判在里面早退，就等于停了不起。

> **S11c 之后多了一层"根本重复不了"**：`startLifecycle()` 对清单是 `for...of` 一次遍历，每个 entry 最多启动一次；而"每个 id 恰好被一条 entry 覆盖"由 `tests/t-lifecycle.mjs` 第 2 段对账钉住。两者合起来，长期任务的**重复注册在结构上不再是一个可达状态**——这正是把 jmcomic 两个 id 合成一条 entry 的意义（§6.2.1 第 2 点）。

### 7.6 web 模块整理后的位置对账

本文大量引用 `src/web/app.ts:NNN`，其中一部分是**设计期的快照**（引用当时的行为，行号保留原样并已就地标注），另一部分是**当时对"今天"的描述**（那些必须跟着代码走）。S11 之后的 web 模块整理把组装根 881 行拆成 **228 行**，拆出的四块各有自己的私有状态或独立职责，因此有了 `src/web/onebot/` 与 `src/web/http/console.ts`：

| 原先在 `app.ts` | 现在在 | 拆出的理由 |
|---|---|---|
| SnowLuma 目录/子进程/日志缓冲/端口探活/WebUI（`launchSnowluma` 等六个 `AppContext` 成员不变） | `src/web/onebot/snowluma.ts` | 自己拥有子进程句柄与日志环形缓冲 |
| 令牌候选收集、401 轮换、限频、去重签名 | `src/web/onebot/tokens.ts` | 自己拥有候选游标与时间戳 |
| `handleOneBotEvent` / `ingestMessage` / `ingestPoke` / `resolveAtName` / `resolveReply` / 白名单 `allowed()` | `src/web/onebot/ingest.ts` | 自己拥有 `atNameCache` 与引用预览上限 |
| `handleHttp` / `listenOn` / `json` / `authorize` / `SECRET_KEY_*` 脱敏 / `buildStatus` | `src/web/http/console.ts` | **控制台这一侧的对外表面**：它只回答"外部请求进来时怎么答"，不改变组件图；它自己拥有"未授权时怎么回"与"什么字段算密钥"这套判定 |

**`web/onebot/` 与 `src/qq/` 的分工**：`qq/` 是 OneBot 传输客户端（协议、重连、发送），`web/onebot/` 是"那个 OneBot 端"自己的本地状态——SnowLuma 是它的宿主程序，令牌是它的凭据，入站摄取是它的消费者。依赖仍是单向的：`web/onebot/*` → `qq/`、`chat/`、`agent/runtime/control-port`，没有反向边，`check-layers.mjs` 只按顶层目录判层，`web/` 内部嵌套是自由的。

**未移动的东西**（有守护断言钉着，别顺手搬）：`applyConfigPatch`（`t-timers.mjs` 按函数名切片）、`start()`/`stop()`/`lifecycleDeps()`（`t-lifecycle.mjs` 按函数名切片）、SSE 的 `emit` 闭包（`t-sse-project.mjs` 读 `dist/web/app.js` 里那个闭包的形状）。判据是"它是否触碰共享组件图"——**只碰共享图的不搬，自己拥有私有状态的才搬**。`applyConfigPatch` 是这条判据最微妙的一个：它**确实**在 `start()` 之外启停长期任务（S10b/S11b 有意保留，配置刷新路径刻意不接 `LIFECYCLE`），所以精确的规则是"**装配期**启停只走 `start()`/`stop()`；**运行期**配置变更的启停只经 `applyConfigPatch`"。它跟 `start()` 同类，属于组装根职责而不是 HTTP 职责——`http/console.ts` 只是把它转交给路由（`POST /api/config`）。

**这次拆分的证伪探针**（§9.5 第 23 项）：① 让 `http/console.ts` 的 `handleHttp` 立刻返回 404 → `t-admin` / `t-window-http` / `t-smoke` 三套件红（`t-web-router` **保持绿**——它是 `dispatchRoute` 的纯单元测试，不经过 HTTP，这正好说明"谁在管这条链路"）；② 在 `http/console.ts` 里直接写 `onebot.wsUrl = '…'` 绕过 `applyEndpoint` → **四套件全绿**，即 `t-timers.mjs` 第 5 段那条"端点只有一个写入口"的扫描面**只覆盖 `src/web/app.ts`**，这是本次拆分引入的**已知守护空白**，已写进 `http/console.ts` 的文件头注释。

**第二次整理（2026-09-28）：按功能与层级搬进子目录。** 上表把根目录从 12 个文件减到 8 个，但根目录仍混着六类东西——组装根（`app.ts`、`console.ts`）、headless 入口（`server.ts`）、领域类型（`types.ts`）、HTTP 原语（`http.ts`/`router.ts`/`static-files.ts`/`event-projector.ts`）、长期任务三件套（`tasks.ts`/`lifecycle.ts`/`shutdown.ts`）、用量读模型（`usage-service.ts`）。本次是**纯搬运**：不改文件名、不改任何函数体、不改任何断言语义。落点是根目录只留四个（组装根 `app.ts`、入口 `server.ts`、领域类型 `types.ts`、读模型 `usage-service.ts`），其余按"是不是 HTTP/SSE 表面""是不是长期任务与退出路径"分进 `http/` 与 `runtime/`：

| 原路径 | 新路径 |
|---|---|
| `web/console.ts` | `web/http/console.ts` |
| `web/event-projector.ts` | `web/http/event-projector.ts` |
| `web/http.ts` | `web/http/http.ts` |
| `web/router.ts` | `web/http/router.ts` |
| `web/static-files.ts` | `web/http/static-files.ts` |
| `web/tasks.ts` | `web/runtime/tasks.ts` |
| `web/lifecycle.ts` | `web/runtime/lifecycle.ts` |
| `web/shutdown.ts` | `web/runtime/shutdown.ts` |

`routes/` 与 `onebot/` 未动，`app.ts`/`server.ts`/`types.ts` 三项锚点原地不动（套件按字面路径读它们、还按函数名切 `app.ts` 的源码文本），因此 `package.json` 的 `server` 脚本与 `electron/main.js` 的 import 都无需改动。`http/http.ts` 的目录名与文件名重复是**刻意保留**的：本轮只搬运、不重命名，diff 才可审。

**本文的路径口径**：上表八个文件在本文中一律按**新路径**书写，包括 S1/S9/S11a/S11c 各步里"新增 `src/web/…` / 删 `…`"的表述——那是本轮**回填**后的位置，当时它们建立在 `web/` 根目录下，**不存在两份文件**；文中大量出现的**裸文件名**（`tasks.ts`、`lifecycle.ts`、`console.ts` 等）同样按上表读。行号快照的规则不变（见本节开头）：`src/web/app.ts:NNN` 这类引用**不受本次搬运影响**，因为 `app.ts` 没动——它占本节与附录的绝大多数。

**这次搬运的守护**：`check-layers.mjs` 新增 web 根目录白名单（只放行那四个文件；`http`/`runtime`/`routes`/`onebot` 四个子目录缺一个也报错），形态与 `agent/` 那条规则完全一致，守护边界也一样——**只禁止回根，不管子目录内部怎么分**。证伪探针见 §9.5 第 25 项，其中第 ③ 条记录了一个**必须记住的操作事实**：`npm run build` 是裸 `tsc`、**不清理 `dist/`**，所以搬完文件必须先 `rm -rf dist` 再 build，否则旧位置的编译产物还在，指向旧路径的测试会**照样全绿**，验证就成了假的。


## 8. 迁移方案与回滚（回答 Q6）

### 8.1 原则

- **新旧并行**：新类型与现有 `emit` / 计时器同时存在，不搞一次性替换。
- **逐消费者迁移**：一步只动一类东西，改完立刻可验证。
- **每步可回滚**：每步都写明"回滚 = 撤销哪几个 hunk"。
- **不碰禁止项**：S1–S9 中没有任何一步修改启动流程、配置刷新流程、退出流程，或 `src/qq` 的入站解析。

### 8.2 步骤

| 步 | 内容 | 触发协议变化 | 守护套件 | 回滚 |
|---|---|---|---|---|
| **S0** | 落本文档；在 `global-registry-roadmap.md`、`ts-migration-plan.md`、`AGENTS.md` 加交叉链接 | 否 | 无（纯文档） | 删文档 |
| **S1** | 抽 `src/web/http/event-projector.ts`：`app.ts:264-302` 改为调用 `projectSse` / `writeSse`。**纯重构，SSE 帧逐字节不变**（含保留不可达的富投影分支） | 否 | `t-smoke.mjs` + 新增 `t-sse-project.mjs`(ASSERT) | 撤销两个文件改动；projector 变未使用文件 |
| **S2** | 新增 `src/core/events.ts`（词表 + 载荷类型 + 双向编译期护栏）。**纯增量**，无生产者改动 | 否 | `npm run check`（层级检查证明 core 仍在 0 层：66 → 67 个源码文件仍全绿） | 删文件 |
| **S3**（已落地） | 61 个发射点的字符串字面量 → `EVENTS.*`。**值不变**，线上与套件读取的载荷都不变。实际：**59 处换成 `EVENTS.<key>`**（分布：`chat-update` 16、`session-update` 12、`memory-update` 8、`vision-scan` 5、`sticker-update` 5、`session-end` 4、`snowluma-status` 4、`session-start` 2、`feedback`/`snowluma-log`/`onebot-status` 各 1），另加 `event-projector.ts` 的入口比较改成 `EVENTS.sessionUpdate`；余下 **2 处 `'status'` 有意保留**（`orchestrator.ts:284`、`app.ts:680`）——词表里根本没有这个名字，S4 才拆。§8.2 记的"61 处"是**发射点总数**，其中 59 处能改名，不是笔误 | 否 | 全量 `tests/run.mjs` + 新增 `t-events.mjs`(ASSERT，见 §9.3) | 整体撤销（常量仍被别处引用，可保留）；`t-events.mjs` 是同一改动的一部分，一并回滚 |
| **S4**（已落地） | 拆 `status`：`app.ts:711` → `config-applied`；`orchestrator.ts:284` → `orchestrator-pause`；UI 加一个监听。实际：两个发射点改用**早已登记在词表里**的 `EVENTS.configApplied` / `EVENTS.orchestratorPause`（S2 就位，此前无生产者），`ui/js/main.js:351` 那一条 `'status'` 监听拆成两条、处理函数不变，行为逐字不变。顺带确认 `'status'` **没有 UI 之外的消费者**（§10 待定 3 关闭） | **是**（唯一改名） | `t-panel-wiring.mjs`（新增"UI 订阅的名字必须在词表里"的跨边界断言 + 两个新名字都订上）、`t-events.mjs`（`EXPECTED_PENDING_STATUS` 2 → 0，并去掉"待接线"豁免） | 撤销 3 个文件（`app.ts`、`orchestrator.ts`、`ui/js/main.js`）+ 把 `t-events.mjs` 的期望值改回 2 |
| **S5**（已落地） | 收敛 `session-end` 四形状：`agent-runner.ts:336` 的 `sent` → `sentCount`；`:332`、`wake-scheduler.ts:366/382/567` 对齐 `SessionEndPayload`。实际：① `sent` → `sentCount`（该字段全仓无读方）；② `#finishWaiting` 的 `status: string` 收成 `SessionEndStatus`（8 个调用点全部传 `'aborted'`，属于边界收窄）；③ **`SessionEndPayload.error` / `.finishReason` 由 `string \| null` 放宽为 `unknown`**——不这么做四处里有两处编译不过（§4.2 修正表 + §4.5）；④ `t-events.mjs` 补齐载荷段（真 Orchestrator 跑出 done/noreply/aborted 三种真实载荷） | 否（`sentCount` 无读方，属载荷清理而非协议破坏） | `t-events.mjs` 载荷段（新增）+ `t-orch.mjs`、`t-vision-log.mjs`（`readArchivedSession` 依赖 `sessionId`）+ `npm run typecheck`（`SessionEndStatus` 收窄） | 撤销这 3 处调用点 + `core/events.ts` 的两个字段，并把 `t-events.mjs` 的载荷段退回 |
| **S6** | ~~7 处 `emit` 注入类型 → `AppEmit`（§3.3 表）~~ **已落地**（实际 **13 处标注 / 9 个文件**，见 §4.3——⚠️ 这个"13"是当时人工读出的数，含 1 处从未标注的箭头转发；按套件规则实测是 12，**S11d 后是 10 处 / 7 个文件**，口径说明见 §4.3 末）。生产者从此受编译期检查。**此步不删 `orchestrator.ts:70` 兜底**。落地时附带把 `AppEventMap['session-update']` 改成今天的**事实** `string`——否则那 12 个裸串发射点编译不过（§4.4 末、§4.2 修正表） | 否（纯类型标注；编译产物逐字节不变，已实测） | `npm run typecheck` + 全量 + `t-events.mjs` 新增的"注入点必须标着 `AppEmit`"两条 | 撤销类型标注，并把 `AppEventMap['session-update']` 还原成 `{ sessionId: string }` |
| **S7** | ~~12 处 `session-update` 裸串 → `{ sessionId }`，并把 `AppEventMap['session-update']` 从 `string` 翻成 `{ sessionId: string }`（两者必须同一次提交：只改载荷不改类型会编译不过，只改类型不改载荷会让那 12 处也编译不过——这个类型是 S6 与 S7 的接缝）~~ **已落地**：实际改了 **12 处发射点 / 3 个文件**（`agent-runner.ts` 5、`wake-scheduler.ts` 5、`tools/shared.ts` 2，与附录 A 的点数一致），类型同步翻回。⚠️ **这不是无害的载荷统一，而是激活一条从未通电的通道**（§3.4 三）：UI 从这一刻起才第一次真的吃 SSE 快照，`main.js:246-266` 的 patch 合并与 `:210` 的"patch 优先"才第一次被真实数据跑到 | 是（载荷形状 + 面板数据来源） | `npm run check` 全绿（19 套件）；`t-events.mjs` 新增**第 6 段**（把载荷在 emit 当刻喂给真投影函数，断言出的是富帧）；`t-sse-project.mjs` **没有改动**——投影函数一个字没动，它钉的两侧变成"真实路径 + 兜底路径"（§4.4）。**真机冒烟仍必须做且尚未做**（面板在 SSE 与 4s 轮询双写下不跳、不闪、`sent` 徽标正确；见 §10 待定 2） | 撤销这 12 处 + 类型翻回 `string`（投影分支可留着，回到"不可达"即 S7 之前的行为） |
| **S8** | ~~端口 `AgentControlPort` + `METHOD_CATALOG`；`Orchestrator implements`；`t-orch.mjs`/`t-vision-log.mjs` 的假货 `satisfies`~~ **已落地**，但**最后半句是设计稿写错了**：那两个套件里没有假 `Orchestrator`，假的是 `onebot`/`memory`/`stickers` 依赖（§5.5），所以没有 `satisfies` 可加。实际改了 **4 个文件**：新增 `control-port.ts`（端口 16 方法 + 4 状态字段、`AgentControlMethod` 派生类型、`METHOD_CATALOG` 16 项）、`orchestrator.ts:37` 加 `implements`、`web/types.ts` 的 `AppContext`/`AppHandle` 两处 `orchestrator` 类型从具体类换成端口。**调用点零改动**——这正是端口建对了的标志。运行期影响：`tsc` 仍会 emit 出 `dist/agent/runtime/control-port.js`（常量表要落成 JS），但**没有任何模块 `require` 它**（两处引用都是 `import type`，编译期擦除），已实测 `grep -rn --include=*.js "control-port" dist/` 只剩 sourceMappingURL 自己 | 否（编译期；`implements` 擦除、类型引用擦除） | 新增 `t-ports.mjs`(ASSERT，6 段断言) + 全量（20 套件绿） | 删 `control-port.ts` + 撤销 `orchestrator.ts:37` 与 `web/types.ts` 两行类型（回到具体类） |
| **S9**（已落地） | 任务描述符表（纯数据，不启动任何任务），逐行填 `conformance`。实际：新增 **`src/web/runtime/tasks.ts`**（类型 + **6 行**表，零 import），新增 `tests/t-tasks.mjs`(ASSERT，11 条断言)，`tests/run.mjs` 登记。**表里是 6 行不是 7 行**——设计稿 §6.1/附录 B 的"7 个长期任务"是照 §6.3 的表行数数的，而那张表第 7 行 `wake.debounce` 自己标着"排除"（§6.1 已更正）；`wake.debounce` 变成套件的**反向断言目标**。四处与设计稿的形态偏离见 §6.2。`tests/lib/src.mjs` 顺带新增共享的 `stripComments()`（见 §9.5 第 13 项），t-ports 的第 6 段也改用它 | 否（纯数据 + 测试） | 新增 `t-tasks.mjs`(ASSERT，11 条) + 全量（**21 套件绿**） | 删 `tasks.ts` + `t-tasks.mjs`，`run.mjs` 去掉登记 |
| **S10a**（已落地） | 收下 `price.feed`：新增 `stopPriceFeed()`、修掉"同 URL 早退却已清掉 timer"那个静默停摆的 bug、把 `initPriceFeed` 的启动点从 `createApp()` 搬进 `app.start()`、接线 `app.stop()`。`tasks.ts` 的 `price.feed` 行 → `stop` 填上 / `stopCancelsPending: true` / `conformance: 'full'`；`tests/t-tasks.mjs` 第 ⑦ 段的实名断言**翻成正向**。新增 `tests/t-timers.mjs`(ASSERT，13 条断言) + `run.mjs` 登记（**22 套件**） | 是（退出语义 + 启动时机：`start()` 失败时价格表不再启动） | 新增 `t-timers.mjs`(ASSERT) + `t-tasks.mjs` + `t-smoke.mjs`（唯一真跑 `app.stop()` 的套件）+ 全量（**22 套件绿**）；4 条证伪探针见 §9.5 第 14 项 | 撤销 `stopPriceFeed` 与两处接线、把 `initPriceFeed` 搬回 `createApp()`、`tasks.ts` 那一行退回 `partial`、实名断言翻回反向、删 `t-timers.mjs`（这一步是**唯一修了真 bug** 的一步，回滚它等于把停摆放回去） |
| **S10b**（已落地） | 收下两个 jmcomic 任务：新增 `stopJmcomicQueue()`（置空 `runtime` + 清 `cleanupTimer`/`wakeTimer`，**不清 `jobs`**；置空 runtime 而非新增 `stopped` 标志位，以保留"stop 之后 enqueue 会重新拉起队列"的既有不变量）；`initJmcomicQueue` 从 `Orchestrator` 构造函数（`:75`）搬进 `app.start()`、接线 `app.stop()`（在 `onebot.close()` 之前）；补上 `scheduleNextWake()` 开头的 `if (!runtime) return` 与 `runWorker` 的 `while (runtime && …)`。`tasks.ts`：`jmcomic.cleanup` → `full`、`jmcomic.worker` → `partial`（停不掉**正在跑**的那一次下载），worker 的 unref 策略定性为**刻意保持**（§10 待定 6 关闭）；`tests/t-tasks.mjs` 第 ⑦ 段那条实名断言**翻成正向**。`tests/t-timers.mjs` 加 jmcomic 段（13 → 21 条断言） | 是（退出语义 + jmcomic 队列的启动时机；stop 之后一次 enqueue 会重新拉起队列，如实写在 `note` 里） | `t-timers.mjs` + `t-tasks.mjs` + `t-smoke.mjs` + 全量（**22 套件绿**）；5 条证伪探针见 §9.5 第 15 项（其中 1 条是**如实记录的覆盖空白**） | 撤销 `stopJmcomicQueue` 与两处接线、把 `initJmcomicQueue` 搬回构造函数、删 `scheduleNextWake` 的守卫、`tasks.ts` 两行退回 `none`、实名断言翻回反向 |
| **S10c**（已落地） | 收下 `onebot.reconnect`：`qq/onebot.ts` 新增私有字段 `#reconnectTimer:55`（非 null ⟺ 有待触发的一次重连）、`#scheduleReconnect():74`（**先清旧再存新**）、`#cancelReconnect():83`；两处排定（`:126` 构造失败、`:155` close 事件）改走它；`close()`/`connect()`/`reconnect()` 三处都调 `#cancelReconnect()`；**刻意不 unref**；`#connectLoop:115` 的 `#closedByUs` 早退保留为**第二道闸门**。`tasks.ts` 的 `onebot.reconnect` → `stopCancelsPending: true` / `conformance: 'full'`，`note` 纠正了"取消不掉已在等待中的那一次"的旧表述。`tests/t-timers.mjs` 加 onebot 段（21 → 30 条断言）；`tests/t-tasks.mjs` 加第 3 条实名断言（文本扫描：重连调度只许一处且句柄必须存） | 是（**退出语义**：`close()` 从"只阻止下一次"变成"连待触发的那一次一起撤掉"，不再白钉住事件循环 `RECONNECT_MIN_MS`；顺带堵掉一条真实的重复连接泄漏路径） | `t-timers.mjs` + `t-tasks.mjs` + `t-notice.mjs`（构造真 `OneBotClient` 的既有套件）+ `t-smoke.mjs` + 全量（**22 套件绿**）；6 条证伪探针见 §9.5 第 16 项 | 撤销 `#reconnectTimer`/两个私有方法与三处调用、两处排定退回裸 `setTimeout`、`tasks.ts` 那一行退回 `partial`/`stopCancelsPending: false`、删 `t-timers.mjs` 的 onebot 段与 `t-tasks.mjs` 的第 3 条实名断言 |
| **S10d**（已落地） | 删 `orchestrator.ts` 的兜底总线：`agent/shared/types.ts` 的 `emit?: AppEmit \| null` → **`emit: AppEmit`**（必填），构造函数去掉 `= null` 与三元兜底、删 `createEventBus` 的 import；**8 个** `.mjs` 构造点补 `emit: () => {}`（`t-orch.mjs` 5、`t-orch2.mjs:24`、`t-panel.mjs:59`、`t-ports.mjs:126`）。守护：`t-ports.mjs` 新增**第 1c 段**——两条断言，① 源码文本：`orchestrator.ts` 不再引用 `createEventBus`；② 扫 `tests/*.mjs` 里每个 `new Orchestrator(\s*{` 的实参对象必须含 `emit`（`.mjs` 不受 `tsc` 管，且实测**真正纯静默的只有 `t-ports.mjs` 自己那一个**，其余一旦被使用就 `TypeError`） | 否（生产路径上 `emit` 一直由 `app.ts` 传入，行为零变化；变的只是"忘了传"从运行期炸变成编译期错） | `t-ports.mjs`（1c 两段 + 既有的 11 条）+ 全量（**22 套件绿**）；5 条证伪探针见 §9.5 第 17 项（其中 1 条**纠正了本节原先的乐观估计**） | 把 `types.ts` 的 `emit` 退回可选、恢复三元兜底与 import、撤回 8 个构造点的 `emit`、删 `t-ports.mjs` 第 1c 段 |

| **S11a**（已落地） | 收口无头入口的退出路径：新增 **`src/web/runtime/shutdown.ts`**（`createShutdown({ stop, exit, log, onError? })`，纯逻辑、可单测），`server.ts` 把 `SIGINT` / `SIGTERM` 两行各接一次 `shutdown`。语义三条：只关停一次（`shuttingDown` 在 `await` **之前**置位）、**重复信号立即 `exit(1)`**（逃生舱）、**`stop()` 抛错也照常退出**（老写法会落进 `unhandledRejection`，那里只打日志、不退出 → 进程挂住）。新增 `tests/t-lifecycle.mjs`（ASSERT，本步落第 1 段；第 2–4 段留给 S11c/S11d/S11e）+ `run.mjs` 登记（**22 → 23 套件**） | 是（退出语义：多了一个信号、多了一条强退路径，且 `stop()` 抛错时行为从"挂住"变成"退出"） | 新增 `t-lifecycle.mjs`(ASSERT) + 全量（**23 套件绿**）；5 条证伪探针见 §9.5 第 18 项 | 撤销 `server.ts` 的信号接线与 import、删 `shutdown.ts` 与 `t-lifecycle.mjs`、`run.mjs` 去掉登记 |
| **S11b**（✅ 已落地） | 收口配置刷新语义：`OneBotClient.applyEndpoint(next)`（比较四个端点字段，`undefined` = 不碰、别的值走与构造函数同一份归一化、返回 `true ⟺ 有字段真的变了`）；`applyConfigPatch` 在该值为真时 `onebot.reconnect()`；`start()` 的端点覆写改走它（于是实例端点字段只剩一个写入口，`applyTokens` 是刻意例外）；`RECONNECT_MAX_MS` 删除（附录 C）；`AppHandle` 暴露 `applyConfigPatch`。**实际落地与方案的偏离只有一处**：`''` 的语义按字段分开（空 URL 回落默认值、空 token 真清空），理由见 §7.3——按方案原文实现会落进"空地址 → `new WebSocket('')` 抛错 → 3s 重连循环" | 是（改端点保存后会断连重建；**没动端点的保存不会断连**） | `t-timers.mjs` 新增第 5 段（30 → **41** 条断言，含真 app 的 socket 身份断言 + `OneBotClient` 单元断言 + `applyConfigPatch` 函数体文本扫描）+ 全量 23 套件 | 撤销 `applyEndpoint` 与三处调用、恢复端点覆写与常量、`tasks.ts` 的 note 复原 |
| **S11c**（✅ 已落地） | 补上注册层的第四条腿——**执行清单** `src/web/runtime/lifecycle.ts`：`LIFECYCLE` 是有序的**函数引用**数组（`import` 不启动任何东西，`dist/web/runtime/lifecycle.js` 里**零 `require`**），`startLifecycle` 正序、`stopLifecycle` **逆序**（于是 §7.4 的"关停顺序 = 注册顺序的逆序"从约定变成**结构性质**，"停长期任务排在 `onebot.close()` 之前"由逆序自动满足）；jmcomic 两个 id 合成一条 entry；`app.start()`/`stop()` 改走它，`app.ts` 只保留一个 `lifecycleDeps()` 工厂（"装的是什么"）；配置刷新路径**不接清单**（5 条里 3 条 `ALWAYS`，会误调 `connect()`） | 是（退出顺序：`price.feed` 与 jmcomic 的停止次序互换——两者互不依赖，属可观察但良性的变化，记入真机冒烟） | `t-lifecycle.mjs` 第 2/3 段（20 条：清单 ⇄ `LONG_TERM_TASKS` 对账、逐条 `enabled`、import 纯度、**逆序 spy 行为断言**、接线文本扫描、**无按键分发**文本扫描；套件 7 → **27** 条）+ 全量 23 套件；5 条证伪探针见 §9.5 第 20 项 | 撤销 `lifecycle.ts` 与 `lifecycleDeps()`、`start()/stop()` 退回硬编码六对调用、删 `t-lifecycle.mjs` 第 2/3 段 |
| **S11d**（已落地） | 死代码与空转事件收口：删 `scheduleConfigSave` + `saveTimers`（`core/config.ts`，两样一起——后者只被前者用）、`AgentEventMap`（`agent/shared/types.ts`，**该文件侧早已被删，本步只收口文档与注释**）、`MemoryConsolidatorDependencies.emit`（+ `orchestrator.ts` 构造处传参）、整个 `vision-scan` 事件（词表 + `VisionScanPayload` + `AppEventMap` 键 + 5 个发射点 + `scanModelsVision` 的 `emit` 参数 + `routes/providers.ts` 的 `emit:` 传参）。**同步 `t-events.mjs` 的 `TYPED_FILES`（删两处，最容易漏的红）**、`t-tasks.mjs` 的 `LOCALTIMER_ONLY_FILES`（删 `src/core/config.ts` 那行，只被一条断言用、不减覆盖面）；`t-lifecycle.mjs` 第 4 段（5 条断言：死符号绝迹 + `config.ts` 零计时器 + 三个文件零 `emit` + `new MemoryConsolidator({…})` 实参不含 `emit` + **正向**钉住 `providers.ts` 那个**活的**本地 `visionScan` 对象） | 否（`vision-scan` 零消费者，能力已由 HTTP 提供；删除不改变任何可观察行为） | `t-lifecycle.mjs` 第 4 段 + `t-events.mjs`（注入点清单）+ `t-tasks.mjs` + 全量（**23 套件绿**）；3 条证伪探针见 §9.5 第 21 项 | 把四个符号加回、`TYPED_FILES` 与 `LOCALTIMER_ONLY_FILES` 复原。⚠️ **这一步的守护全是文本的**——删的东西零调用者/零消费者，"删与不删运行期完全一样"，一条行为断言都写不出来（`visionScan` 那个**同名活的**本地对象是唯一的动作断言） |
| **S11e**（✅ 已落地） | 桌面端的退出也等关停落地：`electron/main.js` 的 `before-quit` 改成 `quitting = true` → `if (stopping) return;` → `event.preventDefault()` → `Promise.resolve().then(() => core.stop()).catch(…).finally(() => app.quit())`。三条不变量：`quitting` 必须先置位（否则关窗缩托盘把退出挂住）、`stopping` 守卫（否则第二次 `app.quit()` 拦下自己 → 死循环）、`.finally` 里自己再退一次（否则 `preventDefault` 之后**永远不退**）。关停放进 `.then` 而非 `Promise.resolve(core.stop())`，同步抛错才逃不出处理器 | 是（桌面端退出从"不等 `stop()`"变成"等它落地"；退出语义与 S11a 的无头入口对齐） | `t-lifecycle.mjs` **第 5 段**（6 条文本断言；套件 33 → **39** 条）+ 全量 23 套件；3 条证伪探针见 §9.5 第 22 项 | 把处理器还原成 `try { core?.stop(); } catch {}` 并删掉 `stopping` 声明 |

### 8.3 排序理由（几处不显然的）

- **S1 在最前**：它是唯一"纯重构且能立刻提升可测性"的一步，后续 S4/S5/S7 都靠这个投影函数被单测守住。
- **S2 早于 S3**：常量先落地，S3 才是纯机械替换；反之则要先在 61 处手写字符串再回头统一。
- **S4/S5/S7 单独成步**：这三步是仅有的**协议/载荷变化**，隔离成独立步骤才能"改坏了单独回滚"。
- **S6 晚于 S3**：先让事件名可枚举，再加类型约束；顺序反了会先红一片。
- **S6 不删兜底总线**：`t-orch.mjs:27` 不传 `emit`（§5.6），删了套件当场挂。删除排在 S10+（**S10d 已删**）。
- **S6 与 S7 共用 `AppEventMap['session-update']` 这一个类型**：S6 需要它写成当时的 `string`（否则 12 个裸串发射点编译不过），S7 需要它写成 `{ sessionId }`（否则改完的 12 处编译不过）。所以这个字段是两步之间的接缝，**S7 必须同时改载荷与类型**（已如此落地）；顺序上 S6 在前 S7 在后，中间的中间态（类型 `string` + 发射点裸串）是自洽的——它既编译得过，又和 S7 之前的行为完全一样。
- **S9 是纯数据**：所以它能安全地在任何时刻加，且 `t-tasks.mjs` 可以断言它，不需要假时钟。但**"纯数据"要求表里的启停入口存的是名字、不是函数引用**——存引用的话套件只能断言"我写进去的函数是个函数"（自己验自己），存名字才能拿它到真对象/真模块上解析（§6.2 差异 1）。
- **S9 的反向断言与 S8 的文本扫描同源**：S8 是"新增的绑定点删掉不报错"，S9 是"最容易犯的错是往表里塞不该塞的东西"（把 17 个局部计时器也当成长期任务收编，表就从清点退化成杂物箱）。两处都靠**一条手工登记的正向清单 + 一条反向断言**守，而不是靠表的自我一致性。
- **S8 的类型改动是"零调用点改动"**：`AppContext.orchestrator` 从具体类换成接口后，全 `src/web/` 与 `electron/` 一行没改就编译通过——说明端口收的成员恰好就是跨模块面。这也是 S8 的验收判据：**要是有调用点需要改，就说明端口漏了东西**（落地时确实靠这条发现了设计稿漏掉的 4 个只读状态字段，§5.3）。
- **S8 的守护必须包含文本扫描**：这一步引入的唯一新绑定点是 `implements` 那一行，而它删掉不报错。凡"新增一处只靠约定维持的绑定点"的步骤，守护套件里都得有一条文本断言——S3（`EVENTS.*` 而非字面名）与 S4（UI 订阅名跨边界）都是同一模式的先例。
- **S10a 排在最前，且与 S10b 不合并**：它是最小的一个闭环（模块级单例补一个 stop 导出 + 两处接线 + 翻一行表），先用它把"补 stop → 接线 `start()`/`stop()` → 翻 `conformance` → 翻实名断言 → 加计时器断言"这套模式跑通；而且它**顺带修掉的那个 bug 单独可验证、可回滚**——万一 S10b 的改法要推翻重来，那个 bug 的修复和它的回归钉子不该被一起拖下水。
- **S10b 排在 S10d 之前**：两步都要动 `orchestrator.ts`（S10b 删 `:75` 的构造函数副作用，S10d 删 `:73` 的兜底总线）。让**没有测试改造**的那一步先动这块区域，S10d 再动时面对的是同一片代码、且此时 S10b 的守护已经就位。
- **S10c 排在 S10b 与 S10d 之间**：它只动 `qq/onebot.ts` 与 `tasks.ts` 的一行，**不碰 `orchestrator.ts`**——夹在两步动同一块代码（S10b 删 `:75`、S10d 删 `:73`）的步骤中间，可以把"改构造函数区域"这件事集中在两头，中间插一个不相干的模块。它同时也是**本阶段唯一改退出语义之外还修了第二条真实缺陷**的一步（`connect()`/`reconnect()` 的重复连接泄漏），单独成步才能单独验证与回滚。
- **S10d 排在最后**（已按此顺序落地）：它是唯一需要改 **8 个测试调用点**的一步（§5.6 的结论："删除必须排在测试改造之后"）。放最后也让前三步的证伪证据不会被测试改造的噪声污染。

## 9. 测试与验证（回答 Q7）

### 9.1 今天能覆盖的

| 目标 | 手段 | 依据 |
|---|---|---|
| SSE 投影正确性 | 纯函数直接调用（S1 之后） | 新增 `t-sse-project.mjs` |
| 事件名 / 载荷一致性 | 建**真** `Orchestrator` + 收集式 `emit`，驱动一次唤醒后断言 | 模式已有：`t-orch.mjs:19-27` |
| 任务表完整性与诚实性 | 拿表里每一条声明**去现实里核对**：当前 9 个 id 齐全、owner 文件真在调度、开关路径能在真配置里取到值、`conformance` 与启停入口相符；**反向**：局部计时器不在表内 | `t-tasks.mjs`（已落地） |
| 层级与类型约束 | 静态检查 | `scripts/check-layers.mjs`（S2/S8）、`npm run typecheck`（S6） |
| 端到端 | 真 `createApp()` 起服务再 fetch | `t-smoke.mjs:63-64` |
| Agent 分层与 Catalog | 静态断言 | `t-agent-structure.mjs` |

### 9.2 缺口：仓库没有假时钟

`tests/lib/harness.mjs` 目前只导出：`checker()`（`:21`）、`dataDir()`（`:47`）、`PNG_1X1`（`:56`）、`fakeImageServer()`（`:65`）、`fakeModelServer()`（`:91`）、`toolCall()`（`:130`）、`readArchivedSession()`（`:146`）、`createDomSandbox()`（`:172`）。**没有任何计时器/时钟注入能力。**

两种补法，都符合现有风格：

1. ~~给任务类加可选 `timers?: TimerApi` 依赖~~ —— **S10a 落地时否决了这条，不再需要**。理由：它要改生产代码（每个任务类加一个可选依赖），而这些任务恰恰**不在 DI 图里**（`price-feed` 与 `jmcomic` 都是模块级单例，没有构造参数），为了测试给它们凿一个只有测试会传的参数，是把"可测性"反向压进生产接口。
2. ✅ **采用这条**：**给模块级单例用临时替换全局**的助手 —— 换掉 `globalThis.setInterval/setTimeout/clearInterval/clearTimeout`（还有 `fetch`），跑断言，`try/finally` 恢复。**这条有先例**：`createDomSandbox()` 已经在自己的沙箱里这么干。成立的前提是**实测确认的**：`dist/` 里 `setTimeout`/`setInterval`/`clearInterval` 编译成**裸全局标识符**（运行期查找），所以在 `load()` 之后替换 `globalThis.*` 拦得住被测模块的调用。落地形态见 `tests/t-timers.mjs`（S10a 起 ASSERT），三个踩过的坑写在那个文件头部：假句柄必须是**带 `unref()` 的真值对象**、必须 `try/finally` 恢复（被测模块是模块级单例）、**不能只数"建了几次"**（"清了但没重建"与"压根没清"在只数建立次数时长得一样 —— 而前者正是 S10a 修掉的那个 bug）。

**没有假时钟这件事本身不构成缺口**：这些断言要的是"句柄的增减与归属"，不是"时间推进后发生了什么事"（那要真等待，不是一个好套件的形状）。真正推不动的仍然是真机行为（§9.4）。

### 9.3 建议新增的套件

| 套件 | 断言 | 归类 | 对应步骤 |
|---|---|---|---|
| `t-sse-project.mjs` | 裸串载荷 `session-update` 逐字节等于通用帧（S7 之后这是**兜底**路径）、对象载荷 + `peek` 得到 16 字段富帧且顺序固定（S7 之后这是**真实**路径）、`peek` 抛错/返回空时退回通用帧、未知事件名与 `undefined` 载荷退化为 `JSON.stringify(payload ?? {})`、`writeSse` 单客户端抛错不影响其余；另加两条结构守卫：`app.ts` 的 `emit` 委托给 `projectSse` 且不再自己拼帧。**S7 未改动本套件**——投影函数一字未动，S7 改的是谁往它里面送对象 | **ASSERT**（已落地） | S1 |
| `t-events.mjs` | **名称段（已在 S3 落地，S4 收紧）**：扫 `src/` 的全部发射点，事件名必须是 `EVENTS.*` 引用——S4 之后期望值是 **0 处字面量**，那个"待拆计数"已删；`EVENTS` 里不躺没有发射点的名字（S4 接上 `configApplied`/`orchestratorPause` 后，"待接线"豁免名单也删了，这条现在是纯反向断言）；`EVENTS` 的值互不重复。**载荷段（`session-end` 已在 S5 落地）**：真起 `Orchestrator` + 假模型端点，跑出 `done` / `noreply` / `aborted` 三种真实载荷，断言 `sessionId` 非空字符串、`chatKey` 是字符串、`status` ∈ `SessionEndStatus`、字段集合不超出 `SessionEndPayload`、没有 `sent` 键、`sentCount` 出现时是数字。**注入类型段（S6 落地）**：5a 扫 `src/`，不许任何 `emit` 注入点还写着宽松的 `payload: unknown`（`core/util.ts` 的 `createEventBus()` 是总线本体、路线图禁替换，豁免）；5b 用**精确文件集合**断言"受编译期检查的注入点一处不少、一处不多"，判定标准是**同一行**上同时出现 `emit` 与 `AppEmit`——只查"文件里提没提 `AppEmit`"会漏掉"把标注换成 `(...args: any[]) => void` 而 import 还留着"这种改法（第一版就这么漏的）。**通道段（S7 落地）**：真跑一轮，收集 `session-update` 载荷，断言 ① 载荷一律是对象且带非空 `sessionId`（不是裸串）、② 除 `sessionId` 外不塞别的键（瘦事件）、③ 每条在 **emit 当刻**喂给真 `projectSse` 都产出**富帧**（含 `messages`/`status`）而非退化的 `data: "sess-x"`、④ 富帧带的是该会话的真实字段。③ 是本段的核心：**"载荷是对象"只证明形状，证明不了通道通**，而这条通道坏就坏在"形状看着对、接线从未对齐"（§3.4 三）。 | **ASSERT**（已落地） | S3（名称）/ S4（收紧）/ S5（`session-end` 载荷）/ S6（注入类型）/ S7（`session-update` 载荷与通道通电，第 6 段）/ **S11d（5b 的清单减两个文件名——删注入点必须与它成对，§9.5 第 21 项②）** |
| `t-ports.mjs` | **⚠️ 设计稿这一行写错了**：`t-orch` / `t-vision-log` 里**没有**假 `Orchestrator`，假的是 `onebot` / `memory` / `stickers` **依赖**（§5.5）。落地后的实际断言：① 文本扫 `orchestrator.ts:37` 必须有 `implements AgentControlPort`（**删掉不报错**，见 §5.3 与 §9.5 第 12 项 E-正）；② `control-port.ts` 源码里解析出的接口成员必须与套件内那份手工清单**完全一致**（防"加个没人用的端口成员"，证伪 B）；③ 端口成员集合与 `src/web/**` + `electron/` 里 `orchestrator.<name>` 的实际出现集合**一一对应**（死成员与越界调用一起挡）；④ 真起一个 `Orchestrator` 实例，16 个方法是函数、4 个状态字段形状正确（两个必须是真 `Set`——web 要 `.has()`/`.add()`）；⑤ `METHOD_CATALOG` 键集正确且每个 `owner` 是磁盘上真实存在的文件；⑥ **`src/` 里除定义处外没有任何文件引用 `METHOD_CATALOG`**（它一旦参与分发就是路线图禁止的字符串式注册表）。**S10d 追加第 1c 段**：⑦ 文本扫 `orchestrator.ts` 不再引用 `createEventBus`；⑧ 扫 `tests/*.mjs` 里每个 `new Orchestrator(\s*{` 的实参对象都含 `emit`（`.mjs` 不受 `tsc` 管；这条是**唯一**能拦住"忘给测试构造点补 `emit`"的东西，因为只有 `t-ports.mjs` 自己那一个会静默全绿） | **ASSERT**（已落地；S10d 后 11 条断言） | S8（1–6 段）/ S10d（1c） |
| `t-tasks.mjs` | S9 落地时真任务是 6 个；视频转写与每日热搜接入后手工登记清单扩为 8 个，并继续核对 owner、启停入口、`conformance`、纯数据性质以及局部计时器反向边界。新增项分别核对 `VideoTranscriptionQueue.start/stop` 与 `HotSearchScheduler.start/stop`。 | **ASSERT**（已落地） | S9 / 视频转写 / 每日热搜 |
| `t-timers.mjs` | **S10a 起 ASSERT；S10a 落 13 条，S10b 加到 21 条（三段），S10c 加到 30 条（加第 4 段）**。**第 1 段（price-feed，模块级）**：`initPriceFeed(u)` 恰好起一个 interval 且周期是模块头部写的 1 小时、**同 URL 再调一次后它仍然活着且没有任何句柄被清掉**（早退 bug 的回归钉子）、换 URL 时旧句柄被清掉且恰好一个活着、新句柄调了 `unref()`、`stopPriceFeed()` 清掉定时器且只把 `enabled` 置假（`url` 与快照留着）、`stopPriceFeed()` 幂等（第二次不再产生 `clearInterval`）、stop 之后能再 init、空 URL 等价于停止。**第 2 段（jmcomic，S10b）**：夹具是一份写在 `load()` 之前的 `jobs.json`（**一个 pending 任务 + 一个真 PDF 文件**；不这么备夹具，首跑清理会把下载目录连同夹具一起删掉）——先让 stub 的 `onebot.call` **在上传途中停队列再抛错**，断言 `scheduleNextWake` **没有**排出新 wake timer（这就是"队列不会自我复活"，本步的核心），再断言重新 init 时 wake timer 为那个待办重新排了出来（＝ **stop 没清掉 `jobs`** 的行为证据）、两个句柄都被清、幂等。**第 3 段（真起一个 app）**：`createApp()` 期间**一个长期 timer 都没有**（S10b 起成立——构造期副作用没了），`app.start()` 后活动 interval 恰好 2（价格表 + jmcomic 清理），`app.stop()` 后归零——**这一段是"接线真的接上了"的守护**，前两段只证明模块有能力停。**第 4 段（onebot，S10c）**：构造真 `OneBotClient`，用**非法 URL 让 `new WebSocket` 同步抛 `SyntaxError`** 确定性地触发 catch 分支（不联网、不依赖真实时间）——断言重连排定为 `setTimeout`、周期是 `RECONNECT_MIN_MS`、**刻意没调 `unref()`**；`close()` 用**同一个句柄** `clearTimeout`（直接读记录器，不靠状态事件计数）；手动调那个已作废句柄的回调，断言 `#closedByUs` 早退仍然挡得住（第二道闸门）；`connect()`/`reconnect()` 的取消断言**必须让新 socket 真的建得出来**（换成构造不抛的地址），否则新排定会顺手清掉旧句柄、被测那一行删不删都一样（§9.5 第 16 项②）；手动 `emit('close')` 把第二处排定点也跑一遍。**覆盖不到的**：句柄之外的任何事（时间推进、真实重连、退出时进程是否干净退出、jmcomic 在途下载被 stop 后的实际状态）——那要真机，见 §9.4。**另有一处已知的守护空白**：`runWorker` 的 `while (runtime && …)` 删掉不会让本套件变红（见 §9.5 第 15 项），那道闸门只有注释在守。**第 5 段（onebot 端点，S11b；全套装 30 → 41 条断言）**：真起一个 app 后记下 `app.onebot.socket` 的**身份** —— 用同值 patch（连 `httpUrl` 尾斜杠都照旧多写一个）断言身份**不变**（＝"保存一次没动端点的设置不会断连"的回归钉子），再用改值的 patch 断言身份**变了且非 null**（一次断言同时区分"没清"与"清了没重建"）；另有一组**单元断言**直接构造 `OneBotClient`：`applyEndpoint({}) === false`、尾斜杠不算变更、改 `wsUrl` 返回 `true`、**没给的字段保持不动**（断言的基线要在调用的**紧邻前一拍**取，不能拿构造时的字面量当基线——见 §9.5 第 19 项）、空 token 是真的清空、**调它不建 socket**（"只改字段，不自己重连"）；最后一条**接线文本扫描**：把 `applyConfigPatch` 的函数体切出来，断言体内同时出现 `applyEndpoint` 与 `reconnect`（模块级单元断言证明不了接线，S10a 的教训），且 `app.ts` 里再也不出现 `onebot.wsUrl =` / `onebot.httpUrl =` 这类直接赋值 | **ASSERT**（已落地；原设计稿写的是"先 DIAG 等 `TimerApi` 注入"，§9.2 已否决那条路线，所以直接落 ASSERT） | S10a / S10b / S10c / S11b |
| `t-lifecycle.mjs` | **注册层的执行侧**（S11a 起 ASSERT，本步落第 1 段）。**第 1 段（S11a：关停路径，7 条）**：行为 5 条 —— 连调 `SIGINT`/`SIGINT`/`SIGTERM` 断言 `stop` 恰好 1 次、**强退日志恰好 2 条**（重复信号走的是强退分支，不是再关停一遍）、退出码 `[0,1,1]`（后两条是**分开的两条断言**：S11a 交付时本节写成"行为 4 条"是**漏数了一条**，S11c 收尾时按实际输出更正）；`stop()` 返回永不 resolve 的 promise 时，第二个信号**立即** `exit(1)` 且不重复关停（逃生舱的全部意义）；`stop()` 抛错时仍然 `exit(0)` 且 `onError` 收到 1 个错误。文本 2 条 —— 逐行扫 `process.on('SIG[A-Z]+'`，断言注册的是 `'SIGINT','SIGTERM'` **且每一行都含 `shutdown`**（逐行扫而不是全文 `includes`：全文扫描放得过"再加一个自己 `exit` 的旁路处理器"）。**为什么只能文本守**：`server.ts` 带副作用、套件 import 不了；且 Windows 下 `SIGTERM` 送不到子进程处理器。**第 2/3 段（S11c：清单 ⇄ 描述表对账、`app` 接线与逆序、无按键分发；套件 7 → **27** 条，本步加 20；S11d 又加 6 条 → **33** 条；S11e 再加 6 条 → **39** 条）**。**第 2 段（对账 + 纯度，7 条）**：① 在假计时器下**第一次** `load('web/runtime/lifecycle.js')`，断言 import 期间建的计时器是 **0**（"清单是纯编排，启动只能由 `app.start()` 触发"这条性质的全部机检）；② `LIFECYCLE` 是非空数组、每条 entry 的 `ids` 是非空字符串数组、`enabled`/`start`/`stop` **都是函数**（这条钉住"存函数引用而非名字"——存名字就只能自己验自己）；③ 清单覆盖的 id 集合与 `LONG_TERM_TASKS` **完全相等**；④ 每个 id 恰好被一条 entry 覆盖；⑤⑥ 两条跟着配置走的任务（`proactive.bubble` / `compact.sweep`）拿**真配置**（`updateConfig` 翻 `proactive.enabled` / `compact.enabled` 点分路径，跑完还原）断言真假翻转，另三条 `ALWAYS` 的 id 在两种配置下都恒真；⑦ `lifecycle.ts` 不 import `tasks.ts`。**第 3 段（接线 + 顺序 + 边界，14 条）**：⑧ 清单的 entry 顺序与 id 归属对着**手写登记的一份字面量**（`EXPECTED_ENTRY_IDS`，同 `t-ports` 的 `PORT_METHODS` / `t-tasks` 的 `EXPECTED_IDS` 手法——从清单自己推等于自己验自己）；⑨ 登记条数与清单长度一致（**新增 entry 必须同步登记，否则新 entry 永远不会被顺序断言覆盖**）；⑩⑪ 用 spy `deps` 逐条记调用序列，断言 start 序列 = 手写的期望顺序、stop 序列 = **其逆序**；⑫ 全开时调用次数 = entry 条数（区分"顺序对但漏了谁"）；⑬ **`onebot.close()` 是逆序里最后一个**（"停长期任务排在 `onebot.close()` 之前"的结构性守护）；⑭ 闸门关着的那两条不进启动序列。⑮⑯ 切出 `start()` / `stop()` 的函数体（按 `\n  }` 收尾切，CRLF 无关），断言体内出现 `startLifecycle(` / `stopLifecycle(` **且不再有任何硬编码的任务入口调用**（`initJmcomicQueue(` / `stopJmcomicQueue(` / `start*Loop(` / `initPriceFeed(` …）；⑰ 切出 `lifecycleDeps()` 断言里面递的是**真模块函数**，且**函数名是从 `LONG_TERM_TASKS` 里取出来的**而不是写死的（写死的话，一次改名只改一头，这条断言自己也得跟着改——而它本来该负责把这种不一致指出来；S11d 期间 `initJmcomicQueue` 改名就是这么被抓住的）；⑱ **spy deps ⇄ `lifecycle.ts` 真正读的 `deps.*` 结构对账**（`deps.<a>.<b>(` 每对都必须在 spy 上是函数、`deps.<a>` 每个名字都必须有值）。**这条是 S11d 补上的，起因是一个真实的交付缺陷**：S11c 交付时 `spyDeps` 写的是 `jmcomic.initialize`，而 `LifecycleDeps` 是 `jmcomic.init` —— 纯结构接口，`.mjs` 又不受 `tsc` 管，**编译器永远看不见**；运行期抛 `deps.jmcomic.init is not a function`，**一个未捕获异常中止了整个套件**，本行之后的每条断言（顺序、逆序、闸门、全部接线与无按键分发的文本扫描）**一条都没跑过**，而人看到的只是一个 TypeError。⑲⑳㉑ **无按键分发**（这是"装配清单 vs 被禁注册表"**唯一**的机检边界）：`LIFECYCLE` 这个词在**全 `src/`** 只出现在 `lifecycle.ts`（`app.ts` 只经 `startLifecycle`/`stopLifecycle` 触达，不点表名）、不存在 `LIFECYCLE[动态键]` / `LIFECYCLE….(find|filter|get)(`、遍历函数只出现在 `lifecycle.ts` 与 `app.ts` 两处。**⚠️ 这两条文本扫描必须先 `stripComments()`**——`lifecycle.ts` 的头部注释里就写着 `LIFECYCLE[动态键]` 与 `.find(`，不剥注释会把自己的文档打红（§9.5 第 13 项是同一个坑）。**第 4 段（S11d：死代码与空转事件收口，5 条）** —— ⚠️ **这一段全是文本扫描，因为它盯的东西"删与不删运行期完全一样"**：㉒ 七个死符号/字面量（`scheduleConfigSave` / `saveTimers` / `AgentEventMap` / `AgentPhase` / `VisionScanPayload` / `EVENTS.visionScan` / 字面串 `'vision-scan'`）在**全 `src/`** 绝迹；㉓ **更强的一条**：`core/config.ts` 里一个 `setTimeout`/`setInterval` 都没有（它是纯同步模块）——这条就是"把 `scheduleConfigSave` 加回来"这个探针的直接靶子；㉔ `llm/vision-scan.ts` / `web/routes/providers.ts` / `agent/maintenance/memory-consolidator.ts` 三个文件里 `emit` 一词彻底消失（比逐个发射点耐改）；㉕ `orchestrator.ts` 的 `new MemoryConsolidator({…})` **实参对象**里没有 `emit`（照 `t-ports.mjs` 第 1c 段解析实参对象——不能只扫全文件有没有 `emit`，那样看不到它挂在**哪个**依赖上）；㉖ **唯一的正向断言**：`providers.ts` 里那个 `const visionScan = { running: false }` 还在、`visionScan.running` 仍被读写了 ≥4 处——**防的正是"照着 grep 结果一把删干净"**：那是个**同名但活的**本地对象（`/api/vision/results` 的 `scanning` 标志 + `/api/vision/scan` 的并发闸门），删了它没有任何断言会红（HTTP 层没覆盖这个字段）。**第 5 段（S11e：electron 的 `before-quit` 真的等 `stop()`，6 条）** —— 同样是纯文本扫描（`electron/main.js` 带副作用、import 不了；"退出会不会挂住"只有真起 Electron 才看得见），扫的是 `before-quit` **处理器的函数体**（用 §4 那个 `argObjectOf` 按花括号配平切出来，不是全文 `includes`）：㉗ 体内有 `event.preventDefault(`（不拦就等于没等）；㉘ `quitting = true` 出现在 `preventDefault` **之前**（关窗缩托盘不能抢在退出前面）；㉙ **守卫** `if (stopping) return;` 存在且排在 `preventDefault` 之前（缺它则第二次 `app.quit()` 拦下自己 → 死循环）；㉚ 关停走 promise 链（`Promise.resolve(` + `core.stop()`，同步抛错才逃不出处理器）；㉛ 有 `.catch(`（抛错只记日志、不阻断退出）；㉜ `.finally(` 之后确实又调了一次 `app.quit()`（否则 `preventDefault` 之后**应用永远不退**）。㉙ 与 ㉜ 分别对应两个真实的坑：前者是死循环、后者是"再也不退"——都不会让任何行为套件变红 | **ASSERT**（已落地） | S11a / S11c / S11d / S11e |

**规矩**：每个新 `t-*.mjs` **必须在 `tests/run.mjs` 的 `ASSERT` 或 `DIAG` 数组里归类**，否则 runner 直接报错退出（`run.mjs` 的清单校验段）。S4/S5/S6/S7 都没加新套件，只往既有的两个里加断言（S4/S5/S6 之后仍是 19 个 ASSERT）；**S8 加了 `t-ports.mjs`，S9 加了 `t-tasks.mjs`（21 个），S10a 加了 `t-timers.mjs`，S11a 加了 `t-lifecycle.mjs`，现在是 23 个 ASSERT + 10 个 DIAG = 33 个套件**。

**跨边界的那条断言住在 `t-panel-wiring.mjs`**（它本来就同时读 `ui/js` 与 `src/`，`agentRunnerTs` 就是这么读的）：把 `core/events.ts` 的词表解析出来，断言"**UI 里 `es.addEventListener('<name>')` 的每个名字都在词表里**"。理由见 §4.6——发射端与订阅端分居两种写法、两层，改名只改一边时**不会报任何错**，这是 S4 这类改名的头号事故模式。`t-sse-project.mjs` 钉的是帧形状（只管 `session-update`），`t-smoke.mjs` 不读 SSE，所以这个缺口此前无人守。

⚠️ **`t-events.mjs` 扫 `src/` 而不是 `dist/`**：这条不变量是"源码里还写不写字面量"，而 `dist/` 里躺着 **29 个旧扁平路径的陈旧产物**（`dist/app.js`、`dist/orchestrator.js`、`dist/tools.js`、`dist/personas.js`、`dist/prompt.js` 等）——`tsc` 只写不删，目录重排那次提交之后它们再没被覆盖过。按目录 glob 扫 `dist/` 会把它们一起收进来，扫出几十处 `src/` 里根本不存在的字面量。静态结构类断言直接读 `src/` 有先例（`t-agent-structure.mjs` 就是读 `ROOT/src/agent`）。这些陈旧产物**没有实际入口**（`electron/main.js` 引 `../dist/web/app.js`，`npm run server` 跑 `dist/web/server.js`），清理它们属于构建卫生，不在迁移步骤内。

### 9.4 真机冒烟边界

以下本次**不做**，也不可能靠套件覆盖，必须人工真机验证，且不得擅自操作真实账号：

- 真实 Electron 窗口、托盘、SnowLuma 子进程拉起的完整启动链路；
- 真实 OneBot / SnowLuma 连接下的入站事件（尤其 §2.1 那些"静默丢弃"的类别）；
- 真实退出路径（`before-quit` → `stop()`；无头 `SIGINT` / `SIGTERM`，含 **S11a 的"连按两次 Ctrl-C"**：第一次应优雅退出、第二次应立刻强退，且第一次的信号真的送达时进程是否干净退出）；
- **S11e 之后桌面端的退出要真机走一遍**（托盘"退出"）：预期是**窗口先关、进程等关停日志打完才消失**（而不是"窗口一没进程就没了"），关停日志完整、无"任务停到一半"的痕迹；再从"关窗缩托盘"回头验一次——退出期间关窗**不应**再缩托盘（那是 `quitting` 先置位那条不变量）。**同一次真机里顺带回答 roadmap 的未尽事项③**：`proactive.bubble` 那个**没 unref** 的计时器会不会真的把进程钉住——它在 `stop()` 里会被停掉，所以正常情况下观察不到；**要观察它，得让退出路径不经过 `stopLifecycle()`**（例如在 `before-quit` 里临时注释掉 `stop()`），这是**一次有意的、只在本机做一次的实验**，别把它留在代码里；
- **S11c 换过的那一对停止次序**：退出时 `jmcomic` 现在先于 `price.feed` 被停（逆序的结果）。两者互不依赖，预期无观感差异，但**"没有观感差异"本身要人看一眼**才能算数——确认进程干净退出、无残留 interval、无在途上传被打断、`abortAll()` 与清单各停一次 proactive/compact 不产生异常日志；
- **S11d 删掉 `vision-scan` 之后，设置页的"视觉能力扫描"要人工点一次**：这个功能的行为面**完全靠 HTTP**（`POST /api/vision/scan` → 202，然后 `GET /api/vision/results` 的 `scanning` 标志与结果表），事件从来只是空转的旁路。套件覆盖的只有"发射点没了""那个本地 `visionScan` 对象还在"这类文本事实，**"点下去还能扫、结果还能刷出来、按钮的进行中状态还会回来"没有任何套件覆盖**——删事件与删那个同名本地对象在套件里长得几乎一样，只有人点一次才能区分；
- 进程退出语义的任何变化（§7.4，尤其若将来定性并改动 `proactive` / `jmcomic.worker` 的 unref）。

### 9.5 本文档自身的验证（S0 交付时）

1. **完整性自查**：附录 A/B 必须逐条对上
   ```bash
   grep -rnE "emit\??\.?\(['\"]" src/                  # 61 个发射点
   grep -rnE "(setTimeout|setInterval)\s*\(" src/ electron/   # 26 个调度调用点
   ```
   两条命令与当时的计数（61 / 26）已在 §3.2 与 §6.1 给出；附录 A 的逐名计数已与源码核对一致。
2. **一致性**：文中每个事件名、方法名、任务名、`file:line` 都能在源码中搜到；不出现文档特有名词。
3. **S0 时不改代码**：`git status` 只多出文档与 `AGENTS.md`；`npm run check` 不受影响，27 个套件全绿。
4. **人工复核**：按 7 问逐条对照 §1.3 的禁令，确认没有偷偷写实现代码，也没有把禁止项（启动/退出/配置刷新）写进本阶段。
5. **S1 之后的复核**（已做）：`npm run check` 18 个 ASSERT 全绿；§3.4（三）的"通道无效"结论用 `git log -S` 回溯到初始提交核实过，不是回归。
6. **S2 之后的复核**（已做）：`npm run check` 全绿，层级检查 66 → 67 个源码文件（新增的 `core/events.ts` 记在 0 层）；两条编译期护栏都用"故意写错再还原"实测过会报 `Type 'false' does not satisfy the constraint 'true'`，不是写了没生效的装饰。
7. **S3 之后的复核**（已做）：
   - `npm run check` 全绿（19 个 ASSERT 套件，4.2s），层级检查 67 个源码文件。
   - **"值不变"是逐名核对过的**，不是靠"看 diff 像"：把 `core/events.ts` 的键→值读出来，把工作区里的 `EVENTS.<key>` 还原成字符串，与 `git show HEAD:<file>` 的 `emit('name'` 名字多重集逐文件比对 → **60 处改名点、0 个不匹配**。合计 60 + `orchestrator.ts` 那处未改 = HEAD 的 61 处。
   - **新闸门确实会红**：在 `src/web/routes/system.ts` 里临时把一处改回 `emit('chat-update', '*')`，看到 `t-events.mjs` 报出该 `file:line` 与事件名后还原。
   - 附带发现的 `dist/` 陈旧产物见 §9.3 的警告——它决定了 `t-events.mjs` 的扫描根，不影响任何入口。
8. **S4 之后的复核**（已做）：
   - `npm run check` 全绿（19 个 ASSERT 套件），`grep -rnE "emit\??\.?\(\s*'" src/` 与 `grep -rn "addEventListener('status'" ui/` **都返回空**——发射端与订阅端的 `'status'` 同时绝迹。
   - **两条新断言都实测会红**：① 把 `ui/js/main.js` 改回 `es.addEventListener('status', …)`，`t-panel-wiring.mjs` 报出 `status 不在 EVENTS 里 → 发射端改了名而订阅端没跟上，或拼错了`；② 把 `orchestrator.ts` 的发射点改回 `emit('status', …)`，`t-events.mjs` 同时报出**两处**失败——发射点有字面量，且 `orchestratorPause` 成了没有生产者的空转名字。两处都还原后才全绿。
   - **行为不变的依据**：拆分前后 UI 的处理函数是同一个 `refreshStatus()`（旧那条也是），且全仓搜索确认 `'status'` 事件没有 UI 之外的消费者。
9. **S5 之后的复核**（已做）：
   - `npm run check` 全绿（19 个 ASSERT 套件；`t-events.mjs` 因为要真跑两轮 agent，从 70ms 涨到约 280ms）。
   - **"四个形状都符合 `SessionEndPayload`"是实测的**：编译期用一次性标注探测（四处 `emit` 临时改写成带类型的 `const _probe`），报出**恰好三处**不满足、全部指向 `error`/`finishReason` 这对字段；放宽后四处通过（退出码 0）；探测代码随后删除，`grep -c _probe src/agent/runtime/*.ts` 全部为 0。
   - **新断言实测会红**：把 `agent-runner` 改回 `sent: session.sent.length`，`t-events.mjs` 四条断言同时失败，诊断信息里能直接看到 `sentCount=undefined` 与多余的 `sent` 键。
   - **`SessionEndStatus` 收窄确实拦得住**：把某个 `#finishWaiting` 调用点的 `'aborted'` 改成拼错的 `'abort'`，报 `TS2345: Argument of type '"abort"' is not assignable to parameter of type 'SessionEndStatus'`，还原后通过。
   - 顺带确认 `wake-scheduler.ts:556` 那个**局部变量** `sentCount` 与本次改名的字段无关（不同作用域，无冲突）。
10. **S6 之后的复核**（已做）：
   - `npm run check` 全绿（19 个 ASSERT 套件，4.5s；`t-events.mjs` 约 330ms）。
   - **"零运行时差异"是实测的，不是推断的**：S6 的改动全部是类型标注 / 类型别名 / 注释，所以先把 build 前的 `dist/` 整体复制出来，改完再 `tsc`，`diff -rq` 的结果是**所有 `.js` 逐字节相同**——只有 `.js.map`（源码映射里嵌了注释文本）与 `tsbuildinfo` 变了。这比"把改动读一遍、确认都是类型"强得多，也顺带证明了那 13 处标注没有一处悄悄改变求值。
   - **新护栏实测会红（5 条全过）**：`chat-update` 发对象 → `TS2345`（6 处）；`session-end` 少 `sessionId` → `TS2345`；发词表外的事件名 → `TS2345: Argument of type '"no-such-event"' is not assignable to parameter of type 'AppEventName'`；`orchestrator-pause` 少 `paused` → `TS2345`；`session-end` 的 `status` 写 `'finish'` → `TS2322: Type '"finish"' is not assignable to type 'SessionEndStatus'`。
   - **`t-events.mjs` 新增的两条也实测会红**：把 `wake-scheduler` 的注入点退回 `(event: string, payload?: unknown) => unknown` → 5a 报出该 `file:line`；把 `memory-consolidator` 的标注改成 `(...args: any[]) => void`（**故意留着那行 `import type { AppEmit }`**）→ 5b 报"少了"；让 `core/util.ts` 也用上 `AppEmit` → 5b 报"多了"。三条都还原后才全绿。
   - **一处计划外但必需的改动**：`AppEventMap['session-update']` 由 `{ sessionId: string }` 改成 `string`。这不是新决定，是 S6 翻类型时编译器把 12 个裸串发射点全点出来了（恰好 12 条），按"只写事实"的既有口径记成今天的载荷，S7 再翻回去（§4.4 末、§4.2 修正表、§8.2）。
   - 顺带确认两件事：① `AppEventMap` 只约束**载荷**，约束不了事件名——`this.emit('chat-update', key)` 与 `this.emit(EVENTS.chatUpdate, key)` 在编译器眼里完全一样，所以"不许写字面事件名"仍只能靠第 1 段的文本扫描守，**两道闸门互补而非重复**；② `agent-runner.ts` 里本来没写类型的 `const ctx = {...}` 必须补成 `const ctx: ToolContext = {...}`，否则传给 `ToolContext.emit` 的那个箭头拿不到上下文类型、参数退化成隐式 `any`（`TS7006`，实测报在这里）。
11. **S7 之后的复核**（已做）：
   - `npm run check` 全绿（19 个 ASSERT 套件，4.4s）；`t-events.mjs` 22 条断言（原 17 + 新增 5），约 314ms。
   - **接缝如期生效**：类型翻回 `{ sessionId: string }`、12 处发射点改发对象，`npm run typecheck` 一次通过——S6 曾预报的"只改类型不改载荷会让那 12 处编译不过"是实打实的（S6 时那 12 条 `TS2345` 就是它）。
   - **新断言实测会红（3 条，覆盖两个方向）**：① 把 `agent-runner` 的 5 处发射点退回裸串（`session.id as any`，模拟 S7 之前的真实状态）→ 第 6 段三条断言同时失败，诊断信息里能直接看到退化的帧 `data: "muks…"`；② **只改投影入口条件**（加上 `&& Array.isArray(payload.sent)`，这是一个 typecheck 完全管不到的回归）→ 18/18 条帧全部退化、两条断言红；③ 用 `as any` 绕开对象字面量的多余属性检查、往载荷里多塞 `messages` → 只有"瘦事件"那条红。三条都还原后才全绿。
   - ①与②是**两个不同的方向**，这正是本段存在的理由：`npm run typecheck` 守得住"发射点别退回裸串"，守不住"投影入口条件被改窄"——后者改完编译通过、形状看着也对，只有真跑一遍投影才看得出来。
   - **`t-sse-project.mjs` 不需要翻面**（原本预期要）：投影函数一个字没改，S7 改的是**谁**给它送对象。它钉的裸串→通用帧那条从"今天的事实"变成"兜底路径"，断言本身依然成立。
   - **仍未验证的**：面板在 SSE 与 4s 轮询双写下的真机表现。任何套件都覆盖不到它（见 §10 待定 2）。
12. **S8 之后的复核**（已做）：
   - `npm run check` 全绿（**20 个 ASSERT 套件**，4.7s；`t-ports.mjs` 8 条断言、约 150ms）；`check-layers.mjs` 68 个源码文件通过。
   - **零运行时影响是实测的**：`control-port.ts` 只含类型与一张常量表，两处引用（`orchestrator.ts:35`、`web/types.ts:9`）都是 `import type`，编译期擦除。`grep -rn --include=*.js "control-port" dist/` 的结果只有 `control-port.js` 自己的 sourceMappingURL——**没有任何模块 `require` 它**，`dist/` 里只多了一个没人引用的文件。`implements` 同样是擦除的。
   - **调用点零改动**：`web/types.ts` 把 `orchestrator: Orchestrator` 换成 `orchestrator: AgentControlPort` 之后，全 `src/web/` 与 `electron/main.js` 一行没动就编译通过。这正是端口的验收判据（§8.3）——落地时恰好靠它发现设计稿漏了 4 个只读状态字段。
   - **6 条编译期证伪**（探针改文件 → 跑 `tsc --noEmit` → 还原，逐字节核对）：
     - A. `AgentControlMethod` 若不过滤只读状态字段（把条件类型里的调用签名判断去掉）→ `TS2322: Type '"paused"' is not assignable to type 'AgentControlMethod'`（名录里多了 `paused` 键）。
     - B. 名录漏登记一个方法 → `TS1360`（`satisfies` 不满足）。
     - C. 名录多写一个不存在的 `bogusMethod` → `TS2353` 多余属性。
     - D. 往端口加方法但名录没跟上 → `TS1360` + `TS2420 Class 'Orchestrator' incorrectly implements interface 'AgentControlPort'`。
     - E-反. 端口声明了 `Orchestrator` 没有的方法 → `TS2420` + `TS2741 Property 'addedLater' is missing`。
     - **E-正. 删掉 `orchestrator.ts:37` 的 `implements AgentControlPort` → 一个错误都不报。** 这是本步唯一的静默失效：端口从此没人校验，`web/` 照样编译、照样运行。它就是 `t-ports.mjs` 第 1 段必须存在的全部理由。
   - **`t-ports.mjs` 的运行时证伪（5 条，全部按预期变红；探针跑完逐字节还原）**：
     - A. 删掉 `implements` → 红，**`tsc` 绿**（编译器管不到，只有文本扫描拦得住）。
     - B. 端口加一个没人用的成员（接口 + 名录 + 实现三处补齐）→ 红，**`tsc` 绿**。这条是写套件时**当场发现的自有漏洞**：原本的 `PORT_METHODS` 只是手工转写，没有任何东西核对它与接口本身是否一致，于是"往端口加死成员"全绿溜过。补了第 1b 段（解析 `control-port.ts` 的接口体，与清单对账）之后才拦住。解析时必须**只认两空格缩进的成员行**——四空格的是多行签名的续行（`consolidateMemoryForChat` 的 `options?: …`），会被误读成成员名。
     - C. 名录里某个 `owner` 指向不存在的文件 → 红，**`tsc` 绿**（编译期只能保证它是 `string`）。
     - D. `src/` 里有人引用 `METHOD_CATALOG` → 红（"它开始参与分发了"）。
     - E. 真实例上少一个端口方法（直接改 `dist/` 模拟实现漂移）→ 红。
   - **探针自身踩的两个坑**（下次写同类探针注意）：① `METHOD_CATALOG` 是从 `dist/` 加载的，所以改 `src/` 之后**必须重新 build** 探针才看得见（改 owner 那条一开始"没变红"，就是这个原因，不是套件的问题）；② 还原清单要覆盖 `dist/` 侧新生成的产物（`dist/agent/runtime/control-port.js`），否则上一次探针的改动会被下一次当成"原文"读进来，污染后续所有用例——实测出现过一次，重建 `dist/` 后重跑才得到干净证据。
13. **S9 之后的复核**（已做）：
   - `npm run check` 全绿（**21 个 ASSERT 套件**，4.8s；`t-tasks.mjs` 11 条断言、约 153ms）。`check-layers.mjs` 68 个源码文件通过（`tasks.ts` 在 `web/` 层，不新增任何依赖边——它零 import）。
   - **落地前三处现实核对，其中一处推翻了设计稿**：
     - **"7 个长期任务"是计数错误，真任务是 6 个。** 它是照 §6.3 的表行数数出来的，而那张表第 7 行 `wake.debounce` 自己标着"排除（算局部计时器）"。按本文自己的分界线（§6.1）它就该是**反向断言的目标**，不是表的一行。§6.1 与附录 B 已更正。
     - **26 处调度点的分类与文档一致**：逐条过 `grep -rnE "(setTimeout|setInterval)\s*\(" src/ electron/`，9 处属 6 个长期任务、17 处是局部计时器。没有第三类。
     - **表的每一句声明都实测过**：`typeof priceFeed.stopPriceFeed !== 'function'`、`typeof jmcomic.stopJmcomicQueue !== 'function'`、两个模块 `import` 之后不产出任何计时器（加载期无副作用）、`OneBotClient.prototype.connect` / `.close` 都是函数、三个配置键（`proactive.enabled` / `compact.enabled` / `api.priceRemoteUrl`）在真实 `getConfig()` 上取得到且类型与 `kind` 相符。
   - **9 条运行时证伪**（探针改文件 → 跑套件 → 逐字节还原；`rebuild` 默认为真）：
     - A. 表里加一行幽灵任务（`owner` 指向不存在的文件）→ 红（③）。
     - B. 把 `wake.debounce` 收进表 → 红（④，反向断言生效）。
     - C. `conformance` 谎报：给 `price.feed` 标 `full` → 红（⑥）。
     - D1. `enabledBy.path` 写错（`proactive.enabled` → `proactive.enable`）→ 红；D2. `kind` 与配置值类型不符（`api.priceRemoteUrl` 标 `boolean`）→ 红（⑤）。
     - E. 入口名字写错（`startProactiveLoop` → `startProactive`）→ 红（⑧）。
     - F. **给 `price-feed` 补上 `stopPriceFeed` 导出却不升级 `conformance`** → 红（⑦的实名断言）。这条验证的是"实名断言做成双向"这个设计的价值：它不是"再抄一遍现状"，而是**一份到期的提醒**。
     - G. `src/` 里有人引用 `LONG_TERM_TASKS` → 红（⑩）。
     - H. `tasks.ts` 自己写一个真 `setTimeout(` → 红（⑨，纯数据断言）。
   - **5 条"剥注释"的双向证伪**：S9 期间 `npm run check` 抓到一次真交叉冲突——`tasks.ts` 的**注释**提到隔壁的 `METHOD_CATALOG`，把 t-ports 第 6 段打红了。判断为**断言的误报模式**（注释不参与任何逻辑）而非注释的错，于是新增共享的 `stripComments()`（`tests/lib/src.mjs`）并在 t-ports 第 6 段、t-tasks ⑨⑩ 处使用。随后**双向重验**：代码里真引用 `METHOD_CATALOG` → 红、只在注释里提 → 绿；代码里真调用 `setTimeout(` → 红、注释里写 `不要这样写 setInterval(fn, 1000)` → 绿。四处都如期。
   - **行号重新基线化**：S9 收尾时把附录 B / §6.3 / 附录 C 的每一个 `file:line` 都对了一遍源码，**8 处已漂移、其余全部仍然准确**，对照表写在附录 B（长期任务那 9 个调度点一个没漂）。这是"清点文档"特有的腐化方式——**内容对、行号错**，而按行号跳会读到完全无关的代码，比没有行号更误导。
   - **探针自身踩的三个坑**（与第 12 项的两个合起来是同一类问题的完整清单）：
     - ① **锚点必须锚在数组声明行**，不能锚在某一行 `id:` 之前。前者会拼出两个左花括号 → `TS1136` → `execFileSync` 抛出；而当时 `probe` **没有 `try/finally`**，`restore()` 被跳过，**改坏的文件留在盘上、`dist/` 停在失败构建的状态**。修法：锚定 `export const LONG_TERM_TASKS: LongTermTask[] = [`（并校验 6 个 id 与 typecheck），且 `probe` 一律 `try/finally`。
     - ② **跨行锚点在 CRLF 上匹配不上**（本机检出全是 CRLF）。修法：`sub()` 改成按 `\n` 切分、逐段转义后以 `\r?\\n` 连接成正则，替换文本的换行归一成 `\r\n`。
     - ③ **`rebuild` 必须默认为真**：套件读 `dist/`，而 `restore()` 只还原源码。S8 已经踩过一次（改完不重建 → 探针"没变红"），S9 里 B、F 两条重建过 `dist/`，所以最终的探针骨架把 rebuild 设成默认行为，而不是每处手写。
14. **S10a 的 4 条证伪探针**（这一步是 S10+ 里唯一**修了真 bug** 的一步，所以每条断言都单独证伪过）：
   - ① **删掉 `app.stop()` 里的 `stopPriceFeed()` 接线** → `t-timers.mjs` 第 2 段的"stop 之后回到基数"红（实测：活动 interval `2` 个，start 之前 `1` 个）。**这条是补出来的**——初版 `t-timers.mjs` 只调模块自己的 `stopPriceFeed()`，删掉接线照样全绿，等于"证明模块有能力停"却没人证明"app 里接上了"，正是 §9.5 第 11 项那条教训的同一个形状。
   - ② **把 `tasks.ts` 的 `price.feed` 行 `stop` 撤成 `null`（`conformance` 仍写 `full`）** → `t-tasks.mjs` 的 conformance 断言红（`price.feed 标着 full，但 start=有、stop=无`）。这是"静默失效方向"的那个探针。
   - ③ **把 `initPriceFeed` 还原成最初的形状（先无条件清 timer、再判早退）** → `t-timers.mjs` 的"同 URL 再调一次后定时器仍然活着"红（实测：活动 interval `0` 个、被清 `1` 个）。**这条探针第一版是错的**：当时只去掉早退条件里的 `&& timer`，结果**绿**——因为这次改法已经把清理挪到早退**之后**，所以"少一个条件"与"正确版本"在那个断言上表现相同。**真正的缺陷是顺序（先清后判），不是条件少了一个**。教训：证伪一个 bug 时必须**还原成 bug 的原始形状**，而不是"朝 bug 的方向挪一步"——挪一步可能落在等价类里，于是得到一条假的绿。
   - ④ **删掉 `stopPriceFeed` 导出** → `tsc` 报 `TS2459` 且点名 `stopPriceFeed`（`src/web/app.ts:25`，今天是 **:18**）。证明 src 侧的接线是**编译期**守住的（`src/` 里漏接线会当场编译不过），而不必靠套件。
15. **S10b 的 5 条证伪探针**（4 条如期变红，第 5 条是**如实记录的覆盖空白**）：
   - ① **删掉 `app.stop()` 里的 `stopJmcomicQueue()` 接线** → `t-timers.mjs` 第 3 段的"归零"断言红（实测：活动 interval 还剩 `1` 个）。与第 14 项①同形，说明"接线要有自己的断言"这条已经在两步里各兑现一次。
   - ② **把 `tasks.ts` 的 `jmcomic.cleanup` 行 `stop` 撤成 `null`（`conformance` 仍写 `full`）** → `t-tasks.mjs` 的 conformance 断言红（`jmcomic.cleanup 标着 full，但 start=有、stop=无、stopCancelsPending=false`）。静默失效方向。
   - ③ **删掉 `scheduleNextWake()` 开头的 `if (!runtime) return`** → `t-timers.mjs` 的"worker 收尾时队列已被停 → 不再排新 wake"红（实测：排了 `1` 个 timeout）。这条是 S10b 的核心守卫，**只有真跑一次 worker 才走得到**（stub 的 `onebot.call` 在上传途中停队列），所以第 2 段才要备那份带真 PDF 的 `jobs.json` 夹具。
   - ④ **把 `initJmcomicQueue` 搬回 `Orchestrator` 构造函数（连同 import）** → `t-timers.mjs` 第 3 段的"`createApp()` 期间一个长期 timer 都没起"红（实测：构造期间建了 `1` 个 interval）。**两处都要加回去**，只加调用处的话只是 `tsc` 编译失败——红是红了，但红的理由不对，证明不了那条断言在守什么。
   - ⑤ **删掉 `runWorker` 的 `while (runtime && …)` 里的 `runtime &&`** → **仍然全绿（实测 exit 0）**。这是**已知的守护空白，如实记录**：要观察到它的差别，夹具里得同时有"可跑的任务 A（在它的上传回调里停队列）"和"可跑的任务 B"，而 B 会留在模块内存里过继给后面真起 app 的那一段（那时它会带着真 `onebot` 去上传）。所以那道闸门**只有注释在守**——`t-timers.mjs` 头部与 `jmcomic.ts` 的对应注释里都写明了，免得以后误以为它被管着。

16. **S10c 的 6 条证伪探针**（全部如期变红；**其中第 2、3、5 条第一版是假绿，修了夹具才拿到真证据**——这是本步最有价值的一条记录）：
   - ① **删掉 `close()` 里的 `#cancelReconnect()`** → `t-timers.mjs` 的"close() 取消掉待触发的重连"红（实测：被清 `0` 个、还剩 `1` 个）。这一条是本步的主断言（`tasks.ts` 那行 `full` 的全部依据），单独证伪。
   - ② **删掉 `connect()` 里的 `#cancelReconnect()`** → 第一版**全绿**。原因是夹具只用"非法 URL 让构造同步抛错"，于是第二次 `connect()` 仍会走 catch → `#scheduleReconnect()` → **它自己"先清旧再存新"把手柄清了**，被测的那一行删不删都一样。修法：让**新的 socket 真的建得出来**（换成一个构造函数不抛的地址，`new WebSocket` 不同步建连、不依赖联网），构造成功时不再排定，旧句柄就只剩那一行能取消它 → 变红。**并给这条夹具加兜底断言 `client.socket !== null`**：哪天那个地址也开始抛错，先红的是它，而不是让本段悄悄退回假绿。
   - ③ **删掉 `reconnect()` 里的 `#cancelReconnect()`** → 同 ②，第一版假绿、换夹具后红（实测：被清 `2` 个、还剩 `1` 个）。
   - ④ **删掉 `#connectLoop` 的 `#closedByUs` 早退**（只留"不再排定"那一道闸门）→ `t-timers.mjs` 的"第二道闸门"红（实测：close() 之后迟到的句柄触发时又多排了 `1` 个 timeout）。**保留它是有据的，不是顺手留的**。
   - ⑤ **把 `socket.on('close')` 那一处退回裸 `setTimeout`** → 第一版只有 `t-tasks.mjs` 的**文本扫描**红（`t-timers.mjs` 全绿：`close` 事件那条路在夹具里从没被走到）。补法是在 t-timers 里**手动 `emit('close')`** 把那个处理器同步跑一遍，再断言句柄存了、且 `close()` 取消得掉 → 两处排定现在都被行为断言管住。**教训：一个模块里有两处同类排定时，"测到其中一处"不等于"两处都被管着"。**
   - ⑥ **`tasks.ts` 把 `onebot.reconnect` 的 `stopCancelsPending` 撤成 `false` 却仍写 `conformance: 'full'`** → `t-tasks.mjs` 的 conformance 一致性断言红。这是**静默失效方向**（表里写着 `full` 但现实不是），与第 14/15 项的同类探针同形。

17. **S10d 的 5 条证伪探针**（全部如期；其中 1 条**推翻了 §5.6 原先的估计**）：
   - ① **撤回 `t-orch.mjs` 的 `emit`（只改第一处构造点）** → 该套件**当场炸**：`TypeError: this.emit is not a function`，栈在 `WakeScheduler.scheduleWake`（`t-orch.mjs:39` 的第一次 `orc.scheduleWake(key)`）。**我原本按 §5.6 的估计写"期望它仍然是绿的"，实测红了** —— 于是修正了本节与 §5.6：这 8 个构造点里"删掉也全绿"的**只有 `t-ports.mjs` 自己那一个**，其余一旦被真正使用就会炸。这条探针的价值不在"变红"，而在**它纠正了一条文档里的错误结论**（第一版探针的期望值写错，是因为把"没被调用过"当成了"不会被调用"）。
   - ② **撤回 `t-panel.mjs` 的 `emit`** → `t-panel.mjs` 红（`compactChat` → `HistoryCompactor` 的 `emit`）+ `t-ports.mjs` 第 1c 段红。
   - ③ **把兜底总线整段加回 `orchestrator.ts`（连同 import 与三元表达式）** → `tsc` 仍绿（说明"加回去"是自洽的写法），`t-ports.mjs` **只有**第 1c 段①那条源码文本断言红。正是"删掉不报错"的反面：**加回去也不报错，只能靠文本断言发现**。
   - ④ **只把 `types.ts` 的 `emit` 退回可选（不动实现）** → `tsc` 立刻失败（`this.emit = emit` 不可赋值）。证明 `src/` 侧完全由编译器守，不需要额外套件。**注意探针必须成对看**：③ 与 ④ 合起来才说明"这道改动由两道闸门分管——`src/` 归 `tsc`，`tests/` 归文本扫描"。
   - ⑤ **撤回 `t-ports.mjs` 自己那一个构造点的 `emit`** → 该套件的 11 条断言里**只有 1c 那条红，其余 10 条全绿**（实测，探针脚本里专门数了红了几条断言）。这是本步**唯一真正的静默失效**，也是第 1c 段存在的全部理由：没有它，"忘了补 `emit`"会以一条全绿的套件收场。

18. **S11a 的 5 条证伪探针**（全部如期变红，其中 2 条的红法是**实测出来**、与预期不同的，如实记在下面）：
   - ① **正向：删掉 `server.ts` 的 `process.on('SIGTERM', …)` 那一行** → `t-lifecycle.mjs` 的"headless 入口同时注册 SIGINT 与 SIGTERM"红（实测：`6 通过 / 1 失败`，报告 `实际注册了 'SIGINT'`；另一条"每个信号都只走同一个幂等关停"**仍然绿**——正是两个断言各管一个方向）。
   - ② **静默方向：把关停守卫失效（`if (shuttingDown)` → `if (false)`）** → 前三条行为断言全红，实测 `stop` 被调了 **3** 次、强退日志 **0** 条、退出码 **`[0,0,0]`**（而不是预期的 `[0,1,1]`）。**顺带实测到一个比预期更强的结果**：该套件本身以 **exit 13** 收场——强退分支没了之后，第二个信号走进了 `await stop()` 里那个永不 resolve 的 promise，Node 以"顶层 await 未落定"退出（13）。**也就是说这道守卫被删掉时红的不只是断言，整条逃生舱通道都会失效**，这正是它存在的理由。
   - ③ **旁路方向：把 `SIGTERM` 那行改成一个自己 `process.exit(0)` 的处理器** → "每个信号都只走同一个幂等关停"红（实测：报告里直接打出那行源码）。**这条是逐行扫描存在的唯一理由**——全文 `includes('shutdown')` 会因为 SIGINT 那行仍在而放它过去（S11a 之前 `server.ts` 恰好就是这种"自己 exit 的处理器"）。
   - ④ **静默方向：catch 里不再报告错误（`deps.onError?.(error)` → `void error;`）** → "`stop()` 抛错也要退出"红（实测：`exits=[0] errors=0`——退出仍发生，只有"报得出来"这一半丢了）。这条证明该断言同时钉住了两件事：**照常退出** 与 **报告出来**。
   - ⑤ **静默方向：整个 `try/catch` 撤掉** → 套件以 **exit 1 收场，但 `❌` 计数是 0**：实测是 `fixture: 关停失败` 从 `await failShutdown('SIGTERM')` 冒出去、栈指到 `dist/web/runtime/shutdown.js:36`，套件在打到第 4 条断言后**崩掉**，根本没走到汇总。**如实记录：这个方向确实红了（非零退出），但红法是一场崩溃而不是一条断言**——所以本条不能拿来证明"那条断言在守它"，真正守 `stop()` 抛错语义的是 ④。

19. **S11b 的 4 条证伪探针**（全部如期变红；其中 1 条**第一版是假绿，改了断言基线才拿到真证据**）。基线：`t-timers.mjs` **41 通过 / 0 失败**。
   - ① **正向：删掉 `applyConfigPatch` 里"比较后重连"整块**（还原成 S11b 之前的形状）→ **2 条红**：真 app 段的"改了 wsUrl → 立刻重连（新 socket 身份不同且非空）← socket=有、身份未变"，以及接线文本扫描那条"`applyConfigPatch` 函数体里同时出现 `applyEndpoint` 与 `reconnect` ← 没有 `applyEndpoint`、没有 `reconnect`"。两个方向各红一条，正是它们各自存在的理由。
   - ② **静默方向：`applyEndpoint` 无条件 `return true`（去掉 `return changed`）** → **3 条红**：真 app 段的"端点没真的变 → 不重连 ← socket 被换掉了 —— 保存一次没动端点的设置就断了一次连接"，加上单元段的 `applyEndpoint({}) → false` 与"`httpUrl` 尾斜杠不算变更"。**这一条是本步最值钱的探针**：它证明"同值不断连"不是巧合，而是那道 `return changed` 撑起来的。
   - ③ **归一化探针：从 `normalizeHttpUrl` 去掉 `.replace(/\/+$/, '')`** → **2 条红**：真 app 段那条同值不重连，与单元段的"`httpUrl` 尾斜杠不算变更 ← `httpUrl="http://127.0.0.1:3000/"`"。**这就是"归一化规则必须只有一份"的实证**：规则一旦在比较的那一侧缺席，用户每保存一次设置就断一次连接，而代码看上去只是"少了个清洗步骤"。
   - ④ **静默方向：在 `applyEndpoint` 末尾加 `if (changed) void this.reconnect();`** → **1 条红**："`applyEndpoint` 只改字段，不自己重连 ← socket 被建出来了"。这条守的是**职责边界**（重连是调用方的决定），不是某项功能——它红了不代表用户会看到错，但会让"比较后重连"这个唯一的决策点分裂成两处。
   - **探针自身踩的坑（新形态，写下来供以后的断言复用）**：③ 的第一版让"没给的字段保持不动"那条也红了，**而那条根本不属于本步的探针靶子**。成因不是断言写错，而是**断言的比较基线取了构造函数的归一化字面量**（`'http://127.0.0.1:3000'`）——而 ③ 探针恰好把构造函数那道归一化也一起拿掉了，于是"归一化不存在"这件事去污染了一条"别的字段有没有被动"的断言。第一次修法（构造后立刻把 `initial` 抓下来）**仍然不够**：断言 ② 本身（拿 `initial.httpUrl` 加尾斜杠去调）就会**先**把 `ep.httpUrl` 改掉，④ 再读就已经不是原值了。最终修法是**在调用的紧邻前一拍重新取一次基线**（`beforeUndefined`），并换一个没被用过的 `wsUrl` 值。**教训：断言的基线不能是一个"系统另一处也会改写/归一化"的常量字面量**——那样的断言会跟它本不拥有的性质一起红绿。
   - **如实说明：删除 `RECONNECT_MAX_MS` 没有正向行为断言。** 它零引用，删与不删运行期完全一样（§9.5 第 15 项⑤是同类"守护空白"，但那条至少还能设想一个夹具；这条连夹具都构造不出来）。它的收口只有三处**非行为**证据：`onebot.ts` 原位那两行说明为什么不做退避的注释、`tasks.ts` 的 `note`、以及附录 C。**不假装它有行为背书。**

20. **S11c 的 5 条证伪探针**（4 条如期变红，**第 4 条如期全绿——它证伪的是本计划的原文**）。基线：`t-lifecycle.mjs` **27 通过 / 0 失败**（S11a 的 7 条 + 本步的 20 条），全量 23 套件绿。
   - ① **正向：`stopLifecycle` 里的 `[...LIFECYCLE].reverse()` 改成正序** → **2 条红**：逆序断言（实际 `["onebot.close","proactive.stop","compact.stop","priceFeed.stop","jmcomic.stop"]`）与"`onebot.close()` 是逆序里最后一个 ← 最后一个是 `jmcomic.stop`"。**这一条是 §7.4 那条顺序约束从"约定"变成"结构性质"之后的第一次实证**：改一个字符，它当场红。
   - ② **正向：在 `start()` 里塞回一行硬编码 `initPriceFeed('')`** → **1 条红**："`app.start()` 走的是清单 ← start() 里还有硬编码的任务调用：`initPriceFeed(`"。这正是 S11c 存在的一半理由——在此之前，这样一行**不会引起任何编译错误或套件变红**。
   - ③ **正向：给 `LONG_TERM_TASKS` 加一行幽灵任务 / 给 `LIFECYCLE` 加一条 `ids: []` 的 entry** → 各 **1 条红 / 2 条红**，都是对账那条（`清单=[…] 描述表=[…ghost.task…]`）。两个方向都验过：幽灵行是"表里有、清单没有"，空 entry 是"清单漏了 id"。**这就是"表里加一行要动两处"的实证。**
   - ④ **⚠️ 前提探针（本计划原文写错了）：把 jmcomic 的两条 id 拆成两条 entry** —— 计划里写的预期是"`initJmcomicQueue` 被调两次 → 两个 interval → `t-timers.mjs` 的'恰好 2'**当场红**"。**实测 `t-timers.mjs` 41 条断言全绿。** 成因是 `startCleanupTimer()` 开头那句 `if (cleanupTimer) return;`（`media/jmcomic.ts:151`）——第二个 interval 根本不会被建出来；`runWorker` 也有单 worker 护栏。**拆开真正会被抓住的地方是本步新加的登记式断言**（`t-lifecycle.mjs` 在此探针下 5 条红：`["…","jmcomic.initialize","jmcomic.initialize"]` 与 `["jmcomic.stop","jmcomic.stop",…]`；标号当时写作 `jmcomic.initialize`，S11d 的 ⑱ 之后统一成 `jmcomic.init`），它们看得见"同一个入口跑了两次"。**结论：合并依然是对的形态**（一条 entry 代表一次真实的装配动作），但**这个理由不能用行为故障来背书**，`lifecycle.ts` 的注释与 §6.2.1 第 2 点已按实测改写。
   - ⑤ **静默方向：在 `lifecycle.ts` 里加一个按键分发的 `startById(id)`（内部 `LIFECYCLE.find(…)`）** → **26 绿 / 1 红，且红的只有文本扫描那一条**（"没有按键分发 ← `src/web/runtime/lifecycle.ts: const entry = LIFECYCLE.find((e) => e.ids.includes(id));`"）。**所有行为断言——对账、顺序、逆序、接线、纯度——全部保持绿色。** 这是本步最值钱的一条：它把"为什么必须有一条文本断言"从论证变成了演示。**按名字分发的运行时注册表不会让任何一个功能坏掉，只会让架构退化**；没有这条扫描，它能在无人察觉的情况下长回来。
   - **⚠️ 交付勘误（S11d 开工时实测）**：本项上面记的"基线 27 通过 / 0 失败"**在 S11d 开工时复现不出来**——`t-lifecycle.mjs` 会在第 3 段的 spy 调用处抛 `TypeError: deps.jmcomic.init is not a function` 并**中止整个套件**（§9.3 ⑱）。也就是说 S11c 的第 3 段后半与全部文本扫描**当时并没有真的跑过**，"27 通过"这个数是不可达的。**这不是措辞问题，是方法问题**：`.mjs` 不受 `tsc` 管，而 `LifecycleDeps` 是纯结构接口，所以"spy 属性名写错一个字母"编译器永远看不见；后果又不是"一条断言红"，而是**后面所有断言静默消失**。S11d 为此补了 ⑱ 那条结构对账（spy ⇄ `deps.*`），把运行期中止变成一条普通的红。**教训：报告"套件全绿"之前，必须确认断言总数与上一次一致**——27 与 33 的差别看得见，而"27 条里其实只跑了 21 条"看不见。
   - **探针自身踩的坑（写给以后的断言）**：`lifecycle.ts` 的**头部注释里就写着** `LIFECYCLE[动态键]` 与 `.find(`（那是文件在设计说明里列出被禁形态）——**不 `stripComments()` 的话，文件会把自己的文档打红**。这与 §9.5 第 13 项是同一个坑（当时是 `tasks.ts` 的注释提到 `METHOD_CATALOG` 打红了 `t-ports`）。本套件的三条无按键分发断言全部先剥注释。

21. **S11d 的 3 条证伪探针**（3 条全部如期变红）。基线：`t-lifecycle.mjs` **33 通过 / 0 失败**，全量 **23 套件绿**。**本步的三条守护全是文本的**——它删的东西零调用者/零消费者，"删与不删运行期完全一样"，行为断言一条都写不出来，所以探针只证明"加回来会被文本挡住"。
   - ① **正向：把 `scheduleConfigSave` 连同一个裸 `setTimeout` 加回 `core/config.ts`** → **2 条红**，且两条各自给出正确诊断：死符号绝迹那条（`scheduleConfigSave 又出现在 src/core/config.ts`）与 `core/config.ts 里没有任何计时器 ← config.ts 里出现了 setTimeout/setInterval`。第二条是刻意加的**更强形态**：它不认名字，只认"这个文件里有没有计时器"，所以换个名字复活同样会被抓住。
   - ② **正向：把 `emit: AppEmit` 加回 `MemoryConsolidatorDependencies`（连带 import）** → **两个套件同时红，方向还相反**：`t-lifecycle.mjs` 的"三个 emit 点再无残留"（`memory-consolidator.ts 里仍有 emit`），以及 `t-events.mjs` 注入点清单报 **"多了（新注入点请登记进 TYPED_FILES）"**。**这是"删注入点"与"从 `TYPED_FILES` 删文件名"必须成对**的实证——那份清单是对称的，只做一半会以"清单多了/少了"的形式报出来，而报的是文件名、不是运行错误，最容易被当成测试噪音忽略。
   - ③ **正向：只把 `visionScan: 'vision-scan'` 加回 `EVENTS`、发射点与载荷都不加回** → `npm run typecheck` **3 条编译错误**，其中 `src/core/events.ts(221,10): error TS2344: Type 'false' does not satisfy the constraint 'true'` 就是文件末尾的 `EveryEventNameHasPayload`。**证明这道编译期护栏真在管**（词表加一个名字却忘了加载荷类型是硬错误），因此它不需要额外套件守；对照 §5.6 那条"事件名不受 `AppEmit` 约束、只能靠文本扫"是两回事：**载荷受编译期管、名字不受**。

22. **S11e 的 3 条证伪探针**（3 条全部如期变红）。基线：`t-lifecycle.mjs` **39 通过 / 0 失败**，全量 **23 套件绿**。守护同样全是文本的（`electron/main.js` import 不了；"退出会不会挂住"只有真起 Electron 才看得见），但与前两步不同：**它盯的不是死代码，而是两条"缺了就挂"的活路径**。
   - ① **静默方向：删掉 `if (stopping) return;` 那一行** → **1 条红**（㉙ 守卫：`没有 if (stopping) return;（或它排在 preventDefault 之后）`），其余 38 条全绿。删了它什么都不会"坏"：第二次 `app.quit()` 会再次进这个处理器并 `preventDefault()` 拦下自己 → **死循环**。真机表现是"点了退出、窗口关了、进程还在"，而**没有任何行为套件看得见**。
   - ② **正向：删掉 `.finally(() => app.quit());`** → **1 条红**（㉜：`.finally( 在 -1、其后 没有 app.quit()`）。这条比 ① 更狠也更安静：`preventDefault()` 之后无人再退，**应用永远不退**。
   - ③ **正向：整个处理器还原成 S11e 之前的同步版本**（`try { core?.stop(); } catch {}`）→ **6 条红**（第 5 段全红 ㉗–㉜），第 1–4 段 33 条**全绿**。这条同时是对照组：旧实现不是"漏了一条断言"，而是**一段都没有**——它照样能启动、能聊天，只是退出时把在途的上传切掉。
   - **一处如实记录的守护空白**：`if (!core) return;` 删掉**不会红**。`core` 为 null 时 `.then(() => core.stop())` 抛 `TypeError` 被 `.catch` 接住，`.finally` 照常 `app.quit()`，只是日志里多一行 `[electron] 退出时关停失败`；它的作用仅是"核心没起来过就别白等一轮"。**不把它写成能力**，§7.4 已注明。
   - 三个探针跑完都从备份还原，`diff` 为空；`git status` 无残留。

23. **web 模块整理的 3 条证伪探针**（**第一条是假绿，修了断言才拿到真证据**——与第 15 项⑤、第 20 项④同属"如实记录的覆盖空白"，但这次空白被就地补上了；第三条则是**如实记录的、本次拆分新引入的**空白）。基线：全量 **23 套件绿**，`t-ports.mjs` **11 通过 / 0 失败**，`t-events.mjs` 22、`t-tasks.mjs` 12、`t-timers.mjs` 41、`t-lifecycle.mjs` 39、`t-sse-project.mjs` 21（各为断言数，不含套件自身的汇总行）。**抽出 `console.ts` 之后这六个数字一个都没变**（`t-events.mjs` 虽然新增了 `TYPED_FILES` 的一行，但那是清单内容不是断言数）——这是"搬运而非改造"的直接证据。
   - ① **静默方向：把 `web/onebot/ingest.ts` 的端口绑定从 `orchestrator` 改名成 `orc`（连同两处 `orc.onIncoming`）** —— 预期是 `t-ports.mjs` 第 2 段的"端口成员与跨模块实际调用的名字一一对应"变红（`onIncoming` 会变成"端口里躺着没人用的"）。**实测全绿：`11 通过 / 0 失败`。**
   - **成因**：那一版第 2 段扫的是**原文**，而 `ingest.ts` 头部注释里写了 `` `orchestrator.onIncoming` ``（纯文档）。注释把 `onIncoming` 留在了 `used` 集合里，于是**端口唯一的 `onIncoming` 调用点已经消失，报告却说"一一对应"**。这不是探针写错——探针指出的是一条真实的守护空白：该段的靶子是"谁在调什么"，而注释里的提及**不是**调用。
   - **修法**：第 2 段改成"**成员集合**从 `stripComments()` 后的文本取、**行号**仍从原文取"（`stripComments` 会吃掉多行块注释的换行，按它数行会漂）。改完重跑：未变异时 `11 通过 / 0 失败`，同一变异下 **`10 通过 / 1 失败` 且退出码 1**，诊断是 `端口里躺着没人用的：onIncoming`。探针随后从备份还原，`diff` 为空。
   - **这条与本文件反复出现的"先剥注释"是同一规则的两个方向**：扫"有没有 X"时，不剥注释会**误报**（注释里提一句就打红，第 13 项、第 20 项踩过两次）；扫"还有没有人在用 X"时，不剥注释会**漏报**（注释里的提及冒充调用）。前者是假红、后者是假绿——**假绿更贵**，因为它让守护静默失效。§9.5 第 13 项当时只记了假红那一半。
   - ② **拆 `console.ts`：切断委托**（在 `handleHttp` 开头插一句无条件 404）。预期"HTTP 表面真的经由新模块"能被行为套件看见。**实测 `t-admin` / `t-window-http` / `t-smoke` 三套件红**，而 `t-web-router.mjs` **保持绿**——它是 `dispatchRoute` 的纯单元测试，根本不经过 HTTP。这条顺带回答了一个容易想当然的问题："谁在管这条链路"不是靠猜的：`t-web-router` 绿并不代表链路通，三条走真 HTTP 的套件才是。
   - ③ **已知守护空白（本次拆分新引入，如实记录、**未**修复）**：在 `web/http/console.ts` 里插一句 `onebot.wsUrl = 'ws://probe.invalid/'`（绕过 `applyEndpoint` 的归一化与比较），**`t-timers` / `t-lifecycle` / `t-events` / `t-smoke` 四套件全绿**。成因：`t-timers.mjs` 第 5 段那条"端点只有一个写入口"的全文件扫描，扫描面写死为 `src/web/app.ts`；HTTP 表面搬到 `console.ts` 之后，代码从扫描面里走了出去，而断言没跟着走。**这次没有修**（把扫描面扩成"整个 `src/web/`"会让 `onebot/*.ts` 一起被卷进来，而那三个文件今天确实不写端点字段——扩面属于独立的一步），改以 `console.ts` 文件头注释明示。**别以为它被管着**。

   - ④ **同一次整理还带出了第四条探针**（`{ proactive: true }` 的缺口），因为它是缩减时顺手问出来的，记在第 24 项。

24. **`Orchestrator` 第一档缩减 + 顺带补上的一条守护**（1 条**假绿**探针，就地修掉）。基线：全量 **23 套件绿**，`t-window.mjs` **55 通过 / 0 失败**（后续为 58）。
   - **缩减本身**（用户指令"按照第一档修改"）：删掉无外部调用者的门面方法 `wake()`（唯一调用点在同文件 :146）并内联为 `wake: (chatKey) => this.scheduler.wake(chatKey, { proactive: true })`；删 `#maybeConsolidateMemory`（零调用者，`:115` 的接线直接调 `this.memoryConsolidator.maybeSchedule`）；删两个纯别名 `this.runSeq` / `this.runtimeState`（全仓零读方）；`toolDefs` 从公共字段降级为构造函数的局部 `const`（`AgentRunnerHost` 的 host 是 **scheduler**，不是本类）；`chatNameCache` 收成私有 `#chatNameCache`。**这些全是零读方/零调用者的符号，删与不删运行期完全一样**——所以缩减本身写不出任何行为断言，它的正确性由"全量 23 套件绿 + 六个套件断言数一个不变"背书。
   - **探针（本条的价值所在）**：缩减把 `this.wake(chatKey, { proactive: true })` 压成了一次直接调用，于是我顺手问了一句"这个 `{ proactive: true }` 有没有人守"——**把它去掉，全量 23 个套件全绿**。这条语义此前**没有任何守护**。
   - **为什么它是"恒为 no-op"而不是"偶尔失灵"**：`ProactiveController.candidates()` 挑的恰恰是**窗口里没有未读**的空闲群（`windows.pending(chatKey).length === 0` 是入选条件之一），而 `wake-scheduler.wake()` 里"窗口里没有未读就早退"的那次判断**被 `proactive: true` 跳过**（同一个标志还负责越过 `isPaused()` 闸门）。所以标志一丢，每一次主动冒泡都会撞死在那条早退上——不是概率问题，是确定性失效。
   - **收口**：`tests/t-window.mjs` 新增第 15 段（3 条断言）。夹具的关键一步是 `store.markRead(K, { ids: [1] })`——**不标已读的话 `ContextWindowRegistry.ensure()` 会把那条未读播种进窗口**，`pending()` 就不是 0 了，于是"有空闲群可唤醒"这个前提被破坏，**无论有没有 proactive 标志都会往下走，这条断言会退化成假的绿**（第一版就是这么写的，前置断言当场红，才发现了这一点）。本套件没有假时钟，所以只在 `startProactiveLoop()` 那一瞬截下它排的 15s tick 再手动触发（`try/finally` 还原 `globalThis.setTimeout`，同 `t-timers.mjs` 的约定）。
   - **实测**：去掉 `{ proactive: true }` → `❌ 主动唤醒真的建出了会话（丢掉 proactive: true 会恒在这里早退）  压根没建会话` / `❌ 1 项失败`；加回来 → `✅ … session=mul3r1j1-d63f06f9 trigger=[]` / `✅ 全部通过`。**注意诊断里的 `trigger=[]`**：主动唤醒**没有触发批**（这正是 `proactive: true` 的第三条语义），普通唤醒这里会是一串消息。
   - **教训**：`{ proactive: true }` 这种"一个布尔值承载三条语义、且只由一处传参"的形态，是**最容易被一次无害的重构抹掉**的——压缩一次调用层级（把 `this.wake(k, opt)` 内联成 `this.scheduler.wake(k, opt)`）就会顺手把它当成冗余参数删掉，而删掉之后**代码看着更干净、所有套件全绿**。§9.5 第 22 项记的是"缺了就挂"的活路径（`before-quit` 的三条不变量），本条是它的近亲：**缺了就永远静默失效**。
   - **⚠️ 后续修正（同日，本条交付时未发现）**：上面这条新增断言**第一版是会随机红的**，因此它交付时那次"23 套件全绿"是**走运**。`ProactiveController.tick()` 是 `candidates[Math.floor(Math.random() * candidates.length)]`——从**所有**合格群聊里随机挑一个；而存档按 `QQ_AGENT_DATA_DIR` 落盘、整个套件共用同一个临时目录，于是本套件前面 9 个小节留下的空闲群**全都合格**，本群被选中只有约 1/N 的概率。实测六次里挂三次（`❌ 压根没建会话`）。**一条会随机红的断言比没有断言更坏**：它把 `npm run check` 变成抽奖。修法是把 `allow.groups` 钉死成本群（+ `allowAllWhenEmpty: false`），使"合格候选"唯一；改后连跑 8 次全绿，证伪探针重测（去掉标志 → 红；加回 → 绿）。**教训：加行为断言前先问"这条断言的前提是唯一的吗"**——凡是依赖"全局状态里只有我一个满足条件"的夹具，都要把条件显式钉死，不能靠"运行到这里时恰好只有它"。


25. **`web/` 按功能与层级搬进子目录**（纯搬运；探针 ① 证明新规则会红、② 证明测试字面量不是被化石喂的假绿、③ **如实记录一条"预期得到绿"的探针**）。
   - **动因**：`web/` 的 24 个文件里 **12 个平铺在根目录**，混了六类东西——组装根（`app.ts`、`console.ts`）、headless 入口（`server.ts`）、领域类型（`types.ts`）、HTTP 原语（`http.ts`/`router.ts`/`static-files.ts`/`event-projector.ts`）、长期任务三件套（`tasks.ts`/`lifecycle.ts`/`shutdown.ts`）、用量读模型（`usage-service.ts`）。`agent/` 早就有"根目录不得平铺实现"的硬规则并由 `check-layers.mjs` 守着，`web/` 一直没做。落点与映射见 §7.6。
   - **纯搬运的证据是"断言数一个不变"**：`t-window` 58、`t-events` 22、`t-ports` 11、`t-tasks` 12、`t-timers` 41、`t-lifecycle` 39、`t-sse-project` 21、`t-web-router` 11，全量与基线逐个对齐（计数口径：每套件 `grep -c "✅"` 减去自身汇总行）。**注意这个口径的坑**：套件失败时断言行与汇总行会一起从 ✅ 变 ❌，于是 `grep -c ✅` **少 2**——先量一遍作基线再对比，否则会把"这条断言红了"误读成"少了两条断言"。
   - **探针①（新规则真的会打红）**：往 `src/web/` 根目录放一个 `probe-tmp.ts` → `check-layers` 阶段失败，打印 `web/probe-tmp.ts: web 根目录只许放组装根/入口/领域类型/读模型，实现请落进子目录`，退出码 1；删掉 → `依赖层级检查通过：75 个源码文件`。
   - **探针②（测试字面量不是被"化石"喂的假绿）**：只把 `t-web-router.mjs:6` 改回 `load('web/router.js')`，**在清过 `dist` 的前提下**跑该套件 → 必须打红（`ERR_MODULE_NOT_FOUND`，未捕获错误直接中止套件）；改回来 → 绿。
   - **探针③（⚠️ 这条的期望是"绿"，它记录的是一个操作事实）**：**先不清 `dist`、只增量 build**，重复探针②的变异 → **`✅ 全部通过：11 通过 / 0 失败`**。原因：`npm run build` 是裸 `tsc`，**不会清理旧产物**，`dist/web/router.js` 这个旧位置的化石还在，Node 照样解析得到（实测 `dist/` 里累计过 **29 个**这类化石）。**所以"纯搬运"的验证在没清 `dist` 时是假的**——顺序必须是 `rm -rf dist` → `npm run build` → 跑套件。这条已写进 `AGENTS.md`「测试约定」与 `ts-migration-plan.md` §11。
   - **守护**：`check-layers.mjs` 新增 web 根目录白名单（只放行 `app.ts`/`server.ts`/`types.ts`/`usage-service.ts`；`http`/`runtime`/`routes`/`onebot` 四个子目录缺一个也报错），形态与 `agent/` 那条完全一致。**它只禁止"回根"，不管子目录内部怎么分**——与 `agent/` 那条规则同样的守护边界。
   - **没搬的东西**：`app.ts`/`server.ts`/`types.ts` 三项锚点原地不动——套件按字面路径读它们，还按函数名切 `app.ts` 的源码文本（`start()`/`stop()`/`lifecycleDeps()`/`applyConfigPatch()`/`const emit = (type, payload) =>`）。`package.json` 的 `server` 脚本（`dist/web/server.js`）与 `electron/main.js` 的 import（`dist/web/app.js`）也因此无需改动。`routes/` 与 `onebot/` 未动。文件名一个没改——`web/http/http.ts` 的目录名与文件名重复是刻意保留的，只搬运不重命名，diff 才可审。
   - **只能真机人工确认**：`npm run server` 与 `npm start`（Electron）能正常起、控制台能开、SSE 有帧、退出干净；面板五个页面能正常请求（搬的是文件位置不是路由表，风险低，但 `console.ts` 从根目录挪进了 `http/`，值得点一遍）。本轮未做。


## 10. 待定问题（本文档标出，不在本阶段替用户决定）

1. ~~**`SessionEndStatus` 的确切字面量集合。**~~ **已在 S2 解决**：枚举全部 `sessions.finish(` / `#finishWaiting(` 调用点后定为 `'done' | 'noreply' | 'error' | 'aborted' | 'discarded'`，落在 `src/core/events.ts`。无集合外的值，不需要扩宽联合。
2. ~~**`session-update` 该不该激活、以及激活后的面板行为。**~~ **决策部分已在 S7 解决：选择激活，不删。** 12 处发射点改为对象载荷，通道首次通电（§3.4 三、§8.2）。两个子问题的现状：
   - **(b) 帧依赖 emit 时刻的 `sessions.peek()`，取不到会话时怎么办——已查清，不是风险。** `peek()` 在内存里找不到会**回读会话文件**，所以"已被回收"并不等于取不到；真的取不到只剩"会话被 `discard` 删档"这一种情形，而那一路发的是 `session-end` 不是 `session-update`。12 个发射点也全部处在会话存活（或已落盘）的守卫之内。所以这是**理论兜底**，实际不可达。附带一个已登记的形状变化：兜底帧今天是 `{"sessionId":"x"}`（不再是裸串），UI 仍会把它当 patch 合并、用 `undefined`/`[]`/`0` 覆盖那一行，直到 4s 轮询拉回来——比"帧被忽略"更难看出，但前提是走到那条不可达的路径。
   - **(a) 面板在 SSE 与 4s 主轮询（`sessions.js:136-142`）双写下不跳、不闪、`sent` 徽标正确——仍未验证。** 这一条**只能真机确认**：`t-smoke.mjs` 不读 SSE，`t-sse-project.mjs` 只测投影函数，`t-panel-wiring.mjs` 只做名字的跨边界比对，没有任何套件能覆盖"两个写入源同时改同一行"的观感。**这是 S7 唯一剩余的验收项，未完成前不应视为这一步已验收。**

   > **S6 的补充**（历史记录）：S6 落地后 `AppEventMap['session-update']` 曾是 `string`（当时的载荷），S7 连同 12 处发射点一起翻成 `{ sessionId: string }`。若当初决定"删掉死通道"，则类型与那 12 处一起删、S7 改名为"删除"——**实际走的是激活路线**（§3.4 三末、§9.5 第 11 项）。
3. ~~**`status` 改名是否还有 UI 之外的消费者。**~~ **已在 S4 解决**：全仓搜 `addEventListener('status'` / 监听方，唯一命中是 `ui/js/main.js:351`（旧版），没有外部脚本或工具在听这个事件。改名已在 S4 落地，`t-panel-wiring.mjs` 的跨边界断言会拦住今后任何一端漏改。
4. ~~**`sent` → `sentCount` 改名**，确认没有读方依赖旧名。~~ **已在 S5 解决**：该字段全仓**零读方**——UI 的 `session-end` 处理器只读 `data.sessionId`（`ui/js/main.js:277-289`，它读的 `sent` 数组来自 `session-update` 的 SSE 投影，是另一个通道），`t-vision-log.mjs` 与 `harness.readArchivedSession` 也只读 `sessionId`。改名已落地。
5. **`proactive.bubble` 不 unref 是有意还是疏忽。** 改动会改变进程退出语义；`orchestrator.ts:263-264` 的注释显示作者对同类问题是自觉的，但没写冒泡的理由。
6. ~~**jmcomic worker「有待办时未 unref」是有意的进程钉住还是泄漏。**~~ **已关闭（S10b）**：定性为**刻意保持**——有待办时别让进程退出，否则用户的下载任务会丢。S10b 不动 unref 策略，补上的是它缺的另一半（stop 之后 `scheduleNextWake` 不再排新 wake）。这条不再需要在接管前定性。
7. ~~**`vision-scan`（5 个发射点、无消费者）与 `MemoryConsolidator.emit`（从未被调用）**：收编为遥测，还是删除？~~ **已关闭（S11d）**：**两条都删**。`vision-scan` 的裁决理由是"能力已由 HTTP 提供"——补一个面板消费者等于为一个空转事件造需求（§3.5）；`MemoryConsolidator.emit` 的裁决理由是"接上它要先回答'自动记忆整理要不要对面板可见'这个产品问题"，那是独立的有意动作，留着那个依赖只是噪音。**副作用如实记录：自动记忆整理对面板仍然完全静默**——删掉死依赖没有让任何东西变得可见，只是不再假装它有来源。
8. **词表放在 `core/` 的代价。** 将来若某个载荷需要 `chat/` 或 `agent/` 的类型，就只能换位置或登记 `T1_ALLOW` 精确白名单（`check-layers.mjs:16-17`）。
9. **§2.3 第 3 条**：是否要为"未识别的入站事件"（其余 notice / meta / 解析失败的帧）加一个统一记录出口。涉及 `src/qq` 与 `app.ts` 的行为变化，需单独评估。

## 附录 A：事件全表（设计期 12 个事件 / 61 个发射点；S4 之后 13 个名字、点数不变；**S11d 之后 12 个名字 / 56 个点**）

| 事件名 | 点数 | 发射点 | 载荷 | 消费者 |
|---|---|---|---|---|
| `chat-update` | 16 | `wake-scheduler.ts:190/291/332/457/528/577`、`routes/chats.ts:15/45/53/63/106`、`app.ts:554/599`、`history-compactor.ts:137/194`、`routes/system.ts:150` | `string`（chatKey 或 `'*'`） | 面板 |
| `session-update` | 12 | `wake-scheduler.ts:313/418/522/559/612`、`agent-runner.ts:134/181/202/272/320`、`tools/shared.ts:155/219` | **S7 之前是裸字符串**（sessionId），投影侧要求 `{ sessionId }`，两边从未对齐 → **通道无效**（§3.4 三）。**S7 落地后**：12 处改发 `{ sessionId }`，`AppEventMap` 同步写回 `{ sessionId: string }`，通道首次通电（S6 期间该类型曾是 `string`，见 §9.5 第 11 项） | 面板（监听此前必定提前 return，S7 起真的生效） |
| `memory-update` | 8 | `routes/memory.ts:31/37/54/63/70/82/84/85` | `{ chatKey, phase?, userIds?, error? }` | 面板 |
| `session-end` | 4 | `agent-runner.ts:332`、`wake-scheduler.ts:366/382/567` | 设计期：**四种形状**（§3.4 二）；**S5 落地后**：四处都符合 `SessionEndPayload`（`sent` 已改名 `sentCount`，`#finishWaiting` 的 `status` 收成 `SessionEndStatus`） | 面板（只读 `sessionId`）/ `harness.readArchivedSession` |
| ~~`vision-scan`~~ | ~~5~~ | ~~`routes/providers.ts:156/158/159`、`vision-scan.ts:160/170`~~ | ~~`{ phase?, key?, providerId?, model?, verdict?, done?, total?, error? }`~~ | **S11d 已整条删除**（词表 + 载荷 + 5 个发射点 + `scanModelsVision` 的 `emit` 参数 + UI 零监听方，无处需要改）。今天的点数合计因此是 **56** 而不是 61 |
| `sticker-update` | 5 | `app.ts:318`（onChange 适配）、`routes/stickers.ts:26/37/68/78` | `{}` 或 `{ id }` | 面板 |
| `snowluma-status` | 4 | `app.ts:199/204/258/260` | `{ running, embedded, pid }` | 面板 |
| `session-start` | 2 | `wake-scheduler.ts:327/525` | `{ sessionId, chatKey, status?, triggerSummary? }` | 面板 |
| `status` → 已拆成两行 | 2 | `app.ts:711`（`{configUpdated}`）、`orchestrator.ts:284`（`{paused,pauseReason}`） | 设计期：**两种不兼容形状**共用一名（§3.4 一）；**S4 落地后**：`config-applied`（`ConfigAppliedPayload`）+ `orchestrator-pause`（`OrchestratorPausePayload`），`'status'` 从两端绝迹 | 面板（都只 `refreshStatus()`） |
| `onebot-status` | 1 | `app.ts:329`（onStatus 适配） | `{ connected, everConnected, error }` | 面板 |
| `snowluma-log` | 1 | `app.ts:139` | 日志行 | 面板 |
| `feedback` | 1 | `tools/shared.ts:655` | `{ sessionId, chatKey, level, message }` | 面板 |

不计入发射点：`app.ts:265` 的 `bus.emit` 透传，以及 4 处转发包装（`orchestrator.ts:85/112/132`、`agent-runner.ts:164`）。

## 附录 B：计时器全表（S9 清点快照；当前计数见下方增量说明）

**长期任务（6 个，共占 9 个调度点）** —— 见 §6.3 的详细表，落地为 `src/web/runtime/tasks.ts` 的 `LONG_TERM_TASKS`。逐个对应：`proactive-controller.ts:28`/`:37`、`history-compactor.ts:32`/`:37`、`price-feed.ts:212`（S10a 把清理逻辑挪到它之前，行号从 195 漂到 212）、`jmcomic.ts:155`/`:405`、`onebot.ts:126`/`:155`（S10c 前是 89/118，两处都改走 `#scheduleReconnect()`，见下面的漂移表）。

> **视频转写接入后的当前增量**：`transcription.worker` 是第 7 个长期任务，持有一处队列 wake `setTimeout`；同文件另有 FFmpeg 可用性检查与单任务总超时两处任务作用域计时器。当前源码按 `rg "setTimeout|setInterval"` 的同一口径共 27 处，其中长期任务调度点 9 处、局部计时器 18 处。上面的“6 个 / 9 个点”段落保留为 S9 清点快照，不再代表当前任务数。

> **每日热搜接入后的当前增量**：`hot-search.daily-broadcast` 是第 8 个长期任务，由 `node-cron` 持有日程句柄（因此不增加上面的原生长期任务调度点计数）。ApiZero 客户端另有一处请求作用域的 8 秒 `setTimeout`，所以局部计时器增为 19 处。`HotSearchScheduler.stop()` 会销毁未来计划并等待在途播报收尾；配置保存经 `applyConfigPatch` 只重建这一条计划，不重跑整张生命周期清单。

> **搜图 worker 接入后的当前增量**：`image-source.pic-worker` 是**第 9 个**长期任务，宿主是 `src/media/image-source/pic-image-search-client.ts`。它长期持有的资源是 **Python 子进程**，不是计时器——该文件里的三处 `setTimeout`（等就绪、`probe` 等待、退出等待）与 `reverse-image-source-service.ts` 的总超时都是**请求作用域**的，所以 §6.3 的"长期任务调度点 9 处"不变。**推论：`tests/t-tasks.mjs` 第 2 段那条"owner 文件里必须有 `setInterval(`/`setTimeout(`"对这一行是为错误的理由通过的**——它扫到的是请求超时，不是"这个任务持有的长期资源"；那条断言的形态与"子进程型任务"不匹配，本次未改，记在这里免得后人以为它验证了什么。启动闸门 `imageSource.enabled` **默认 `false`**（不用搜图的部署不付 Python 冷启动）；`conformance` 为 `full`（`closePicImageSearchClient()` 关子进程并 fail 掉所有在途请求），启停入口是 `initPicImageSearch` / `closePicImageSearchClient`，装配清单里排**最后**（于是逆序停止时第一个被收掉）。
>
> ⚠️ **顺带实测（与本次改动无关的既有漂移）**：本节几条增量说明里的"局部计时器 17 / 16 / 18 / 19 处"**与源码对不上**。按同一 grep 口径（`grep -rnE "(setTimeout|setInterval)\s*\(" src/ electron/`，排除 `ReturnType<typeof setTimeout>`）重数：当前共 **33 行**命中，其中属于长期任务的 **9 处**，其余 **24 处**（含 `snowluma.ts:117` 的 `socket.setTimeout`，按本附录口径也算局部计时器）。**结论照旧：稳定的事实是"文件名 + 内容"，汇总数会漂**——下次做 §6.1 清点时统一重核一次，别再逐个增量地 +1。

> ⚠️ 本节原先写"7 个"，把 §6.3 表里标着"排除"的 `wake.debounce` 也算进来了。**它是局部计时器**（下表的 `wake-scheduler.ts:336` 就是它），按 §6.1 的分界线不进任务表，而是 `tests/t-tasks.mjs` 反向断言的目标。
>
> ⚠️ **本附录、§6.3 与附录 C 的行号是清点时的快照**，S3–S8 的改动让一部分漂移了。**稳定的键是文件名 + 内容描述，不是行号**；查证时按内容找。S9 收尾时逐条重核（`grep -nE "set(Timeout|Interval)\(" src/ electron/`）的结果：
>
> | 漂移 | 清点时 → 现在 |
> |---|---|
> | `wake-scheduler.ts` 三处局部计时器 | 336 / 421 / 560 → **338 / 431 / 570** |
> | `history-compactor.ts` 两处巡检 | 32 / 37 → **34 / 39** |
> | `vision-scan.ts` 扫图 flush | 143 → **144**（**S11d 后仍在**——删的是事件与两个发射点，那条 2s 的进度 flush 是局部计时器，与事件无关） |
> | `app.ts` socket 超时 / 启动期端口轮询 | 119 / 835 → **122 / 806** |
> | `routes/chats.ts` `getChatName` 兜底 | 78 → **79** |
> | `orchestrator.ts` 兜底总线（附录 C） | 70 → **73**（S10d 已删） |
> | `memory-consolidator.ts` 的 `emit` 依赖（附录 C） | 33 → **34**（**S11d 已删**，行号不再有意义） |
> | `agent/shared/types.ts` 的 `AgentEventMap`（附录 C） | 106 → **107**（**S11d 已删**，行号不再有意义） |
>
> **未漂移、S9 时仍然逐条对得上的**（可直接按行号跳）：`proactive-controller.ts` 28/37、`jmcomic.ts` 155/272/314/405、`core/util.ts` 4、`llm/llm.ts` 128/155、`llm/providers.ts` 224/360、`media/safe-fetch.ts` 107、`core/config.ts` 458/460（**S11d 已删**：那是 `scheduleConfigSave` 与它自己的 `setTimeout`——`config.ts` 今天一个计时器都没有，见附录 C）、`electron/main.js` 131，以及 §6.3 长期任务那一行列出的全部 9 个调度点（其中 `onebot.ts` 的两个自 S10c 起漂到 126/155）。若要重新基线化，重跑 §9.5 第 1 项的两条 `grep`。
>
> **S10a 之后新增的漂移**（只列被这一步改动的两个文件）：`price-feed.ts` 的 `setInterval` 195 → **212**、`unref` 201 → **218**（新增了 `stopPriceFeed()` 与两段注释）；`app.ts` 的 `applyConfigPatch` 675 → **676**、`onebot.connect()` 821 → **822**、`async function stop` 831 → **836**（`createApp` 里删掉 `initPriceFeed` 三行、`start()` 里加了四行注释与一行调用）。
>
> **S10b 之后新增的漂移**：`jmcomic.ts` 的 `startCleanupTimer` 仍在 **152**、它的 `setInterval` 仍在 **155**（该函数未动）、`scheduleNextWake` 仍在 **400**、它的 `setTimeout` 405 → **409**（函数头加了四行守卫与注释）、`runWorker` 408 → **412**、`initJmcomicQueue` 426 → **436**、新增 `stopJmcomicQueue` 在 **:461**（13 行注释 + 3 行实现）；`app.ts` 的 `initPriceFeed` 调用搬到 **:830**、新增 `initJmcomicQueue` 调用在 **:834**、`async function stop` 836 → **841**、新增 `stopJmcomicQueue()` 在 **:848**；`orchestrator.ts` 删掉 `initJmcomicQueue` 的 import（原 `:19`）与构造函数调用（原 `:75`，现该处是一行注释）。
>
> **S10a–S10d 已动过 `app.ts` / `orchestrator.ts` / `onebot.ts` / `jmcomic.ts` / `price-feed.ts`**，本附录的行号只适合当"当时在哪"的历史记录，**一律按内容找**。S10d 还删掉了 `orchestrator.ts` 构造函数里的兜底总线那一行，`shared/types.ts` 的 `emit` 也改了必填——这两处的行号已经不再有意义。
>
> **S10c 之后新增的漂移**：`onebot.ts` —— `RECONNECT_MIN_MS` 仍在 **:14**、`RECONNECT_MAX_MS` 仍在 **:15**（两个常量未动），两个调度点 **89 / 118 → 126 / 155**（上面加了私有字段、`#scheduleReconnect()` / `#cancelReconnect()` 与一段注释；`:89` 现在是 `this.#scheduleReconnect();`、`:118` 现在是 `if (!this.#closedByUs) this.#scheduleReconnect();`），`connect()` 61 → **:90**、`reconnect()` 67 → **:99**、`#connectLoop` 77 → **:112**（早退在 **:115**）、`close()` 130 → **:167**；新增 `#reconnectTimer` 在 **:55**、`#scheduleReconnect()` 在 **:74**、`#cancelReconnect()` 在 **:83**。（`src/web/runtime/tasks.ts` 与 `tests/` 不在本附录范围内，但同一笔改动也动了它们。）
>
> **S11c 之后新增的漂移（`app.ts`）**：原先 `start()` 里那六行硬编码调用（`onebot.connect()` :823、proactive/compact :825-827、`initPriceFeed` :830、`initJmcomicQueue` :834）与 `stop()` 里的 `stopJmcomicQueue()` :848 全部**消失**，各换成一个 `startLifecycle(...)` / `stopLifecycle(...)` 调用；新增 `lifecycleDeps()` 工厂在 **:791**、`async function start` 在 **:814**（`startLifecycle` 在 **:858**）、`async function stop` 在 **:865**（`stopLifecycle` 在 **:872**）。**本附录的"9 个任务调度点"计数与归属不变**——S11c 只改"谁按什么顺序调用它们"，一个 `setInterval` / `setTimeout` 都没增删。
>
> **S11b 之后再次漂移（上面几条的行号也一并过期）**：`onebot.ts` —— `RECONNECT_MAX_MS` **已删**（原 `:15`，现在那里是两行说明为什么不做退避的注释），`RECONNECT_MIN_MS` 仍在 **:14**；新增两个归一化助手 `normalizeWsUrl` / `normalizeHttpUrl` 在 **:25 / :26**（构造函数与 `applyEndpoint()` 共用），构造函数改用它们（原 `:31` / `:32` 的两行 `String(...||...)`）；新增 `applyEndpoint()` 的签名在 **:138**（在 `reconnect()` 之后，文档注释从 `:125` 起）。`app.ts` 的 `applyConfigPatch` 里多了一步比较后重连（**:687-692**），`start()` 的端点覆写改成走 `applyEndpoint`（**:832**），handle 的 return 多一个 `applyConfigPatch`（**:868**）。
>
> **S11d 之后：本附录少了一处，且是唯一被"删掉"而非漂移的一处。** `core/config.ts` 的 `scheduleConfigSave` / `saveTimers` 已删（原 `:460` / `:458-470` / `:375`），于是**局部计时器从 17 处降到 16 处**——上面那张表本身没动（它记的是清点时的快照），但"17"这个数不再成立，`config.ts` 也从"有局部计时器的文件"里退出。同一笔改动没有增删任何别的计时器（`vision-scan.ts` 的 2s flush 与 `app.ts` 的 socket 超时都还在），所以 §6.3 的"9 个任务调度点"计数不变。附录 C 另有三个符号（`AgentEventMap` / `AgentPhase` / `MemoryConsolidatorDependencies.emit`）的行号随之作废。

> **S11 之后（web 模块整理）：本附录的计数一个都没变，但两处宿主文件换了。** `app.ts` 里那两处（socket 超时、启动期端口轮询）——**socket 超时随 SnowLuma 控制器搬进了 `src/web/onebot/snowluma.ts`**，启动期端口轮询仍在 `app.ts` 的 `start()` 里。上表已按文件（不带行号）记录。**"9 个任务调度点"与"16 处局部计时器"的总数不变**：这次整理一行 `setInterval` / `setTimeout` 都没增删（搬的是**宿主**，不是计时器）。`tests/t-tasks.mjs` 的 `LOCALTIMER_ONLY_FILES` 同步加了 `src/web/onebot/snowluma.ts`，`app.ts` 那行保留（它仍持有端口轮询那处）。上面几条提到的 `app.ts:791/814/865` 等行号**再次作废**——组装根从 881 行缩到 392 行。

> **解释器探测 / 依赖自检接入后的当前增量**：新增 `src/core/python-probe.ts`，其中一处 `setTimeout`（探测 15s / 自检 60s 的硬超时，按调用方的 `deps.timeoutMs` 取）。它是**请求作用域**的短命子进程等待——一次探测或一次自检，与长期任务无关，**不进 `LONG_TERM_TASKS`**；宿主也不是任何任务的 owner（已加进 `t-tasks.mjs` 的 `LOCALTIMER_ONLY_FILES`）。所以**局部计时器 16 → 17 处**，§6.3 的"9 个任务调度点"不变。两个端点（`POST /api/system/python-probe` / `-selfcheck`）本身只有一次 HTTP 调用的生命周期，唯一的模块级状态是自检的忙等布尔（`pythonSelfCheck.running`），与 `routes/providers.ts` 的 `visionScan` 同款、同样**零计时器**。

**局部计时器（17 处，排除在注册层之外）**：

| 位置 | 用途 | 生命周期 |
|---|---|---|
| `core/util.ts:4` | `delay()` 助手 | 调用方决定 |
| `llm/llm.ts:128` | 重试退避 | 单次请求 |
| `llm/llm.ts:155` | LLM 请求超时 | 单次请求 |
| `llm/providers.ts:224`、`:360` | 供应商请求超时 | 单次请求 |
| `llm/vision-scan.ts:143` | 扫图进度 flush（每 2s） | 单次扫描 |
| `media/safe-fetch.ts:107` | DNS 解析超时（5s） | 单次请求 |
| `media/jmcomic.ts:272` | 下载无进度 5 分钟后终止 | 单次下载 |
| `media/jmcomic.ts:314` | 下载 30 分钟硬超时 | 单次下载 |
| `web/onebot/snowluma.ts` | 端口探活 socket 超时 | 单次连接 |
| `web/app.ts` | 启动期 SnowLuma 端口轮询（1s × 20） | 单次启动 |
| `web/routes/chats.ts:78` | `getChatName` 3s 兜底 | 单次请求 |
| `core/python-probe.ts` | 解释器探测 / 依赖自检的硬超时（15s / 60s） | 单次请求 |
| `electron/main.js:131` | 窗口加载前的 2s 延时 | 单次启动 |
| `agent/runtime/wake-scheduler.ts:336` | 每会话唤醒防抖 | 单条消息（按会话清理） |
| `agent/runtime/wake-scheduler.ts:421` | 等待窗口相关调度 | 单会话轮次 |
| `agent/runtime/wake-scheduler.ts:560` | 限速等待 | 单次发送 |

（`core/config.ts:460` 的 `scheduleConfigSave` **已在 S11d 删除**，见附录 C，所以它不再计入上表，也不再是"config.ts 有局部计时器"的理由——`config.ts` 现在一个计时器都没有。⚠️ 这一条同时是 `t-tasks.mjs` 的 `LOCALTIMER_ONLY_FILES` 里删掉 `src/core/config.ts` 那一行的依据：那份清单只被"这些文件不许当任务 owner"这一条断言使用，而 `config.ts` 从来不是任何一行的 owner，所以删行不减覆盖面。）

> 判定标准是"生命周期是否长于一次请求或一次会话"（§6.1）。`wake-scheduler.ts:336` 的防抖虽然在 `WakeScheduler` 里，但每个会话独立、随会话清理，因此按局部计时器处理——这也是 `t-tasks.mjs` 要做"反向断言：不在表内"的原因。

## 附录 C：死代码登记

> 行号是清点时的快照，部分已漂移（本表已知：`orchestrator.ts` 70→**73**、`memory-consolidator.ts` 33→**34**、`agent/shared/types.ts` 106→**107**；完整对照与未漂移清单见附录 B 的说明）。S10d 删掉兜底总线之后，`orchestrator.ts` 的构造函数区域又少一行，**这一片行号按内容找，不要按数字跳**。

| 对象 | 位置 | 现状 | 处置建议 |
|---|---|---|---|
| ~~`scheduleConfigSave` + `saveTimers`~~ | ~~`core/config.ts:458-470` / `:375`~~ | **已在 S11d 删除**（两样一起：`saveTimers` 只被它使用）。定义了防抖保存但**无任何调用者**——全仓唯一的"引用"是本表与 `t-tasks.mjs` 清单里的一行注释。⚠️ 删除它**没有任何行为断言能守**（零调用者，删与不删运行期完全一样），所以守护只能是文本：`t-lifecycle.mjs` 第 4 段扫 `scheduleConfigSave` / `saveTimers` 是否绝迹，外加一条更强的"`config.ts` 里没有任何 `setTimeout`/`setInterval`"（`config.ts` 从 S11d 起是纯同步模块） | **登记关闭。** 不要顺手接上（会改变配置写盘时机）；真要防抖保存，它是一个有意的动作，得同时补行为断言 |
| ~~`MemoryConsolidator` 的 `emit` 依赖~~ | ~~`agent/maintenance/memory-consolidator.ts:33`~~ | **已在 S11d 删除**：注入后**从未被调用**。裁决写成"删"而不是"接上"的理由见 §3.5 与 §10 待定 7；`orchestrator.ts` 构造处的传参一并移除 | **登记关闭。** 守护是 `t-lifecycle.mjs` 第 4 段的两条：该文件再无 `emit`、`orchestrator.ts` 的 `new MemoryConsolidator({…})` 实参不含 `emit`（照 `t-ports.mjs` 第 1c 段解析实参对象）。⚠️ **加回去会同时打红两处**（`t-events.mjs` 的注入点清单也会报"多了"）——这正是它值得留一条断言的原因 |
| ~~`AgentEventMap`~~ | ~~`agent/shared/types.ts:106-110`~~ | **已在 S11d 删除**。定义了"事件名 → 类型"映射，**全仓库无任何使用者**（当时 `grep -rn AgentEventMap src/ tests/` 只命中定义行）。已被 `core/events.ts` 的 `AppEventMap` 取代。它那句 `[event: string]: unknown` 正是本设计要消灭的反面教材（§4.2）；**S6 之后它还躺在 `ToolContext.emit: AppEmit` 隔壁**（同一个文件、隔 70 行），一个是被弃用的松散映射、一个是接班的正解，留着尤其容易让人抄错那一个 | **登记关闭。** ⚠️ 注意 `core/events.ts` 的注释里**故意**留着这个名字当反面教材，所以"绝迹"断言必须先 `stripComments()` |
| ~~`RECONNECT_MAX_MS`~~ | ~~`qq/onebot.ts:15`~~ | **已在 S11b 删除**（原位留两行注释说明为什么不做退避：本机回环上 3s 常量足够，退避会改掉重连的可观察行为，而现有断言只钉首跳）。`RECONNECT_MIN_MS`（`:14`）保留，是**唯一**的重连间隔常量 | **登记关闭。** ⚠️ 删除它**没有正向行为断言**（零引用，删与不删运行期完全一样，连夹具都构造不出来），收口只有注释、`tasks.ts` 的 `note` 与本表——不假装它有行为背书（§9.5 第 19 项末） |
| ~~`orchestrator.ts` 的兜底总线~~ | ~~`agent/runtime/orchestrator.ts`~~ | **已在 S10d 删除**：兜底三元表达式与 `createEventBus` 的 import 一起移除，`OrchestratorDependencies.emit` 改成必填，8 个测试构造点补上 `emit`；守护在 `tests/t-ports.mjs` 第 1c 段（§5.6） | **登记关闭。** 若将来有人把兜底加回去，第 1c 段①的源码文本断言会红——这也是"删掉不报错"的另一面（加回去同样不报错） |

## 相关文档

- `docs/global-registry-roadmap.md` —— 本文要回答的路线图与禁令清单
- `docs/ts-migration-plan.md` —— 当前架构与维护原则（§2 目录分层、§10 构建测试、§11 维护原则）
- `docs/model-prices.md` —— 价格表来源（对应任务 `price.feed`）
- `AGENTS.md` —— 长期开发约束（长任务与事件相关条目见"提示词维护规则"之后）
