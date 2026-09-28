# QQ Agent 当前架构与维护指南

> 本文档描述当前代码，而不是迁移计划。TypeScript、目录分层、Web 路由拆分和 UI 模块化均已完成。
> 最后更新：2026-09-28。

## 1. 当前状态

后端源码位于 `src/`，全部使用严格 TypeScript；`tsc` 编译到 `dist/`，Node 与 Electron 只运行编译产物。前端位于 `ui/`，使用浏览器原生 ES Module，不经过打包。

当前工程约束：

- Node.js ≥ 20，模块格式为 ESM / NodeNext。
- TypeScript import 保留 `.js` 后缀，保证编译后的 Node 解析路径不变。
- `src/` 是唯一后端源码，`dist/` 是可删除、可重建的产物，禁止直接修改。
- JSON、HTTP、OneBot 和模型响应等外部边界使用 `unknown` 后再窄化。
- `npm run check` 同时执行类型检查、依赖层级检查和断言测试。

## 2. 目录与依赖层级

```text
src/
├─ core/       配置、路径、通用函数、档位滑条
├─ llm/        模型请求、供应商、价格、视觉能力探测
├─ chat/       消息存档、长期记忆、会话记录
├─ qq/         OneBot 客户端、发送队列、Markdown 转纯文本
├─ media/      安全下载、网页搜索、媒体任务
├─ stickers/   表情库、缓存与管理
├─ agent/      Agent 领域（内部继续按职责分层）
│  ├─ runtime/       唤醒调度、运行状态、跨模块端口与 Agent 循环
│  ├─ context/       当前窗口、响应策略与历史策略
│  ├─ prompting/     动态提示词拼装与预算裁剪
│  ├─ tools/         工具统一入口、领域分组与执行
│  ├─ maintenance/   主动冒泡、历史压缩与记忆整理
│  └─ shared/        Agent 内共享类型与解析器
└─ web/        HTTP 基础设施、路由、SSE 帧拼装、长期任务描述符表与领域接口

ui/js/
├─ main.js     浏览器入口与页面编排
├─ state.js    前端共享状态
├─ views/      会话、聊天、记忆、用量与设置页面
└─ parts/      设置区块和复用组件
```

依赖只能从高层指向低层：

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

`scripts/check-layers.mjs` 会阻止反向依赖。领域共享类型分别放在各自的 `types.ts` 中，不建立全局巨型类型文件。

`agent/` 对 `web/` 的跨模块面固化成端口 `src/agent/runtime/control-port.ts`（`AgentControlPort`），`Orchestrator implements` 它；`src/web/` 与 `electron/main.js` 只依赖这个接口，不依赖具体类。端口只做**编译期**检查（`implements` 与 `satisfies`），运行期零成本，也不含任何 `instanceof`/`Symbol` 品牌——`tests/t-orch.mjs`、`t-vision-log.mjs` 用普通对象字面量充当依赖，加运行期校验会当场打碎它们。配套的 `METHOD_CATALOG` 只作文档与测试引用，不参与任何运行时分发。

长期后台任务的清点落在 `src/web/tasks.ts` 的 `LONG_TERM_TASKS`（6 行）。它是**纯数据**：描述 owner / 开关来源 / 配置刷新方式 / 启停入口 / 是否 unref / `conformance`，**不触发任何启停**，也不许在文件里出现调度调用；`start`/`stop` 存的是入口的名字而非函数引用，好让 `tests/t-tasks.mjs` 拿到真对象上去核对。请求作用域局部计时器不进这张表（有反向断言守），判定标准见 `docs/global-registry-design.md` §6.1。

**启停点只有一处**：长期任务一律在 `src/web/app.ts` 的 `start()` 里启动、在 `stop()` 里停止（成对出现），不靠模块加载期或构造函数副作用。已接管的样子参照 `price.feed`（S10a：`initPriceFeed`/`stopPriceFeed` 在 `src/llm/price-feed.ts`）、两个 jmcomic 任务（S10b：`initializeJmcomicQueue`/`stopJmcomicQueue` 在 `src/media/jmcomic.ts`，原先靠在 `Orchestrator` 构造函数里调用启动）与 `onebot.reconnect`（S10c：宿主就是 `OneBotClient`，停止入口就是 `app.stop()` 里的 `onebot.close()`；`src/qq/onebot.ts` 用私有字段 `#reconnectTimer` 存重连句柄，`close()`/`connect()`/`reconnect()` 都会取消掉已排定的那一次，**刻意不 unref**——有待重连时钉住进程是有意的）；计时器句柄行为由 `tests/t-timers.mjs` 用假计时器断言。**6 行长期任务里只剩 `jmcomic.worker` 是 `partial`**（停不掉正在执行的那一次下载），其余 5 行为 `full`。`stop()` 里停长期任务必须排在 `onebot.close()` 之前——在途的 QQ 上传调用还依赖传输层。

