# QQ Agent 项目长期开发记忆

> 这是供后续开发者与编码 Agent 使用的长期上下文。开始修改前先读本文，再按需阅读 `README.md` 和 `docs/ts-migration-plan.md`。
> 最后核对：2026-10-10。

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
只负责依赖注入和生命周期装配。`media/` 下**平铺的单文件是给"单一职责、没有内部结构"的模块用的**
（`safe-fetch` / `html-to-text` / `call-budget` / `bookmark-request`），一旦它长成"几个来源共用一个形状"
就该开目录（`hot-search/`、`image-source/`、`web-search/`、`transcription/`、`image-gen/`）。由于 `llm`、`chat`、`qq`、
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
│  ├─ slash-commands.ts 斜杠命令的**唯一落点**：判定、解析、入队与即时回执
│  └─ ingest.ts      入站摄取：白名单、@ 名字解析、引用预览、合并转发展开、拍一拍
└─ runtime/          长期任务与退出路径（描述腿 / 执行腿 / 退出编排）
   ├─ tasks.ts       描述腿（纯数据，零 import）
   ├─ lifecycle.ts   执行腿（装配清单，start 正序 / stop 逆序）
   └─ shutdown.ts    退出编排（幂等关停，零 import）
```

**这套目录约束是可机检的**（`check-layers.mjs`）：根目录出现白名单（上表前四个文件）之外的 `.ts` 直接报错，四个子目录缺一个也报错。守护空白照 `agent/` 那条：它只**禁止回根**，不管你在子目录里怎么分。

**斜杠命令只有一个落点**（`web/onebot/slash-commands.ts`）：判定、解析调用、入队与即时回执全在那里；`ingest.ts` 只用**同一个** `isSlashCommand()` 决定"要不要并入引用附件"与 `wakeEligible`。**不许在 ingest 或别处再写一份命令正则** —— 两份判据漂移（`/^\/画(?:\s|$)/` 与 `/^\/画/` 看着都对）不会有任何报错，表现只有两种：命令没被认出来、消息进了 LLM；或者同一条消息被处理两次。加一条命令 = 在 `COMMANDS` 表里**加一行**（存函数引用、按数组顺序匹配，与装配清单同形，**不是**按键分发的注册表）；命令自己的语法（用法提示、参数解析）仍留在各自的领域模块（`media/transcription/commands.ts`、`media/image-gen/commands.ts`）。守护是 `tests/t-slash-commands.mjs`（含一条源级断言：ingest.ts 里不许再出现命令正则）。

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

链路另有**三条异步回流**入口：后台转写完成后写入 `kind:'transcript'` 的【转写结果】；漫画 PDF 被 OneBot 明确接收后写入 `kind:'jmcomic-result'` 的【漫画下载结果】；出图队列把画好的图片发进群后写入 `kind:'image-result'` 的【图片生成结果】。三条都会落存档、推入窗口，再走同一套「窗口 → 响应判定 → runAgent」。那次运行**拿不到原始 tool result**（任务在更早一次运行里入队），所以正确性只能由 system prompt 规则与窗口判定承载，不能指望上下文里留着工具调用痕迹。

第三种的**交付物本身是文件**，与漫画那条同形、与转写不同：图片由队列**直接发进群**（`SendQueue.sendImage`），回流条目只承载"发过了"这个事实，让模型有机会补一句话——说不说由它决定，因为图已经在那里，而模型也没法"说"出一张图。

**合并转发展开后仍然是「一条」消息，不是几条记录**：`ingest.ts` 认到 `forward` 段就展开，产物是 `[合并转发 共N条]\n名字: 内容\n…`（`expandForwardNodes`），然后**整份替换**那条消息的 `text` —— 存档里发送者仍是转发的人，那些行只是 `text` 里的换行。三条推论：① 那些行**不带时间戳**（OneBot 的转发节点没有时间）、发送者也属于别的会话，所以任何按行展示的地方都必须让"这是一段被转发进来的东西"看得出来，否则观感就是"混进了几条不属于本群、还没有时间的记录"（实测报过一次）；② 面板侧 `ui/js/views/chats.js` 的 `forwardBlockHtml` 只把它渲染成缩进/弱化的区块、**不改 `text`**（模型要读的仍是展开后的原文），且判据 `/^\[合并转发 共\d+条\]/` 必须与 `read_forward` 工具那句 `entry.text.startsWith('[合并转发 共')` 同形 —— 两边认的不是同一件事时，工具说"已展开"、面板却平铺；渲染出的仍是**一行 `<tr>`**，多渲染出行会打乱分页账本（`state.chatMsgRendered` 与滚动加载）。③ 已知空白：`expandForwardNodes` **没有任何套件覆盖**（`[合并转发 共N条]` 这个字面也没被钉过），且展开后的形态在 `prompt-catalog.ts` 里**没有说明** —— 目录只写了未展开的 `[合并转发聊天记录]` / `[转发消息 …]`，而入站是自动展开的，模型实际看到的是第三种拼法。

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
- **异步任务结果（`transcript` / `jmcomic-result` / `image-result`）是一等窗口条目，且两个谓词给出的答案相反**：`isSystemRecord` 必须**不**认它们（否则永远进不了窗口），`isPersonMessage` 必须**排除**它们（否则空 `senderId` 会制造幽灵成员）。它们必须 `read:false`——写 `true` 会落进 `#lastSeenId` 水位线之下：进程内刚写入时看得见，**重启后永久不可见**。窗口里只要有其中一种，`evaluateWindowTrigger` 无条件响应（`responseTier:0`，原因分别为“转写结果”/“漫画下载结果”/“图片生成结果”）；**`forceWake` 绕不过档位判定**，这是唯一落点，且规则不能读 `roll`。规则作用于**整批**。出图那条要单独记一句：它保证的是"模型有机会补一句话"，**不是**"图能发出去"——图由队列自己发。

## 提示词维护规则

所有模型可见的固定指令（内置 persona、system/user 固定段、工具 description、历史压缩与记忆整理指令）只允许写在 `src/core/prompt-catalog.ts`，业务模块引用其中的 `PROMPT_CATALOG`；`src/agent/prompting/prompt-builder.ts` 只负责动态变量、聊天记录格式化、条件选择与预算裁剪。UI 文案、日志、HTTP 错误和运行时参数校验错误不属于提示词目录。

工具**结果**串一般留在各自工具文件里（它带动态数据或错误文案）；唯一的例外是 `transcribe_video` 的回执话术 `TOOL_PROMPT_TEXT.transcribe_video.receipt`——它没有动态成分，且要解决的是"诱导模型说哪句话"而不是"返回什么数据"，所以按固定指令处理。**它必须整句取自目录，不许在工具文件里拼状态串**：带上任务号（`job.id`）会让模型回一句"任务已派上（任务 xxxx）"，而 `description` 与 `toolProtocol` 第 7 条是同一件事的另外两个面，分居两地就调不齐。

**「工具的参数是 JSON」这条也只写一处**：`toolProtocol` 第 3 条（字符串值里需要引号时用中文引号，不要用英文双引号）。它是**所有工具调用共有的传输格式**，不是某个参数的语义约束——写进 tool schema 就得在 `send_message.messages`、`sticker_note.note`、`memory_append` 每个自由文本字段里各抄一遍，而抄本必然漂移（这正是 §5.1 那句"参数定义留在 schema"的**唯一例外**，docs 里已注明）。模型偶尔仍会漏（实测一次群聊：它写了 `一脸"你们人类真无聊"`，引号没转义 → 整个 `arguments` 不是合法 JSON → **这条消息根本没发出去**），所以通用失败文案（`agent/tools/shared.ts` 的"参数不是合法 JSON"）必须带上可执行的下一步（改用中文引号后重新调用）。**不许加猜测式的 JSON 修复**：猜错配对/位置会把**被改动过的文本真的发到群里**，比发不出去更糟；正确做法是把原文与下一步一起回给模型，让它自己重发。

- 稳定且全局的行为规则进入 system prompt。
- **出图的提示词分两层，只有第一层进 Catalog**：模型写"画什么"（`TOOL_PROMPT_TEXT.generate_image.prompt` 里要求它写成给画图模型看的成稿描述，不是群友原话），管理员配的 `imageGen.stylePrompt` 管"怎么画"、由**代码**拼在描述之后（`media/image-gen/client.ts` 的 `withStyleLayer`）。**第二层一个字都不许进给模型看的任何指令**：说了模型就会自己把那句话也写一遍，同一句出现两遍。这与"工具的参数是 JSON 只写一处"是同一类边界（写两遍必然漂移）。
- 出图那条 `receipt` 与转写同形（整句取自目录、不含任务号）；但**规则内容与转写相反**：转写要求"看到【转写结果】必须开口"，出图要求"顺口补一句就够、也可以安静结束，不许复述已发送、不许描述画面"——因为图已经由系统发进群了，而那张图模型压根看不到。
- 会话状态、摘要、历史、新消息、相关记忆和表情目录进入 user prompt。
- 工具参数和参数约束只写 tool schema，不在提示词中复制一份。
- 新增信息前先确认是否已在 system、user 或 tool schema 中存在，避免重复注入。
- 当前窗口从【过去状态】排除；已注入的摘要也从【过去状态】排除。
- 长期记忆只选择本轮触发消息和实际注入历史中出现的成员。

统一字符预算为 `store.promptContextMaxChars`，默认 32000，`0` 表示不限。保护区包括当前状态、【本次唤醒】和【本轮决策】；超限时依次收缩表情目录、摘要、记忆、已读历史。不得为了满足预算静默截断本轮用户新消息。

【过去状态】目前按整段让位，不进行半条消息截断；被预算移除时必须同步修正 `session.pastStateCount`。

引用预览是**动态拼装**（不算固定指令），所以不在 Catalog 里：唯一拼法是 `prompt-builder.ts` 的 `formatReplyPrefix`，数据来自存档的结构化 `reply`。只用前缀匹配（`text.startsWith('[引用 ')`）判断"这条是不是引用"的地方**必须**改成看 `reply`——预览已经不在 `text` 里了。形状、成因与三处调用点见「图片链路」那条与 `docs/ts-migration-plan.md` §5.4。

## 工具与记忆边界

- 模型普通文本不会自动发到 QQ；发送必须通过发送类工具。
- **工具不得代模型发言**：工具只负责查询/入队并返回结果，说不说、怎么说由模型在这一次运行里自己决定。当前契约的三个实例是 `transcribe_video`、`generate_image` 与 `reverse_image_source`。这条不是风格偏好，它有两条机制上的理由，都实测发生过：① 代发会写进 `ctx.session.sent`，而收尾按发送记录判状态（发过即 `done`），于是模型本该在失败时给群友一句交代，却因为"看着已经说过了"停在错误结果上结束 —— 症状看起来是"任务没有正常结束"，其实是**任务被代发伪装成了已收尾**；② 工具一旦返回错误，模型会拿同一份输入再调一次，代发提示就跟着**重复发一遍**（实测：图源接口先 HTTP 400 后成功的一轮里，「在找图源，稍等」出现了两次）。代价是模型选择沉默时群里在结果到达前没有提示，这是刻意取舍。**推论**：失败路径的正确做法是把真实原因**返回给模型**（如 `imageSourceFailureText` 把未知原因连原始码一起带出），而不是替它开口；异步结果（转写回流）则靠 system prompt 规则保证模型届时一定开口。
- **工具后的普通文本有且只有一次协议纠正**：同一次 `runAgent` 已执行过工具、尚未成功发送任何 QQ 动作，随后模型返回非空普通文本却没有 `tool_calls` 时，不得把那段文本直接代发（它可能是思考或内部说明）；追加一次 `PROMPT_CATALOG.user.toolProtocolCorrection`，给模型一个独立于 `maxRounds` 的额外轮次，让它自己选择发送工具或 `finish`/空内容保持沉默。纠正后再次没有工具调用就正常 `noreply`，绝不循环。没有调用过工具的普通文本、以及已经成功发送文本/表情/拍一拍的运行不走这条路径。专项守护是 `tests/t-tool-protocol.mjs`。
- `memory_append` 和 `memory_query` 必须使用准确的数字 QQ 号。
- `memory_query` 禁止无参数读取全部成员记忆，只允许定向查询一个 QQ 号。
- 历史摘要回答“过去发生了什么”；长期记忆只保存以后与该成员交流仍有用的稳定印象。
- 工具返回内容属于不可信外部数据，不能当作高优先级指令重新注入。

## 事件与长期任务边界

- **注册层的实际形态是四件产物的合称，不是一个对象**（S11c 起，详见设计稿 §0.1）：事件腿 `core/events.ts` 词表、方法腿 `AgentControlPort` 端口、任务**描述**腿 `web/runtime/tasks.ts`（纯数据）、任务**执行**腿 `web/runtime/lifecycle.ts`（有序的函数引用数组）。四件都不是注册表，合起来才是；任何把它们收进一个 `register(...)` 的尝试都会撞上跨层反向依赖与字符串式动态调用两条禁令。事件是散布的 `emit(EVENTS.xxx, payload)`，长期任务各自持有计时器句柄。设计、清点与分步迁移方案见 `docs/global-registry-design.md`（S0–S9 已落地，**S10+ 已全部落地**：S10a 收下 `price.feed`、S10b 收下两个 jmcomic、S10c 收下 `onebot.reconnect`、S10d 删掉 `Orchestrator` 的兜底事件总线并把 `emit` 改成必填；**S11a–c 已落地**：S11a 收口无头入口的退出路径——`src/web/runtime/shutdown.ts`，`SIGINT`/`SIGTERM` 都走同一个幂等关停，重复信号立即强退、`stop()` 抛错也照常退出；S11b 端点热生效；S11c 装配清单；**S11d 收死代码与空转事件**——`core/config.ts` 的 `scheduleConfigSave`/`saveTimers`、`agent/shared/types.ts` 的 `AgentEventMap`、`MemoryConsolidatorDependencies.emit`（连同 `orchestrator.ts` 的传参）、`vision-scan` 整条事件（词表键 + 载荷类型 + 两个发射点 + `/api/vision/scan` 的 emit 传参）。**注意它删的是事件，不是 `providers.ts` 里那个同名的 `visionScan` 局部对象**——那个是活的，别当残留一起删掉；**S11e 让桌面端的退出也等关停落地**——`electron/main.js` 的 `before-quit` 是 `quitting = true` → `if (stopping) return;` → `event.preventDefault()` → `Promise.resolve().then(() => core.stop()).catch(...).finally(() => app.quit())`。**三条不变量缺了都会挂，改动它之前先读那一段的注释**：`quitting` 必须先置位（退出期间关窗会缩托盘，把退出挂住）、`stopping` 守卫（第二次 `app.quit()` 会再进这个处理器，缺了它 `preventDefault` 拦下自己 → 死循环）、`.finally` 里必须自己再退一次（`preventDefault` 之后没人再退 → **应用永远不退**）。前两者与后者都**没有任何行为套件看得见**（`electron/main.js` import 不了），只有 `t-lifecycle.mjs` 第 5 段那 6 条文本断言守着）。S10+ 解除了"改启动/配置刷新/退出流程"与"动定时器生命周期"两条禁令，**但只为"让长期任务能被显式启停"**；其余禁令（不替换事件总线、不建字符串式注册表、不动 `src/qq` 入站解析）照旧。**注意 S10c 动的是 `src/qq/onebot.ts` 的 `close()`/`connect()`/`reconnect()`，不是入站事件解析**——后者仍在禁令内；S10d 删的是 `Orchestrator` 自建的那条兜底总线，`core/util.ts` 的 `createEventBus()` 本体保留（`app.ts` 照旧用它）。
- 事件名与载荷类型**只在 `src/core/events.ts`**（`EVENTS` + `AppEventMap`）。新增事件必须同时加常量与载荷类型，否则编译期护栏会报错。词表放 `core` 是因为生产者散在 agent/llm/qq，而层级检查禁反向依赖；代价是载荷只能用基础类型，不能引用 `chat/` 或 `agent/` 的领域类型。
- **发射点一律写 `EVENTS.<key>`，不许再写字面事件名**；`tests/t-events.mjs` 扫 `src/` 钉住这条（它同时断言没有"词表里有、却没有任何发射点"的空转名字，并真跑一轮 agent 断言 `session-end` 的真实载荷）。UI 侧的 `es.addEventListener('<name>')` 由 `tests/t-panel-wiring.mjs` 对词表做**跨边界比对**——改名只改一端会静默失效、不报任何错，所以两端都要动。
- **S6 起载荷受编译期检查**：`emit` 的注入类型是 `AppEmit`，写错载荷 `npm run typecheck` 直接报错，不需要额外套件守。但**事件名不受它约束**——`this.emit('chat-update', key)` 与 `this.emit(EVENTS.chatUpdate, key)` 在编译器眼里一样，所以字面名只能靠上面那条文本扫描挡。`tests/t-events.mjs` 另有一条断言钉住"受检查的注入点清单"（S6 时 9 个文件 / 13 处，**S11d 删掉 `memory-consolidator` 与 `vision-scan` 两处注入点后一度降到 7 个文件 / 10 处，此后新增的注入点（如 `web/onebot/ingest.ts`）又把它长回 10 个文件 / 13 处**——两个数的口径见设计稿 §4.3，**以文件集合为准**），因为**把某个注入点退回 `(event: string, payload?: unknown) => unknown` 不会报任何错**——它后面所有发射点会静默失去检查；新增注入点时要把它登记进那个套件的 `TYPED_FILES`。**那份清单是对称的**："少了"与"多了"都会报，删注入点时忘了同步删文件名同样会红——报出来的是**文件名**而不是运行错误，最容易当成测试噪音忽略（S11d 实测：把 `emit: AppEmit` 加回 `memory-consolidator.ts` 会同时打红 `t-lifecycle.mjs` 与 `t-events.mjs` 两边）。
- 注意同名异物：`session-end` 载荷里的 `sentCount` 是**条数**（数字），而 SSE 投影给面板的 `sent` 是**数组**（每条发出的消息）。改这两个字段前先看 `docs/global-registry-design.md` §4.5。
- `session-update` 是**瘦事件**：载荷只有 `{ sessionId }`，富字段（`messages`/`sent`/`finishReason`…）由 `src/web/http/event-projector.ts` 在 emit 当刻现读 `sessions.peek()` 拼进 SSE 富帧，不要把读模型搬进 `agent`。这条通道在 S7 之前**全程无效**（12 个发射点发裸串、投影与 UI 都要求对象，三方从未对齐）——正因为"形状看着对、接线从未对齐"能瞒过所有人，`tests/t-events.mjs` 第 6 段才会真跑一轮并把载荷喂给真投影函数、断言出的是**富帧**；只断言"载荷是对象"证明不了通道通。真机面板表现（SSE 与 4s 轮询双写）任何套件都覆盖不到。
- 服务端事件总线是空转的：`createEventBus()` 的 `on()` 在 app 里没有任何调用者，实际投递由 `src/web/app.ts` 的 SSE 包装完成。**不得把业务正确性挂在 `on()` 上。**
- `Orchestrator` 的 `emit` 是**必填依赖**（S10d 删掉了构造函数里的兜底总线）。`src/` 侧漏传 `tsc` 直接报错；**`tests/` 侧不会**——`.mjs` 不在 `tsconfig` 的 include 里，`tsc` 永远看不到它们，而 8 个构造点里只有一个（`t-panel.mjs`）会因为真的调用了会 emit 的方法而变红，`t-ports.mjs` 那一个**删掉 `emit` 会全绿**。所以往 `tests/` 里新增 `new Orchestrator({...})` 必须自己记得写 `emit: () => {}`，守护是 `tests/t-ports.mjs` 第 1c 段的文本扫描（逐个实参对象必须含 `emit`）。
- SSE 帧的拼装只在 `src/web/http/event-projector.ts`（纯函数，`tests/t-sse-project.mjs` 逐字节钉住）。`app.ts` 的 `emit` 闭包只负责委托，不要在它身上重新长出拼帧逻辑。
- 不为业务方法引入字符串式动态调用或运行时热替换。仓库里仅有的三处字符串键分发（工具分发、OneBot `call`、HTTP 路由）都是外部契约，保持原样。
- **跨模块方法面走端口，不走注册表**：`web/` 与 `electron/main.js` 只能依赖 `src/agent/runtime/control-port.ts` 的 `AgentControlPort`（`Orchestrator implements` 它），不许直接依赖 `Orchestrator` 具体类。往端口加成员是个**有意的动作**：接口、`METHOD_CATALOG`、`tests/t-ports.mjs` 里那份手工清单三处要同时改（`tsc` 会拦下前两处，第三处由套件拦）。端口里**不得**出现 `instanceof` 检查、`Symbol` 品牌或运行期校验——那会打碎 `t-orch`/`t-vision-log` 用普通对象字面量充当依赖的构造策略。`METHOD_CATALOG` 只作文档与测试引用，**`src/` 里除定义处外不许引用它**（一旦参与分发就是被禁的字符串式注册表，套件会扫出来）。
- 动手改端口相关代码前先读 `src/agent/runtime/control-port.ts` 顶部注释：`implements` 那一行**删掉不报任何错**，端口会静默退化成注释——`tests/t-ports.mjs` 第 1 段就是为此存在的文本扫描。
- **长期任务用 `src/web/runtime/tasks.ts` 的 `LONG_TERM_TASKS` 登记**（当前 10 行：S9 的 6 行 + `transcription.worker` + `hot-search.daily-broadcast` + `image-source.pic-worker` + `image-gen.worker`）。这张表是**纯数据**：不得触发任何 `start`/`stop`、不得在文件里放调度调用，`src/` 里除定义处外也不许引用它（三条都有断言守，见 `tests/t-tasks.mjs`）。写法上有两条硬约束：
  - `start`/`stop` 存的是**入口的名字**（`{ on, kind, name }`），不是函数引用——存引用的话套件只能自己验自己，存名字才能拿到真对象/真模块上解析。
  - `conformance` 的判定规则写在文件头部注释里（`full ⇒ start && stop && stopCancelsPending`；`partial ⇒ (start && !stop) || (stop && !stopCancelsPending)`；`none ⇒ !start`），套件按同一条规则断言；**改规则要同时改两处**。做不到的不许写成能力，只能如实标 `partial`/`none` 并在 `note` 里写清"接管它需要做什么"。
