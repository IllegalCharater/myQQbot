# QQ Agent 当前架构与维护指南

> 本文档描述当前代码，而不是迁移计划。TypeScript、目录分层、Web 路由拆分和 UI 模块化均已完成。
> 最后更新：2026-09-29。

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
├─ core/       配置、路径、Python 运行时解析、通用函数、档位滑条
├─ llm/        模型请求、供应商、价格、视觉能力探测
├─ chat/       消息存档、长期记忆、会话记录
├─ qq/         OneBot 客户端、发送队列、Markdown 转纯文本
├─ media/      安全下载、网页搜索、媒体任务与 Bot 可选扩展能力（按功能子目录收拢）
├─ stickers/   表情库、缓存与管理
├─ agent/      Agent 领域（内部继续按职责分层）
│  ├─ runtime/       唤醒调度、运行状态、跨模块端口与 Agent 循环
│  ├─ context/       当前窗口、响应策略与历史策略
│  ├─ prompting/     动态提示词拼装与预算裁剪
│  ├─ tools/         工具统一入口、领域分组与执行
│  ├─ maintenance/   主动冒泡、历史压缩与记忆整理
│  └─ shared/        Agent 内共享类型与解析器
└─ web/        组装根、HTTP/SSE 表面、领域路由、OneBot 接入侧与长期任务
   ├─ app.ts            组装根：建对象图、接 OneBot 入站回调、起 HTTP/SSE、启停长期任务
   ├─ server.ts         headless 入口（带副作用：import 即建 app、起服务、装信号处理器）
   ├─ types.ts          web 领域共享类型（AppContext / AppHandle / Route / Reply）
   ├─ usage-service.ts  用量与花费读模型（控制台表面与 /api/usage 共用）
   ├─ http/             HTTP 与 SSE 表面
   │  ├─ console.ts        控制台 HTTP 表面：SSE 端点、鉴权、路由分发、静态文件、状态快照、配置脱敏
   │  ├─ event-projector.ts SSE 帧拼装（纯函数，`tests/t-sse-project.mjs` 逐字节钉住）
   │  ├─ http.ts           请求/响应原语
   │  ├─ router.ts         路由匹配与分发
   │  └─ static-files.ts   静态文件服务
   ├─ routes/           领域路由（8 个领域 + index）
   ├─ onebot/           OneBot 接入侧（"那个 OneBot 端"自己的状态，与 `src/qq/` 的传输客户端分开）
   │  ├─ snowluma.ts    SnowLuma 程序目录、子进程、日志环形缓冲、端口探活与 WebUI 地址
   │  ├─ tokens.ts      令牌桥：候选收集、401 轮换、限频与去重签名
   │  └─ ingest.ts      入站事件摄取：白名单、@ 名字解析、引用预览、合并转发展开、拍一拍、B 站卡片补成视频媒体
   └─ runtime/          长期任务与退出路径
      ├─ tasks.ts       长期任务描述符表（纯数据，回答"有哪些、谁开谁停"）
      ├─ lifecycle.ts   长期任务装配清单（S11c；回答"谁按什么顺序装起来、拆下来"）
      └─ shutdown.ts    退出路径的关停编排（S11a；纯逻辑、可单测，`server.ts` 只负责接到 process 上）

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

### Python 工具（仓库根 `python-tools/`）

Python 脚本不在 `src/` 里，但它们的**位置与解释器**是后端的一部分，所以收敛成一处（2026-09-29）：

```text
python-tools/
├─ jmcomic_download.py          漫画下载（Cmd 提交的下载任务）
├─ pic_image_search_worker.py   搜图 worker（PicImageSearch 常驻进程，JSON Lines 走 stdin/stdout）
└─ requirements.txt             **两个工具共用的唯一依赖清单**
```

