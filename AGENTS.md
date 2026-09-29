# QQ Agent 项目长期开发记忆

> 这是供后续开发者与编码 Agent 使用的长期上下文。开始修改前先读本文，再按需阅读 `README.md` 和 `docs/ts-migration-plan.md`。
> 最后核对：2026-09-29。

## 项目定位

这是一个基于 Electron、Node.js、OneBot v11 和 OpenAI 兼容接口的本地 QQ AI Bot。后端采用严格 TypeScript，前端采用不打包的浏览器原生 ES Module。

权威文档：

- 用户入口、安装与配置：`README.md`
- 当前架构、对话链路、上下文和提示词：`docs/ts-migration-plan.md`
- 模型价格来源与表格：`docs/model-prices.md`
- 事件、方法接线与长期任务的设计与清点：`docs/global-registry-design.md`（**"注册层仍未实现"这句话自 S11c 起作废**，注册层 = 四件产物的合称，见该文档 §0.1；S0–S9 已落地，**S10+ 已全部落地**——S10a 收下 `price.feed`、S10b 收下两个 jmcomic、S10c 收下 `onebot.reconnect`、S10d 删掉兜底事件总线；**S11a–c 已落地**：S11a 补齐 `SIGTERM` 与幂等关停、S11b 让端点变更经配置保存触发重连并删掉死常量 `RECONNECT_MAX_MS`、S11c 补上第四条腿 `src/web/runtime/lifecycle.ts` 装配清单、S11d 收掉死代码与空转事件（`scheduleConfigSave`/`AgentEventMap`/`MemoryConsolidatorDependencies.emit`/`vision-scan` 事件）、S11e 让 electron 的 `before-quit` 真正等 `stop()` 落地；**S11 全部落地**；改动事件、端口或后台任务前先查它）

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

`media/` 同时承载媒体处理与 Bot 的可选扩展能力。新增这类能力时，主体实现统一放在
`src/media/<feature>/`，按功能目录收拢；`src/web/routes/` 只保留 HTTP 管理表面，`src/web/app.ts`
只负责依赖注入和生命周期装配。当前范例是 `src/media/hot-search/`。由于 `llm`、`chat`、`qq`、
`media` 同属 T1，能力模块不得直接横向 import `qq/` 等同层实现；需要发送消息等能力时定义最小
结构化端口，由 `web/app.ts` 注入真实对象。

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

`web/` 是组装根，除 HTTP/SSE 接线外还挂三样跨层产物：`http/event-projector.ts`（SSE 帧拼装，纯函数）、`runtime/tasks.ts`（长期任务描述符表，纯数据）与 `types.ts` 的 `AppContext`（路由依赖对象）。三者都**不得**反向依赖 `agent/` 的实现细节——跨模块方法面只走 `AgentControlPort`（见下文）。

`web/` 内部同样按职责落进子目录，**根目录只留组装、入口、领域类型与读模型**，与 `agent/` 那条规则同一个理由（没有闸门，搬进子目录的东西会一个一个搬回来）：

```text
web/
├─ app.ts            组装根：建对象图、接 OneBot 入站回调、起 HTTP/SSE、启停长期任务
├─ server.ts         headless 入口（import 即建 app、起服务、装信号处理器）
├─ types.ts          web 领域共享类型（AppContext / AppHandle / Route / Reply）
├─ usage-service.ts  用量与花费读模型（控制台表面与 /api/usage 共用）
├─ http/             HTTP 与 SSE 表面
│  ├─ console.ts        控制台 HTTP 表面：SSE 端点、鉴权、路由分发、静态文件、状态快照、配置脱敏
│  ├─ event-projector.ts SSE 帧拼装（纯函数，t-sse-project 逐字节钉住）
│  ├─ http.ts            请求/响应原语
│  ├─ router.ts          路由匹配与分发
│  └─ static-files.ts    静态文件服务
├─ routes/           领域路由（8 个领域 + index）
├─ onebot/           OneBot 接入侧（与 `src/qq/` 的分工：qq/ 是协议客户端，这里放"那个 OneBot 端"自己的状态）
│  ├─ snowluma.ts    SnowLuma 程序目录、子进程、日志环形缓冲、端口探活与 WebUI 地址
│  ├─ tokens.ts      令牌桥：候选收集、401 轮换、限频与去重签名
│  └─ ingest.ts      入站摄取：白名单、@ 名字解析、引用预览、合并转发展开、拍一拍
└─ runtime/          长期任务与退出路径（描述腿 / 执行腿 / 退出编排）
   ├─ tasks.ts       描述腿（纯数据，零 import）
   ├─ lifecycle.ts   执行腿（装配清单，start 正序 / stop 逆序）
   └─ shutdown.ts    退出编排（幂等关停，零 import）
```