- **局部计时器不进任务表**：LLM/HTTP 超时、重试退避、限速与拟人停顿、唤醒防抖、单次扫描轮询、启动期端口轮询等，按"生命周期是否长于一次请求或一次会话"判定为局部计时器（**判定看的是这条界线，不是某个数字**——设计稿附录 B 里那些汇总数各条增量说明各写一次、已经漂了：2026-09-29 实测源码共 34 处调度调用点，其中属于长期任务的 9 处，其余是局部计时器（含解释器探测/自检那处硬超时，宿主 `core/python-probe.ts`）；逐条清单见 `docs/global-registry-design.md` 附录 B）。**绝不要包装 `setTimeout`/`setInterval` 全局来"顺便"收编它们**——那会把排除清单变成谎言。`tests/t-tasks.mjs` 有一条反向断言专门钉这条，设计稿里被点名排除的 `wake.debounce` 就是它的靶子。
- 新增长期后台任务必须能显式启停，**不得靠模块加载期或构造函数副作用启动**。启停点已收敛成一条硬规则：**长期任务一律在 `src/web/app.ts` 的 `start()` 里启动、在 `stop()` 里停止**。**S11c 起这条规则由 `src/web/runtime/lifecycle.ts` 的装配清单（`LIFECYCLE`）驱动**：`start()` 只调 `await startLifecycle(deps)`，`stop()` 只调 `await stopLifecycle(deps)`，`app.ts` 里**不再出现任何一条硬编码的任务启停调用**（`lifecycleDeps()` 只负责把真模块递进去——"装的是什么"在 app，"按什么顺序装"在清单）。清单的三条可机检性质：① `start`/`stop` 存**函数引用**（不是名字），运行期只有 `for...of`，没有 `LIFECYCLE[动态键]`/`.find(`/`.get(`；② `ids` 只作**对账元数据**，运行期从不读；③ **import 它不启动任何东西**。**顺序即语义**：start 正序 = 清单顺序，stop **逆序**，于是"停长期任务排在 `onebot.close()` **之前**"（在途的 QQ 上传调用还依赖传输层）由"`onebot.reconnect` 排第一位"自动满足，不再靠人记。**往清单里插一行时位置就是行为**——插错地方不会有任何编译错误，只有 `t-lifecycle.mjs` 第 3 段的顺序断言会红。可参照的现成实现有：`price.feed`、两个 jmcomic 任务、`onebot.reconnect`、`transcription.worker`，以及 `hot-search.daily-broadcast`（`HotSearchScheduler.start/stop`，`node-cron` 句柄可销毁并等待在途播报）；`image-gen.worker` 是**唯一不加清单级闸门**的一条（队列空载时不持有任何东西，而把闸门提到清单里会让"配置关着"报成"画图服务尚未启动"，见该行 note）。**配置刷新路径刻意不接清单**：`applyConfigPatch` 只直接刷新确实支持热刷新的价格表与热搜计划，避免误调无条件任务。`stop()` 里 `abortAll()` **不进清单**（它管的是中止在跑的会话）。**`conformance` 列今天只剩 `jmcomic.worker` 是 `partial`**，成因是"停不掉**正在执行**的那一次下载"。新增任务时**要动三处**：`LONG_TERM_TASKS`（+ `tests/t-tasks.mjs` 的 `EXPECTED_IDS`）、`web/runtime/lifecycle.ts` 的 `LIFECYCLE`（+ `tests/t-lifecycle.mjs` 的 `EXPECTED_ENTRY_IDS` 与两条顺序期望），以及 `app.ts` 的 `lifecycleDeps()`；**只改一处会被套件拦下**。
- 请求作用域计时器（LLM/HTTP 超时、重试退避、限速与拟人停顿、会话防抖、单次扫描轮询、启动期端口轮询等）**不是长期任务**，不要纳入任务表——判定标准与清单见上一条。
- 改长期任务相关代码前先看 `tests/t-timers.mjs` 的 `withFakeTimers()`：它替换的是**全局** `setTimeout`/`setInterval`/`clearInterval`（`dist/` 里编译成裸标识符，所以拦得住）。两条坑写在它的注释里——假句柄必须放**原对象**进记录数组（放拷贝会把 `unrefCalled` 冻在 `false`，断言永远假绿），以及 `try/finally` 必须恢复（被测模块是模块级单例，漏恢复会污染同进程后续用例）。**第三条是 S10c 踩出来的**：断言"某处排定被取消"时，夹具必须让**新的排定真的不会发生**（例如测试 `connect()` 的取消时，要让 `new WebSocket` 构造成功）——否则被替换路径上的新排定会顺手清掉旧句柄，被测的那一行删不删都一样，探针会拿到**假的绿**（实测踩到，见设计稿 §9.5 第 16 项②）。**另有一处已知的守护空白**：`jmcomic` 的 `runWorker` 里 `while (runtime && …)` 那道闸门删掉不会让任何套件变红（要观察到差别得让夹具里有两个可跑任务，而第二个会过继给后面的真起 app 段去碰真 onebot），它只有注释在守——别以为它被管着。

## 图片链路

`get_message_images` 只负责找到并安全下载图片。图片以 data URL 形式作为额外的多模态 `role: user` 消息交给视觉模型，不塞入 `role: tool` 图片内容。

**被引用对象的 id 必须可寻址，这是本条链路的硬约束**：存档里 `ChatMessage.reply` 是结构化的 `{ mid, sender, text }`，**预览只存在这里、不拍进 `text`**（完整设计与实测成因见 `docs/ts-migration-plan.md` §5.4）。三条推论，改动时别拆散：① 模型可见的引用预览一律由 `prompt-builder.ts` 的 `formatReplyPrefix` 拼成 `[引用 #-966228343 清三：[图片]]`（`formatEntry` / `buildTriggerBlock` / 历史压缩的输入行三处共用），面板侧 `ui/js/views/chats.js` 的 `replyPrefixHtml` 是**同形态的另一份实现**（`ui/js/` 够不着 `src/`），改一处要改两处；② 触发标签「引用」认结构化 `reply`、不认文本前缀（老存档按前缀兜底）—— 只看前缀的话标签会静默消失，这正是本轮差点踩到的形态；③ `get_message_images` 在目标消息没有图、但它引用了某条消息时**顺着 `reply.mid` 回退**去取被引用那条的图，并在结果文本里点明图来自哪条（不点明的话模型会把图归到错误的发送者名下）。这条回退不是猜测：`reply.mid` 是入站时就记死的关联；引用段没带 id 时 `reply` 为 `null`（按"没有引用"处理），解析不出被引用正文时**只丢正文、不丢 id**。守护分散在四个套件里，改这条链时四个都要跑：落库形状与预览上限在 `t-transcription.mjs`（它的 `replyIngestFor` 每个用例用一个**独立群号**——`new ChatStore()` 会从磁盘重载，同群号会让 `findByMid` 读到前面用例留下的那条），渲染与标签在 `t-reply.mjs`（含压缩输入行），工具回退在 `t-vision-log.mjs`，面板行在 `t-ui-render.mjs`。

下一轮模型输出需要回填到 session 的 `toolImages.reply`，UI 在图片工具卡片中显示；对应 assistant 条目标记 `imageReply`，避免相同读图结果显示两次。

**`get_message_images` 的结果必须点名「这张图**是谁发的**」，不能只印消息 id**（**实测反馈**）：甲发了一张图、乙也发了一张，模型连着读了这两张，然后把它做的吐槽算到了**乙**头上（图是甲的）。原因是标签原来只写 `消息 -1135000659 的图片内容` —— **id 对模型没有"这是谁发的"含义**，两条结果长得几乎一样，模型就把"图"和"先说话的那个人"配了对。现在拼成 `消息 <id>（<发送者名> 发的）的图片内容`（回退那条是 `消息 <id> 引用的是消息 #<来源id>（<名> 发的）图片内容`），并同步在 `TOOL_PROMPT_TEXT.get_message_images.description` 里写明"返回内容开头会写明是谁发的、同一轮多张图不要算到另一个群友头上"——**承诺与实现必须一致**，套件里有一条断言钉住"实现真的把『X 发的』放在开头附近"。这跟上面那条"走回退时必须说清图是从哪条消息取的"是**同一个病**的两种形态：那条修的是"把图归到被引用者名下"，这条修的是"把图归到错误的发送者名下"。守护在 `t-vision-log.mjs` 第 5 段：**两个不同发送者各一张图**，各自只能出现自己的名字（对照断言是"甲某那张里不出现乙某"，否则等于没点名）。
- ⚠️ 写这条链的套件时注意：`get_message_images` 的 `content` 是**内容部件数组**（`shared.ts` 的 `imageParts` 返回 `[{type:'text'}, {type:'image_url'}…]`），不是字符串。直接 `String(content)` 会得到 `[object Object],[object Object]` —— 本套件初版就这么假红了一条。取文本要 `content.map(p => typeof p === 'string' ? p : p?.text || '').join('')`。

修改此链路时重点运行 `t-vision-log.mjs` 和 `t-ui-render.mjs`。

会话 JSON 面板只以 `session.llmRequests` 展示逐轮真实模型输入（完整 messages/tools），不要再建立首次输入副本。

**反向搜图（`reverse_image_source` 工具）是另一条链路**，与上面那个"把图片喂给视觉模型"无关：入站图片 → `src/media/image-source/` 的缓存/队列 → **唯一一个通用 provider**（`pic-image-search-provider.ts`）→ 常驻 Python worker（`python-tools/pic_image_search_worker.py`）。**路由、掩码、预算与四条常量的完整设计见 `docs/image-source-routing-design.md`**（改这一链之前先读它）。三条边界：