- **脚本路径常量只在 `src/core/python-runtime.ts`**（`JMCOMIC_SCRIPT` / `PIC_IMAGE_SEARCH_SCRIPT`，由 `src/core/paths.ts` 的 `PYTHON_TOOLS_DIR` 拼出）。调用方自己写 `path.join(ROOT, 'python-tools', 'x.py')` 是禁止的：改名不报编译错误，`spawn` 一个不存在的文件连日志都没有。守护是 `tests/t-paths.mjs` 第 5 段。
- **搜图是"Node 一个通用 provider + 引擎分发在 Python"**：`src/media/image-source/pic-image-search-provider.ts` 是**唯一**的 provider，它只做转发——`search(engine, buffer, mime, timeoutMs, maxResults, signal?, engineOptions?)` 把引擎名连同图片一起递给 `pic-image-search-client.ts`，`test(engine, …)` 则是把客户端的 `ping()` 包成**吞异常返回 `false`** 的形式（设置页按钮的路径：库没装是"不可用"，不是抛给页面）。**引擎的类名、家族与字段归一化全部只在 Python**（worker 的 `ENGINE_CLASS_CANDIDATES` 与几张映射表），Node 侧的映射实现也只有一份（客户端的 `toImageSourceResult`）。按引擎的 `enabled`、`apiKey`（**只走 stdin，绝不进 argv**）与 `similarity >= minSimilarity` 过滤**仍留在 Node**，因为它们是 Node 自己的配置。**不要**再按引擎长出一个 provider 类。
- **worker 由长期任务表接管**（`image-source.pic-worker`，`imageSource.enabled` 门控、**默认 `false`**）：启动入口是显式的 `initPicImageSearch()`（预热，失败只记日志），停止入口是 `closePicImageSearchClient()`（关子进程并 fail 掉所有在途请求）。**懒启动保留**——预热不是唯一入口，预热失败不影响首次搜索，`test()` 之后也不会留下一个没人收的子进程。
- **分发策略与缓存都在 `reverse-image-source-service.ts`**：引擎表 `ENGINE_ROWS`（一段配置一行）与顺序表 `ORDER`（按 `SearchIntent`）都是显式声明的，加引擎 = 加一行 + 定位置；`anime_trace` **有意不入表**（它是 trace.moe 的中文别名，同一远端服务，入了表会有两条路打同一个接口）。缓存存的是**单个引擎的响应**而非整轮结论，键 = `引擎 + 图片 hash + maxResults + 引擎参数指纹`，**失败从不写缓存**——旧版按图片 hash 缓存整轮结论，换 intent 会命中另一个引擎的答案（第二个引擎根本没被问过），失败也会被冻结 `cacheTtlMs`。`SearchOutput.cached` 只表示"本次一次远端调用都没发"。队列保持全局单并发（下游是串行读 stdin 的单进程 worker）。
- **解释器只从 `python.path` 读**，解析链唯一实现在 `resolvePythonCommand()`：`python.path` → `QQ_AGENT_PYTHON` → Windows 固定环境 → `conda run -n my_bot python`，返回值带 `source`（`config`/`env-primary`/`windows-direct`/`conda`）供面板显示"当前生效的是哪一层"。**不要给新工具另加解释器环境变量**——两个工具用同一个解释器，各加一个的结果是"装了 A 库的环境跑不了 B"，报错却指向库缺失。旧别名 `JMCOMIC_PYTHON` 已于 2026-09-29 **正式废弃并从链上删除**，同一原因。
- **解释器探测与依赖自检**（`src/core/python-probe.ts` + 两个 `POST /api/system/python-*` 端点）：`probePython()` 用配置的解释器跑一次 `-c` 脚本（`find_spec` + `importlib.metadata.version`），回答"生效层级 / 命令 / 版本 / 两个库装没装"；`runSelfCheck()` 跑 `pic_image_search_worker.py --self-check` 并把输出**原文**（stderr 优先）带回来——worker 头部那几张待验证的映射表要靠这段原文对齐。三条边界：两个端点**只读已保存的配置、刻意忽略请求体**（接受请求体里的路径等于开一个"用 HTTP 启动任意本机程序"的一步接口，唯一写入口仍是鉴权过的 `POST /api/config`，故 UI 必须先保存再探测）；它们是**请求作用域**短命子进程，**不进 `LONG_TERM_TASKS`**、不碰常驻 worker 客户端单例；argv 里**不含任何密钥**。测试用注入的假 `spawn`（`SpawnLike` 是最小结构类型，无 `instanceof`），安全网是"`python.path` 指向不存在的程序"，所以套件永不真启动解释器。**这个按钮是 worker 那几张映射表唯一的对账入口**：2026-09-29 在目标解释器（Python 3.10.12 / PicImageSearch 3.12.11）上首跑一次，⚑ c（引擎类名）与 d（入参名 / 能否直接喂 bytes）已实测确认、并据此改了 `BaiDu` 与 `Network(proxies=…)`；a（结果访问器）/ b（条目字段名）仍未定，自检现已把每个引擎 `search()` 的返回类型与条目类声明的字段打印出来，**再跑一次即可收口**。对账结论与两条断言的射程见 AGENTS.md「图片链路」。
- 字段迁移：旧的 `jmcomic.pythonPath` 已并入顶层 `python.path`，由 `normalizeConfigShape` **迁移**（`delete root.jmcomic` 是必需的：`updateConfig` 的 `deepMerge(getConfig(), patch)` 只加键不删键，不显式删就永远留在用户的 `config.json` 里）。`python.path` 的**空串是合法值**，含义是"走自动探测链"，所以保存端不要兜非空默认值。守护在 `tests/t-jmcomic.mjs` 第 1、1b、1c 段（解析优先级、来源层级、探测/自检模块）与 `tests/t-admin.mjs`（两个端点的真 app 断言：请求体里的可执行路径必须被忽略）。