## 3. Bot 对话调用链

```text
OneBot 入站事件
  → ChatStore 持久化
  → ContextWindowRegistry.push
  → WakeScheduler 防抖聚批
  → evaluateWindowTrigger 只判断窗口是否命中响应条件
  → resolveHistoryPolicy 独立解析历史深度
  → 同步取得新消息批次并消费窗口
  → runAgent 组装提示词和工具
  → chatCompletionWithRetry
  → executeTool（可多轮）
  → send / finish 等工具产生外部动作
  → SessionRegistry 收尾并通知 UI
  → 运行期间到达的新消息进入下一轮 drain
```

模型没有跨运行的原生对话历史。每次 `runAgent` 都重新创建 system 和 user 两条初始消息。同一次运行中的工具轮次会继续追加 assistant、tool 和视觉 user 消息；运行结束后不把这串模型消息作为下一次运行的 LLM history。

## 4. 新消息窗口与历史深度

这两个概念职责不同，不能混用。

### 4.1 `ContextWindow`

每个 `chatKey` 有一个窗口，只管理对方发来的当前新消息：

- 私有滑动窗口：最新的驻留消息，容量由 `store.maxContextMessages` 控制，`0` 表示不限。
- 折叠 id 账本：因容量不足被滑出的消息 ID，不保留消息内容；`takeFoldedIds()` 将新滑出的 ID 立即同步为已读历史，折叠计数则保留到本轮消费。
- 私有消费游标：已经由某次调度处理到的位置。
- 私有结算队列：等待同步到存档 `read` 镜像的消息 ID。

主要读取接口：

- `pending()` / `batch()`：窗口中尚未消费消息的深拷贝，严格受容量限制；用于响应判断并进入【本次唤醒】。
- `foldedCount()`：已滑出但尚未结算的 id 数，用于提示模型较早消息已降级到历史。
- `seen()`：推进水位线。回复与不回复都会消费，避免旧消息反复成为“新消息”。

### 4.2 独立历史策略

响应档位只决定当前窗口是否值得响应；`store.historyCount` 独立决定读取多少条窗口之前的历史。二者没有数据或策略依赖。

响应档位的持久化事实源只有 `store.contextSliderPos`。`contextTier` 与
`randomPercent` 仅在运行时由滑条位置计算，不再写入配置；加载旧配置时会一次性把
旧字段迁移成滑条位置。全局滑条与 `groupSliderPos` 也遵循同一换算规则。

旧配置的 `atCount/keywordCount/randomCount/allCount` 会按照升级时所选响应档位迁移成一个 `historyCount`，随后删除。内部统一使用 `historyCount` / `historyLimit`。

调度器在消费窗口前完成两件彼此独立的事：

1. `evaluateWindowTrigger()` 用 `pending()` 对当前滑动窗口做响应判定；
2. `resolveHistoryPolicy()` 只读取 `store.historyCount`，不接收消息、窗口或响应结果；
3. 用 `batch()` 拍下实际进入【本次唤醒】的当前窗口，并以其中最早消息的本地 ID
   作为 `historyBeforeId`。

提示词构建器从 `historyBeforeId` 之前向前读取 `historyCount` 条，形成【过去状态】；
`batch()` 中的消息只形成【本次唤醒】。两段以明确边界相接，不按数组 offset 猜测，也不
在窗口消费后重新计算响应策略。窗口外已滑出的较早消息属于历史候选，能否实际注入
仍受独立历史深度和统一字符预算限制。

## 5. 提示词组装