- **引擎知识在 Python**：引擎的类名、家族与字段归一化都在 worker 里（`ENGINE_CLASS_CANDIDATES` 与几张映射表）；Node 侧**只有一个通用 provider**，它只做转发（`search(engine, …)`）并把客户端的 `ping()` 包成吞异常的 `test()`。**不要**再按引擎长出一个 provider 类。
- **映射唯一实现在客户端**：`pic-image-search-client.ts` 的 `toImageSourceResult` 是 `ImageSourceResult` 的唯一起草处；按引擎的 `enabled`、`apiKey`、`similarity >= minSimilarity` 过滤来自 Node 自己的配置，所以留在 Node。SauceNAO 的 `apiKey` **只走 stdin，绝不进 argv**（Windows 上任何本地进程都读得到命令行）。
- **worker 由长期任务表接管**（`image-source.pic-worker`，`imageSource.enabled` 门控、**默认 `false`**）：`initPicImageSearch()` 预热（失败只记日志，不掀翻 `app.start()`）、`closePicImageSearchClient()` 关子进程并 fail 掉在途请求；懒启动保留，所以 `test()` 不会留下没人收的子进程。`test()` 走 worker 的 `probe`，**刻意不烧远端配额**——`true` 的含义是"配置对"，不是"远端活着"。
- **跑哪些引擎、什么顺序、门槛多少在 Node**：唯一绑定处是 `reverse-image-source-service.ts` 的 `ENGINE_ROWS`（`Record<EngineWhich, EngineRow>`，一段配置一行），顺序另由 `ORDER`（`Record<SearchIntent, …>`）表达。两张表都是**逐行写明**的：加引擎 = 加一行 + 在 `ORDER` 里给它定位置（顺序是语义，不该由"按 kind 排序"这类现成规则替加引擎的人做决定）。`failures` 里的 `trace:` / `sauce:` 标签经工具**原样进模型可见文本**，不能为了好看改成引擎名。
- **`ORDER` 是"命中即停"的，所以它同时决定"谁先答"和"谁拦住谁"**：结构是**每个类型先问它的专属引擎，答不上（没结果 / 不过门槛 / 抛错 / 超时）再问一般向兜底，兜底也失败就结束 —— 链上最多两发**。`anime → ['trace','baidu']`、`manga`/`illustration → ['sauce','baidu']`、**`unknown → ['baidu']`（没有专属引擎）**。一般向引擎是**百度识图**（`baidu`：5 个候选里唯一不要 API Key、面向中文互联网、类名 `BaiDu` 已被真机实测确认的那个），恒排链尾。`unknown` **不是** `anime` 的同义词：它恰恰是模型判不出类型时填的那个值，而窄域引擎（trace.moe 只索引动画帧）要么白烧一次调用、要么给假命中并因为 `break` **拦住**后面的广域引擎（真机实测：一张梗图两次都走上动画那条路；探针实测：把顺序改回去，`intent=unknown` 会变成 `calls=trace.moe sim=0.99`）。判据是**引擎覆盖面**：窄域引擎只在类型已确认时才先问。守护是 `t-image-source.mjs` ⑦ 段（**它此前对 `unknown` 一条断言都没有**——模型最常填的值、四套件全绿的守护空白——夹具必须让 trace.moe 也自称命中才可判别；`manga` 这一档同理，三处取值域缺一处就会有断言红）。
- **intent 除了决定顺序，还决定引擎参数**（`INTENT_PARAMS`，与 `ORDER` 并列的第三张显式表）：SauceNAO 的 R18 掩码 `hide` 按类型一行 —— **今天真正带上它的只有两条：`manga` 与 `illustration`，值都是 `{ sauce: { hide: 0 } }`（不藏）**；`anime` 与 `unknown` 根本不问 SauceNAO，也就没有这个参数（见 `INTENT_PARAMS`）。**这个"按类型收紧过滤"的档位今天没有任何实际分岔**，它保留的是一个**落点**：`Record<SearchIntent, …>` 的穷尽性会在第五个 intent 出现时逼出一次决定（"将来只有 `illustration` 藏 R18"就是改那一行，只改一处）。不藏的理由是实测撞出来的：`hide=1` 曾把 Madokami 那张同人志图**藏掉**，而 `hide` 由**服务端按它自己的判定**过滤，我们无法复核它凭什么认为某张图是预期 R18 —— 误判一次的成本是整条结果消失（完整推导见 `docs/image-source-routing-design.md` §2）。**刻意不做成设置页上的档位**：模型每次调用都已经给出了"这是什么图"，而一个全局档位只能同时错杀一边。三条边界：① `hide` 是 SauceNAO 的**构造**参数，**不是** `search()` 的 kwargs（实测签名见 worker 头部 ⚑ f 条），所以它经 `engineOptions` 一路递到 worker 的 `_saucenao_constructor_args()`；② 那个函数**必须是白名单，不许整份透传 `options`** —— `__init__` 结尾是 `**request_kwargs`，`_has_var_keyword()` 判真之后 `_filtered_call` 是**全传**的，键名拼错不会有任何报错、会被原样塞给 HTTP 客户端（不报错、参数却没生效）；③ `dbmask` / `dbmaski` / `db` / `dbs` **有意不接**：编号表不在库里（实测 `constants` 只导出 `COPYSEEKER_CONSTANTS`），凭印象填掩码的表现是"悄悄隐藏了另外几套库"，而结果里只有 `index_name` 一个线索。守护在 `t-image-source.mjs`：⑦ 段三条（三种 intent 各一条 —— `anime` 那条**只能**挂在"trace 低于门槛、真的问到了 SauceNAO"那个用例上，因为 trace 先命中就 `break` 了）+ ⑩ 段两条（白名单函数体、`_engine` 里那行调用，后者用**方法体**锚点）。
- **预算必须为兜底留位置，否则"专属引擎超时 → 兜底"在最需要它的那一刻不会发生**：`totalTimeoutMs`（默认 35000）是**整轮**死线且**包含图片下载**，而上一版每一发都拿满自己配置的 `timeoutMs` —— 真机那次 `TOTAL_TIMEOUT` 的算术正好是 `20000 + 15000 = 35000`，**零余量**。现在每一发都从同一条死线倒推：`available = 剩余 - 8000×后面还有几发 - 500`，**`available < 3000` 就跳过并记 `<which>:NO_BUDGET`**（一句关于**我们**的陈述），否则 `budget = min(该引擎配置的 timeoutMs, available)`；判据比的是 `available` 而**不是**最终预算 —— 配置侧的钳制是 1000–60000，用户把小超时配成 1 秒是合法决定，拿最终预算去比会把"用户把超时配小了"报成 `NO_BUDGET`（实测踩到过一次，改完才绿）。四个常量（`FALLBACK_RESERVE_MS` / `MIN_ENGINE_MS` / `DEADLINE_EDGE_MS` / `DOWNLOAD_MAX_MS`）是**写明的常量而不是配置项**，理由写在各自注释里，改它们等于改行为。下载也被夹在 `min(DOWNLOAD_MAX_MS, 剩余)` 里并接上 `AbortSignal`（`loadSafeImage`/`safeFetchBinary` 的可选第三参），超时由**服务层**抛 `IMAGE_TIMEOUT` —— 于是"下载慢"与"接口慢"第一次能被分开（此前两者都落进 `TOTAL_TIMEOUT`，而文案写的是"图源接口响应太慢"，**归因是错的**）。守护：`t-image-source.mjs` ⑦ 段的两条（夹住给后面留位置 / 预算不够就不发这一枪）。
- **门槛是引擎级的**：网页类引擎（`baidu`）**不返回置信度**，所以它那段配置里**根本没有 `minSimilarity` 这一栏**（`EngineLimits.minSimilarity` 可选，"没有这个概念"由**字段的缺席**表达），`ImageSourceResult.similarity` 也随之变成可选、`result-formatter.ts` 按"字段在不在"决定印不印那一行（与 `time` 那个 `00:00` 同一条规矩；`pct(undefined)` 印出来的是 `NaN%`）。**有门槛的引擎仍要求结果自带置信度且过线，无置信度的结果对它们照样被丢弃**——两条互为对照，别只留一条（否则"顺手把门槛删了"与"顺手给所有引擎放行"都看不出来）。客户端里那句 `similarity: num('similarity') ?? 0` 已改成"取到才写"：兜出来的 `0` 不是"零相似"，是**替引擎编了一个它没说过的数**。
- **AnimeTrace 不是第三个引擎**：worker 的 `ENGINE_CLASS_CANDIDATES` 里 `anime_trace` 的候选是 `("TraceMoe","AnimeTrace")`，它是 trace.moe 的**中文叫法**。加成独立一行、两个都打开时会打同一个接口两次、白烧一份配额。`t-image-source.mjs` 有一条断言钉着"服务层源码里不出现 `anime_trace`"。
- **与真实库的对账结论是实测出来的，不是推出来的**（2026-09-29 在目标解释器上跑了三次，Python 3.10.12 / PicImageSearch 3.12.11，入口就是设置页那个「跑一遍依赖自检」）：worker 头部 ⚑ 四条（a 结果访问器 / b 条目字段名 / c 引擎类名 / d 入参名与能否直接喂 bytes）**已全部实测确认**，此后重跑 `--self-check` 的用途是**回归/升级探测**，不是补未知。这四条对账结论（⚑ a–d）各自钉下的事：① 第一次把每个引擎的返回类型打了出来，由此知道**响应类在类上一个字段都不声明**（属性是在 `__init__` 里 `self.x = …` 赋的，所以第一版 dump 打出来是一片 `{}`）、而且 **`google_lens` 是唯一有两个形态的引擎**（返回 `Union[GoogleLensResponse, GoogleLensExactMatchesResponse]`，其余 7 个各一个类，所以 `_items()` "两个都试、只接受 list" 的写法不能改成只认一个）。dump 已按这两条实测重写：字段名从四个来源取（MRO 注解 / pydantic 字段 / `__slots__` / **`__init__` 里赋值的 `STORE_ATTR` 字节码**），条目类从"响应类的 `__init__` 构造了哪个类"（`LOAD_GLOBAL`，**必须递归进嵌套 code object** —— 列表推导有自己的 code，只看外层 `__init__.__code__` 会漏掉，实测在假夹具上漏过一次）与模型子模块两处找。② 第三次把真实字段名打全了，b 条随之收口：两个响应类都**没有 `results`**（`BaseSearchResponse{origin,url,raw}`，条目列表就在 `.raw` 里），`_pick("https://trace.moe","title")` 这类取法取到的是**字符串的同名方法**（`str.title`），所以新增了 `_attr_node()` 在取属性前先把 str/bytes/数值/容器挡掉。③ c 条红过一次：库导出的名字是 **`BaiDu`**（大写的 D），原先写 `Baidu`，于是那个引擎**永远解析不到**（既不在 ready 事件的 engines 里，真去请求报 `PROVIDER_UNAVAILABLE`），而静态清单里 `baidu` 一直都在、谁也不觉得缺。④ d 条是好消息：参数名恒为 `file`，**可以直接喂 bytes**，所以 `INPUT_MODE=auto` 先走 bytes 是对的，`_call_search` 里那个临时文件降级是纯保险。
- **那次实测当场抓出两个真机 bug，两个都是"字段名猜错"的同一病**（都是先有代码、后有实测，谁也没报错）：① trace.moe 的时间戳字段真名是**大写 `From`**（`To` 同理），而链里写的是小写 `from` —— 于是**每条结果的开始时间都取不到**；又因为当时数据层兜了 `0.0`，`result-formatter.ts` 里那句"字段在不在"（`time != null`）永远成立，**每个结果都印 `00:00`**，与"接口没给时间"长得一模一样。修法是 `_pick(raw_item, "From", "from", …)` **并在取不到时干脆不写 `time` 键**（数据层写 0 = 替模型编了一个第 0 分 0 秒；`time === 0` 是合法值，判据必须是"字段在不在"）。② 动画标题可能变成**来源站点的 URL**：旧链里"`origin` 是裸字符串就当标题"排在真 `title` **前面**，而实测 `TraceMoeItem` 直接给了 `title_chinese`/`title_native`/`title_romaji`/`title_english` 四个平铺字段，所以正确的是先取这四个、那条 `origin` 兜底整个删掉（`idMal` 是 MyAnimeList 的 id，**刻意不读**）。两条都有断言（`t-image-source.mjs` 第 ⑩ 段，见下）。
- **与上一条配套的实测细节**：`Network(...)` 的参数名是**复数 `proxies`**（写成 `proxy` 会被静默丢掉）；`TinEye` **不在** 3.12.11 的 22 个导出里（导出的是 `Tineye`，候选顺序已把实测名摆到前面）；那 22 个名字里另有 `Ascii2D` / `Copyseeker` / `EHentai` / `Iqdb` / `Lenso` 五个引擎我们**没接**（要接就是 worker 加一行 + Node 的 `ENGINE_ROWS` 加一行 + 在 `ORDER` 里定位置——**位置就是角色**：排在某类型第一位当专属引擎，还是排链尾当第二发兜底）。
- **这条链的断言分三段，射程各不同，别拿一段当另一段用**（`t-image-source.mjs` 第 ⑨ ⑩ 段）：① 跨进程比对 worker 的引擎**键集合** ⇄ Node 的 `PIC_IMAGE_SEARCH_ENGINES` —— 引擎少一个/多一个会红，但**看不见候选类名的拼写**（把 `BaiDu` 改回 `Baidu`，实测该套件仍全绿 —— 这是本轮证伪探针亲自撞出来的，原先的注释把它说成了"唯一的比对点"，是过度声称）；② `MEASURED_CLASS_NAMES` 钉住实测到的类名**在候选链里够得着**（不管排序：`google_lens` 的 `Google` 近亲、`tineye` 的老版本名刻意排在后面）。② 钉的是**实测结论而非可推导的规则**，挡不住"库改名"，只挡得住"有人把已经实测对的名字又改回去"；库里真改名了要重跑 `--self-check`、同时改 worker 的表与那一行。③ 第 ⑩ 段扫 worker **源码文本**钉住上述两个 bug 的修法（`From`、`time` 不写 0、标题四个平铺字段在前、`origin` 兜底不在）—— 它必须**锚定到具体调用**而不是字段名：**`pyBody()` 只按行丢掉 `#` 注释，docstring 不是注释、丢不掉**，初版第三条写的是裸 `/title_chinese[\s\S]*title_native/`，把代码里的 `title_chinese` 删掉后它**照样绿**（那几个名字原样躺在 `_tracemoe_title` 的 docstring 里），是证伪探针撞出来的假绿。同一段里其余几条靠"剥注释"是有意为之：worker 的注释里就写着 `From` 与那句被删掉的 `origin if not isinstance`（那是在记教训），不剥注释会让注释把"代码已经改回去了"伪装成"还在"。
- **缓存的是单个引擎的响应，不是整轮结论**，键 = `引擎 + 图片 hash + maxResults + 引擎参数指纹`（`cacheKey`）。四条都在键里，缺一条就有一类串台：没有引擎维度则换 intent 会拿到另一个引擎的答案（第二个引擎根本没被问过）；没有 `maxResults` 则用户调了条数却拿回上一次的条数；没有参数指纹则换了 key 还在复用、或者 `hide` 哪天随 intent 变了却命中上一次的档位（今天问 SauceNAO 的两条 intent 参数逐字节相同，这个分岔**暂时不存在**；指纹是给"将来把某一行的 `0` 改成 `1`"时兜底的，见 `docs/image-source-routing-design.md` §2）；反过来，参数逐字节相同的两种 intent（今天 `manga` 与 `illustration`）**共享**槽位 —— 请求一样，共享是对的。**失败从不写缓存**——限流/超时是远端此刻的状态，不是这张图的属性（旧版把失败也缓存，一次超时能让这张图冻结 `cacheTtlMs`，默认 24 小时）。`SearchOutput.cached` 的含义是"本次**一次远端调用都没发**"，部分命中不算。
- **`queue.ts` 的并发恒为 1，是故意的**：下游是单个串行处理 stdin 的 Python worker，放开并发只会让"总任务超时"从发出时刻起算、被排队时间吃掉。真要提高吞吐应起多个 worker 进程，而不是把队列改成 N。
- **展示层是唯一决定输出形状的地方**：`formatImageSourceResult` 是模型看到的文本的唯一来源（本轮起有了断言）。判据是"字段在不在"（`time != null`）而不是"值是否非零"——`time === 0` 是合法值（正好片头），旧版无条件插值 `time || 0`，于是没有时间戳的结果会印出一个凭空出现的 `00:00`，与"接口没给"长得一模一样。

## 配置兼容与命名

- `store.maxContextMessages`：当前新消息窗口容量，`0` 表示不限；它不控制历史深度。
- `store.historyCount`：窗口之前统一读取的原始历史条数，不受艾特、关键词、随机或响应档位影响。
- `store.promptContextMaxChars`：完整 user prompt 的统一字符预算。
- `digest.maxChars`：摘要通道候选预算，不替代统一预算。
- `imageGen.*`：出图能力的开关、Key（留空回退 `DASHSCOPE_API_KEY`）、接口地址（`normalizeBaseUrl` 去尾斜杠并在 `/api/v1/` 处截断）、模型、尺寸（`normalizeSize` 把 `x`/`×` 归一成官方要求的星号，认不出则当作"不传"）、`promptExtend`/`watermark`/`negativePrompt`（**只在 3.0 系列发送**）、`stylePrompt`（第二层提示词）、超时与三档上限、两个调用上限（**两条入口共用**）。钳制只在 `media/image-gen/config.ts` 的 `resolveImageGenConfig` 与设置页的 save 分支两处，改一处要同时改另一处。
- 会话只写 `currentWindowCount/foldedAway`、`responseTier/responseReason`、`historyLimit/historyBeforeId/pastStateCount`，不写也不读取旧 `contextTier/contextLimit` 字段。

修改配置时同时检查：

- `src/core/config.ts` 默认值；
- `ui/js/parts/chat-settings.js` 表单；
- `ui/js/views/settings/save.js` 保存与钳制；
- 对应面板接线和配置测试。

**Python 工具只有一个目录、一份依赖、一个解释器配置**（2026-09-29 统一）：

- 脚本一律放 `python-tools/`（当前两个：`jmcomic_download.py`、`pic_image_search_worker.py`），依赖合并进 `python-tools/requirements.txt`——**不要在工具旁边另开一份依赖清单**，两份必然漂移，最后没人知道该装哪个。新脚本的路径常量加进 `src/core/python-runtime.ts`（**不要**在调用方自己 `path.join(ROOT, 'python-tools', 'x.py')`：脚本改名不会编译报错，只会在运行期炸，而 `spawn` 一个不存在的文件连日志都不会有）。
- 解释器只从 `python.path` 读，解析链唯一实现在 `src/core/python-runtime.ts` 的 `resolvePythonCommand()`：`python.path` → `QQ_AGENT_PYTHON` → Windows 固定环境 → `conda run -n my_bot python`。**不要再给新工具加一个自己的解释器环境变量或配置项**——两个工具用同一个解释器的前提下，各给一个变量的结果就是"装了 A 库的那个环境跑不了 B"，而报错会指向库缺失，排查方向完全错。
- `JMCOMIC_PYTHON` 已于 2026-09-29 **正式废弃并从解析链删除**（旧别名支持的代价就是上一条那句话）。同一原因，`resolvePythonCommand()` 的返回值现在带 `source`（`config`/`env-primary`/`windows-direct`/`conda`），设置页靠它显示"当前生效的是哪一层"。**探测/自检的安全网已从环境变量搬进夹具的 `config.json`**：`tests/t-jmcomic.mjs` 把 `python.path` 写成一个不存在的程序（`config` 层优先级最高，比任何环境变量都硬），保证那个套件永远不真的 spawn conda 去下载漫画。**别再退回环境变量做法** —— 那会让"某台机器上有这个变量"决定套件的红绿；而且安全网死掉本身是**静默**的（真下载与"任务压根没跑"看起来一样），所以它另配了一条正向断言（任务失败文本必须含"无法启动 Python"）。
- 旧字段 `jmcomic.pythonPath` 已并入 `python.path`，靠 `normalizeConfigShape` **迁移**（不是纯删）。这里有一条容易漏的：`updateConfig` 走 `deepMerge(getConfig(), patch)`，**只加键不删键**，所以迁移里必须显式 `delete root.jmcomic`，否则旧键会永远留在用户的 `config.json` 里——守护在 `tests/t-jmcomic.mjs` 第 4 段（去掉 `delete` 会同时打红内存与落盘两条断言）。`python.path` 为空串是**合法值**（含义是"走自动探测链"），所以 `save.js` 里不要像 `ffmpegPath` 那样兜一个非空默认值——**这条现在有机检守护**（`tests/t-panel-wiring.mjs` 的「Python 工具设置」段：兜底必须仍是 `p.path || ''`，出现非空字面量就红），因为"好心兜一个默认值"把留空变成写死路径后，症状只是搜图/漫画悄悄不可用。
- 设置页的两个按钮（**测试解释器** / **跑一遍依赖自检**）对应 `POST /api/system/python-probe` 与 `POST /api/system/python-selfcheck`（`src/web/routes/system.ts`），逻辑在 `src/core/python-probe.ts`。三条边界：① 两个端点**只读已保存的配置、刻意忽略请求体**——接受请求体里的可执行路径等于凭空开一个"用 HTTP 启动任意本机程序"的一步接口，唯一的写入口仍是鉴权过的 `POST /api/config`（所以 UI 必须先 `saveConfig` 再探测，`t-panel-wiring.mjs` 有断言钉着这个顺序）；② 它们是**请求作用域**的短命子进程，**不进 `LONG_TERM_TASKS`**，也不碰常驻的搜图 worker 客户端单例；③ argv 里**不含任何密钥**（自检不拿 `apiKey`/`engineOptions`），与"SauceNAO 的 apiKey 绝不进 argv"是同一条不变量。自检的 409 忙等分支（`pythonSelfCheck.running`，照 `providers.ts` 的 `visionScan`）**没有行为断言**——触发它需要一次真的耗时 spawn，而测试约定不许启动真解释器，别以为它被管着。
- 守护分布：脚本路径锚点与"两个脚本真的在同一个目录里"在 `tests/t-paths.mjs` 第 5 段（改名会红），解释器优先级/来源层级/探测与自检模块在 `tests/t-jmcomic.mjs` 第 1、1b、1c 段，端点在 `tests/t-admin.mjs` 的 D 段（把 `python.path` 配成不存在路径 → 200 + `ok:false` + 请求体里的路径被忽略），UI 接线在 `tests/t-panel-wiring.mjs`。`.gitignore` 已挡 `__pycache__/` 与 `*.pyc`——`python-tools/` 是要提交的源码，跑一次脚本就会在它旁边生成字节码缓存。

