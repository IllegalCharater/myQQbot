# QQ Agent 项目长期开发记忆

> 这是供后续开发者与编码 Agent 使用的长期上下文。开始修改前先读本文，再按需阅读 `README.md` 和 `docs/ts-migration-plan.md`。
> 最后核对：2026-09-28。

## 项目定位

这是一个基于 Electron、Node.js、OneBot v11 和 OpenAI 兼容接口的本地 QQ AI Bot。后端采用严格 TypeScript，前端采用不打包的浏览器原生 ES Module。

权威文档：

- 用户入口、安装与配置：`README.md`
- 当前架构、对话链路、上下文和提示词：`docs/ts-migration-plan.md`
- 模型价格来源与表格：`docs/model-prices.md`
- 事件、方法接线与长期任务的设计与清点：`docs/global-registry-design.md`（全局注册层尚未实现；S0–S9 已落地，**S10+ 已全部落地**——S10a 收下 `price.feed`、S10b 收下两个 jmcomic、S10c 收下 `onebot.reconnect`、S10d 删掉兜底事件总线；改动事件、端口或后台任务前先查它）

如果代码与文档不一致，以代码和测试为当前事实，并在同一次改动中更新文档。

## 构建与运行事实

- 后端源码只改 `src/**/*.ts`，不要直接修改 `dist/`。
- `dist/` 是 `tsc` 生成物，Node、测试和 Electron 实际运行它。
- TypeScript 使用 `NodeNext`；源码中的相对 import 必须保留 `.js` 后缀。
- 不使用 TypeScript path alias，Node 不会自动解析它们。
- UI 位于 `ui/js/`，使用原生 ES Module，不引入打包器。
- 所有运行数据默认位于 `data/`，不得为测试或排查修改真实用户数据。

常用验证：

```bash
npm run typecheck
npm run build
npm run check
npm run test:all
```

完成普通源码改动至少运行 `npm run check`。涉及真实 Electron、OneBot 或桌面交互时，说明仍需人工真机冒烟，不要擅自操作真实账号。

## 依赖分层

允许的依赖方向：

```text
core
  ↓
llm / chat / qq / media
  ↓
stickers
  ↓
agent
  ↓
web
```

`scripts/check-layers.mjs` 会检查这条规则。不要为了方便制造 `core → agent`、`chat → web` 等反向依赖。

`agent/` 内部必须按职责落进子目录，根目录不得平铺实现文件，也不保留旧路径的转发兼容壳：

```text
agent/
├─ runtime/     唤醒调度、运行状态、跨模块端口（control-port）与 Agent 循环
├─ context/     当前窗口、响应策略与历史策略
├─ prompting/   动态提示词拼装与预算裁剪
├─ tools/       工具统一入口、领域分组与执行
├─ maintenance/ 主动冒泡、历史压缩与记忆整理
└─ shared/      Agent 内共享类型与解析器
```

`web/` 是组装根，除 HTTP/SSE 接线外还挂三样跨层产物：`event-projector.ts`（SSE 帧拼装，纯函数）、`tasks.ts`（长期任务描述符表，纯数据）与 `types.ts` 的 `AppContext`（路由依赖对象）。三者都**不得**反向依赖 `agent/` 的实现细节——跨模块方法面只走 `AgentControlPort`（见下文）。

工具的**名字、顺序和参数 schema** 是硬约束：它们只由 `src/agent/tools/index.ts` 的 `buildToolDefs()` 按固定顺序拼装，拆分或搬运工具文件时不得改动既有工具的对外表现。

`check-layers.mjs` 同时检查依赖方向、agent 分层、相对引用越出 `src/` 和缺失的 `.js` 后缀；`tests/t-agent-structure.mjs` 再断言分层目录、Catalog 五类指令与工具顺序。

## 对话主链路

```text
OneBot 入站
→ ChatStore 持久化
→ ContextWindowRegistry.push
→ WakeScheduler 聚批；响应策略判断是否处理，历史策略独立决定回看深度
→ runAgent 重新构造 system/user prompt
→ 模型与工具多轮循环
→ 发送类工具产生 QQ 外部动作
→ SessionRegistry 收尾
→ 运行期间的新消息由下一轮 drain 处理
```