**这套目录约束是可机检的**（`check-layers.mjs`）：根目录出现白名单（上表前四个文件）之外的 `.ts` 直接报错，四个子目录缺一个也报错。守护空白照 `agent/` 那条：它只**禁止回根**，不管你在子目录里怎么分。

`http/http.ts` 的目录名与文件名重复是刻意保留的（该轮只搬运不重命名，diff 才可审）。**`app.ts` / `server.ts` / `types.ts` 的位置动不得**：套件按字面路径读它们，还按函数名切 `app.ts` 的源码文本（见下条）。

**组装根里有几块代码是搬不动的**，因为套件按**函数名切片**它的源码文本：`start()` / `stop()` / `lifecycleDeps()`（`t-lifecycle.mjs`）、`applyConfigPatch()`（`t-timers.mjs`）、`const emit = (type, payload) =>`（`t-sse-project.mjs`）、以及 `web/types.ts` 的 `AppContext`。往这些函数外面搬家会打红——**报出来的是套件失败，不是编译错误**。判据是"它是否触碰共享组件图"：只碰共享图的不搬，自己拥有私有状态的才搬。两个按这条判据容易判错的：

- `applyConfigPatch` **不是** HTTP 职责而是组装根职责——它确实在 `start()` 之外启停长期任务（S10b/S11b 有意保留，配置刷新路径刻意不接 `LIFECYCLE`）。精确规则是"**装配期**启停只走 `start()`/`stop()`；**运行期**配置变更的启停只经 `applyConfigPatch`"。`http/console.ts` 只是把它转交给路由。
- `http/console.ts` 装的是"外部请求进来时怎么答"（脱敏、鉴权、状态快照、`handleHttp`、`listenOn`），它自己拥有"未授权怎么回"与"什么字段算密钥"这套判定。**已知守护空白**：`t-timers.mjs` 那条"端点只有一个写入口"的全文件扫描只覆盖 `src/web/app.ts`，所以在 `http/console.ts`（以及 `onebot/*`）里直接给 `onebot.wsUrl` 赋值**没有任何断言会拦住**——实测四套件全绿。别以为它被管着。


工具的**名字、顺序和参数 schema** 是硬约束：它们只由 `src/agent/tools/index.ts` 的 `buildToolDefs()` 按固定顺序拼装，拆分或搬运工具文件时不得改动既有工具的对外表现。

`check-layers.mjs` 同时检查依赖方向、agent 分层与 web 分层、相对引用越出 `src/` 和缺失的 `.js` 后缀；`tests/t-agent-structure.mjs` 再断言分层目录、Catalog 五类指令与工具顺序。

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

链路另有一条**异步回流**入口：后台转写完成后把一条 `kind:'transcript'` 的【转写结果】写进存档并推入窗口，走同一套「窗口 → 响应判定 → runAgent」。它与众不同的是那次运行**拿不到任何 tool result**（转写是在更早一次运行里入队的），所以正确性只能由 system prompt 规则与窗口判定承载，不能指望上下文里留着工具调用痕迹。

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
- **转写结果（`kind:'transcript'`）是一等窗口条目，且两个谓词给出的答案相反**：`isSystemRecord` 必须**不**认它（认了它就永远进不了窗口），`isPersonMessage` 必须认它（它的 `senderId` 是空串，否则会凭空多出一个叫“转写”的成员）。它必须 `read:false`——写 `true` 会落进 `#lastSeenId` 水位线之下：进程内刚写入时看得见，**重启后永久不可见**。窗口里只要有它，`evaluateWindowTrigger` 无条件响应（`responseTier:0` / `reason:'转写结果'`）；**`forceWake` 绕不过档位判定**，这是唯一落点，且它必须不读 `roll`（`#resolvePendingResponse` 有 `scheduleWake`/`wake` 两个调用点）。规则作用于**整批**。

## 提示词维护规则

所有模型可见的固定指令（内置 persona、system/user 固定段、工具 description、历史压缩与记忆整理指令）只允许写在 `src/core/prompt-catalog.ts`，业务模块引用其中的 `PROMPT_CATALOG`；`src/agent/prompting/prompt-builder.ts` 只负责动态变量、聊天记录格式化、条件选择与预算裁剪。UI 文案、日志、HTTP 错误和运行时参数校验错误不属于提示词目录。