Bot 的可选扩展能力主体统一落在 `src/media/<feature>/`；例如每日热搜位于
`src/media/hot-search/`。Web 层只保留路由、配置表面与组装接线。`media` 与 `qq` 同属 T1，
扩展能力不能直接 import `qq/` 实现，发送等需求通过由 `web/app.ts` 注入的最小结构化端口完成。

`agent/` 与 `web/` 还各有一条"根目录不得平铺实现"的硬规则，同由 `check-layers.mjs` 执行：`agent/` 的六个职责目录必须齐全且根目录不得有 `.ts`；`web/` 根目录只放行 `app.ts`/`server.ts`/`types.ts`/`usage-service.ts`（组装根、入口、领域类型、读模型），其余实现必须落进 `http/`、`runtime/`、`routes/`、`onebot/` 四个子目录之一。两条规则的判据相同——**是否触碰共享组件图**：只碰共享图的不搬，自己拥有私有状态的才搬。三项锚点（`app.ts`、`server.ts`、`types.ts`）不能挪位置，因为测试按字面路径读它们、还按函数名切 `app.ts` 的源码文本。嵌套层级本身不受检查（只按顶层目录判层）。

`agent/` 对 `web/` 的跨模块面固化成端口 `src/agent/runtime/control-port.ts`（`AgentControlPort`），`Orchestrator implements` 它；`src/web/` 与 `electron/main.js` 只依赖这个接口，不依赖具体类。端口只做**编译期**检查（`implements` 与 `satisfies`），运行期零成本，也不含任何 `instanceof`/`Symbol` 品牌——`tests/t-orch.mjs`、`t-vision-log.mjs` 用普通对象字面量充当依赖，加运行期校验会当场打碎它们。配套的 `METHOD_CATALOG` 只作文档与测试引用，不参与任何运行时分发。

长期后台任务的清点落在 `src/web/runtime/tasks.ts` 的 `LONG_TERM_TASKS`（9 行：原有 6 行 + `transcription.worker` + `hot-search.daily-broadcast` + `image-source.pic-worker`）。它是**纯数据**：描述 owner / 开关来源 / 配置刷新方式 / 启停入口 / 是否 unref / `conformance`，**不触发任何启停**，也不许在文件里出现调度调用；`start`/`stop` 存的是入口的名字而非函数引用，好让 `tests/t-tasks.mjs` 拿到真对象上去核对。请求作用域局部计时器不进这张表（有反向断言守），判定标准见 `docs/global-registry-design.md` §6.1。