Bot 不保留跨运行的模型侧 messages。长期连续性来自本地消息存档、历史摘要和成员记忆。

## 上下文的四种数据必须分开

1. 当前新消息窗口：`ContextWindow` 私有滑动窗口，只保留最新 `maxContextMessages` 条并决定【本次唤醒】。
2. 已读原始历史：独立的 `historyCount/historyLimit` 决定【过去状态】深度，与响应档位无关。
3. 历史摘要：压缩结果，注入为【历史印象】。
4. 长期记忆：稳定成员印象，注入为【记忆】。

关键不变量：

- `pending()` / `batch()` 只返回窗口内未消费消息的深拷贝，外部不能增删或修改成员。
- 被滑出的未消费消息通过 `takeFoldedIds()` 立即标为已读历史，不再参与响应判定；折叠数量保留到本轮消费并计入 `foldedAway`。
- `batch()`、`foldedCount()`、`seen()` 必须在同一个同步块内调用，中间不能 `await`。
- 是否回复都要消费已经判断过的消息，防止旧消息反复成为“本次新消息”。
- 原始历史以本轮 `triggerEntries` 最早消息为边界，只从边界之前读取；当前批只进【本次唤醒】。
- 内部统一使用 `historyCount/historyLimit`，不要重新引入 `contextLimit`。

## 提示词维护规则

所有模型可见的固定指令（内置 persona、system/user 固定段、工具 description、历史压缩与记忆整理指令）只允许写在 `src/core/prompt-catalog.ts`，业务模块引用其中的 `PROMPT_CATALOG`；`src/agent/prompting/prompt-builder.ts` 只负责动态变量、聊天记录格式化、条件选择与预算裁剪。UI 文案、日志、HTTP 错误和运行时参数校验错误不属于提示词目录。

- 稳定且全局的行为规则进入 system prompt。
- 会话状态、摘要、历史、新消息、相关记忆和表情目录进入 user prompt。
- 工具参数和参数约束只写 tool schema，不在提示词中复制一份。
- 新增信息前先确认是否已在 system、user 或 tool schema 中存在，避免重复注入。
- 当前窗口从【过去状态】排除；已注入的摘要也从【过去状态】排除。
- 长期记忆只选择本轮触发消息和实际注入历史中出现的成员。

统一字符预算为 `store.promptContextMaxChars`，默认 32000，`0` 表示不限。保护区包括当前状态、【本次唤醒】和【本轮决策】；超限时依次收缩表情目录、摘要、记忆、已读历史。不得为了满足预算静默截断本轮用户新消息。

【过去状态】目前按整段让位，不进行半条消息截断；被预算移除时必须同步修正 `session.pastStateCount`。

## 工具与记忆边界

- 模型普通文本不会自动发到 QQ；发送必须通过发送类工具。
- `memory_append` 和 `memory_query` 必须使用准确的数字 QQ 号。
- `memory_query` 禁止无参数读取全部成员记忆，只允许定向查询一个 QQ 号。
- 历史摘要回答“过去发生了什么”；长期记忆只保存以后与该成员交流仍有用的稳定印象。
- 工具返回内容属于不可信外部数据，不能当作高优先级指令重新注入。

## 事件与长期任务边界