工具**结果**串一般留在各自工具文件里（它带动态数据或错误文案）；唯一的例外是 `transcribe_video` 的回执话术 `TOOL_PROMPT_TEXT.transcribe_video.receipt`——它没有动态成分，且要解决的是"诱导模型说哪句话"而不是"返回什么数据"，所以按固定指令处理。**它必须整句取自目录，不许在工具文件里拼状态串**：带上任务号（`job.id`）会让模型回一句"任务已派上（任务 xxxx）"，而 `description` 与 `toolProtocol` 第 7 条是同一件事的另外两个面，分居两地就调不齐。

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

- **注册层的实际形态是四件产物的合称，不是一个对象**（S11c 起，详见设计稿 §0.1）：事件腿 `core/events.ts` 词表、方法腿 `AgentControlPort` 端口、任务**描述**腿 `web/runtime/tasks.ts`（纯数据）、任务**执行**腿 `web/runtime/lifecycle.ts`（有序的函数引用数组）。四件都不是注册表，合起来才是；任何把它们收进一个 `register(...)` 的尝试都会撞上跨层反向依赖与字符串式动态调用两条禁令。事件是散布的 `emit(EVENTS.xxx, payload)`，长期任务各自持有计时器句柄。设计、清点与分步迁移方案见 `docs/global-registry-design.md`（S0–S9 已落地，**S10+ 已全部落地**：S10a 收下 `price.feed`、S10b 收下两个 jmcomic、S10c 收下 `onebot.reconnect`、S10d 删掉 `Orchestrator` 的兜底事件总线并把 `emit` 改成必填；**S11a–c 已落地**：S11a 收口无头入口的退出路径——`src/web/runtime/shutdown.ts`，`SIGINT`/`SIGTERM` 都走同一个幂等关停，重复信号立即强退、`stop()` 抛错也照常退出；S11b 端点热生效；S11c 装配清单；**S11d 收死代码与空转事件**——`core/config.ts` 的 `scheduleConfigSave`/`saveTimers`、`agent/shared/types.ts` 的 `AgentEventMap`、`MemoryConsolidatorDependencies.emit`（连同 `orchestrator.ts` 的传参）、`vision-scan` 整条事件（词表键 + 载荷类型 + 两个发射点 + `/api/vision/scan` 的 emit 传参）。**注意它删的是事件，不是 `providers.ts` 里那个同名的 `visionScan` 局部对象**——那个是活的，别当残留一起删掉；**S11e 让桌面端的退出也等关停落地**——`electron/main.js` 的 `before-quit` 是 `quitting = true` → `if (stopping) return;` → `event.preventDefault()` → `Promise.resolve().then(() => core.stop()).catch(...).finally(() => app.quit())`。**三条不变量缺了都会挂，改动它之前先读那一段的注释**：`quitting` 必须先置位（退出期间关窗会缩托盘，把退出挂住）、`stopping` 守卫（第二次 `app.quit()` 会再进这个处理器，缺了它 `preventDefault` 拦下自己 → 死循环）、`.finally` 里必须自己再退一次（`preventDefault` 之后没人再退 → **应用永远不退**）。前两者与后者都**没有任何行为套件看得见**（`electron/main.js` import 不了），只有 `t-lifecycle.mjs` 第 5 段那 6 条文本断言守着）。S10+ 解除了"改启动/配置刷新/退出流程"与"动定时器生命周期"两条禁令，**但只为"让长期任务能被显式启停"**；其余禁令（不替换事件总线、不建字符串式注册表、不动 `src/qq` 入站解析）照旧。**注意 S10c 动的是 `src/qq/onebot.ts` 的 `close()`/`connect()`/`reconnect()`，不是入站事件解析**——后者仍在禁令内；S10d 删的是 `Orchestrator` 自建的那条兜底总线，`core/util.ts` 的 `createEventBus()` 本体保留（`app.ts` 照旧用它）。
- 事件名与载荷类型**只在 `src/core/events.ts`**（`EVENTS` + `AppEventMap`）。新增事件必须同时加常量与载荷类型，否则编译期护栏会报错。词表放 `core` 是因为生产者散在 agent/llm/qq，而层级检查禁反向依赖；代价是载荷只能用基础类型，不能引用 `chat/` 或 `agent/` 的领域类型。
- **发射点一律写 `EVENTS.<key>`，不许再写字面事件名**；`tests/t-events.mjs` 扫 `src/` 钉住这条（它同时断言没有"词表里有、却没有任何发射点"的空转名字，并真跑一轮 agent 断言 `session-end` 的真实载荷）。UI 侧的 `es.addEventListener('<name>')` 由 `tests/t-panel-wiring.mjs` 对词表做**跨边界比对**——改名只改一端会静默失效、不报任何错，所以两端都要动。
- **S6 起载荷受编译期检查**：`emit` 的注入类型是 `AppEmit`，写错载荷 `npm run typecheck` 直接报错，不需要额外套件守。但**事件名不受它约束**——`this.emit('chat-update', key)` 与 `this.emit(EVENTS.chatUpdate, key)` 在编译器眼里一样，所以字面名只能靠上面那条文本扫描挡。`tests/t-events.mjs` 另有一条断言钉住"受检查的注入点清单"（S6 时 9 个文件 / 13 处，**S11d 删掉 `memory-consolidator` 与 `vision-scan` 两处注入点后是 7 个文件 / 10 处标注行**——两个数的口径见设计稿 §4.3，**以文件集合为准**），因为**把某个注入点退回 `(event: string, payload?: unknown) => unknown` 不会报任何错**——它后面所有发射点会静默失去检查；新增注入点时要把它登记进那个套件的 `TYPED_FILES`。**那份清单是对称的**："少了"与"多了"都会报，删注入点时忘了同步删文件名同样会红——报出来的是**文件名**而不是运行错误，最容易当成测试噪音忽略（S11d 实测：把 `emit: AppEmit` 加回 `memory-consolidator.ts` 会同时打红 `t-lifecycle.mjs` 与 `t-events.mjs` 两边）。
- 注意同名异物：`session-end` 载荷里的 `sentCount` 是**条数**（数字），而 SSE 投影给面板的 `sent` 是**数组**（每条发出的消息）。改这两个字段前先看 `docs/global-registry-design.md` §4.5。
- `session-update` 是**瘦事件**：载荷只有 `{ sessionId }`，富字段（`messages`/`sent`/`finishReason`…）由 `src/web/http/event-projector.ts` 在 emit 当刻现读 `sessions.peek()` 拼进 SSE 富帧，不要把读模型搬进 `agent`。这条通道在 S7 之前**全程无效**（12 个发射点发裸串、投影与 UI 都要求对象，三方从未对齐）——正因为"形状看着对、接线从未对齐"能瞒过所有人，`tests/t-events.mjs` 第 6 段才会真跑一轮并把载荷喂给真投影函数、断言出的是**富帧**；只断言"载荷是对象"证明不了通道通。真机面板表现（SSE 与 4s 轮询双写）任何套件都覆盖不到。
- 服务端事件总线是空转的：`createEventBus()` 的 `on()` 在 app 里没有任何调用者，实际投递由 `src/web/app.ts` 的 SSE 包装完成。**不得把业务正确性挂在 `on()` 上。**
- `Orchestrator` 的 `emit` 是**必填依赖**（S10d 删掉了构造函数里的兜底总线）。`src/` 侧漏传 `tsc` 直接报错；**`tests/` 侧不会**——`.mjs` 不在 `tsconfig` 的 include 里，`tsc` 永远看不到它们，而 8 个构造点里只有一个（`t-panel.mjs`）会因为真的调用了会 emit 的方法而变红，`t-ports.mjs` 那一个**删掉 `emit` 会全绿**。所以往 `tests/` 里新增 `new Orchestrator({...})` 必须自己记得写 `emit: () => {}`，守护是 `tests/t-ports.mjs` 第 1c 段的文本扫描（逐个实参对象必须含 `emit`）。
- SSE 帧的拼装只在 `src/web/http/event-projector.ts`（纯函数，`tests/t-sse-project.mjs` 逐字节钉住）。`app.ts` 的 `emit` 闭包只负责委托，不要在它身上重新长出拼帧逻辑。
- 不为业务方法引入字符串式动态调用或运行时热替换。仓库里仅有的三处字符串键分发（工具分发、OneBot `call`、HTTP 路由）都是外部契约，保持原样。
- **跨模块方法面走端口，不走注册表**：`web/` 与 `electron/main.js` 只能依赖 `src/agent/runtime/control-port.ts` 的 `AgentControlPort`（`Orchestrator implements` 它），不许直接依赖 `Orchestrator` 具体类。往端口加成员是个**有意的动作**：接口、`METHOD_CATALOG`、`tests/t-ports.mjs` 里那份手工清单三处要同时改（`tsc` 会拦下前两处，第三处由套件拦）。端口里**不得**出现 `instanceof` 检查、`Symbol` 品牌或运行期校验——那会打碎 `t-orch`/`t-vision-log` 用普通对象字面量充当依赖的构造策略。`METHOD_CATALOG` 只作文档与测试引用，**`src/` 里除定义处外不许引用它**（一旦参与分发就是被禁的字符串式注册表，套件会扫出来）。
- 动手改端口相关代码前先读 `src/agent/runtime/control-port.ts` 顶部注释：`implements` 那一行**删掉不报任何错**，端口会静默退化成注释——`tests/t-ports.mjs` 第 1 段就是为此存在的文本扫描。
- **长期任务用 `src/web/runtime/tasks.ts` 的 `LONG_TERM_TASKS` 登记**（当前 8 行：S9 的 6 行 + `transcription.worker` + `hot-search.daily-broadcast`）。这张表是**纯数据**：不得触发任何 `start`/`stop`、不得在文件里放调度调用，`src/` 里除定义处外也不许引用它（三条都有断言守，见 `tests/t-tasks.mjs`）。写法上有两条硬约束：
  - `start`/`stop` 存的是**入口的名字**（`{ on, kind, name }`），不是函数引用——存引用的话套件只能自己验自己，存名字才能拿到真对象/真模块上解析。
  - `conformance` 的判定规则写在文件头部注释里（`full ⇒ start && stop && stopCancelsPending`；`partial ⇒ (start && !stop) || (stop && !stopCancelsPending)`；`none ⇒ !start`），套件按同一条规则断言；**改规则要同时改两处**。做不到的不许写成能力，只能如实标 `partial`/`none` 并在 `note` 里写清"接管它需要做什么"。