**存储上限与手动清理**（`store.maxMessagesPerChat` / `store.keepSessionFiles` + 三条 DELETE 路由）：

- **`listChats()` 只列磁盘上有文件的会话**（`.filter(hasChat)`）——**这不是多余的一步，别"优化"掉**。`#state()` 的语义是"读不到就建个空对象放进缓存"，所以删除之后**任何一次碰这个会话**都会在缓存里重建出一个**没有文件**的对象：`reloadWindow`（→ `ContextWindowRegistry.reload` → `#createSeeded` → `recentIncoming` → `#state`）、`getChatMeta`、`get /messages` …… 照着缓存列的话，删干净的会话会一直挂在存档列表里、点开却是空的。**文件才是"这个会话存在"的唯一权威**，与 `#dropIfEmpty` 是同一条判据。同理，删除接口**不许在删完之后调 `getChatMeta()` 取条数**（那一步就会复活缓存条目）——条数必须在 `deleteByLocalId`/`removeChat` 内部、删之前算好并随返回值带出。这条是被端到端复核抓出来的：单测只验了"文件没了"，没再列一次列表，于是放过了一个真 bug（列表里那条一直在）。
- **`removeChat` 取条数前要先 `#state()` 加载**（用 `hasChat` 判存在、而不是 `chats.has`）：这个会话可能还没进当前实例的缓存（管理端刚重启、或读盘走的是另一个实例），按 `chats.has` 判会直接取 0、谎报"删了 0 条"。
- **删到"一条不剩"时要连文件/目录一起删**（`ChatStore.#dropIfEmpty` 与 `MemoryStore.clear`）。判据是"这个会话在磁盘上还在不在"，不是"数组空不空"：两个列表都是**扫磁盘**还原的（`listChats` 扫文件名 / 扫目录），留个空壳的话用户删完发现列表里那条还在，会以为没删干净。两条路都要覆盖 —— 整会话清空（`removeChat`/`clear`）**与单条删除删到最后一条**（`deleteByLocalId` 里调 `#dropIfEmpty`）。对照必须存在：还有别的消息时**绝不能**删文件，否则"删一条"就等于清空整个会话。
- **`GET /api/memory-files` 只列磁盘上真实存在的记忆，不许拿白名单补行**。它**曾经**把 `config.allow` 里每个群/私聊都补一行 `{memberCount:0, impressionCount:0}`（本意是"让管理员能提前手工记印象"），代价是记忆页列出**从未有过任何记忆的幽灵条目**：刚配好白名单就满屏空条目，用户看到的是"没有记录却有个容器"（**实测反馈**）。实测对照很清楚：`memory/` 目录都还不存在时，旧接口已返回白名单里的三个会话，而同一刻 `/api/chats` 老老实实返回 `[]` —— 两个页面对同一件事给出相反答案，这就是它像 bug 的原因。判据统一成一句话：**列出来的，磁盘上一定真的有**。想"先建出空记忆"是**明确动作**，走面板「＋ 新建会话」（`MemoryStore.create()` 落 `_meta.json`，由 `listChats()` 正常列出）。
- **`MemoryStore.removeMember` 删掉最后一个成员时必须连目录一起删**（`#dropIfEmpty`）。`listChats()` 是**扫目录**还原记忆列表的，只删成员文件、留着空目录的话，用户把某个会话的记忆**一个个删光**之后，列表里那条**仍然在**（显示"暂无群友印象"），看起来就是"删不掉"（**实测反馈的 bug**）。完整不变量是：**目录存在 ⇒ 要么里面有成员文件，要么是用户明确"新建"出来的** —— 所以"删光成员"必须落到删目录，否则这个不变量漏一个口子。对照必须存在：**还有成员时绝不能删目录**（否则删一个成员就等于清空整个会话的记忆）。`backups/`（迁移前的旧单文件）不必删，它不匹配 `group_<id>`/`private_<id>`，不会让空目录被列出来。
- **`MemoryStore.clear` 会删掉整个目录**（含 `_meta.json` 与 `backups/`）。它是"这个会话不再存在"的语义，不是"清空内容"。旧版单文件形态（`legacyFile`）也要一起清，否则列表里那条会由它继续撑着。
- **"新建会话"一次建出两份**（`ChatStore.ensureChat` + `MemoryStore.create`，走 `POST /api/chats/<key>`）。必须两份一起建：两个列表各自扫磁盘，只建一份的话另一个页签里这个会话仍然不存在，用户会以为没建成功。两份都**幂等**（已存在回报 `created:false`，绝不覆盖）——`ensureChat` 复用 `#state`+`saveChat` 落一个空存档，`create` 写一个 `_meta.json`（空目录在同步/打包工具里会被丢掉，且"这是故意建的"需要留痕）。
- **删除后列表与详情都要刷新**（用户明确要求）。只刷列表的话，右侧会继续显示那个已经不存在的会话/存档/记忆 —— 这是"删了没反应"最典型的观感。另外 `loadSessions`/`loadChats` 发现**当前选中项已不在列表里**时要清掉指针并复位详情面板（会话页那次实测就是漏了这条，导致详情轮询每轮拿失效 id 收一个 404）。
- `t-panel.mjs` 里校验"管理端删除的结果"**必须读盘**，不能查本套件那个 `store` 实例：管理端走的是 app 自己的 ChatStore（另一个实例、有自己的内存缓存），本套件的实例还留着删之前的内容（实测因此假红了一条）。

- **`currentSessionId` 指向的会话可能已经不在列表里**（被删除、或被 `keepSessionFiles` 清掉）。`loadSessions` 必须在这个情况下**清掉它**并把详情面板复位，否则详情轮询会一直拿这个失效 id 请求，每轮收获一个 404，界面上反复出现"加载失败：会话不存在"而列表里那行早就没了（**实测踩到**：删掉正在查看的会话后出现）。
- **网络层失败 ≠ 服务端没做**。`fetch` 在"请求已送达、响应在回来路上断了"时同样 reject（实测报 `Failed to fetch`），于是删除明明成功、界面却弹失败，用户会重复点。删会话的 catch 里先调 `sessionMissingAfter(id)` 刷新一次列表核事实：**真的没了就按成功收尾**，还在才报失败。判定不出来时返回 `false`（宁可保守报失败，也不谎报成功）。
- **`ui/js/api.js` 不再把裸的 `Failed to fetch` 抛给用户**：换成一句指向下一步的话（检查机器人是否在运行、端口是否可达），并**保留原始信息**（连接被拒 / 隧道断了 / 服务重启，排查方向完全不同）。**但必须仍然抛错** —— 吞掉的话调用方会以为操作成功，而服务端可能根本没收到。`t-ui-render.mjs` 有一条断言专门钉"网络失败仍然抛错"。
- 这三个删除接口**在浏览器侧无法复现**网络层失败（`curl` 直连永远通）。排查这类报错时**先在服务器上 curl 同一个端点**：它证明的是"路由与服务端是好的"，从而把问题限定到"浏览器↔服务端"这一段——本轮就是靠它把方向从"接口写错了"扭转到"连接抖了一下 + UI 收尾逻辑有缺陷"。
- **两个上限都早已存在，缺的一直是界面**。`maxMessagesPerChat` 由 `ChatStore.#trim` 在每次写入时执行（`<=0` 直接跳过）；`keepSessionFiles` 由 `SessionRegistry.finish()` 在会话结束时清理。加 UI 时**别顺手改语义**：两者都是 **0 = 不限**（= 原行为），且 `keepSessionFiles` **不能用 `x || 300` 兜底**——0 是 falsy，会把"取消上限"变回 300，构造函数里那句注释就是为这个写的。
- **`keepSessionFiles` 的清理只在 `finish()` 里，不在 `get()` 里**（`get()` 只裁内存索引、不动磁盘）。写测试时别摆几个文件再 `get()` 就断言——那验的是"我以为的清理时机"（本套件初版就这么假红了一条）。要真跑 `create`→`finish`。
- **`ChatStore.removeChat` 必须同时删冷归档**（`data/messages/archive/<会话>.jsonl`）。只删主文件的话，历史压缩后的原文还在磁盘上，而这个页面上看不到它——用户会以为删干净了。另外**必须把内存 `chats` 里那份摘掉**：留着的话下一次 `#state` 会把旧对象还回去，并在任何一次写入时 `saveChat` 把刚删掉的文件原样写回，"删除成功"被静默撤销。
- **删存档前留备份**（`backupChatFileTo(..., 'removed')`，只保留最近一次）：这是面板上唯一一个一次抹掉整段历史的入口。删除*会话记录*则**不备份**——那是过程数据，删除意图明确。两者取舍不同是有意的。
- **`SessionsRegistry.remove` 与 `discard()` 分工不同**：`discard` 是编排层的"占位会话没跑起来、撤掉"，只允许删 `waiting`；`remove` 是管理端用户明确点的删除，已结束的（done/noreply/error/aborted）都允许。**`running` 必须拒绝**：它还在写该文件，删掉之后收尾的 `#persist` 会把文件原样写回来（看起来"删了又出现"），并继续 `#bumpTodayUsage`。
- **删会话记录不影响今日用量**：已结束会话的 token 在 `finish()` 时就累加进 `usage-today.json` 这个**独立聚合**了，`todayUsage()` 读的是它 + 运行中的内存态，不再读单条会话文件。改这条链前先确认这一点，否则会以为"删记录会毁账"。
- **整会话记忆删除（`DELETE /api/memory-files/<key>`）与成员级（`.../members/<id>`）是两条路由**，靠正则结尾区分。加路由时注意别让前者吞掉后者 —— `t-panel.mjs` 有一条断言专门验成员级删除没被抢走。`ctx.memory.clear(chatKey)` 早就是"删这个会话全部成员文件"的现成实现，不必自己遍历。
- **测试落点**：`t-panel.mjs`（真起 app + 真 HTTP + 真磁盘文件，验"删干净"与"上限真的生效"）、`t-panel-wiring.mjs`（三个按钮都先 `confirm`、文案说清删的是什么、两个上限的 input 与 save **成对**存在）。最后一条尤其重要：只有 `save.js` 没有 `input` 时，`val()` 取到 `undefined` 会**静默回退成当前值**——用户改了没反应，且没有任何报错。

**「是不是在叫我」由模型判断，代码只提供证据**（`qqSceneRules` 的【判断"是不是在叫我"】那段 + `user.groupState`）：

- **提示词必须同时给正反两侧判据**。只给"别抢话"（引用场景）是不够的——它没回答"什么才算在说你"，而模型手里有名字和"我"的标记，缺判据时**默认把指代别人的第三人称当成自己**（"他/这人/那家伙"）。正面：@你 / 引用你的消息 / 单独叫你的显示名或人设名 / 明显在接你的上一句话。反面：第三人称、别人昵称里恰好含你的名字（你叫「小鱼」而对方叫「小鱼干」）、"我的/我养的"这类顺带提到、两人互相 @。并给出默认动作：**拿不准先沉默**（误接一句比少说一句难堪），同时钉住反面——明确 @ 你 / 直接问你 / 接着你说时**必须**回应，别过头成装死。
- **两个名字都要给**（`groupState(chat, nickname, botName)`）：`selfNickname` 是群名片/QQ 昵称（群友 @ 你用的那个），`persona.botName` 是人设名。**实测这两个经常不一样**（一个是中文名、一个是英文 ID），只给一个会出现双向误判：有人叫群名片它不应答、有人顺口提人设名它却抢着接。同名时只报一次（不啰嗦、也免得它以为有两个名字）。显示名取不到时回退成人设名。
- **`提到我` 标签是子串匹配，语义只能是"出现了你的名字"，不是"有人在叫你"**。中文没有分词，`小鲸鱼酱`、`我养的小鲸鱼` 都会命中（实测）。所以：**不许**把它升级成断言式措辞，**更不许**据此在 `response-policy` 里抬高响应档位——那正是这次要修的病根；但**也不要删掉标签**，名字出现对模型仍是有用信号（可能只是在议论你）。`triggerLabels` 里有对应注释，改之前先读。
- **不要试图在 Node 侧用分词/更长名字匹配来"修准"这件事**。中文没有分词器，任何 `includes` 之外的启发式都是猜；`t-reply.mjs` 第 3b 段钉的是「判据进提示词 + 两个名字都进提示词」，不是「代码判对了」。
- 已知残余：**管理员的自定义人设卡可能主动要求"名字被提到就要有反应"**（属于管理员配置，不在 Catalog 里）。那种情况下提示词判据会被拉回去一部分——这是配置与判据的张力，不是代码 bug；要彻底改得动人设卡。

**漫画搜索与下载是刻意分开的两条路**（`search_jmcomic` / `download_jmcomic`），这是用户明确要求的分界，别"顺手合并"：

- **搜索只搜索，绝不入队**。搜索是廉价的只读操作（实测 1.9～2.3 秒）；下载要过页数检查、拉全部图片、导出 PDF、上传群文件（30 分钟超时且**不可撤销**）。合成一个动作等于"模型猜一个关键词"触发一次完整下载。`search_jmcomic` 的执行体**不得出现 `enqueueJmcomicDownload`**（`tests/t-tool-protocol.mjs` 用切片后的源码文本钉这条）。
- **对模型的约束在 system prompt 里**（`toolProtocol` 那条"搜到之后不要自己挑一本下载"）：要它把候选标题（带 ID）念给用户、等对方指定后再 `download_jmcomic`。这是**刻意的人工闸门**，不是没做完。工具结果里也重申了一句"以上只是搜索结果，不会自动下载"——模型很容易把"搜到了"当成"那就下载吧"。
- **参数走白名单，不透传库的魔法值**：排序是 `latest/view/picture/like/score/comment`（映射到 `mr/mv/mp/tf/tr/md`），范围是 `keyword/tag/author/work/actor`（映射到 `search_site`/`search_tag`/…）。**Node 与 Python 两侧各校验一次**，这些值会拼进查询串，透传等于让模型决定 URL 内容。两侧的表必须同步改（`SEARCH_MODES`/`ORDER_BY_CHOICES` ⇄ `JmSearchMode`/`JmSearchOrder`）。
- **`search` 是子命令，无子命令 = 旧的下载契约**：`jmcomic_download.py <漫画ID> <下载目录>` 必须继续逐字可用（Node 的下单路径与既有测试都按这个形状调用）。判据写的是"第一个参数是不是 `search`"，**不要**改成"参数个数"或"位置推断"。
- **`parseResultFrame` 是两条路共用的**（`media/jmcomic.ts`）：stdout 任意分块、JSON 可能没收全、只看最后一帧，这三条坑不该写两份。改它要同时想到下载的 `validatePdf` 收尾与搜索的失败文案。
- **搜索超时 12 秒，远短于下载的 30 分钟**：它是模型在等的同步调用，不是后台任务。它**不写 per-job 日志、不碰 `jobs`、不做心跳**——搜索结果没有留存价值（同名再搜还要重查）。`tests/t-jmcomic.mjs` 第 5 段正面钉住"搜索前后 `jobs.json` 逐字节相同、onebot 调用数为 0"。
- **"没搜到"与"搜索坏了"必须分开说**：都返回空列表的话模型会以为结果就是空的，而实际可能是查询词不对（`total > 0` 时提示换词或回前几页）或分页越界。库缺失时把"用哪个解释器装依赖"那句一并带出（同下载路径的 `PYTHON_MISSING_HINT`）。
- 实测（2026-10-05，jmcomic 2.7.0）：`client.search_site/search_tag/search_author/search_work/search_actor` 都返回 `JmSearchPage`，用 `iter_id_title_tag()` 拿 `(album_id, name, tags)`；`total` 是总数（tag 搜索能到 10000），**分页大小由服务端定**，所以 `limit` 只在客户端截断。`iter_id` 是**方法不是属性**（写成属性会 `TypeError: 'method' object is not iterable`）。

**`snowluma` 端点的热生效只有一条路（S11b）**：`applyConfigPatch` 把 `next.snowluma` 的四个字段交给 `OneBotClient.applyEndpoint(next)`，**它返回 `true` 才** `onebot.reconnect()`。三条不变量，改动时别拆散：

- `applyEndpoint` 的归一化（`normalizeWsUrl`/`normalizeHttpUrl`）与**构造函数共用同一份**——只要规则在比较的那一侧另写一份，`http://127.0.0.1:3000/` 与 `http://127.0.0.1:3000` 就会被判成变更，**用户每保存一次设置就断一次连接**；
- `applyEndpoint` **只改实例字段**：不重连、不发事件、不动已建的 socket，重连是调用方的决定；
- 空 URL 回落默认值、空 token 是真的清空（逐字段分开，与构造函数同一语义）。注意 `ui/js/views/settings/save.js:276` 会把用户清空的 wsUrl **原样存成 `''`**，所以"空 URL 就当成清空"会让 `new WebSocket('')` 抛错并落进 3s 重连循环。