- 全局注册层**尚未实现**。事件是散布的 `emit(EVENTS.xxx, payload)`，长期任务各自持有计时器句柄。设计、清点与分步迁移方案见 `docs/global-registry-design.md`（S0–S9 已落地，**S10+ 已全部落地**：S10a 收下 `price.feed`、S10b 收下两个 jmcomic、S10c 收下 `onebot.reconnect`、S10d 删掉 `Orchestrator` 的兜底事件总线并把 `emit` 改成必填；**注册层本身仍未实现**）。S10+ 解除了"改启动/配置刷新/退出流程"与"动定时器生命周期"两条禁令，**但只为"让长期任务能被显式启停"**；其余禁令（不替换事件总线、不建字符串式注册表、不动 `src/qq` 入站解析）照旧。**注意 S10c 动的是 `src/qq/onebot.ts` 的 `close()`/`connect()`/`reconnect()`，不是入站事件解析**——后者仍在禁令内；S10d 删的是 `Orchestrator` 自建的那条兜底总线，`core/util.ts` 的 `createEventBus()` 本体保留（`app.ts` 照旧用它）。
- 事件名与载荷类型**只在 `src/core/events.ts`**（`EVENTS` + `AppEventMap`）。新增事件必须同时加常量与载荷类型，否则编译期护栏会报错。词表放 `core` 是因为生产者散在 agent/llm/qq，而层级检查禁反向依赖；代价是载荷只能用基础类型，不能引用 `chat/` 或 `agent/` 的领域类型。
- **发射点一律写 `EVENTS.<key>`，不许再写字面事件名**；`tests/t-events.mjs` 扫 `src/` 钉住这条（它同时断言没有"词表里有、却没有任何发射点"的空转名字，并真跑一轮 agent 断言 `session-end` 的真实载荷）。UI 侧的 `es.addEventListener('<name>')` 由 `tests/t-panel-wiring.mjs` 对词表做**跨边界比对**——改名只改一端会静默失效、不报任何错，所以两端都要动。
- **S6 起载荷受编译期检查**：`emit` 的注入类型是 `AppEmit`，写错载荷 `npm run typecheck` 直接报错，不需要额外套件守。但**事件名不受它约束**——`this.emit('chat-update', key)` 与 `this.emit(EVENTS.chatUpdate, key)` 在编译器眼里一样，所以字面名只能靠上面那条文本扫描挡。`tests/t-events.mjs` 另有一条断言钉住"受检查的注入点清单"（13 处 / 9 个文件），因为**把某个注入点退回 `(event: string, payload?: unknown) => unknown` 不会报任何错**——它后面所有发射点会静默失去检查；新增注入点时要把它登记进那个套件的 `TYPED_FILES`。
- 注意同名异物：`session-end` 载荷里的 `sentCount` 是**条数**（数字），而 SSE 投影给面板的 `sent` 是**数组**（每条发出的消息）。改这两个字段前先看 `docs/global-registry-design.md` §4.5。
- `session-update` 是**瘦事件**：载荷只有 `{ sessionId }`，富字段（`messages`/`sent`/`finishReason`…）由 `src/web/event-projector.ts` 在 emit 当刻现读 `sessions.peek()` 拼进 SSE 富帧，不要把读模型搬进 `agent`。这条通道在 S7 之前**全程无效**（12 个发射点发裸串、投影与 UI 都要求对象，三方从未对齐）——正因为"形状看着对、接线从未对齐"能瞒过所有人，`tests/t-events.mjs` 第 6 段才会真跑一轮并把载荷喂给真投影函数、断言出的是**富帧**；只断言"载荷是对象"证明不了通道通。真机面板表现（SSE 与 4s 轮询双写）任何套件都覆盖不到。
- 服务端事件总线是空转的：`createEventBus()` 的 `on()` 在 app 里没有任何调用者，实际投递由 `src/web/app.ts` 的 SSE 包装完成。**不得把业务正确性挂在 `on()` 上。**
- `Orchestrator` 的 `emit` 是**必填依赖**（S10d 删掉了构造函数里的兜底总线）。`src/` 侧漏传 `tsc` 直接报错；**`tests/` 侧不会**——`.mjs` 不在 `tsconfig` 的 include 里，`tsc` 永远看不到它们，而 8 个构造点里只有一个（`t-panel.mjs`）会因为真的调用了会 emit 的方法而变红，`t-ports.mjs` 那一个**删掉 `emit` 会全绿**。所以往 `tests/` 里新增 `new Orchestrator({...})` 必须自己记得写 `emit: () => {}`，守护是 `tests/t-ports.mjs` 第 1c 段的文本扫描（逐个实参对象必须含 `emit`）。
- SSE 帧的拼装只在 `src/web/event-projector.ts`（纯函数，`tests/t-sse-project.mjs` 逐字节钉住）。`app.ts` 的 `emit` 闭包只负责委托，不要在它身上重新长出拼帧逻辑。
- 不为业务方法引入字符串式动态调用或运行时热替换。仓库里仅有的三处字符串键分发（工具分发、OneBot `call`、HTTP 路由）都是外部契约，保持原样。
- **跨模块方法面走端口，不走注册表**：`web/` 与 `electron/main.js` 只能依赖 `src/agent/runtime/control-port.ts` 的 `AgentControlPort`（`Orchestrator implements` 它），不许直接依赖 `Orchestrator` 具体类。往端口加成员是个**有意的动作**：接口、`METHOD_CATALOG`、`tests/t-ports.mjs` 里那份手工清单三处要同时改（`tsc` 会拦下前两处，第三处由套件拦）。端口里**不得**出现 `instanceof` 检查、`Symbol` 品牌或运行期校验——那会打碎 `t-orch`/`t-vision-log` 用普通对象字面量充当依赖的构造策略。`METHOD_CATALOG` 只作文档与测试引用，**`src/` 里除定义处外不许引用它**（一旦参与分发就是被禁的字符串式注册表，套件会扫出来）。
- 动手改端口相关代码前先读 `src/agent/runtime/control-port.ts` 顶部注释：`implements` 那一行**删掉不报任何错**，端口会静默退化成注释——`tests/t-ports.mjs` 第 1 段就是为此存在的文本扫描。
- **长期任务用 `src/web/tasks.ts` 的 `LONG_TERM_TASKS` 登记**（6 行，S9 落地）。这张表是**纯数据**：不得触发任何 `start`/`stop`、不得在文件里放调度调用，`src/` 里除定义处外也不许引用它（三条都有断言守，见 `tests/t-tasks.mjs`）。写法上有两条硬约束：
  - `start`/`stop` 存的是**入口的名字**（`{ on, kind, name }`），不是函数引用——存引用的话套件只能自己验自己，存名字才能拿到真对象/真模块上解析。
  - `conformance` 的判定规则写在文件头部注释里（`full ⇒ start && stop && stopCancelsPending`；`partial ⇒ (start && !stop) || (stop && !stopCancelsPending)`；`none ⇒ !start`），套件按同一条规则断言；**改规则要同时改两处**。做不到的不许写成能力，只能如实标 `partial`/`none` 并在 `note` 里写清"接管它需要做什么"。