**启停点只有一处**：长期任务一律在 `src/web/app.ts` 的 `start()` 里启动、在 `stop()` 里停止（成对出现），不靠模块加载期或构造函数副作用。**S11c 起这句话是结构性的**：`start()` 只调 `startLifecycle(deps)`、`stop()` 只调 `stopLifecycle(deps)`，顺序写在 `src/web/runtime/lifecycle.ts` 的 `LIFECYCLE` 数组里（`start` 正序、`stop` **逆序**，于是"停长期任务排在 `onebot.close()` 之前"由"`onebot.reconnect` 排第一位"自动满足）；`app.ts` 的 `lifecycleDeps()` 只负责把真模块递进去。清单的元素存**函数引用**（不是名字），`ids` 只作对账元数据，`import` 它不启动任何东西——三条都有断言（`tests/t-lifecycle.mjs` 第 2/3 段），因为"按名字分发的运行时注册表"是明令禁止的形态。配置刷新路径**不接清单**（`applyConfigPatch` 只重应用确实支持热刷新的能力；当前 8 条 entry 中有 5 条无条件，不能整表重跑）。已接管的样子参照 `price.feed`、两个 jmcomic 任务、`onebot.reconnect`、`transcription.worker`、`hot-search.daily-broadcast`（`node-cron` + `Asia/Shanghai`，配置保存经 `applyConfigPatch` 只重建自己的计划），以及 `image-source.pic-worker`（`imageSource.enabled` 门控，**默认 `false`**，不用搜图的部署完全不付 Python 冷启动；启动入口 `initPicImageSearch()` 预热且**预热失败只记日志、不外抛**——没装 `PicImageSearch` 是"搜图不可用"，不该掀翻 `app.start()`）。**9 行长期任务里只剩 `jmcomic.worker` 是 `partial`**（停不掉正在执行的那一次下载），其余 8 行为 `full`。**新增长期任务要动三处**：`LONG_TERM_TASKS`、`lifecycle.ts` 的 `LIFECYCLE`、`app.ts` 的 `lifecycleDeps()`——只改一处会被对账断言拦下。

**端点（`snowluma` 的 ws/http 地址与令牌）只有一个写入口**：`applyConfigPatch` 把 `next.snowluma` 的四个字段交给 `OneBotClient.applyEndpoint(next)`，**它返回 `true`（真的变了）才** `onebot.reconnect()`——所以"保存了一次没动端点的设置"不会断连。归一化规则（去 httpUrl 尾斜杠、空 URL 回落默认值、空 token 真清空）与构造函数**共用同一份**，规则一旦在比较的那一侧另写一份，`…:3000/` 与 `…:3000` 就会被判成变更、每次保存都断一次连接。唯一例外是 `applyTokens`（401 轮换路径上必须先写 token 再无条件重连）。守护在 `tests/t-timers.mjs` 第 5 段。

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

链路还有一条**异步回流**入口：后台转写完成后，把一条 `kind:'transcript'` 的【转写结果】写进存档并推入窗口，它随后走上面同一套「窗口 → 响应判定 → runAgent」流程。区别在于那一次运行**没有任何 tool result 与之对应**——转写是在更早一次运行里入队的，中间隔了一次会话收尾。所以这条路径的正确性只能靠 system prompt 规则（见 5.1）与窗口判定（见 4.2）承载，不能指望上下文里还留着工具调用痕迹。

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

窗口收的是“对方发来的消息”，但有一类**机器生成的条目**也必须进窗口：转写结果（`kind:'transcript'`）。它不是谁说的话（`senderId` 为空串、`senderName` 为 `转写`，仅用于摘要与提示词显示），却必须让模型看到并开口。它的 `read` 必须是 `false`——否则播种时 `#lastSeenId` 取的是“最长的一段 `read === true` 前缀”，条目会落在那条水位线**之下**：进程内刚写入时看得见，重启后永久不可见。

存档层因此用**两个谓词**回答两个不同的问题（此前由 `isSystemRecord` 一个函数兼任，转写结果的两个答案是相反的，所以必须拆开）：