唯一不走它的是 `applyTokens`（401 轮换路径上必须先写 token 再无条件重连，刻意保留）。守护在 `tests/t-timers.mjs` 第 5 段。

**联网搜索的两层入口与网页收藏夹（模型选站点）**：`media/web-search.ts` 有**两个**导出层次，改这条链之前先分清职责：

- `webSearch(query, site?)` —— 对工具的唯一入口，负责站点选择、校验与合并；
- `searchOnce()` —— 按 `webSearch.provider` 分发到七路 provider，**不认识收藏夹**。新增 provider 只接进这张分发表即可，不必重复实现优先逻辑（这与 image-source "引擎知识在 Python、映射唯一实现在客户端"是同一种"把易变的部分收进一层"的取舍）。

三条不变量：

- **收藏夹是「枚举值 + 网页URL + 用途」三元组，三项都必须非空**（`webSearch.bookmarks: [{key,url,purpose}]`）。三项各有各的用处，缺一条就整条丢弃（半残条目比没有更坏：模型会拿到一个没有用途的枚举值，于是要么不用要么乱用，而配置页看起来"配了"）：
  - `key` 枚举值，**模型在 `site` 里回传的就是它**。限 ASCII 标识符（`^[A-Za-z0-9_-]{1,32}$`，`isBookmarkKey`）—— 与代码里的枚举同形，也最不容易在 JSON 参数传输里被改写。**中文被有意排除**（需要中文说明时那是 `purpose` 的事）。**不做大小写归一**：枚举值是配置里逐字写明的标识符，宽容匹配会让"模型传 wiki、配置里是 Wiki"这类不一致被掩盖。
  - `url` 归一出宿主名（`hostnameOf`），只有它参与 `site:` 检索 —— `site:` 只认站点不认页面，所以填整条网址是允许的、路径会被丢掉。
  - `purpose` **注入 system prompt 给模型当选站依据**。上限 60 字（`MAX_BOOKMARK_PURPOSE`）：这条文本每轮都进提示词，20 条不设限能吃掉大块预算。
- **`site:` 在搜索引擎侧是无效的，这是实测结论不是推测**：`cn.bing.com` 与 `www.bing.com`、zh-CN 与 en-US 四个组合下，带 `site:` 与不带的结果**逐字节相同**（连 zhihu.com 这种必然被收录、且本机可达的站也零命中）。所以"限定站点"**必须靠站内搜索模板**（`bookmarks[].searchUrl`，含 `{q}` 占位符），那只拼 `site:` 的老路只有在服务方真的认这个语法时才有用（自建 SearXNG 等）。**别把这个结论当成"Bing 坏了"**：这是搜索引擎对程序化抓取的行为，换 provider 前先实测。
- **`searchUrl` 的两条硬校验**（`normalizeConfigShape` 与 `bookmarkList()` **各做一次**，因为夹具/未过 `loadConfig` 的路径不经过配置层）：必须是 http/https（这地址会被直接请求），且**必须含 `{q}`** —— 缺占位符时请求会打到搜索页首页、返回"文不对题"的结果，而不是报错，比直接拒掉难查得多。模板填充用 `split('{q}').join(...)` 而不是 `String.replace`：查询词由模型给出，含 `$&`/`$1` 时 `replace` 会把它们当替换模式解释，悄悄改掉查询词。
- **`parseSiteSearch` 必须先按结果页 URL 解相对地址再判本站**（`new URL(raw, pageUrl)`）。少了这一步，站内搜索页里所有相对链接都会在 `new URL` 抛错而被丢掉 —— 而链路能跑通只是因为大多数页面吐绝对链接，属于侥幸（本套件初版就漏了这条，夹具用绝对链接时全绿，补一条直接调用才暴露）。
- **自动检测（`probeSiteSearch` + `POST /api/search-bookmark/probe`）的判据是"减掉基线链接"，不是"有没有解析出结果"**。这条是实测逼出来的：真实搜索页里全是导航，通用解析对**任何**查询都吐十几条（Bing 实测真/乱都是 16 条、MDN 15 vs 15），所以"能解析出结果"完全不能作为判据。现在先抓一次该站首页、收集它的链接集合，再看搜索页里**多出来**的链接有几条（GitHub 原始 130 → 减基线后 74）。**改这个判据前先想清楚替代品**——第一版用的"真查询条数 ≫ 乱串条数"对照法**会把 GitHub 判成可用**（124 vs 66，纯导航噪声），那不是判据松，是判据错。
- **探测必须有总时间预算**：候选是 10 个通用 + 10×4 个类名组合，每个都可能在慢站上耗到超时。没预算的一版实测 MDN 跑满 **64 秒**（用户对着按钮干等）。现在默认 12 秒预算 + 单次 6 秒超时，超预算就如实说"探测未跑完"。
- **候选清单刻意不做全笛卡尔积**：`/search` 配全部参数名（q/query/search/keyword/wd/word），
  `/w/index.php` 与 `/index.php` **只配 `search`**（MediaWiki 的参数名恒为 `search`），站点根只配 `q`。
  初版按 4 路径 × 6 参数 = 24 个候选全跑，预算在筛选阶段就耗尽、真正可用的候选排在后面没人确认
  （实测 Gentoo Wiki 的 `?search=` 是第 3 个候选，就这么从"可用"变成"找不到"）。
- **"只收本站链接"必须按「站点家族」比，不能按"宿主或它的子域"比**：站内搜索页与它搜出来的内容**经常不在同一个子域上**。实测 B 站：搜索页是 `search.bilibili.com`，而每一条结果都在 `www.bilibili.com` —— 旧判据把那 47~95 条结果**全部丢掉**，表现为"页面上明明有 49 个 BV 号、解析出来却是 0 条"。判据是 `siteFamily()`（近似 eTLD+1，`a.b.c` → `b.c`）。代价是 `com.cn`/`co.jp` 这类二级后缀会略微放宽；这是有意的取舍（收藏夹语义本来就是"这个站点家族"）。**反过来说**：这一条也意味着"站内搜索"实际是"站内**家族**搜索"。
- **站点根也要配多个参数名**：有些站的搜索就在根路径上、且用别的参数名。实测 B 站 `https://search.bilibili.com/?keyword=test` 返回 95 条真结果，而 `/search?q=` 是 **404** —— 只配 `/?q=` 时自动检测必然漏掉它（只能靠用户手填 hint）。
- **`parseSiteSearch` 的锚点正则要能容忍 `href` 不是第一个属性**：`<a class="x" href="...">` 很常见（实测 B 站的卡片就是 `class` 在 `href` 前面）。取 `m[1]` 后在其中搜 `\bhref="..."` 是对的写法，别改成 `<a\s+href=`。
- **探测的每次取页要带一次重试**：这是一串几十个请求的连续探测，任何一次网络抖动都会让该候选被判成"取页失败"而悄悄丢掉。实测踩到过：GitHub 在十几秒内**每个** URL 都 `fetch failed`（含纯首页），而同期别的站点一切正常 —— 这种抖动是常态，不该让探测给出错误的"找不到"。重试只在还来得及（剩余预算够一次最小超时）时做，且只重试一次。
- **类名检查排在通用解析之前**，不能挂在"通用解析命中数"的门槛后面：那个门槛比的是**原始**条数（含导航，动辄十几），而类名命中的是**结果块**（可能只有 2~3 条）。初版写成 `if (genericReal < 3)`，于是"通用解析出 10 条、类名命中 2 条"的页面两边都不落地、被直接放弃。
- **`siteSearchCandidates` 要拒绝单标签宿主名**：WHATWG URL 会接受 `不是地址` 这种输入并 punycode 成 `https://xn--ihqq6tnb086g`，于是探测去打一个毫无意义的域名、白等一轮超时，而用户看不出是自己输错了。判据是"宿主名含点或是 IP 字面量"。
- **裸域名必须能走通全链路**（`normalizeSiteInput`）：设置页那一栏的标签是「网页地址」、占位符就是裸域名（`zh.wikipedia.org`），所以裸域名是最正常的填法。而 `validateFetchUrl` 直接吃 `new URL(...)`、裸域名会抛"URL 无效" —— 实测报出来就是"站点地址不可用：URL 无效"，用户完全不知道自己哪里错了。**路由校验与探针内部（连基线集合那一步）都要走同一个归一**，否则基线会退化成空集、整条判据失效。
- **hint（用户自己贴的地址）排在自动候选之前**，且是唯一能覆盖"参数名不在这几个里"与"结果在另一个主机上"（Bing 的 `cn.bing.com` 搜索其实由 `www.bing.com` 出结果）的办法。缺 `{q}` 的 hint 整条丢弃（会成为不可用候选）。
- **`resultClass` 只在检测有值时才覆盖用户手填的值**（UI 与 `save.js` 两处都按这条）：检测不出类名不代表用户原来填的是错的。
- **这个端点是仓库里少数"由请求内容决定目标地址"的出口**，所以先过 `validateFetchUrl`（拒非 http/https、URL 内嵌凭据、本机/内网/链路本地/云元数据 + 一次 DNS 检查）。**已知残余风险**（知情取舍，写在路由注释里）：实际发请求用 `fetch`，它会**再解析一次 DNS**，所以 `safeFetch` 那层"固定到已校验 IP"的防 rebinding 保护在这里不成立；换来的是不必再写一遍有界读取与逐跳校验。端点仅管理员可达、只读、一次性、不写配置（**唯一配置写入口仍是 `POST /api/config`**，同 python-probe 那条规矩）。
- **实测：Bing 的结果标记会时有时无**（同一个模板一次 9 条 `b_algo`、一次 0 条），说明反爬会连结果标记一起去掉。所以 `b_algo` 只是候选之一，不能当成保证；同理"某站解析出结果"这件事必须每次都靠减基线重新判定。
- **「站内搜索地址」只接受 HTML 网页搜索页，JSON 接口永远填不进去**（实测反馈：用户填了第三方 JSON 百科接口 `.../baikebaidu.php?...&words={q}`）。两条独立的理由：① `parseSiteSearch` 解析的是**链接**，JSON 里没有链接；② `siteSearch` 在 0 结果时**一律抛错**（它不会静默返回空列表）。所以这不是"页面改版/需要改结果容器类名"，是**结构性不兼容**。`judgeTemplate` 现在把这种地址单独认出来（`content-type` 或正文以 `{`/`[` 开头）并**只发 1 次请求**就返回 —— 旧文案说"结构可能变了 / 要登录"会把人引去改「结果容器类名」，方向完全错。
- **认 JSON 必须排在认 HTML 之前**：`content-type: text/html` 里天然含 "html" 子串，而接口站经常把 content-type 写错；先看 content-type 的话 JSON 会被当成网页放过去，这段识别等于白写（**实测踩到**，断言全红）。**正文形态才是权威**。
- **`fetchHtml` 返回 `{body, contentType}` 对象，不许把 content-type 记在闭包变量上**：它还被基线（站点根）与乱串对照用，记在共享变量上会被**后一次**抓取覆盖，于是"判定这一页是不是网页"读到的是**别人**的类型（实测：JSON 夹具被判成 HTML，新加的识别完全不生效、断言假绿）。想让某页的属性跟着该页走，就让它随返回值一起传。
- 判据链的**顺序本身就是语义**：`judgeTemplate` 现在是「不是网页(JSON/非 HTML) → 类名命中 → 通用解析(基线差+乱串对照)」。往前面插一条就会改变后面所有分支看到的东西，别只看单条的表达式。

- **「检测」有两种模式，由「站内搜索地址」那一栏空不空决定**（`probeSiteSearch` 的 `searchUrl` 选项）：**空着 → 自动检测**（按 `siteSearchCandidates` 逐个试，找到可用的填进去）；**已填 → 只测他填的那一个**，绝不换成别的地址。填了地址就说明他知道这一栏怎么用，"测试"该回答的是"我填的这个能不能用"。
- **`hint` 与 `searchUrl` 语义不同，别混**：`searchUrl` = "用户已填 → 只测这一个"；`hint` 只是**自动检测模式下的候选排序线索**（旧入口，保留兼容）。UI 必须**同时**发这两个字段 —— 只发 `hint` 的话后端拿不到"用户已填"这个事实，会退化成"拿他的输入当线索去猜别的"，点完检测框里的值被悄悄换掉，观感就是"检测把我的配置改了"（**实测反馈的就是这个**）。
- **两条路径必须共用同一套判据**：自动检测的每个候选与"只测一个"都走同一个 `judgeTemplate()`（类名 → 基线差 → 乱串对照）。判据分两份写必然漂移，那正是"检测说可以、真用起来不对"的来源。
- 填的地址缺 `{q}` 时**一次请求都不发**，直接说清怎么改（把查询词位置换成 `{q}`）；失败文案里必须点明"**清空这一栏再点检测可以自动找**"，否则用户不知道还有另一条路。
- 测"只测了一个"**不能只看 `ok`**：自动检测也会搜到同样的地址，两者结论一样 —— 那是假绿。`t-web-search.mjs` 第 8 节用**请求数**（`tried`）钉这条：只测一个时 `tried` 很小，自动检测明显更多。