- **局部计时器不进任务表**：LLM/HTTP 超时、重试退避、限速与拟人停顿、唤醒防抖、单次扫描轮询、启动期端口轮询等，按"生命周期是否长于一次请求或一次会话"判定为局部计时器（`design` 文档 §6.1，共 17 处）。**绝不要包装 `setTimeout`/`setInterval` 全局来"顺便"收编它们**——那会把排除清单变成谎言。`tests/t-tasks.mjs` 有一条反向断言专门钉这条，设计稿里被点名排除的 `wake.debounce` 就是它的靶子。
- 新增长期后台任务必须能显式启停，**不得靠模块加载期或构造函数副作用启动**。启停点已收敛成一条硬规则：**长期任务一律在 `src/web/app.ts` 的 `start()` 里启动、在 `stop()` 里停止**（两者成对出现，中间不隔别的东西）。可参照的现成实现有三条：`price.feed`（S10a：`initPriceFeed`/`stopPriceFeed` 在 `llm/price-feed.ts`）、两个 jmcomic 任务（S10b：`initializeJmcomicQueue`/`stopJmcomicQueue` 在 `media/jmcomic.ts`，**stop 时置空 `runtime` 而不是新增标志位**——这样 stop 之后的一次 `enqueueJmcomicDownload` 会重新拉起队列，工具回复的"已加入队列"仍是真话；代价是"stop 可被一次 enqueue 撤销"，只在退出路径上调用所以现实到不了）、`onebot.reconnect`（S10c：宿主就是 `OneBotClient` 自己，停止入口就是 `app.stop()` 里那个 `onebot.close()`；它现在会**取消掉已排定待触发的那一次重连**，而不再只是"阻止下一次"）。`stop()` 的顺序约束：停长期任务必须排在 `onebot.close()` **之前**（在途的 QQ 上传调用还依赖传输层）。**S10b 之后已没有靠构造函数副作用启动的长期任务**（原先的 `Orchestrator` → `initializeJmcomicQueue` 已搬走）。**`conformance` 列今天只剩 `jmcomic.worker` 是 `partial`**，成因是"停不掉**正在执行**的那一次下载"，不是"取消不掉等待中的那一次"——后者（`stopCancelsPending`）自 S10c 起全表为真。新增任务时同步登记 `LONG_TERM_TASKS` 与 `tests/t-tasks.mjs` 的 `EXPECTED_IDS`——**表里加一行是个有意的动作**，只改一处会被套件拦下。
- 请求作用域计时器（LLM/HTTP 超时、重试退避、限速与拟人停顿、会话防抖、单次扫描轮询、启动期端口轮询等）**不是长期任务**，不要纳入任务表——判定标准与清单见上一条。
- 改长期任务相关代码前先看 `tests/t-timers.mjs` 的 `withFakeTimers()`：它替换的是**全局** `setTimeout`/`setInterval`/`clearInterval`（`dist/` 里编译成裸标识符，所以拦得住）。两条坑写在它的注释里——假句柄必须放**原对象**进记录数组（放拷贝会把 `unrefCalled` 冻在 `false`，断言永远假绿），以及 `try/finally` 必须恢复（被测模块是模块级单例，漏恢复会污染同进程后续用例）。**第三条是 S10c 踩出来的**：断言"某处排定被取消"时，夹具必须让**新的排定真的不会发生**（例如测试 `connect()` 的取消时，要让 `new WebSocket` 构造成功）——否则被替换路径上的新排定会顺手清掉旧句柄，被测的那一行删不删都一样，探针会拿到**假的绿**（实测踩到，见设计稿 §9.5 第 16 项②）。**另有一处已知的守护空白**：`jmcomic` 的 `runWorker` 里 `while (runtime && …)` 那道闸门删掉不会让任何套件变红（要观察到差别得让夹具里有两个可跑任务，而第二个会过继给后面的真起 app 段去碰真 onebot），它只有注释在守——别以为它被管着。