- **局部计时器不进任务表**：LLM/HTTP 超时、重试退避、限速与拟人停顿、唤醒防抖、单次扫描轮询、启动期端口轮询等，按"生命周期是否长于一次请求或一次会话"判定为局部计时器（热搜客户端加入 8 秒请求超时后是 **19 处**；长期任务另含 9 处原生计时器调度点，以及 `node-cron` 管理的热搜日程）。**绝不要包装 `setTimeout`/`setInterval` 全局来"顺便"收编它们**——那会把排除清单变成谎言。`tests/t-tasks.mjs` 有一条反向断言专门钉这条，设计稿里被点名排除的 `wake.debounce` 就是它的靶子。
- 新增长期后台任务必须能显式启停，**不得靠模块加载期或构造函数副作用启动**。启停点已收敛成一条硬规则：**长期任务一律在 `src/web/app.ts` 的 `start()` 里启动、在 `stop()` 里停止**。**S11c 起这条规则由 `src/web/runtime/lifecycle.ts` 的装配清单（`LIFECYCLE`）驱动**：`start()` 只调 `await startLifecycle(deps)`，`stop()` 只调 `await stopLifecycle(deps)`，`app.ts` 里**不再出现任何一条硬编码的任务启停调用**（`lifecycleDeps()` 只负责把真模块递进去——"装的是什么"在 app，"按什么顺序装"在清单）。清单的三条可机检性质：① `start`/`stop` 存**函数引用**（不是名字），运行期只有 `for...of`，没有 `LIFECYCLE[动态键]`/`.find(`/`.get(`；② `ids` 只作**对账元数据**，运行期从不读；③ **import 它不启动任何东西**。**顺序即语义**：start 正序 = 清单顺序，stop **逆序**，于是"停长期任务排在 `onebot.close()` **之前**"（在途的 QQ 上传调用还依赖传输层）由"`onebot.reconnect` 排第一位"自动满足，不再靠人记。**往清单里插一行时位置就是行为**——插错地方不会有任何编译错误，只有 `t-lifecycle.mjs` 第 3 段的顺序断言会红。可参照的现成实现有：`price.feed`、两个 jmcomic 任务、`onebot.reconnect`、`transcription.worker`，以及 `hot-search.daily-broadcast`（`HotSearchScheduler.start/stop`，`node-cron` 句柄可销毁并等待在途播报）。**配置刷新路径刻意不接清单**：`applyConfigPatch` 只直接刷新确实支持热刷新的价格表与热搜计划，避免误调无条件任务。`stop()` 里 `abortAll()` **不进清单**（它管的是中止在跑的会话）。**`conformance` 列今天只剩 `jmcomic.worker` 是 `partial`**，成因是"停不掉**正在执行**的那一次下载"。新增任务时**要动三处**：`LONG_TERM_TASKS`（+ `tests/t-tasks.mjs` 的 `EXPECTED_IDS`）、`web/runtime/lifecycle.ts` 的 `LIFECYCLE`（+ `tests/t-lifecycle.mjs` 的 `EXPECTED_ENTRY_IDS` 与两条顺序期望），以及 `app.ts` 的 `lifecycleDeps()`；**只改一处会被套件拦下**。
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