- **收藏夹有两种取数方式，别混**：`searchUrl`（站内搜索页 → 抓 HTML → 解析链接）与 **`request` 请求结构**（按方法/地址/请求头发一次请求 → 响应是 JSON 就直接转候选）。**权威数据源大多只提供 JSON 接口**（如百度千帆 `/v2/baike/lemma/*`），它们没有"结果页"，硬塞进 `searchUrl` 会**永远检测不通过**且报错指向"页面改版/容器类名"——方向完全错。实现见 `src/media/bookmark-request.ts`。
- **`request` 单独存在时必须走 `siteSearch`**：`webSearch` 里那句路由是 `if (picked.searchUrl || picked.request) return siteSearch(...)`。**漏掉 `request` 会让它掉进 `site:` 分支** —— 请求结构根本不被执行，用户看到的是真实搜索引擎的结果，而配置页看起来配好了（**实测踩到**，是端到端测试抓出来的）。
- **占位符两分法**：`{q}` 是**运行时查询词**；其余 `{xxx}` 是**静态参数**，值来自 `params`。缺值的占位符**必须报错**（不能原样留下：会被 URL 编码成 `%7B…%7D` 发出去，表现为"接口返回空/参数错误"，而配置页看着配好了）。`params.q` 被显式忽略——查询词不许被静态值顶掉。
- **URL 参数要编码，请求头绝不能编码 —— `fillRequestTemplate` 的 `mode` 是必须的**。URL 里（`?lemma_title={q}`）必须 `encodeURIComponent`（查询词含 `&`/空格/`#` 时不编码会撑坏 URL 结构）；请求头里（`Authorization: Bearer {API Key}`）必须 **raw**。实测报错：千帆的 Key 形如 `bce-v3/ALTAK-xxx/yyy`，一编码 `/` 就变 `%2F`，服务端报 `InvalidHTTPAuthHeader: Fail to parse apikey authorization` —— **而配置页看起来完全正确**，用户不可能想到是"密钥被转义了"。写测试时**密钥必须用带斜杠的真实格式**：拿 `abc123` 这种不含特殊字符的假值测，这个 bug 测不出来（本套件初版就是，改成真实格式后才红）。
- **「静态参数」是一行一个参数（不是 `名字: 值` 的多行 textarea），形状与设置页「模型 API」那套故意一致**：`type="password"` 的输入框 + 旁边的「显示」按钮（`password ⇄ text`，文案「显示」/「隐藏」）。**为什么必须逐行**：密钥要能**单独切换显示**，而 textarea 里没法给某一行加按钮。判据、按钮文案、切换方式都抄「模型 API」（`settings/index.js` 的 `pwdToggles` 循环 + `sections.js` 的 `#cfg-apikey-toggle`），用户不必学第二种交互。**增删与切换一律走 overlay 上的事件委托** —— 行是动态插进来的，绑到具体按钮上会漏掉新增行；保存时从 `[data-bqp-row]` 收成对象（空名字与 `q` 丢弃）。
- **别把这里的「显示」与「模型 API」的搞混**：后者 `/api/config` 是脱敏的，所以它的按钮要经 `fetchRealKey()` 向后端专用端点取真值；而 **`params` 的值是明文回显的**（脱敏层刻意不碰它，见下条），所以这里的按钮只是把已回显的值从密码态切成明文，**没有对应端点可调**。
- **会话日志块是 `pre-wrap` **加** `overflow-x: auto`，不是二选一**（**实测反馈**：日志过长时右边被截、后半截看不到）。成因是父容器 `.detail-pane` 只声明了 `overflow-y: auto`，**横向是 `visible`** —— 它不建立横向的裁剪盒，所以**折不了的长行**（JSON 里被 `\n` 转义成两字符的长串、URL、没有空格的长 token）直接溢出到右边看不见。两条判据各管一半，别拿一条换另一条：`pre-wrap` 让**自然语言**在空白处折行（否则一段普通提示词会长到没法读）；`overflow-x` 才兜得住**折不了的行**。**不要改用 `white-space: pre`** —— 它取消软换行、让滚动条常驻，对普通文本反而更难读。覆盖 `.collapsible .coll-body` / `.tool-args` / `.tool-result` 三处；守护在 `t-panel-wiring.mjs`（**它只证明声明存在，证明不了生效** —— 被后续规则覆盖同样红不了，所以另有 `.dsh-css.mjs` 那种"按出现顺序算最终生效值"的一次性探针验过一次）。
- **检测到 JSON 接口时，前端要把地址搬进「请求结构」并弹窗（`openRequestModalFor` + `buildJsonRequest`）**。这一栏只解析 HTML，JSON 接口填这里**永远**通不过 —— 所以光说"没通过检测"就是让用户**卡住**（他还得自己意识到换按钮、再手抄一遍地址，**实测反馈**）。三条判据：① 分流必须看后端给的**机器可读标记** `detectedJson`/`jsonApiUrl`，**不许正则匹配 `note` 文案**（文案改过一次，匹配文案会静默失效）；② 预填只在**该行还没配过**请求结构时生效（`!row.dataset.bmReqJson`），不顶掉已有配置；③ 弹窗的打开与回填**只有一份实现**（点击与预填共用 `openRequestModalFor`），两份必然漂移成"看 A 写 B"。
- **搬地址要逐字照抄，不用 `new URL()` 重建**：`new URL(x).toString()` 会归一化 —— 实测 9 个用例里 5 个被改动（去掉默认端口 `:443`/`:80`、主机名转小写、中文路径百分号编码、路径空格成 `%20`）。地址是用户填的、检测也是照它请求的，搬过来该逐字一致，否则用户以为"检测改了我的配置"。**⚠️ 别拿花括号当理由**：`new URL()` **不会**编码查询串里的 `{q}`（实测保留花括号），会编码花括号的是 `URLSearchParams` —— 我第一版注释就这么写错过，是实测纠正的。
- **检测失败的文案必须给出下一步，且末尾那句"清空这一栏再自动找"不能无条件追加**（**实测反馈**）。① 判定出"这是 JSON 接口"时，初版文案写的是"若它就是你要的数据源，需要单独支持 JSON 接口" —— 而那个能力**就是收藏夹那行的「请求结构」**，用户照着这句话只会以为"这个站接不了"、或者去改「结果容器类名」（方向完全错）。所以必须点名「请求结构」并说明那一栏留空。② 那句自动检测提示在 **JSON 接口主机上是死路**（自动检测那一支试的是 HTML 搜索页，而 `api.php` 这种主机本来就没有），还会把用户从"去填请求结构"这个正确下一步带走 —— 所以给 verdict 加 `jsonApi` 标记，只在**非 JSON** 失败时才追加那句。对照必须存在：非 JSON 的失败路径**仍然**要带那句（别一刀切删掉）。
- **测试的默认查询词是"两边各留一份字面量"，必须有机检守护**：`TEST_QUERY_DEFAULT` 在 `src/media/bookmark-request.ts`（后端权威）与 `ui/js/parts/bookmark-request.js`（提示与 placeholder 用）各一份 —— `ui/` 是浏览器原生 ES Module，**够不着 `dist/`**（没有打包器，也没有取值端点）。漂移的表现是"提示说会用 A、实际发了 B"，这种不一致没人会去核对，所以 `t-panel-wiring.mjs` 有一条断言把两边的字面量钉成逐字相同（报错时**把两个值都印出来**，省一次翻文件）。留空回落后端默认词的判据在**后端**（`testBookmarkRequest`），前端只发空串、**不兜自己的默认值** —— 否则"用户留空"与"用户手打了默认词"在后端看起来一样。
- **「请求结构」的链接测试必须与真实检索共用同一支解析链**（`testBookmarkRequest` → `jsonToResults`/`openSearchToResults`/`flattenJson`，即 `siteSearch()` 用的那批函数）。理由：这一栏填的东西**除了保存没有别的验证手段**（地址拼错、占位符没填值、密钥不对、该 POST 却填 GET），要等模型真去搜、在群里答不出话时才暴露；而「网页地址」那栏早有「检测」按钮（**实测反馈**）。⚠️ **若给测试另写一支解析，它就会变成骗人的东西** —— 测试通过而实际搜不到（或反过来）时，没人会怀疑测试。落地三处：`BOOKMARK_JSON_MAX_CHARS` **移到 `bookmark-request.ts`**（两份字面量会漂移成"测试说 5000、实际 2000"）、`testBookmarkRequest()`、路由 `POST /api/search-bookmark/test-request`。结论要带**实测细节**（HTTP 码 / kind / 响应字符数 / 耗时 / 前几条标题）—— 只说"成功/失败"用户没法判断结果对不对。
- **测试路由的 SSRF 校验要尊重 `security.allowPrivateImageHosts`**：内网/本机上的自建 JSON 接口是**正常用法**（自建百科、Dify、内网知识库），硬挡会把这条路走死。而 `validateFetchUrl(url)` **不传 `allowPrivate` 时默认拒绝内网** —— 那是安全的那一侧，不是漏掉。另外校验的是**填好占位符之后**的地址（用户填的是模板，`{q}` 会让 `new URL` 直接抛），且**只写路径 + `Host` 头**的写法要先补出协议再校验（`resolveEndpoint()` 支持那种写法，漏了它会把合法配置误报成"地址不可用"）。
- **`media/web-search/` 的模块划分**（2026-10 从单个 1560 行的 `web-search.ts` 拆出，仿 `image-source/`）：`types.ts`（跨 provider 的统一形状）/ `query.ts`（查询词清洗）/ `record-utils.ts`（外部 JSON 防御性读取）/ `shared.ts`（`maxResults` / `resolveCustomConfig`）/ `text-utils.ts`（实体解码、站点家族、去重键）/ `bookmarks.ts`（**清单**：名单、枚举值校验、命中标记与排序）/ `site-search.ts`（**取值**：抓站内搜索页 + `flattenJson` 那条整条资料的路）/ `providers/*.ts`（七个 provider 一个来源一个文件）/ `web-search.ts`（`webSearch()` 编排 + `searchOnce()` 分发 + `webFetch()`）/ `site-probe.ts`（设置页「自动检测」的后端）/ `index.ts`（桶文件）。三条边界：① **消费方一律 import `media/web-search/index.js`**（不是 `web-search.js` —— 那还是 `dist/` 里的**目录名**，Node 恰好解析成 `index.js` 才没炸，写全路径别赖这条侥幸）；② 桶文件**逐个 `export *` 具名文件，不 `export * from './providers'` 一个目录** —— `bingSearchWithUrl` 之类是 `custom` 的内部细节；③ **源级文本断言的路径必须跟着实现走**：拆分时 `t-web-search.mjs` 里三条 `readSrc('media/web-search.js')` 当场打红（那两段代码已经搬到 `site-search.js`），改指 `index.js` 会变成**假绿**（桶里没有这段代码）。这类断言指向"实现所在的那个文件"，不是桶。
- **拆分大文件时，"导出面没变"要机检、不要靠眼睛**：`git show HEAD:` 取旧文件 + 扫它的 `export` 名，与桶文件可达的导出名对差集（本仓库那次实测：旧 22 个导出**全部**可达，多出来的 9 个是原先不导出、现在因 `export *` 顺带变公开的内部帮手 —— 那是 `export *` 的正常代价，不是 bug）。⚠️ 用 `git show > 文件` 取旧版本**会被 PowerShell 的编码毁掉**（实测：一个 60KB 的 .ts 变成满是 U+FFFD，`export` 一个都不剩，于是"旧导出 0 个"看起来像"什么都没丢"——**假绿**）。改用 `execFileSync('git', ['show', ...])` 拿 Buffer 再写。
- **`check-layers.mjs` 的正则会扫到注释里的 `from '...'`**：在文件头注释里举例写 `from './providers/…'` 会被判成"相对说明符必须显式带扩展名"而报错（实测踩到）。注释里别写完整的 import 语句形态，或写成真文件名的 `.js`。
- **改了模块路径 / 拆了目录之后，必须 `rm -rf dist && npm run build` 再跑套件**（**实测**：本轮拆分 `media/web-search.ts` → `media/web-search/` 时，套件里那条 `load('media/web-search.js')` **没有当场变红** —— Node 把 `web-search` 当目录、悄悄取到 `index.js`，于是"巧合成立"；直到一次**清空 dist 的干净重建**才以 `ERR_MODULE_NOT_FOUND: dist/media/web-search.js` 炸出来，而那条报错看起来像"文件被删了"。同一轮清空重建还**顺带救回一个真丢的文件**：`src/media/bookmark-request.ts` 当时已从磁盘消失，但 `dist/media/bookmark-request.js` 是旧的，所有套件照常全绿 —— **陈产物会替丢失的源码兜底**，只有从零构建才看得出来。配套的两条：① 套件里的 `load()` 写**全路径**（`media/web-search/index.js`），别依赖目录/index 的隐式解析；② 清空重建后拿 `src/**/*.ts` 与 `dist/**/*.js` **对一遍账**（`src/qq/ws.d.ts` 天然没有产物，是唯一的合法例外），确认每个源文件都真的编译出了产物。
- **`media/transcription/` 的模块划分**（2026-10 从单个 866 行的 `video-transcription.ts` 拆出，仿 `web-search/`）：`types.ts`（共享类型，**不 import 本模块任何文件** —— 它被所有别的文件依赖，反向依赖就成环）/ `errors.ts`（`TranscriptionError` + `safeErrorCode`/`userError`）/ `primitives.ts`（env 读取与整数钳制）/ `config.ts`（配置解析与钳制）/ `commands.ts`（`/转写` 解析 + `findTranscriptionMedia`，**只读无副作用**）/ `media-proxy.ts`（SSRF 安全的本机流式代理）/ `extract.ts`（音轨提取 + FFmpeg 探测）/ `recognize.ts`（腾讯云极速版：签名、上传、响应解析）/ `queue.ts`（单并发状态机 + 两条投递路径）/ `index.ts`（桶文件）。三条边界：① 消费方一律 import `media/transcription/index.js`；② **`extract.ts` 里不许出现平台名**（解析交给 `media-source`），套件有断言钉住整个目录；③ **`t-tasks.mjs` 的 `owner` 必须指实际持有那个 `setTimeout` 的文件**（拆分后是 `src/media/transcription/queue.ts`，不是桶文件 —— 那个套件会读 owner 文件并要求里面有调度调用）。实测：旧 10 个导出在桶里**全部可达**，多出的 17 个是原先不导出、被 `export *` 顺带公开的内部帮手。
- **`media/image-gen/` 的模块划分**（2026-10 新增，仿 `transcription/`）：`types.ts`（共享类型，**不 import 本模块任何文件**）/ `errors.ts`（`ImageGenError` + `safeErrorCode`）/ `config.ts`（解析、钳制与两处归一化：接口地址、尺寸分隔符）/ `commands.ts`（`/画` 解析 + `findReferenceImage`，**只读无副作用**）/ `image-io.ts`（两条取图路径：进来的参考图、出去的结果图）/ `client.ts`（百炼同步接口，请求体是**纯函数**）/ `queue.ts`（单并发状态机）/ `index.ts`（桶文件）。四条边界：
  - **投递是确定性的**：图片由队列自己发（`SendQueue.sendImage`，因此受限频、也留 `我：[图片]` 的存档），回流条目只承载"发过了"这个事实 —— 与 jmcomic 的 PDF 同一分工。
  - **临时文件的生命周期归队列**（`#drain` 建目录、投递完删），**不归 `runTask`**：转写的 `runTask` 返回文本，可以在自己的 `finally` 里删；这里返回的是文件，必须活到投递之后。所以 `runTask` 的第 5 个参数是队列递进去的 `workDir`。
  - **成本闸门在 `enqueue` 里，两条入口共用**。⚠️ 这是**刻意偏离 `/转写`** 的地方（那条命令路径不受闸门约束）：`/画` 是群里任何人都能敲的，而出图按张计费，命令路径不设闸门等于开一个可被刷的开支口子。放进 `enqueue` 也顺手避免了"工具先扣一次、队列再扣一次"的双记，并让被拒的那一次不占额度。
  - **`n` 固定为 1**（接口层仍按数组处理）。额度按"一次调用 = 一张图"记账最直观：想画三张就调三次、占三个额度。