- `isSystemRecord`：判“要不要进动态唤醒窗口”。只有 `digest` / `note` 不进，转写结果**天然通过**。
- `isPersonMessage`：判“算不算某人说的话”。`digest` / `note` / `transcript` 都不算，供 `activeMembers` 与记忆整理过滤幽灵成员（否则会凭空多出一个叫“转写”的成员）。

归档范围（`selectArchiveRange`）仍按 `isSystemRecord` 判定，所以转写结果**可以被压缩归档**，长文本不会在存档里只增不减。

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

窗口里只要有一条转写结果，`evaluateWindowTrigger()` 就无条件返回 `shouldRespond: true`
（`reason` 为 `转写结果`，`responseTier: 0`）。理由是转写结果是**异步交付**的：它到达时距离入队已经隔了一次完整的会话收尾，那次运行的 tool result 早已不在上下文里；若在低档位被判成“未触发”，它会被静默消费，模型永远看不到，用户等了半分钟只等来一片沉默。`responseTier: 0` 沿用主动机会的同类先例——非档位来源共用 0，含义由 `reason` 承载，UI 打印的“档 N · reason”里 N 为 0 也不与 1–4 的档位词表混淆。

这条规则有两条刻意保住的性质：

- 它排在“全部响应”与“被艾特”**之后**（那两种原因更具体，配了全部响应的用户仍看到“全部响应”），排在关键词/随机**之前**（后两者受档位闸门约束，而转写结果必须在**任何**档位下都触发）；
- 它**不读骰子**。`#resolvePendingResponse` 同时被 `scheduleWake`（建等待会话之前）与 `wake`（真正运行之前）调用，与随机无关才能保证两处给出同一个答案。

后果要知道：规则作用于**整批**。一条转写结果与一批无关闲聊同处窗口时，整批都会进入【本次唤醒】并被响应，模型看到的不只是转写结果。

提示词构建器从 `historyBeforeId` 之前向前读取 `historyCount` 条，形成【过去状态】；
`batch()` 中的消息只形成【本次唤醒】。两段以明确边界相接，不按数组 offset 猜测，也不
在窗口消费后重新计算响应策略。窗口外已滑出的较早消息属于历史候选，能否实际注入
仍受独立历史深度和统一字符预算限制。

## 5. 提示词组装

模型可见固定文案的唯一目录是 `src/core/prompt-catalog.ts`。它统一保存默认 persona、
system/user 固定段、工具及参数 description、历史压缩和记忆整理指令；
`src/agent/prompting/prompt-builder.ts` 只负责动态变量、聊天记录格式化、条件选择与预算裁剪。
UI 文案、日志、HTTP 错误和运行时参数校验错误不属于提示词目录。

工具**结果**串通常是动态返回值（含错误文案），留在各自工具文件里；唯一例外是
`transcribe_video` 的回执话术（`TOOL_PROMPT_TEXT.transcribe_video.receipt`）：它没有任何动态成分，
且它要解决的问题是"**诱导模型说哪句话**"而不是"返回什么数据"，所以按固定指令处理。这一条特别值得
放在目录里，因为它是纯话术、需要反复调——它和 `description`、`toolProtocol` 第 7 条是同一件事的
三个面，分居两地就永远调不齐。

### 5.1 System prompt

`buildSystemPrompt()` 放稳定、跨会话的规则：人设与表达约束、是否应当发言的原则、工具调用与引用安全规则、表情使用策略。工具参数定义留在 tool schema，不再复制到 system/user prompt。

其中一条规则只能在 system prompt 里交代：**看到【转写结果】必须开口**。转写结果是异步到达的，到达的那次运行拿不到任何 tool result，也没有“上一轮我提交过转写”的痕迹；只有 system prompt 能跨运行把这件事说清楚（要求模型评价或转述，并禁止在没有【转写结果】时凭空评价视频内容）。

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

转写结果在【本次唤醒】与【过去状态】两处用同一段渲染：`[时间] 【转写结果】<正文>`，正文被截断时前缀里写明原文全长。它不参与触发标签判定——不因为正文里有“吗/呢”被标成「提问」，也不因为正文提到 bot 名字被标成「提到我」（转写正文里出现这两样是常事）；它也不带 `#id` 前缀（`mid` 为 `null`，没有可引用的消息号）。