**`snowluma` 端点的热生效只有一条路（S11b）**：`applyConfigPatch` 把 `next.snowluma` 的四个字段交给 `OneBotClient.applyEndpoint(next)`，**它返回 `true` 才** `onebot.reconnect()`。三条不变量，改动时别拆散：

- `applyEndpoint` 的归一化（`normalizeWsUrl`/`normalizeHttpUrl`）与**构造函数共用同一份**——只要规则在比较的那一侧另写一份，`http://127.0.0.1:3000/` 与 `http://127.0.0.1:3000` 就会被判成变更，**用户每保存一次设置就断一次连接**；
- `applyEndpoint` **只改实例字段**：不重连、不发事件、不动已建的 socket，重连是调用方的决定；
- 空 URL 回落默认值、空 token 是真的清空（逐字段分开，与构造函数同一语义）。注意 `ui/js/views/settings/save.js:276` 会把用户清空的 wsUrl **原样存成 `''`**，所以"空 URL 就当成清空"会让 `new WebSocket('')` 抛错并落进 3s 重连循环。

唯一不走它的是 `applyTokens`（401 轮换路径上必须先写 token 再无条件重连，刻意保留）。守护在 `tests/t-timers.mjs` 第 5 段。

## 测试约定

- 测试加载 `dist/`，因此不要用未 build 的结果判断源码行为。**推论：搬动/删除 `src/` 文件后必须先 `rm -rf dist` 再 build**——`npm run build` 是裸 `tsc`，**不清理旧产物**，实测 `dist/` 里曾积了 29 个化石文件。旧位置的编译产物还在时，一个指向旧路径的 `load('web/xxx.js')` 会**照样解析成功、套件全绿**（实测：伪造 `dist/web/router.js` + 把 `t-web-router.mjs` 的字面量改回旧路径 → `11 通过 / 0 失败`），所以"纯搬运"的验证在没清 dist 时是假的。
- **`web/` 根目录白名单是机检的**：`check-layers.mjs` 只放行 `app.ts`/`server.ts`/`types.ts`/`usage-service.ts`，其余 `.ts` 出现在根目录直接报错；`http`/`runtime`/`routes`/`onebot` 四个子目录缺一个也报错。它与 `agent/` 那条规则是同一形态、同一理由。判据仍是"它是否触碰共享组件图"：**组装根、入口、领域类型、读模型留根，其余落子目录**；`routes/` 与 `onebot/` 内部本轮未再细分（嵌套是自由的，`check-layers.mjs` 只按顶层目录判层）。**动 `app.ts`/`server.ts`/`types.ts` 的位置之前先读上一条**——套件按字面路径读它们，还按函数名切 `app.ts` 的源码文本。
- 新增 `tests/t-*.mjs` 后，必须在 `tests/run.mjs` 的 ASSERT 或 DIAG 中归类。
- ASSERT 套件必须在失败时以非零状态退出；打印式诊断只能放 DIAG。
- 测试数据使用临时 `QQ_AGENT_DATA_DIR`，不得读取或清理真实 `data/`。
- 不通过弱化断言让测试变绿；行为改变时更新实现、断言和文档三者。
- **文本扫描式断言先剥注释**：`tests/lib/src.mjs` 导出的 `stripComments()` 用于"这段代码里没有 X"这类断言。注释里提一嘴 X 不参与任何逻辑，不剥会把断言打红（实测踩到过两次：`runtime/tasks.ts` 的注释提到 `METHOD_CATALOG` 打红了 t-ports；注释里写 `setInterval(fn, 1000)` 打红了 t-tasks）。该助手用状态机跳字符串，**已知边界**记在它的注释里，别在它上面加正则。**反方向的坑同样真实**：扫"某名字还有没有人在用"时，不剥注释会让**一句纯文档注释把"调用已被删掉"伪装成"还在用"**——S11 之后的 web 模块整理里，`web/onebot/ingest.ts` 头部注释提到 `orchestrator.onIncoming`，于是"把端口绑定改名成 `orc`"这个探针在 `t-ports.mjs` 第 2 段**全绿**（端口唯一的 `onIncoming` 调用点其实已经消失）。现在该段从剥注释的文本取**成员集合**、从原文取**行号**。判据：扫"有没有 X"和扫"还有没有人在用 X"都要剥，只有取行号时才用原文。
- **带副作用的入口文件只能靠文本断言守**：`src/web/server.ts`（import 即 `createApp()`、起服务、装信号处理器）与 `electron/main.js` 套件都 import 不了，所以它们的接线事实由 `tests/t-lifecycle.mjs` **扫源码文本**钉住（`stripComments()` 后逐行扫，不用全文 `includes`——全文扫描放得过"再加一个自己 `exit` 的旁路处理器"）。同类还有：Windows 下 `SIGTERM` 事实上送不到子进程的处理器，行为级的信号测试不可靠，所以"注册了哪两个信号"只能看文本。这些入口的纯逻辑应当抽成可 import 的模块（先例：`web/http/event-projector.ts`、`web/runtime/shutdown.ts`），文本扫描只负责剩下的接线那几行。
- **`.mjs` 不受 `tsc` 管**：`tsconfig.json` 显式排除了 `tests/`，所以"改了 `src/` 的必填依赖/参数形状，忘了改某个测试调用点"**不会**编译报错。判断要不要配一条扫 `tests/` 的文本断言，看这个测试调用点**是否真的会被用到**——而不是"它看起来没用到"。S10d 实测过一次：8 个 `new Orchestrator({…})` 里原以为只有 1 个会因缺 `emit` 变红，实际 `t-orch.mjs` 在第一条 `scheduleWake` 就抛 `TypeError`；真正完全静默的只有 `t-ports.mjs` 那一个（它只做 `typeof` 检查）。**写证伪探针时同理：探针的"期望值"本身也要实测确认，不能从代码外观推断。**
- **抛异常的断言会"吃掉"它后面的所有断言**：套件是顺序执行的一串 `ok(...)`，中途一个未捕获的 `TypeError` 会**中止整个套件**——后面的断言不是变红，是**从未运行**，而终端上仍然只看到"这个套件失败了"。所以**报"套件全绿"之前要核对断言总数与上一次是否一致**：`t-lifecycle.mjs` 从 27 变成 33 看得见，但"33 条里其实只跑了 21 条"看不见。S11c 的真实交付缺陷就长这样：spy 依赖写成 `jmcomic.initialize`，而 `LifecycleDeps.jmcomic` 是 `init`，套件在 `startLifecycle` 处抛 `TypeError` 后静默中止，后半段的文本扫描**一次都没跑过**（S11d 用 `t-lifecycle.mjs` 第 3 段 ⑱ 的结构对账把它变成一条普通的红）。**`LifecycleDeps` 这类纯结构接口正是重灾区**：没有 `runtime` 校验、`tsc` 又看不见 `.mjs`，写错一个属性名只会在运行期炸。
- **一个布尔选项承载多条语义、且只由一处传参时，它就是最容易被一次"无害重构"抹掉的东西**：内联一层调用（`this.wake(k, opt)` → `this.scheduler.wake(k, opt)`）会让人顺手把它当冗余参数删掉，删完**代码看着更干净、所有套件全绿**。当前唯一的实例是 `Orchestrator` 递给 `ProactiveController` 的 `wake: (chatKey) => this.scheduler.wake(chatKey, { proactive: true })`——这个标志在 `wake-scheduler.ts` 里同时管三件事（越过 `isPaused()` 闸门、**跳过整个响应档位判定**（含"窗口里没有未读就早退"那条）、不取触发批只带状态）。而 `ProactiveController.candidates()` 挑的恰恰是**窗口里没有未读**的空闲群，所以标志一丢主动冒泡**不是偶尔失灵而是恒为 no-op**。实测：去掉它全量 23 套件全绿（守护空白），`tests/t-window.mjs` 第 15 段补上后才有判别力（去掉红、加回绿）。写这类守卫的夹具时注意：**`ContextWindowRegistry.ensure()` 会把存档里的未读播种进窗口**，构造"空闲群"必须顺带 `store.markRead()`，否则前置条件不成立、断言退化成假的绿。**另有一条实测踩到的**：第 15 段初版**会随机红**（六次挂三次，报"压根没建会话"）——`ProactiveController.tick()` 是 `candidates[Math.floor(Math.random() * candidates.length)]`，从**所有**合格群聊里随机挑一个；而存档按 `QQ_AGENT_DATA_DIR` 落盘、整个套件共用同一个临时目录，前面 9 个小节留下的空闲群**全都合格**，本群被选中只有约 1/N 的概率。于是上一轮"全绿"的报告来自一次**走运的运行**。修法是**把条件显式钉死**：`updateConfig({ allow: { groups: [本群], allowAllWhenEmpty: false } })` 让候选唯一，改完连跑 ≥8 次再下结论。**教训是通用的**：夹具里凡是"全局状态里只有我一个满足条件"的前提，都要显式钉死，不能靠"运行到这里时恰好只有它"。