## 图片链路

`get_message_images` 只负责找到并安全下载图片。图片以 data URL 形式作为额外的多模态 `role: user` 消息交给视觉模型，不塞入 `role: tool` 图片内容。

下一轮模型输出需要回填到 session 的 `toolImages.reply`，UI 在图片工具卡片中显示；对应 assistant 条目标记 `imageReply`，避免相同读图结果显示两次。

修改此链路时重点运行 `t-vision-log.mjs` 和 `t-ui-render.mjs`。

会话 JSON 面板只以 `session.llmRequests` 展示逐轮真实模型输入（完整 messages/tools），不要再建立首次输入副本。

## 配置兼容与命名

- `store.maxContextMessages`：当前新消息窗口容量，`0` 表示不限；它不控制历史深度。
- `store.historyCount`：窗口之前统一读取的原始历史条数，不受艾特、关键词、随机或响应档位影响。
- `store.promptContextMaxChars`：完整 user prompt 的统一字符预算。
- `digest.maxChars`：摘要通道候选预算，不替代统一预算。
- 会话只写 `currentWindowCount/foldedAway`、`responseTier/responseReason`、`historyLimit/historyBeforeId/pastStateCount`，不写也不读取旧 `contextTier/contextLimit` 字段。

修改配置时同时检查：

- `src/core/config.ts` 默认值；
- `ui/js/parts/chat-settings.js` 表单；
- `ui/js/views/settings/save.js` 保存与钳制；
- 对应面板接线和配置测试。