### 5.3 统一字符预算

配置项：

```text
store.promptContextMaxChars = 32000
```

它约束单次完整 user prompt，`0` 表示不限。当前采用字符预算而不是依赖特定模型 tokenizer，使所有 OpenAI 兼容渠道行为一致。

始终保护、不裁剪的部分：当前时间、会话状态、【本次唤醒】中的新消息和【本轮决策】。

一条转写结果因此**永远进得了提示词**（它就在【本次唤醒】里）。它的正文长度由 `transcription.resultMaxChars` 决定——这项配置本是 QQ 单条消息的上限，现在同时决定条目正文长度，好处是“群里人看到的”与“模型看到的”是同一段文本、与文件上传阈值也自然一致。代价是明确的：默认 3500 字约占 32000 总预算的 11%，极端情况下会挤掉表情目录、摘要、记忆与已读历史。这是有界的、可接受的取舍，所以没有另开配置项。

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

注意有一类工具**不在本轮产生外部动作**：它把任务交给后台队列就立刻返回，完毕后由队列自己把结果投递回原会话。`download_jmcomic` 是这个形态，所以它的产出不落在本轮会话记录的发送列表里，也不能用“这轮没发消息”推断它没干活。

与它相邻的是**"工具自己不开口"契约**：`transcribe_video` 与 `reverse_image_source` 都**不代模型发任何消息**——工具只负责入队/查询与返回结果，说不说、怎么说由模型在这一次运行里自己决定。这条契约不是风格偏好，它有两条机制上的理由：

- **代发会写进 `ctx.session.sent`，把这一轮撑成 `done`**（`agent-runner.ts` 的收尾按发送记录判状态）。于是模型本该在失败时给群友一个交代，却因为"看着已经说过了"停在错误结果上结束，群里只剩那句占位提示——症状看起来是"任务没有正常结束"，其实是**任务被代发伪装成了已收尾**。
- **代发提示会在模型重试时重复**。工具一旦返回错误，模型会拿同一份输入再调一次，于是同一句占位提示发两遍（实测：图源接口先 HTTP 400 后成功的一轮里，「在找图源，稍等」出现了两次）。

代价是明确的：模型选择沉默时，群里在结果到达前没有任何提示。这是刻意的取舍（定死一句回执会和模型自己的发言重复），而异步结果到达的那一次运行本来就必须开口（见 5.1）。

`transcribe_video` 现在只算**半个**"交给队列就返回"形态，两条路径要分清：

- **模型自主路径**（工具调用）：工具**自己不发任何消息**，入队成功就立刻返回。要不要先说一句（例如「我先看看」）由模型在这一次运行里自己决定——想说就接着调发送类工具，不想说就直接结束。这不会影响会话收尾：工具不写 `session.sent`、不发 `session-update`，所以"这轮没发消息"如实反映为 `noreply`，而不是被代发撑成 `done`。结果**不再由队列直接贴进群**——后台把它写成一条【转写结果】并触发另一次运行，由模型结合当时的群聊记录决定说什么。所以转写的最终产出既不属于本轮，也不由队列替模型发言。代价是模型选择沉默时群里在结果到达前没有任何提示；这是刻意取舍（定死一句回执会和模型自己的发言重复）。
- **`/转写` 命令路径**：仍由后台队列直接投递（截断段 + 超长时的全文文件），确定性、不经模型、零 LLM 成本，行为逐字节不变。

队列侧的投递按 `mode` 分流（`standalone` / `assisted`），回流端口是注入的最小结构化端口，与 `jmcomic` 的 `store` 端口同款。端口抛错**必须自带 try/catch 且绝不外抛**：`#drain` 把异常一律当成“转写失败”，那会同时把任务记成 `failed` 并往群里发一条莫须有的「转写失败」，而结果其实已经拿到了。

能力型工具的依赖（`transcription` / `hotSearch`）是 `ToolContext` 上的**可选**字段，从 `OrchestratorDependencies` 经 `WakeScheduler`（真正的 `AgentRunnerHost`）透传进来；缺了不做 `instanceof` 校验，由工具自己返回友好错误。未启用的能力由 `agent-runner.ts` 按配置从工具集里过滤掉，与视觉/搜索的过滤同一处。

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