模型可见固定文案的唯一目录是 `src/core/prompt-catalog.ts`。它统一保存默认 persona、
system/user 固定段、工具及参数 description、历史压缩和记忆整理指令；
`src/agent/prompting/prompt-builder.ts` 只负责动态变量、聊天记录格式化、条件选择与预算裁剪。
UI 文案、日志、HTTP 错误和运行时参数校验错误不属于提示词目录。

### 5.1 System prompt

`buildSystemPrompt()` 放稳定、跨会话的规则：人设与表达约束、是否应当发言的原则、工具调用与引用安全规则、表情使用策略。工具参数定义留在 tool schema，不再复制到 system/user prompt。

### 5.2 User prompt

`buildUserPrompt()` 按以下顺序构造动态内容：

1. 【当前时间】
2. 【此刻状态】
3. 【历史印象】——历史压缩产生的摘要
4. 【过去状态】——窗口之外、独立历史策略允许读取的原始历史
5. 【本次唤醒】——当前新消息窗口的未消费批次
6. 【记忆】——仅与本轮可见成员相关的长期印象
7. 可用表情目录
8. 【本轮决策】

避免重复的规则：

- 当前窗口全部从【过去状态】排除。
- 已进入【历史印象】的摘要条目从【过去状态】排除。
- 成员记忆只按 `triggerEntries + 实际注入的 past.messages` 选人。
- 成员备注直接替换消息显示名，不再额外生成重复段落。
- 参与度与工具细则只保留一个权威注入位置。

### 5.3 统一字符预算

配置项：

```text
store.promptContextMaxChars = 32000
```

它约束单次完整 user prompt，`0` 表示不限。当前采用字符预算而不是依赖特定模型 tokenizer，使所有 OpenAI 兼容渠道行为一致。

始终保护、不裁剪的部分：当前时间、会话状态、【本次唤醒】中的新消息和【本轮决策】。

超出预算时依次让位：

1. 表情目录；
2. 历史摘要；
3. 长期记忆；
4. 窗口外的已读历史。

普通可选段保留标题和较新的尾部内容；【过去状态】按整段移除，不截断半条消息。历史整段被移除时 `session.pastStateCount` 同步归零，避免 `get_recent_messages` 的翻页偏移跳过模型实际上没看到的内容。

如果不可裁剪的本轮新消息和固定指令本身已经超过预算，最终文本允许超过上限，并在 session 中记录 `promptBudgetExceeded=true`。预算不能以静默截断用户当前消息为代价。

## 6. 历史摘要与长期记忆

历史压缩将较旧原始消息整理为 digest，并从正常存档窗口中归档。提示词注入受两层约束：

- `digest.maxChars`：摘要通道自己的最大候选字数；
- `store.promptContextMaxChars`：摘要、历史、记忆、表情共同竞争的最终总预算。

摘要默认只在本轮确实读取历史时注入；`digest.injectEveryRound` 可改变这一时机。选中的摘要不会再在【过去状态】出现。

长期记忆用于保存跨多次聊天仍有价值的成员印象，不等同于聊天摘要：

- `memory_append` 必须指定数字 QQ 号。
- `memory_query` 必须指定 1–15 位数字 QQ 号，只返回该成员，禁止无参数读取全会话成员记忆。
- `memory_remove` 用于删除失效印象。
- 自动整理在会话结束后后台执行，不阻塞回复主链路。

摘要负责“过去发生了什么”，长期记忆负责“以后与这个人交流时仍有用的稳定信息”。

## 7. 图片识别与会话面板

图片不会由工具自行 OCR。完整链路是：

1. `get_message_images` 根据 QQ 消息 ID 查找存档媒体。
2. `safe-fetch` 校验地址、下载二进制、识别 MIME，并转为 data URL。
3. 工具文本结果以 `role: tool` 返回。
4. 图片以紧随其后的多模态 `role: user` 消息注入，兼容不接受 tool 图片的 OpenAI 兼容端点。
5. 下一轮视觉模型产生文字理解或继续调用工具。

会话日志中的 `toolImages` 会记录图片数量。下一轮响应到达后，编排层将读图文字和同轮工具调用回填到 `toolImages.reply`；UI 在同一工具卡片中展示，并通过 `imageReply` 避免重复渲染 assistant 气泡。

视觉工具只有在全局视觉开关启用，且模型没有被明确探测为 `no-vision` 时才会提供给模型。