对话相关改动重点关注：

- `t-window.mjs`（第 15 段是主动冒泡的 `{ proactive: true }`——它没有别的守护）
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
- `t-timers.mjs`（长期任务的计时器句柄：起没起、停没停、有没有被"清掉又没重建"；第 5 段是配置刷新触发重连——用 `app.onebot.socket` 的**身份**断言"值没变不断连、值变了才重建"，外加 `applyEndpoint` 的单元断言与 `applyConfigPatch` 函数体的文本扫描）
- `t-hot-search.mjs`（ApiZero 匿名/Bearer 请求、429/5xx/超时退避、字段缺失与空榜、去重分页、白名单目标、状态持久化、当天幂等、手动/定时互斥与配置脱敏）
- `t-lifecycle.mjs`（注册层执行侧：关停路径的信号接线与幂等；S11c 起还有装配清单 ⇄ `LONG_TERM_TASKS` 对账、清单 import 纯度、`app.start()/stop()` 的接线与逆序；S11d 的第 4 段是死代码与空转事件收口（33 条里的 5 条）、S11e 的第 5 段是 electron 的 `before-quit` 真的等 `stop()`（6 条，套件 33 → 39））。**它的文本扫描一律先 `stripComments()`**——`runtime/lifecycle.ts` 的头部注释里就写着 `LIFECYCLE[动态键]` 与 `.find(`（那是在列出被禁形态），不剥注释会让文件把自己的文档打红。**"无按键分发"那三条断言是"装配清单 vs 被禁注册表"唯一的机检边界**：往 `runtime/lifecycle.ts` 里加一个 `startById(id)` 式的按键分发函数，**所有行为断言仍全绿**（对账、顺序、逆序、接线、纯度都不受影响），只有它红——这正是它存在的唯一理由。**S11d 那 5 条全是文本断言**，因为删的东西零调用者/零消费者——"删与不删运行期完全一样"，行为断言一条都写不出来，探针只能证明"加回来会被文本挡住"。其中两条值得记住：① 判 `core/config.ts` 没有计时器**不认名字**，只认这个文件里有没有 `setTimeout`/`setInterval`，所以换个名字复活同样会被抓住；② **`providers.ts` 里 `const visionScan = { running: false }` 这个局部对象是活的**（`/api/vision/results` 读它、`/api/vision/scan` 用它挡 409、UI 读 `visionData.scanning`）——它长得像 `vision-scan` 事件的残留，**删不掉，也没有任何套件能区分"删事件"与"删这个对象"**，只有一条正向文本断言钉着它，另配一条真机冒烟（点设置页的"视觉能力扫描"按钮）。`core/events.ts` 的注释里也写着 `AgentEventMap`（那是在记反面教材，S11d 已把它从代码里删掉），所以这句扫描同样必须先剥注释。**S11e 的第 5 段（6 条）与第 4 段不同：它盯的不是死代码，而是两条"缺了就挂"的活路径**——同上，`electron/main.js` import 不了，所以只能切出 `before-quit` 的**函数体**逐条断言（不是全文 `includes`）。两个探针实测：删掉 `if (stopping) return;` → 红 1 条（真机表现是"点了退出、窗口关了、进程还在"）；删掉 `.finally(() => app.quit())` → 红 1 条（真机表现是**应用永远不退**）。**这两件事都没有任何行为套件看得见**，而它们又都不影响启动与聊天——所以别以为"能跑就没坏"。

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