测试通过 `tests/lib/src.mjs` 加载 `dist/`，确保验证的是实际运行产物。新增 `t-*.mjs` 必须在 `tests/run.mjs` 的 ASSERT 或 DIAG 中显式归类，否则 runner 直接失败。runner 另有一条**清单自身诚实性**的扫描：每个 ASSERT 套件里必须存在一个参数不是字面量 `0` 的 `process.exit(` 调用。因为判定只看子进程退出码，而 `checker().done()` 只返回布尔值、自己从不退出——一句裸 `done();` 会让整个套件**永远退 0**，断言红成一片而 runner 照样打 ✅（实测曾如此：`t-image-source.mjs` 一次 30 通过 / 5 失败的运行被报成全绿）。这是文本扫描，证明不了那条 `exit` 在运行期真会被走到；它只堵"压根没有非零退出路径"这一种形态。DIAG 脚本按定义永远退 0，不在此列。

当前重点回归包括动态窗口语义、摘要去重、当前窗口与独立历史分离、统一预算保护本轮消息、读图结果回填、`memory_query` 定向查询、主动冒泡的唤醒语义（`t-window.mjs` 第 15 段），以及 Web/UI 模块接线。

长期任务与事件相关改动另有一组专项套件：`t-events.mjs`（事件名/载荷/注入类型/`session-update` 通道）、`t-sse-project.mjs`（SSE 帧逐字节）、`t-panel-wiring.mjs`（UI 订阅名跨边界 + 设置页接线：Python 工具那段的 id 解析、保存分支必须写 `patch.python.path` 且**兜底仍是空串**、两个按钮必须先 `saveConfig` 再打探测端点）、`t-ports.mjs`（跨模块端口与 `implements`；另扫 `tests/` 里每个 `new Orchestrator({…})` 是否都传了 `emit`——`.mjs` 不受 `tsc` 管，这条只能文本扫）、`t-tasks.mjs`（`LONG_TERM_TASKS` 描述符与 `conformance` 一致性）、`t-timers.mjs`（计时器句柄：起没起、停没停、有没有被"清掉又没重建"、待触发的那一次取消不取消得掉）、`t-transcription.mjs`（视频命令、SSRF、单并发状态机、凭证脱敏）、`t-jmcomic.mjs`（漫画队列按"请求者 QQ + 漫画 ID"去重：完成后记录**留在** `jobs` 里而不是即时摘除，否则"同一用户短时间内不能重复提交"对**下载成功过**的漫画失效；窗口的计时起点是上传完成时刻而非创建时刻；2026-09-29 起还守 Python 解释器的解析优先级（`python.path` > `QQ_AGENT_PYTHON` > Windows 固定环境 / conda）、每一层报出的 `source`、探测与自检模块（假 `spawn` 注入：非 JSON 输出、非零退出、超时 kill、输出截断、`--self-check` 确实进了 argv），以及旧配置迁移——`jmcomic.pythonPath` 搬进 `python.path` 后旧键必须消失，且保存一次**不会被写回**，因为 `updateConfig` 的 `deepMerge` 只加键不删键，漏掉那句 `delete` 的话内存里看着对、盘上却永远留着；安全网也换了形态：早先靠 `JMCOMIC_PYTHON` 指一个不存在的程序，现在把 `python.path` 写进夹具 `config.json`（`config` 优先级最高，不再依赖"某台机器上恰好有这个变量"），并另配一条正向断言证明安全网真的生效）、`t-jmcomic-upload.mjs`（上传超时/断连与重启遗留的 `uploading` 统一进入 `upload_uncertain`：群文件按文件名和大小查群文件列表，私聊按文件名和大小查好友消息历史，核验期间不再次调用非幂等的上传动作）、`t-lifecycle.mjs`（注册层执行侧：退出路径的信号接线与幂等、装配清单 ⇄ 描述符表对账、`app.start()/stop()` 的接线与逆序、无按键分发；S11d 起还守"被删的死代码与空转事件不许长回来"——`core/config.ts` 无任何计时器、三个文件再无 `emit`、`EventMap` 与 `vision-scan` 在 `src/` 绝迹，同时**正向**钉住 `routes/providers.ts` 里那个活着的 `visionScan` 局部对象；S11e 起还守 electron 的退出等待——`before-quit` 的**函数体**里必须有 `preventDefault(`、排在它前面的 `stopping` 守卫、promise 链上的 `.catch(`，以及 `.finally` 里那次 `app.quit()`，否则桌面端要么不退要么死循环）。