## 8. Agent 工具循环

`runAgent()` 每轮会调用模型、累计用量、保存 assistant 响应、解析原生或文本形式的工具调用、执行工具并追加结果。图片结果转换为额外视觉 user 消息。无工具调用、调用 `finish`、达到轮数上限或全局中止时结束。

模型普通文本本身不会自动发送到 QQ；对外动作必须通过发送类工具完成。因此最终状态按真实发送记录判断：发过消息为 `done`，未发送为正常的 `noreply`。

## 9. 会话记录与可观测性

每次运行记录：

- system/user prompt 与总字符数；
- `llmRequests` 中每一轮实际输入模型的完整 messages、tools 和请求参数；
- vendor、模型、调用轮数与 token 用量；
- 当前窗口的注入条数与折叠条数；
- 独立的响应档位、响应原因，以及历史读取上限、边界和实际注入条数；
- `promptBudgetChars` 与是否因保护区过大而超预算；
- 工具调用、错误、图片注入、发送记录和结束原因。

这些记录用于排查提示词膨胀、渠道计费、读图失败和工具循环，不作为下一次模型请求的对话历史。

会话面板的 JSON 模式以 `llmRequests` 为输入侧唯一真相，不再同时重复展示顶层 `systemPrompt/userPrompt`，也不再用首次输入伪造缺失的逐轮请求。
面板元数据按 `current / response / history` 三块展示，只读取新结构字段。

## 10. 构建、测试与发布

```bash
npm ci
npm run typecheck       # 严格类型检查，不生成文件
npm run build           # 编译 src/ → dist/
npm test                # build 后运行断言套件
npm run test:all        # 额外运行诊断脚本
npm run check           # typecheck + 层级检查 + 断言套件
npm run dev             # tsc --watch
```

测试通过 `tests/lib/src.mjs` 加载 `dist/`，确保验证的是实际运行产物。新增 `t-*.mjs` 必须在 `tests/run.mjs` 的 ASSERT 或 DIAG 中显式归类，否则 runner 直接失败。

当前重点回归包括动态窗口语义、摘要去重、当前窗口与独立历史分离、统一预算保护本轮消息、读图结果回填、`memory_query` 定向查询，以及 Web/UI 模块接线。

长期任务与事件相关改动另有一组专项套件：`t-events.mjs`（事件名/载荷/注入类型/`session-update` 通道）、`t-sse-project.mjs`（SSE 帧逐字节）、`t-panel-wiring.mjs`（UI 订阅名跨边界）、`t-ports.mjs`（跨模块端口与 `implements`；另扫 `tests/` 里每个 `new Orchestrator({…})` 是否都传了 `emit`——`.mjs` 不受 `tsc` 管，这条只能文本扫）、`t-tasks.mjs`（`LONG_TERM_TASKS` 描述符与 `conformance` 一致性）、`t-timers.mjs`（计时器句柄：起没起、停没停、有没有被"清掉又没重建"、待触发的那一次取消不取消得掉）。

发布前执行：

```bash
node scripts/sanitize-release.mjs --scan
```

`data/`、API Key、消息存档、记忆、登录态和会话记录均不得进入公开发布物。

## 11. 维护原则

- 新消息窗口、已读历史、摘要、长期记忆是四种不同数据，不要重新合并成一个模糊的“上下文”。
- 判断是否响应必须使用无限制的 `pending()`，不能只看容量受限的 `batch()`。
- `batch()`、`foldedCount()` 与 `seen()` 之间不得插入 `await`。
- 新增模型可见固定指令必须先进入 `src/core/prompt-catalog.ts`，业务模块只引用 Catalog；同时明确唯一归属并纳入统一预算，避免跨 system/user/tool schema 重复注入。
- 新增事件或长期后台任务前，先查 `docs/global-registry-design.md`：事件名与载荷类型的归属、长期任务的所有者/开关/停止入口、局部计时器的排除边界都在那里定义。
- 修改外部 JSON 或模型响应处理时，先做运行时窄化，不用无注释的全局 `any`。
- 不直接修改 `dist/`；不使用 TypeScript 路径别名；不省略 NodeNext import 的 `.js` 后缀。
- 修改对话主链路后至少运行 `npm run check`。