- **`media/` 内部只横向引用共享的平铺助手**（`safe-fetch` / `call-budget` / `media-source`），功能目录之间**不互相 import**：`image-gen` 需要"安全下载 + 大小上限"时没有去 import `image-source/image-loader.ts`，而是就地重写了那 6 行（**含 `maxBytes + 1` 这个手法**——`safeFetchBinary` 到量只截断、不抛，多读一个字节才能把"正好这么大"与"被截断了"分开）。同理，`image-gen/errors.ts` 与 `transcription/errors.ts` 各留一份（唯一差别是前者把裸 `new Error('HTTP 404')` 收成 `HTTP_404`，否则"结果图 404"在日志里写成 `code=Error`，等于没有信息）。
- **跨文件的源级断言要读整个目录、不要钉单个文件**（**实测**）：`t-transcription.mjs` 里那几条"FFmpeg 只拿本机代理 URL / 用 spawn 参数数组且 shell:false / 不用 SDK"的断言原本只读 `video-transcription.ts`，拆模块后 `spawn` 在 `extract.ts`、`https.request` 在 `recognize.ts`、代理在 `media-proxy.ts`，钉单文件就会以"找不到这段代码"的形式**假红**（而它想守的性质其实完好）。改成读 `src/media/transcription/*.ts` 拼起来，并**用 `join('\n')` 而不是 `join('')`** —— 有几条正则含 `\s`，贴在一起会把两个文件的首尾误配成一次匹配。**另一条同型的坑**：`tests/lib/src.mjs` 的 `readSrc()` 读的是 `dist/`，拿它去读 `src/**/*.ts` 会以 ENOENT 中止整个套件（未捕获异常会吃掉后面所有断言）—— 要扫源码就用 `fs.readFileSync(path.join(ROOT, 'src', …))`。
- **`media/media-source/` 的 `parsers/` 与 `providers/` 是"平台实现"与"协议端适配"的分工**（2026-10 拆出）：`parsers/<x>.ts` 是平台自己的知识（短链展开、`view`/`playurl` 接口、挑最小音频流、CDN 要求的 Referer）；`providers/<x>.ts` 是**适配器**（知道 QQ 卡片的字段名 `qqdocurl`/`jumpUrl` 与该平台域名，转发给 parser）；`providers/card-payload.ts` 是**平台无关的报文摊平**（只判"是 http(s) 且长度合规"）。判据是**方向性**的：**`parsers/` 里不许出现卡片字段名**（那层知识跟着协议端变，跟站点改版无关），`t-media-source.mjs` 第 1b 节有断言钉住，并配了"字段名确实在 providers 里"的对照（否则前一条是假绿）。
- ⚠️ **卡片摊平为什么不能放进 `src/qq/`**（直觉上"卡片字段名属于协议端"）：`check-layers.mjs` 的 `T1_ALLOW` 是**空集**，`media/` 横向 import `qq/` 会被直接打回（实测报 `T1 领域间引用未登记精确白名单`）。这是**刻意的边界**——`media/` 是"给 Bot 用的可选能力"，不该依赖某个协议端的实现。所以分层按**改动理由**切，而不是按字面上谁属于谁。同一原因，`qq/onebot.ts` 里那个 `isRecord` **没有导出**，需要它的模块自己写三行（为一个私有实现细节放宽可见性不划算）。
- **`media/` 的通用能力层（`media/media-source/`）**：音视频来源统一走 provider 清单，加平台 = 加一个 `providers/<x>.ts` + 在 `index.ts` 的 `MEDIA_SOURCE_PROVIDERS` 加一行。三层分工**不能混**：`extract`（从协议端报文里**定位**，**必须是纯函数、不发请求** —— 它在接入层串行摄取链上）、`owns`（识别裸地址归谁）、`resolve`（分享页 → 可播放流，允许发请求，只在 `/转写` 命令路径上调）。没有 provider 认领的地址**原样放行**（普通 .mp4/.m4a 直链不该被平台逻辑碰）。**接入层与转写层都不得再出现平台名**（`t-media-source.mjs` 有断言扫这两处源码；注意"分发体里没有平台名"才是判据 —— **清单那一行本来就该写着平台名**，整文件搜会永远假红）。
- **语音（`record` 段）此前没有任何 media 条目**（`qq/onebot.ts` 只把它文本化成 `[语音]`），于是"给语音做识别"连地址都没有。现在按 OneBot v11 规范取 `url`/`file`/`magic` 存成 `kind:'audio'`，并**顺带存协议端自带的转写 `text`**（白拿的信息，省一次识别）。两条边界：① **没有 `url` 就不产出条目**（一条没有地址的 audio 只会让下游白找一轮）；② 查找判据必须**两处同形** —— `media/video-transcription.ts` 的 `findTranscriptionMedia` 与 `agent/tools/transcription.ts` 都得认 `video|audio`，一边放宽另一边没放的表现是"`/转写` 能跑、`transcribe_video` 说没有"，而那种不一致没人会去核对（`t-media-source.mjs` 第 9 节有两条同形断言）。`kind` 的语义是"给下游找它用的标签"不是文件类型：分享页/外链一律 `'video'`，`'audio'` 表示"本身就是音频流、不需要解析"。
- **收藏夹的"返回形状"是模型唯一的选站依据，而它只由 `purpose` 表达 —— 提示词必须补上那两条**（**实测**）。模型看到的每一行只有 `key — host（适合：purpose）`（`prompt-catalog.ts` 的 `qqSceneRules`），**`request.endpoint`/`params`/`searchUrl`/`resultClass` 一律不注入**；而 `purpose` 对"只配了请求结构"的条目**允许为空**，那时整行只剩 `· moegirltext — zh.moegirl.org.cn`，零线索。两条提示词修正：① 老版那句「指定的站点里没有时结果里仍会附上全网结果」是**错的** —— `webSearch()` 里 `if (picked.searchUrl || picked.request) return siteSearch(...)` **直接返回**，不会补发全网搜索；模型信了它就会把"收藏夹没结果"当成"全网也没有"而**不再换关键词**（归因错误且无报错）。② 要说明「有的收藏夹背后是**接口**，会**直接给一整份资料**：只返回一条、标题带「（接口返回）」后缀、正文是「字段路径: 值」形式，**看到就直接读、不要再 web_fetch 抓接口地址自己解析**」—— 实测管理员配了取正文的收藏夹，模型却连着几次 `web_fetch` 原始 json（那个响应还满是 `\uXXXX` 转义）。对照必须存在：`t-web-search.mjs` 有断言钉住"那句错话不在提示词里"。
- **`resolveBookmarkSite` 按 `key` 精确匹配，同主机多条收藏夹是安全的**（`list.find((item) => item.key === asked)`）。所以"两个收藏夹同域但用途不同"完全可用，`web_search {site:"取正文那条"}` 能正确路由。同主机**只在 host 当标识的那条路上**才有歧义（host-only 的两条经 `mergeScoped` 完全同形、`annotateBookmarks` 分不清是哪条答的）。⚠️ **`siteSearch` 那条路的结果没有 `fromBookmark` 标记**（`annotateBookmarks` 只在 `mergeScoped` 里调），所以"带 fromBookmark 的就是收藏夹结果"那条规则对接口型收藏夹不成立。
- **排查"模型没用我配的收藏夹"时，第一步是查 `data/config.json` 里到底有没有那条**（**实测**）：本轮用户报"模型没调用 moegirltext"，实际落盘的 `webSearch.bookmarks` **只有一条** `moegirl`，`moegirltext` 在整个仓库与 `%APPDATA%` 里都不存在 —— 也就是说那条配置**根本没保存成功**（或保存到了另一份数据目录），模型当然看不到它。**别一上来就改提示词**：先确认配置真的在盘上、且 `bookmarkMode` 不是把这条路关掉的档位。
- **抓取正文的长度预算是配置项（`webSearch.fetchTextMaxChars` / `flattenMaxChars`），不是写死的常量**（2026-10 用户要求）。两个数直接决定"模型一次能读到多少资料"，而**合适的值取决于用户怎么用**：群聊闲聊不需要长正文（越小越省上下文与钱），拿它当资料检索就要长正文（实测萌娘 `prop=extracts` 一篇正文 7036 字符）。写死一个数只能对一半人正确。三条硬约束：① **默认值必须与旧写死值同值**（20000 / 4000）——升级不该悄悄改变行为；② **每次调用现读配置**（`fetchTextMaxChars()` / `flattenMaxChars()`，与 `takeWebBudget` 同一写法），放模块级常量会让设置页改了不生效；③ 钳制范围 500–200000（`normalizeConfigShape` 与 `save.js` 两处**同一组数**，`t-panel-wiring.mjs` 有一条断言把"设置页输入框 / 保存钳制 / 后端钳制"三处口径钉在一起，因为漂移的表现是"我填了 50000 却按别的数走"，用户不可能想到去比三处源码）。压平那条的**单行上限 = 总预算**（`flattenJson(response.body, flattenCap, flattenCap)`）：意思是"整段正文都装进来、只在总预算处截断"。`BOOKMARK_FLATTEN_MAX_CHARS` 现在只是**文档性兜底常量**，`t-cfg.mjs` / `t-web-search.mjs` 各有一条断言钉住它和配置默认值一致。
- **"HTTP 200 但被站点拦了"必须报失败，不能报"成功但内容为空"**（**实测反馈**）。模型抓 moegirl 得到的是 `{statusCode:200, truncated:false, content:"", note:"（已从 HTML 中提取可读正文）"}` —— **内容为空却报成功**，模型于是说"你这修复好像没生效"，而真实原因是**站点在拦它**：`action=raw` 返回 `<title>未授权操作</title>`，主站/移动版返回 **Cloudflare 挑战页**（`<title>` 是正常条目名，正文全是脚本，剥完只剩一个 `cdn-cgi/content?id=…`）。两者都是 **200**，所以"看状态码"判不出来。修法：`looksBlocked(body, {server, cfMitigated, text})`（`safeFetch` 因此要把 `server` / `cf-mitigated` 两个头带出来），工具在返回前判一次、命中就 `err()`。判据三层：① `cf-mitigated` 头 / `cloudflare` + `cdn-cgi`；② `<title>` 是"未授权/403 Forbidden/Access denied"；③ **兜底**：原始 >5000 字符而剥完 <200 字符且 <1%。⚠️ 第 ③ 条**必须同时要求"绝对量小"和"占比小"** —— 只看占比会把"内容确实很少的正常短页"误判，只看绝对量会把"200KB 里 250 字正文"的窄页误判。对照必须存在：正常长正文页（同样有 20000 字脚本）**不能**被误判，否则 `web_fetch` 会拒绝一切有脚本的站点。
- **媒体百科"抓不到正文"的根因常常是站点拦 HTML，但 API 仍通**：实测萌娘百科 `action=query&list=search` / `action=parse` / `action=raw` / `revprop=content` 全被拒（`action-notallowed` 或 Cloudflare），而 **`action=opensearch`（搜标题）与 `action=query&prop=extracts&explaintext=1&titles={q}`（取整篇纯文本正文，实测 7036 字符）都放行**。所以"这个站抓不了"要分开看：**HTML 路走不通 ≠ API 路走不通**。
- **`flattenJson` 的单行上限对"整条正文"型接口是灾难**：原本每行砍 500、总预算 2000，那是按千帆 `get_content` 那种"几行结构化资料"定的。接口给**整篇文章**时（`prop=extracts` 的 7036 字符）压完只剩 **608** —— 模型拿到一份"看起来完整"的摘要，**不知道后面还有 6000 多字**，这种静默丢内容比报错难查得多。所以 `flattenJson(raw, maxChars, perLineChars)` 的第三个参数**按场景传**：真实检索给 `BOOKMARK_FLATTEN_MAX_CHARS`(4000) / `BOOKMARK_FLATTEN_LINE_CHARS`(4000)（单行上限=总预算，意思是"整段正文都装进来、只在总预算处截断"），设置页「测试」保持默认 500/2000（只是给你看"接口通不通"）。
- **`web_fetch` 必须"先剥 HTML 再截断"，顺序反了等于白剥**（**实测反馈**的 bug）。旧实现是 `content: body.slice(0, 20000)` —— 直接把原始 HTML 的前 20000 字符给模型。现代站点的 `<head>` 塞满 `<script>`（MediaWiki 的 `RLCONF={…}` 动辄几十 KB），于是那 20000 字符几乎全被脚本吃掉：实测萌娘百科初音未来词条**只有 206 字可读文本**，正文第一个 `<p>` 在 23306 处。模型拿到一串看不懂的脚本，会以为"抓取失败/被限流"并**反复重试**，而真实原因只是预算花在了元数据上。修法：`media/html-to-text.ts` 的 `htmlToText()`（纯函数、无依赖）+ 工具里 `looksLikeHtml(body, contentType)` 判定。同页从 206 字变到 20000 字。**两条连带改动**：`safeFetch` 返回 `contentType`（工具要它决定剥不剥），且它的字节上限从 50000 提到 250000（那个上限是"防内存爆炸"、不是"省上下文"，后者由 `FETCH_TEXT_MAX_CHARS` 负责；旧值对现代网页太小，前 50000 字节几乎全是 `<head>`）。`truncated` 的语义也随之改成"**给模型看的正文**被截断"——旧判据 `result.truncated`（原始响应 ≥50000 字符）在剥 HTML 之后已不代表模型看到的东西，会误报。
- **`htmlToText` 的"贪到结尾"兜底是危险的**：初版对 `script`/`template`/`style` 都写了 `<x[\s\S]*?(?:</x>|$)`（"没有闭合标签就贪到结尾"），而实测萌娘页面上有个**不闭合的 `<template>`**，于是它把整篇文章吞掉（28648 → 6348 字符，最后只剩一段 Cloudflare URL）。"没有闭合标签"最常见的成因是**响应被上游截断**，那种时候**保留原文远比丢掉好**。正确做法：只在**找到闭合标签**时连内容一起丢；注释是唯一安全的例外（`<!--` 之后没有 `-->` 时剩下的确实都在注释里）。另外相对链接要补绝对地址（否则模型看到 `[/%E5%88%9D…]` 没法用），`img` 的 `alt` 要保留（常是图片唯一说明），块级标签换 `\n`（全压成空格会让整篇文章变成一行）。守护在 `t-web-search.mjs` 第 19 段（42 条，含"不闭合标签不吞正文"与"头 60000 字符全是脚本时仍能拿到正文"两个对照）。
- **`safeFetch` 硬挡内网地址是刻意的，别为了测试放宽它**：`safeFetch` 调 `validateFetchUrl(url)` **不传 `allowPrivate`**（只有 `validateImageUrl`/`safeFetchBinary` 尊重 `security.allowPrivateImageHosts`）。所以"让 web_fetch 打本地夹具"这条路走不通——我试过改 `dns.promises.lookup`，`resolveSafeHost` 在解析结果上**再查一次** `isPrivateIp` 就挡掉了（防护按设计生效）。测这条链的展示层就用**纯函数 + 源级接线断言**，别去削弱安全模板。
- **`web_search` 的描述必须说明"有时候只会返回一条"**：收藏夹可以接 JSON 接口（「请求结构」），而单对象响应（如百科 `get_content` 整条词条）会走 `flattenJson()` —— 返回的是**一条**资料：标题带「（接口返回）」后缀、摘要是「字段路径: 值」形式的正文。不说明的话，模型看到那条与"标题/URL/摘要列表"的描述对不上，会以为工具坏了或这个站没内容，于是**反复重搜**或给出错误归因。判据是"接口直接给了整份资料"，不是"搜不到"。
- **MediaWiki 的 `action=opensearch` 要单独一支解析（`openSearchToResults`）—— 通用判据对它是瞎的**。它的形状是**按下标定语义的并列字符串数组**：`["查询词", [标题…], [描述…], [URL…]]`。而 `findBestArray` 只认"对象数组里带链接字段"，所以 OpenSearch 会**整份退回 `flattenJson()`**，模型看到 `[3]: https://…` 这样的字段路径而不是 5 条可点条目（**实测**：修之前解析出 1 条兜底资料，修之后 5 条真实条目）。判据必须写紧（四个元素 + 下标 0 是字符串 + 标题/URL 等长字符串数组）—— 它是**按位置**取值的格式，判松了会把随便一个四元素数组当结果。**接入萌娘百科只能走这条路**：它的 `action=query&list=search`、`action=parse`、`list=prefixsearch` 全部返回 `action-notallowed / Unauthorized API call`，而 `action=opensearch`、`action=help`、`query&meta=siteinfo` **放行**（2026-10 实测）。所以 `api.php` 不是整体关闭，是**按 action 白名单**；`action=help` 那篇文档本身就证明 `api.php` 活着。
- **脱敏只能作用于"配置的 schema 字段名"，绝不能作用于"用户自己起的键名"**（**实测反馈的 bug**）。`request.params` 是**数据容器**：它的键是用户照接口文档起的参数名（`top_k`、`api_key`、`API Key`），不是配置字段。旧逻辑把 `api_key` 当密钥脱敏，于是：① 回显成 `{"hasApi_key": true}` —— **凭空造了一个要发给接口的参数**；② 前端把回显原样回传 → `{"hasApi_key": "true"}` → 再保存 `hasHasApi_key`……**每保存一次多一层**（用户看到的就是 `hasHasAPI_KEY: true`）；③ **真正的值被删掉且再也回不来**。修法：`DATA_MAP_KEYS`（当前 `params`）整棵子树跳过脱敏。顺带一提，`params` 的值**本来就要发到接口去**，遮它也没有意义。
- **`/^has/` 那条"防连锁"必须不区分大小写**：标记名由 `key.charAt(0).toUpperCase() + key.slice(1)` 生成，小写起源的 `api_key` 会得到 **`hasApi_key`**（大写 A），区分大小写的 `/^has/` 匹配不到它 → 它又被脱敏成 `hasHasApi_key`。同时把"值是字符串 `'true'`"也接受（回显经前端往返会变成字符串）。
- **测脱敏时别拿密钥字面去搜整个 JSON**：夹具里的密钥可能就是一个 `'x'`，那个字符到处都是，断言永远命中（本套件初版就这么假红过）。判据是**字段在不在**加 `hasXxx` 标记。
- **请求结构的回显只能由 `renderBookmarkRows` 给 —— 渲染必须把 JSON 写进 dataset**（**实测反馈的 bug**）。`data-bm-req-json` / `data-bm-params-json` 是 `save.js` 与弹窗**唯一**的读取来源；初版只有弹窗会写它、渲染从不写，于是**刷新后行上没有这两个属性**，再打开弹窗就是空的。**而且这不止是显示问题**：此时点一次「保存设置」（哪怕只改了别的行），这一行的请求结构会被当成"没配"而**从配置里删掉** —— 静默丢数据。两条防线都要有：① 渲染写 dataset（属性的值要过 `esc`，JSON 里的引号不转义会把 HTML 撑坏）；② `save.js` 里 `originalByKey` 兜底 —— dataset 缺值时回退到服务端当前那一份（按枚举值找），让"漏写 dataset"退化成"只是看不见"而不是"被删掉"。
- **`url` 可以由「请求结构」的地址推出来 —— 判定顺序不能反**（**实测反馈的 bug**）：旧版先判 `!host` 就丢，于是"只配了请求结构、上面那一栏留空"的条目被**整条丢掉**（连请求结构一起没），用户保存后一刷新设置页里那条就消失了。请求结构里本来就写着完整接口地址，域名从那里取即可。取值顺序是 **用户填的那一栏 → `endpoint` 里的地址 → `Host` 请求头**（只写路径的写法，域名在 Host 头里）。两处都必须这么算：`core/config.ts` 的 `normalizeConfigShape` **和** `ui/js/views/settings/save.js`（前端算不出 `url` 会在过滤那一步就丢掉整条，后端再宽松也救不回来）。对照必须存在：**两个来源都没有时仍然丢弃**（没有站点就拼不出检索），以及**用户填了就不能被请求结构覆盖**。
- **接口密钥走「静态参数」，没有独立的凭据区**（这一版把原来的 `webSearch.credentials` 整个删了）。写法：请求头里写 `Authorization: Bearer {API Key}`，再在静态参数里给 `API Key` 填真值 —— `{top_k}` 与密钥是**同一条替换链**。为什么不为密钥单开一套（独立字段 + 脱敏 + 回显规则）：那是**同一件事的两套实现**，而两套必然漂移。**代价是知情的**：密钥以明文存在 `config.json` 里，与其它被引用的配置项同一层级（`GET /api/config` 也会回显它）。要遮住就得回到"独立字段 + 按路径脱敏"，那正是刚删掉的东西——别在没想清代价前把它加回来。
- **占位符名字允许空格与中文**（`{API Key}`、`{词条名}`），因为用户是照接口文档写的。正则排除了 `=`、`&`、`/`、`?`、`#` 与换行，以免把 JSON 正文或查询串里的 `{}` 误当占位符。**改这个正则要同时想到**：URL 里缺值 → 报错（硬失败）；请求头里缺值 → 保留原文（不报错，免得只想改地址的人被拦）。
- **配置层必须显式 `delete w.credentials`**：`updateConfig` 走 `deepMerge`（只加键不删键），不删的话旧键会永远留在用户的 `config.json` 里，让下一个人以为那套逻辑还在生效。`t-panel-wiring.mjs` 有一条防回潮断言钉"配置层不再有 credentials 键 + 有 delete 迁移"。
- **`findBestArray` 只认"带链接的数组"**（`url`/`link`/`href`，且至少两条）。只认标题会连踩两次：千帆 `get_content` 的 `{request_id, result:{lemma_title, summary, relations:[…]}}` 里**外层**和 **relations** 都有 `lemma_title`，于是正文 `summary` 被丢掉、结果变成一串"妻子/父亲"。找不到这样的数组就退回 `flattenJson()` 压平成一段资料 —— **那才是单对象响应的正确归宿，不是失败**。
- **合并那一栏（网页地址 + 站内搜索地址）的判据两端必须同形**：含 `{q}` 的 http(s) 输入 → 存 `searchUrl`，同时把 `url` 归一成域名（提示词要给模型看站点、没模板时还要拼 `site:`）。**这一处偏离了"前端不做域名归一"的旧约定**（见 `t-panel-wiring.mjs` 里那条注明偏离的断言），因为一个输入框里可能是域名也可能是整条地址，前端必须自己拆；枚举值校验仍只在 `core/config.ts`。
- **合并后「检测」要多拆一步**：`site` 必须是**域名**（后端拿它做 URL 校验与找入口），而输入框里可能是整条地址 —— 不拆的话裸域名与整条地址会被混着传给 `validateFetchUrl`。
- **请求结构的方法只允许 GET/POST**（这是取数据的配置，不该有副作用），且 `endpoint` **必须含 `{q}`**。两条不满足都在配置层丢弃并打 `[config]` 警告——与 `searchUrl` 是同一条判据。
- **`request` 那条链刻意不做 SSRF 校验**（`validateFetchUrl`），与 `siteSearch`/Bing `searchUrl` 两条既有路径一致（都是裸 `fetch`）。理由写在 `bookmark-request.ts` 那段注释里：地址来自**管理员配置**而非模型，且只加这一条会让"同类配置行为不同"和"无法接内网服务"。**代价是知情的**：凭据会发往配置里写的主机，所以"谁能改配置"等于"谁能拿到凭据"（与 `POST /api/config` 本身是管理员接口同层级）。要收紧就三条路径一起加，别只堵一条。