每日热搜另有 `t-hot-search.mjs`，覆盖 ApiZero 匿名/Bearer 请求、429/5xx/超时重试、字段缺失与空榜、标题去重、按条目分页、白名单目标、重启后当天不重复以及手动/定时互斥。

搜图另有 `t-image-source.mjs`，五段：① 通用 provider 的薄适配——参数按**位次**原样转发（含 `engineOptions` 里的 `apiKey`）、错误码原样透传（`RATE_LIMIT` / `QUOTA_EXHAUSTED` / `TIMEOUT`）、`test()` 走 `ping()` 且**从不抛**（ping 返回 `false` 或直接抛异常都收敛成 `false`）；② **服务层的分发第一次有了直接断言**——用注入的假 provider（`PicImageSearchPort` 是编译期端口，测试用对象字面量顶替，没有 `instanceof`）实测 `intent` 决定的先后顺序（`anime` 先 `trace.moe`、`illustration` 先 `saucenao`）、逐引擎的 `timeoutMs`/`maxResults`/`mime`、`similarity < minSimilarity` 过滤、关闭或空 `apiKey` 的引擎被跳过，以及 `failures` 标签仍是 `trace:` / `sauce:`（这条字符串会进模型可见文本）。为了让 `loadSafeImage` 真的下载到字节，这一段用**回环 HTTP 服务**（`security.allowPrivateImageHosts` 临时打开，跑完复原——先例是 `t-sticker.mjs`），因此它必须排在"被 SSRF 挡下"那条断言**之后**；③ 同一段窗口内另有**缓存**用例（共用同一个 service 实例才有缓存可言）：同引擎同图第二次不发远端调用、**换 intent 不会被另一个引擎的缓存顶替**（旧实现按图片 hash 缓存整轮结论，这条在旧实现下会红）、失败不进缓存、`maxResults` 与引擎参数指纹都进键；④ `formatImageSourceResult` 的输出形状（此前一条断言都没有）——集数与时间点彼此独立、`time === 0` 是合法值、缺失字段兜底而不是印出 `undefined`；⑤ 文本断言钉住原生 fetch 已绝迹：`src/media/image-source/` 下不再出现 `saucenao.com` / `api.trace.moe` / `TraceMoeProvider` / `SauceNaoProvider` / `fetchImpl`，两个按引擎的 provider 文件不存在，服务层源码里不出现 `anime_trace`（它是 trace.moe 的别名，不许加成第三个引擎）；⑥ 引擎名是**跨进程的手工镜像**：worker 的 `ENGINE_CLASS_CANDIDATES` 键集合 ⇄ Node 的 `PIC_IMAGE_SEARCH_ENGINES` 逐字比对（`.py` 不进 `tsc`，没有别的套件会读它），另加 `MEASURED_FIRST_CANDIDATE` 钉住 2026-09-29 实测到的类名在候选链里**够得着**。**两条射程不同，别当同一条用**：键集合那条看不见候选类名的拼写（把 `BaiDu` 改回 `Baidu`，实测该套件全绿），实测名那条挡不住"库改名"——它只挡得住"把已经实测对的名字又改回去"。

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
- 往 `agent/` 或 `web/` 里新增实现时，先看 `scripts/check-layers.mjs` 的两条根目录规则（`src/web/` 根只放行组装根、入口、领域类型与读模型）；搬动 `src/` 文件后**先 `rm -rf dist` 再 build**，因为 `npm run build` 不清理旧产物，留下的化石会让指向旧路径的测试照样通过。
- 修改对话主链路后至少运行 `npm run check`。