## 测试约定

- 测试加载 `dist/`，因此不要用未 build 的结果判断源码行为。
- 新增 `tests/t-*.mjs` 后，必须在 `tests/run.mjs` 的 ASSERT 或 DIAG 中归类。
- ASSERT 套件必须在失败时以非零状态退出；打印式诊断只能放 DIAG。
- 测试数据使用临时 `QQ_AGENT_DATA_DIR`，不得读取或清理真实 `data/`。
- 不通过弱化断言让测试变绿；行为改变时更新实现、断言和文档三者。
- **文本扫描式断言先剥注释**：`tests/lib/src.mjs` 导出的 `stripComments()` 用于"这段代码里没有 X"这类断言。注释里提一嘴 X 不参与任何逻辑，不剥会把断言打红（实测踩到过两次：`tasks.ts` 的注释提到 `METHOD_CATALOG` 打红了 t-ports；注释里写 `setInterval(fn, 1000)` 打红了 t-tasks）。该助手用状态机跳字符串，**已知边界**记在它的注释里，别在它上面加正则。
- **`.mjs` 不受 `tsc` 管**：`tsconfig.json` 显式排除了 `tests/`，所以"改了 `src/` 的必填依赖/参数形状，忘了改某个测试调用点"**不会**编译报错。判断要不要配一条扫 `tests/` 的文本断言，看这个测试调用点**是否真的会被用到**——而不是"它看起来没用到"。S10d 实测过一次：8 个 `new Orchestrator({…})` 里原以为只有 1 个会因缺 `emit` 变红，实际 `t-orch.mjs` 在第一条 `scheduleWake` 就抛 `TypeError`；真正完全静默的只有 `t-ports.mjs` 那一个（它只做 `typeof` 检查）。**写证伪探针时同理：探针的"期望值"本身也要实测确认，不能从代码外观推断。**

对话相关改动重点关注：

- `t-window.mjs`
- `t-reply.mjs`
- `t-digest.mjs`
- `t-memory-tools.mjs`
- `t-vision-log.mjs`
- `t-ui-render.mjs`

事件、端口与长期任务相关改动重点关注：

- `t-events.mjs`（事件名 / 载荷 / 注入类型 / `session-update` 通道）
- `t-sse-project.mjs`（SSE 帧逐字节）
- `t-panel-wiring.mjs`（UI 订阅名跨边界）
- `t-ports.mjs`（跨模块端口与 `implements`；含 S10d 的第 1c 段——扫 `tests/` 里每个 `new Orchestrator({…})` 是否都传了 `emit`）
- `t-tasks.mjs`（长期任务描述符表；含三条实名断言，其中一条是扫 `qq/onebot.ts` 的"重连排定只许一处、句柄必须存进 `#reconnectTimer`"——往那里再加一处裸 `setTimeout` 会打红它）
- `t-timers.mjs`（长期任务的计时器句柄：起没起、停没停、有没有被"清掉又没重建"）

## 已知安全与数据原则

- 工作区可能有用户未提交改动；不要覆盖、回滚或格式化无关文件。
- 不使用 `git reset --hard`、`git checkout --` 等破坏性命令处理用户改动。
- 删除或清理前必须核对精确目标，不对仓库根目录、`data/` 或用户目录执行递归删除。
- 发布前执行 `node scripts/sanitize-release.mjs --scan`。
- API Key、登录态、消息、会话、记忆和白名单都视为敏感数据。

## 文档维护

以下变化必须同步更新 `docs/ts-migration-plan.md`，必要时更新 README：

- 对话调用链或工具循环发生变化；
- 上下文窗口、档位历史、摘要或记忆的语义变化；
- 提示词段落、去重规则或预算优先级变化；
- 配置字段改名、默认值变化或兼容字段移除；
- 构建入口、目录分层、运行命令或测试分类变化。

本文只保留稳定、不易过时的开发约束。具体实现细节应写入架构文档和源码注释，不要把临时任务进度、一次性排障日志或尚未决定的方案写成长久事实。