- **站内搜索不能突破网络封锁**：境内机器访问不到 Wikipedia 时，站内搜索同样超时。这一条要写进文档，避免用户以为是配置问题。实测（2026-10-05）：`zh.wikipedia.org` 被 DNS 投毒到 Meta 网段（`31.13.68.169`），其所有入口（`w/api.php`、`rest_v1`、`m.`、`wiktionary`、`wikidata`）全部不可达，而 `www.deepseek.com`/`cn.bing.com` 正常（125ms/216ms）。
- **名单必须由 system prompt 注入**（`qqSceneRules` 的 `bookmarkSites`，经 `buildSystemPrompt` 递入，来源是 `bookmarkList()` 的 `{key,host,purpose}`）。**每行三样都要进**：枚举值（回传用）、域名（让模型知道实际在哪个站搜 —— 枚举值是我们起的别名，只给 `wiki` 它无法判断是不是自己以为的那个站）、用途（选站依据）。**只在非空时注入**，且**不写进 tool schema**：枚举值与用途是用户配置的动态数据，Catalog 里放的是固定指令（同 stickers 那条）。
- **`bookmarkMode` 只管"模型没点名"时走哪条路**，`prefer` = 先问收藏夹再补全网，`web` = 直接全网。它与 `site` 是**正交**的：`web` 不阻止模型显式指定站点（有断言钉着）。这个正交性容易在重构里被抹掉（"既然 web 模式就是不用收藏夹，那把 site 也忽略掉吧"），而症状是"模型选了站点却什么都没变"。
- **旧形状（纯宿主名数组）自动迁移**：hostname 经 `slugifyKey` 变成枚举值（`news.ycombinator.com` → `news-ycombinator-com`，冲突补 `-2`），**用途留空**并打一条 `[config]` 日志提示用户去补。迁移而不是丢弃是刻意的——那份名单是用户一条条敲的，静默清空等于毁数据（同 `jmcomic.pythonPath`）。**去重只针对枚举值、不针对域名**：同一个站配两条不同用途是合法的，拿域名去重会删掉正当配置。
- **前端与后端的分工**：前端只做"按 `data-bm-*` 逐行读三列 + 三项不全就丢"，**不做域名归一化、不校验枚举值字符集**（唯一实现在 `core/config.ts` 的 `hostnameOf` / `isBookmarkKey`）。前端再写一份必然漂移，而漂移的表现是"设置页看到的"与"实际参与检索的"不是同一份。设置页的增删行走 **DOM 操作 + 事件委托**，不重渲染整页 —— 重渲染会把用户在同一页其他输入框里**还没保存的**改动冲掉（重渲染读的是 `state.config`，不是当前 DOM）。

★ **旧键 `bookmarkFirst` 已废弃并被迁移**（`normalizeConfigShape`：`false`→`web`、其余→`prefer`），迁移里那个 `delete` 是**必须的**（`updateConfig` 只加不删，同 `jmcomic.pythonPath` 的教训），且它已从 `DEFAULT_CONFIG` 与设置页移除——**别再把 `bookmarkFirst` 加回默认值**，那会让 `deepMerge` 每轮都带回来一个没人读的旋钮。迁移的测试**必须在独立进程里跑**：本进程前面调过 `updateConfig`，内存里的 config 已带着一个非迁移来的 `bookmarkMode`，`loadConfig()` 的结果会被它盖掉（第一版就是这么假红的；子进程输出写文件而不是管道，避开沙箱的 EPERM 边界）。
- **域名匹配必须用点边界后缀，不能用 `includes`**：收藏 `example.com` 要命中 `m.example.com`，但**不能**命中 `notexample.com`。这条是**探针实测出来的**——第一版夹具用的是 `book.mark` vs `other.com`，两者无共享子串，`includes` 与后缀匹配结果完全相同，于是那条断言是**假的绿**（改成 `includes` 后 29 条里只红 0 条）；换成 `example.com` / `m.example.com` / `notexample.com` 这组才有判别力（改成 `includes` 会红 2 条）。写域名类断言时注意夹具必须让两种实现**可分**。
- **归一化只在 `core/config.ts` 的 `hostnameOf` + `normalizeConfigShape` 里做一次**（剥 scheme 与路径、只留宿主名、小写去重、上限 20）。运行期只做拼接，前端只做"按行拆分 + 去空行"。前端再写一份必然漂移，而两边规则不一致时"用户看到的名单"与"实际参与检索的名单"会不一样。**上限与"单次查询塞几个"是两个不同的数**：`MAX_BOOKMARK_SITES`（20，管名单长度）在 config，`MAX_SITES_PER_QUERY`（5，管查询串长度）在 web-search —— 二者的正确值由不同约束决定，合并成一个会让另一侧失守。名单为空、或 `bookmarkMode === 'web'` 且模型没传 `site` 时，**一次额外请求都不发**，行为与没有这个功能时逐字相同。

`fromBookmark` 由**字段的缺席**表示"不是收藏夹结果"（不写 `false`，同 `ImageSourceResult.similarity` 与 `time` 的规矩）。它的语义说明写在 `prompt-catalog.ts` 的 `qqSceneRules` 里（"标记只代表被收藏，不代表更权威"），**不按收藏夹是否为空分支**——配置随时可改而 system prompt 每轮重建，分支只会让两边措辞漂移；也不再往 `web_search.description` 里塞（那个字段每轮都进模型上下文，别把它当文档）。

**联网调用阀门复用 `media/call-budget.ts` 的 `SlidingWindowBudget`**（与 image-source / transcription 同形），但有三点与它们不同，改动时注意：

- `web_search` 与 `web_fetch` **共用同一份额度**——两者都算"发一次外部网络请求"。分开记两本账会让用户以为各有限额，实际按两份算。口径与 `agent-runner.ts` 把两者计进同一个 `webSearchCount` 一致。
- 模块级单例（`agent/tools/shared.ts` 的 `webBudget`）是**有意的**：滑动窗口状态必须跨调用累积，放进 `execute` 里每次新建就等于没有闸门。限额每次现读配置（`getLimits` 是回调），改完设置即时生效。
- 默认值 **20/时·200/日**，比搜图（5/30）与转写（3/10）宽松——默认的 Bing 页面解析**不直接产生费用**，这两项的用途是**压住刷屏**而不是护第三方配额；换到按次计费的 provider 时应由用户调小。**这条不对称是有意的，别为了"看起来整齐"把它们调成一样。**

守护：行为套件 `tests/t-web-search.mjs`（209 条，起本地假搜索引擎真跑请求，覆盖站点校验/合并/去重/排序/标记/两发失败/清洗 + system prompt 名单注入 + 旧键迁移 + Yandex 全段），前端接线在 `tests/t-panel-wiring.mjs` 的「联网搜索」段（含一条"前端不重复实现域名归一化"的**剥注释**扫描——不剥注释会因为它自己那句 `hostnameOf` 注释永远假红），配置归一化在 `tests/t-cfg.mjs`（DIAG，只打印）。**改这条链要跑 `t-web-search.mjs`**：本轮证伪探针实测它至少对"优先级反了"、"匹配放宽成 includes"、"site 校验被跳过"三个变异会红。

**Yandex 那一路是"抓公开 HTML 页"，与官方付费 API 无关**，这条边界必须先记清，否则会按错误的前提去改它：

- **官方接口是另一件事，而且我们没接**：Yandex Cloud Search API v2（`POST https://searchapi.api.cloud.yandex.net/v2/web/search`，`Authorization: Api-Key <key>` + 必填 `folderId`，响应是 `{"rawData":"<base64>"}` 包着的 **XML**，`<doc>` 下有 `url`/`title`/`headline`）。它**没有结构化 JSON 出口**，所以现有的"自定义搜索服务"（`customSearch` 找 `results/data/sources/references/webPages.value` 数组）**填不进去** —— 别以为加个自定义 provider 就能接官方 API。
- **抓取天生易碎，且这是已知代价而非缺陷**：Yandex 类名混淆且会变。SearXNG 的同名引擎**2021 年被整个删除**（删除前已在 `settings.yml` 里 `disabled: True`），留下的选择器是更早一代的 `b-serp-item__*`。所以四个选择器是配置项（`webSearch.yandex.serpClass/urlClass/titleClass/textClass`）+ 可换 `baseUrl`：**页面改版时用户能在设置页自救，不必等发版**。默认值取自两代标记的交集（`serp-item` 是唯一贯穿两代的锚点），**未在真机验证过**。
- **被拦必须归因到"被拦"，不能退化成"没搜到"**：`/showcaptcha` 既可来自重定向（`res.url` 的 pathname）也可来自 200 响应正文里的验证码页，两条都要认（SearXNG 只判前者）。返回空列表会让模型说"这个事实不存在"，这是**归因错误**，与本仓库在图片链路里纠正过的那类错误同型。
- **"没解析到"的两种成因文案必须分开**，否则用户会去改错的那一栏：容器一个都没命中 → 让改「结果容器类名」；容器命中了但一条都凑不出链接/标题 → 让改「标题锚点类名」。合并成一句会让后一种被引导去改容器（改也没用）。
- **两条容易静默变坏的地方，都有断言**：① 标题锚点常是 `…/redir?url=<编码过的地址>` 或 `yabs.yandex.ru` 计费跳转，**不解析就没有可用链接**（模型会拿到跳转页）；解不出来时**宁可丢掉这条**也不把跳转地址当结果。② 站内入口（`yandex.<tld>` / `yastatic.net`）不是检索结果，必须过滤，否则模型会把 yandex.com 的页面当成"来源"。
- **`textOfTag()` 的存在理由是一条实测 bug**：初版用 `block.indexOf(tag)` 直接切片，而 `tag` 为 `null` 时写作 `indexOf('') === 0`，于是**从块首**开始找第一个闭合标签、切出一个空串 —— 表现为"结果静默变少"（实测三条只剩一条），比抛错难发现得多。现在类名找不到就逐级兜底（标题类名 → 链接类名 → 块内第一个锚点），**兜底是逐级的而不是取了就算**。
- 夹具里那几条断言的价值各有不同，**别把 `includes` 那条当通用结论**：`hreflang` 不会被当成 `href`（取属性要求 `\bhref=`，`hrefLang` 的 `L` 前没有词边界）；实体解码要同时覆盖数字实体与命名实体。这一段的 HTML 是**手写夹具**，它证明"解析器按既定假设工作"，**不证明"假设等于 Yandex 当前的页面"** —— 真机首次跑若报"没有解析到结果"，就是假设过期了，这是这套设计预期内的维护动作。

## 测试约定

- 测试加载 `dist/`，因此不要用未 build 的结果判断源码行为。**推论：搬动/删除 `src/` 文件后必须先 `rm -rf dist` 再 build**——`npm run build` 是裸 `tsc`，**不清理旧产物**，实测 `dist/` 里曾积了 29 个化石文件。旧位置的编译产物还在时，一个指向旧路径的 `load('web/xxx.js')` 会**照样解析成功、套件全绿**（实测：伪造 `dist/web/router.js` + 把 `t-web-router.mjs` 的字面量改回旧路径 → `11 通过 / 0 失败`），所以"纯搬运"的验证在没清 dist 时是假的。
- **`web/` 根目录白名单是机检的**：`check-layers.mjs` 只放行 `app.ts`/`server.ts`/`types.ts`/`usage-service.ts`，其余 `.ts` 出现在根目录直接报错；`http`/`runtime`/`routes`/`onebot` 四个子目录缺一个也报错。它与 `agent/` 那条规则是同一形态、同一理由。判据仍是"它是否触碰共享组件图"：**组装根、入口、领域类型、读模型留根，其余落子目录**；`routes/` 与 `onebot/` 内部本轮未再细分（嵌套是自由的，`check-layers.mjs` 只按顶层目录判层）。**动 `app.ts`/`server.ts`/`types.ts` 的位置之前先读上一条**——套件按字面路径读它们，还按函数名切 `app.ts` 的源码文本。
- 新增 `tests/t-*.mjs` 后，必须在 `tests/run.mjs` 的 ASSERT 或 DIAG 中归类。
- ASSERT 套件必须在失败时以非零状态退出；打印式诊断只能放 DIAG。**这条规则只写在这儿是不够的，它已经有过一次代价高昂的违反**：`checker().done()` 只**返回**布尔值、自己**从不退出**（`tests/lib/harness.mjs:27`），而 `run.mjs` 判定成败**只看子进程退出码**（`const bad = r.status !== 0;`）。所以一句裸 `done();` 会让整个套件**永远退 0**——实测 `t-image-source.mjs` 一次 `30 通过 / 5 失败` 的运行，`run.mjs` 报的是 `✅ 全部通过`，那段红从来没进过任何人的眼睛（写这条断言的人当时看到的是绿，于是"改好了"）。**现在 `run.mjs` 有一条扫描**：每个 ASSERT 套件里必须存在一个参数不是字面量 `0` 的 `process.exit(` 调用（先 `stripComments()`，覆盖 `process.exit(done() ? 0 : 1)` / `process.exit(fail ? 1 : 0)` / `if (!done()) process.exit(1)` / `if (counts.fail) process.exit(1)` 四种现有写法）。它**只堵"压根没有非零退出路径"这一种形态**——证明不了那条 `exit` 在运行期真会被走到，所以别把它当"套件确实会红"的证明。写新套件时照抄现有结尾（`process.exit(done() ? 0 : 1)`），不要在结尾只写 `done();`。
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
- `t-image-gen.mjs`（出图：两层提示词、单并发队列、`/画` 命令与 `generate_image` 工具、回流条目在窗口/提示词/档位三处的落点）
- `t-slash-commands.mjs`（斜杠命令分发层：判据唯一、回执与失败话术、与 `wakeEligible` 同源）

事件、端口与长期任务相关改动重点关注：

- `t-events.mjs`（事件名 / 载荷 / 注入类型 / `session-update` 通道）
- `t-sse-project.mjs`（SSE 帧逐字节）
- `t-panel-wiring.mjs`（UI 订阅名跨边界）
- `t-ports.mjs`（跨模块端口与 `implements`；含 S10d 的第 1c 段——扫 `tests/` 里每个 `new Orchestrator({…})` 是否都传了 `emit`）
- `t-tasks.mjs`（长期任务描述符表；含三条实名断言，其中一条是扫 `qq/onebot.ts` 的"重连排定只许一处、句柄必须存进 `#reconnectTimer`"——往那里再加一处裸 `setTimeout` 会打红它）
- `t-timers.mjs`（长期任务的计时器句柄：起没起、停没停、有没有被"清掉又没重建"；第 5 段是配置刷新触发重连——用 `app.onebot.socket` 的**身份**断言"值没变不断连、值变了才重建"，外加 `applyEndpoint` 的单元断言与 `applyConfigPatch` 函数体的文本扫描）
- `t-jmcomic-callback.mjs`（Python 只发分块结果帧、永不发 `close` 时仍能上传；OneBot 确认后完成 sink 只回流一次；`jmcomic-result` 在最低档位也会唤醒）
- `t-hot-search.mjs`（ApiZero 匿名/Bearer 请求、429/5xx/超时退避、字段缺失与空榜、去重分页、白名单目标、状态持久化、当天幂等、手动/定时互斥与配置脱敏）
- `t-lifecycle.mjs`（注册层执行侧：关停路径的信号接线与幂等；S11c 起还有装配清单 ⇄ `LONG_TERM_TASKS` 对账、清单 import 纯度、`app.start()/stop()` 的接线与逆序；S11d 的第 4 段是死代码与空转事件收口（33 条里的 5 条）、S11e 的第 5 段是 electron 的 `before-quit` 真的等 `stop()`（6 条，套件 33 → 39）；**搜图 worker 接入后是 43 条**——新增的 3 条恰好是那一行 entry 唯一能被机检的两个面：`DEFAULT_CONFIG.imageSource.enabled` 必须是 `false`、闸门必须认 `=== true`（`false`/`undefined` 都判不开）、`lifecycleDeps()` 里递的必须**是真模块函数**（`moduleEntryNames()` 按 `owner.endsWith('<owner>.ts')` 取名，够不着 `pic-image-search-client.ts`，所以这一条是独立的））。**它的文本扫描一律先 `stripComments()`**——`runtime/lifecycle.ts` 的头部注释里就写着 `LIFECYCLE[动态键]` 与 `.find(`（那是在列出被禁形态），不剥注释会让文件把自己的文档打红。**"无按键分发"那三条断言是"装配清单 vs 被禁注册表"唯一的机检边界**：往 `runtime/lifecycle.ts` 里加一个 `startById(id)` 式的按键分发函数，**所有行为断言仍全绿**（对账、顺序、逆序、接线、纯度都不受影响），只有它红——这正是它存在的唯一理由。**S11d 那 5 条全是文本断言**，因为删的东西零调用者/零消费者——"删与不删运行期完全一样"，行为断言一条都写不出来，探针只能证明"加回来会被文本挡住"。其中两条值得记住：① 判 `core/config.ts` 没有计时器**不认名字**，只认这个文件里有没有 `setTimeout`/`setInterval`，所以换个名字复活同样会被抓住；② **`providers.ts` 里 `const visionScan = { running: false }` 这个局部对象是活的**（`/api/vision/results` 读它、`/api/vision/scan` 用它挡 409、UI 读 `visionData.scanning`）——它长得像 `vision-scan` 事件的残留，**删不掉，也没有任何套件能区分"删事件"与"删这个对象"**，只有一条正向文本断言钉着它，另配一条真机冒烟（点设置页的"视觉能力扫描"按钮）。`core/events.ts` 的注释里也写着 `AgentEventMap`（那是在记反面教材，S11d 已把它从代码里删掉），所以这句扫描同样必须先剥注释。**S11e 的第 5 段（6 条）与第 4 段不同：它盯的不是死代码，而是两条"缺了就挂"的活路径**——同上，`electron/main.js` import 不了，所以只能切出 `before-quit` 的**函数体**逐条断言（不是全文 `includes`）。两个探针实测：删掉 `if (stopping) return;` → 红 1 条（真机表现是"点了退出、窗口关了、进程还在"）；删掉 `.finally(() => app.quit())` → 红 1 条（真机表现是**应用永远不退**）。**这两件事都没有任何行为套件看得见**，而它们又都不影响启动与聊天——所以别以为"能跑就没坏"。

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
