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
   │  ├─ slash-commands.ts 斜杠命令的唯一落点（判定 / 解析调用 / 入队 / 即时回执）
   │  └─ ingest.ts      入站事件摄取：白名单、@ 名字解析、引用解析（结构化 reply）、合并转发展开、拍一拍、B 站卡片补成视频媒体
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
- **搜图是"Node 一个通用 provider + 引擎分发在 Python"**：`src/media/image-source/pic-image-search-provider.ts` 是**唯一**的 provider，它只做转发——`search(engine, buffer, mime, timeoutMs, maxResults, signal?, engineOptions?)` 把引擎名连同图片一起递给 `pic-image-search-client.ts`，`test(engine, …)` 则是把客户端的 `ping()` 包成**吞异常返回 `false`** 的形式（设置页按钮的路径：库没装是"不可用"，不是抛给页面）。**引擎的类名、家族与字段归一化全部只在 Python**（worker 的 `ENGINE_CLASS_CANDIDATES` 与几张映射表），Node 侧的映射实现也只有一份（客户端的 `toImageSourceResult`）。按引擎的 `enabled`、`apiKey`（**只走 stdin，绝不进 argv**）与**引擎级门槛**过滤**仍留在 Node**，因为它们是 Node 自己的配置（门槛是引擎级的：网页类引擎不返回置信度，它那段配置里**根本没有** `minSimilarity` 这一栏，见下文）。**不要**再按引擎长出一个 provider 类。
- **worker 由长期任务表接管**（`image-source.pic-worker`，`imageSource.enabled` 门控、**默认 `false`**）：启动入口是显式的 `initPicImageSearch()`（预热，失败只记日志），停止入口是 `closePicImageSearchClient()`（关子进程并 fail 掉所有在途请求）。**懒启动保留**——预热不是唯一入口，预热失败不影响首次搜索，`test()` 之后也不会留下一个没人收的子进程。
- **分发策略与缓存都在 `reverse-image-source-service.ts`**：引擎表 `ENGINE_ROWS`（一段配置一行）与顺序表 `ORDER`（按 `SearchIntent`）都是显式声明的，加引擎 = 加一行 + 定位置；命中即 `break`（**顺序决定谁有机会先答，也决定谁拦住谁**）。第三张表 `INTENT_PARAMS`（同样按 `SearchIntent`）表达**掩码**：SauceNAO 的 `hide` —— **今天 `manga` / `illustration` 两行都是 `0`**（不藏）。这是实测撞出来的：`hide=1` 曾把 Madokami 那张同人志图**藏掉**，于是这一路不再短路、必须去问 trace.moe，而后者答不了漫画。判据是 `hide` 由**服务端按它自己的判定**过滤，我们无法复核它凭什么认为某张图是预期 R18，一次误判的代价是整条结果消失，而收益（少几条 R18）在"只在群里报来源"的场景里并不明确。所以这张表保留的不是两个不同的值，而是**唯一那个"按类型收紧过滤"的落点**（`Record<SearchIntent, …>` 的穷尽性会在第五个 intent 出现时逼出一次决定）。它**刻意不是设置页上的档位**：模型每次调用都已经给出了"这是什么图"，而一个全局档位只能同时错杀一边。`hide` 是 SauceNAO 的**构造**参数而非 `search()` 的 kwargs（实测签名见 worker 头部 ⚑ f 条），经 `engineOptions` 递到 worker 的 `_saucenao_constructor_args()` —— 那里**必须白名单**，因为 `__init__` 的 `**request_kwargs` 让 `_filtered_call` 变成全传（拼错键不报错、直接塞给 HTTP 客户端）；`dbmask` / `dbmaski` / `db` / `dbs` **有意不接**（编号表不在库里）。`anime_trace` **有意不入表**（它是 trace.moe 的中文别名，同一远端服务，入了表会有两条路打同一个接口）。**`unknown` 不等于 `anime`**：它最初与 anime 同序，理由只是"与改动前一致"（沿袭旧实现，不是决定），而它恰恰是模型判不出类型时填的那个值 —— 于是"我不确定"在顺序上等于"这是动画截图"，且因为 `break` 的存在会把后面的 SauceNAO 整条拦掉。判据是**引擎覆盖面**（trace.moe 只索引动画帧，是窄域专用；SauceNAO 面广），所以窄域引擎只在**类型已确认**时先问，**路由是"类型专属引擎 → 一般向兜底"**：`anime` → `['trace','baidu']`、`manga` / `illustration` → `['sauce','baidu']`、**`unknown` 没有专属引擎**（`['baidu']`，直接走兜底）。一般向引擎是**百度识图**（`baidu`）：5 个候选里唯一不要 API Key、面向中文互联网、且类名 `BaiDu`（大写 D）已被真机实测确认过的那个，恒排链尾。`unknown` 这条是实测撞出来的缺陷：它与 `anime` 最初同序，理由只是"与改动前一致"（沿袭旧实现，不是决定），而它恰恰是模型判不出类型时填的那个值 —— 于是"我不确定"在顺序上等于"这是动画截图"，且因为 `break` 的存在会把后面的广域引擎整条拦掉（真机实测：一张梗图走的就是动画那条路）。判据是**引擎覆盖面**：窄域引擎只在**类型已确认**时先问。**预算必须为兜底留位置**：`totalTimeoutMs`（默认 35000）是**整轮**死线、且**包含图片下载**，而上一版每一发都拿满自己配置的 `timeoutMs` —— 真机那次 `TOTAL_TIMEOUT` 的算术正好是 `20000 + 15000 = 35000`，**零余量**，"专属引擎超时 → 兜底"在最需要它的那一刻恰恰不会发生。现在每一发都从同一条死线倒推：`available = 剩余 - 8000 × 后面还有几发 - 500`，`available < 3000` 就跳过并记 `<which>:NO_BUDGET`（一句关于**我们**的陈述：没给时间），否则 `budget = min(该引擎配置的 timeoutMs, available)`；下载也被夹在 `min(15000, 剩余)` 里并接上 `AbortSignal`，超时由服务层抛 `IMAGE_TIMEOUT`，工具文案因此第一次能把"下载慢"与"接口慢"分开。**接受策略是引擎级的**：网页类引擎不返回置信度，所以 `baidu` 那段配置里**没有 `minSimilarity` 这一栏**（"没有这个概念"由字段的缺席表达），`ImageSourceResult.similarity` 随之变成可选，`result-formatter.ts` 按"字段在不在"决定印不印那一行（与 `time` 那个 `00:00` 同一条规矩）；**有门槛的引擎仍要求结果自带置信度且过线，无置信度的结果对它们照样被丢弃**。四条常量与完整推导见 `docs/image-source-routing-design.md`。缓存存的是**单个引擎的响应**而非整轮结论，键 = `引擎 + 图片 hash + maxResults + 引擎参数指纹`（`hide` 也在指纹里，所以参数不同的 intent 各占一个槽位；今天 `manga` 与 `illustration` 的参数逐字节相同，**共享**槽位是对的 —— 请求一样，共享就是对的），**失败从不写缓存**——旧版按图片 hash 缓存整轮结论，换 intent 会命中另一个引擎的答案（第二个引擎根本没被问过），失败也会被冻结 `cacheTtlMs`。`SearchOutput.cached` 只表示"本次一次远端调用都没发"。队列保持全局单并发（下游是串行读 stdin 的单进程 worker）。
- **解释器只从 `python.path` 读**，解析链唯一实现在 `resolvePythonCommand()`：`python.path` → `QQ_AGENT_PYTHON` → Windows 固定环境 → `conda run -n my_bot python`，返回值带 `source`（`config`/`env-primary`/`windows-direct`/`conda`）供面板显示"当前生效的是哪一层"。**不要给新工具另加解释器环境变量**——两个工具用同一个解释器，各加一个的结果是"装了 A 库的环境跑不了 B"，报错却指向库缺失。旧别名 `JMCOMIC_PYTHON` 已于 2026-09-29 **正式废弃并从链上删除**，同一原因。
- **解释器探测与依赖自检**（`src/core/python-probe.ts` + 两个 `POST /api/system/python-*` 端点）：`probePython()` 用配置的解释器跑一次 `-c` 脚本（`find_spec` + `importlib.metadata.version`），回答"生效层级 / 命令 / 版本 / 两个库装没装"；`runSelfCheck()` 跑 `pic_image_search_worker.py --self-check` 并把输出**原文**（stderr 优先）带回来——worker 头部那几条对账结论靠这段原文产出，此后它是**回归 / 升级探测**的入口（换了库版本、或改了映射表就跑一次）。三条边界：两个端点**只读已保存的配置、刻意忽略请求体**（接受请求体里的路径等于开一个"用 HTTP 启动任意本机程序"的一步接口，唯一写入口仍是鉴权过的 `POST /api/config`，故 UI 必须先保存再探测）；它们是**请求作用域**短命子进程，**不进 `LONG_TERM_TASKS`**、不碰常驻 worker 客户端单例；argv 里**不含任何密钥**。测试用注入的假 `spawn`（`SpawnLike` 是最小结构类型，无 `instanceof`），安全网是"`python.path` 指向不存在的程序"，所以套件永不真启动解释器。**这个按钮是 worker 那几张映射表唯一的对账入口**：2026-09-29 在目标解释器（Python 3.10.12 / PicImageSearch 3.12.11）上跑了三次，⚑ 四条（a 结果访问器 / b 条目字段名 / c 引擎类名 / d 入参名与能否直接喂 bytes）**已全部实测确认**，此后重跑是回归/升级探测。据此改掉的三处：`BaiDu`（而不是 `Baidu`）、`Network(proxies=…)`（复数）、以及**两个真机 bug**——trace.moe 的时间戳字段真名是大写 `From`（旧链写小写 `from` → 每条结果都是 `00:00`），标题的"`origin` 是裸字符串就当标题"兜底排在真 `title` 前面（会把来源站点 URL 印成动画名）；修法是标题先取 `title_chinese`/`title_native`/`title_romaji` 这些实测平铺字段、删掉 `origin` 兜底，并且**取不到时间就不写 `time` 键**（数据层写 0 会让 `result-formatter.ts` 的"字段在不在"判据失效，重新印出 `00:00`）。对账结论、两个 bug 与三段断言的射程见 AGENTS.md「图片链路」。自检现在还会打**各引擎的构造签名与取值表**（worker 的 `_dump_engine_params` / `_dump_constants`），于是"某个参数住在构造还是 `search()` 的 kwargs"这类问题**一次点击即可** —— SauceNAO 的 `hide` 就是这么定下来的（在此之前只能在目标解释器上手跑一行），而取值表是**照抄**用的：凭印象填掩码的表现不是报错，是"悄悄隐藏了另外几套库"。
- 字段迁移：旧的 `jmcomic.pythonPath` 已并入顶层 `python.path`，由 `normalizeConfigShape` **迁移**（`delete root.jmcomic` 是必需的：`updateConfig` 的 `deepMerge(getConfig(), patch)` 只加键不删键，不显式删就永远留在用户的 `config.json` 里）。`python.path` 的**空串是合法值**，含义是"走自动探测链"，所以保存端不要兜非空默认值。守护在 `tests/t-jmcomic.mjs` 第 1、1b、1c 段（解析优先级、来源层级、探测/自检模块）与 `tests/t-admin.mjs`（两个端点的真 app 断言：请求体里的可执行路径必须被忽略）。

Bot 的可选扩展能力主体统一落在 `src/media/<feature>/`；例如每日热搜位于
`src/media/hot-search/`。Web 层只保留路由、配置表面与组装接线。`media` 与 `qq` 同属 T1，
扩展能力不能直接 import `qq/` 实现，发送等需求通过由 `web/app.ts` 注入的最小结构化端口完成。

`agent/` 与 `web/` 还各有一条"根目录不得平铺实现"的硬规则，同由 `check-layers.mjs` 执行：`agent/` 的六个职责目录必须齐全且根目录不得有 `.ts`；`web/` 根目录只放行 `app.ts`/`server.ts`/`types.ts`/`usage-service.ts`（组装根、入口、领域类型、读模型），其余实现必须落进 `http/`、`runtime/`、`routes/`、`onebot/` 四个子目录之一。两条规则的判据相同——**是否触碰共享组件图**：只碰共享图的不搬，自己拥有私有状态的才搬。三项锚点（`app.ts`、`server.ts`、`types.ts`）不能挪位置，因为测试按字面路径读它们、还按函数名切 `app.ts` 的源码文本。嵌套层级本身不受检查（只按顶层目录判层）。

`agent/` 对 `web/` 的跨模块面固化成端口 `src/agent/runtime/control-port.ts`（`AgentControlPort`），`Orchestrator implements` 它；`src/web/` 与 `electron/main.js` 只依赖这个接口，不依赖具体类。端口只做**编译期**检查（`implements` 与 `satisfies`），运行期零成本，也不含任何 `instanceof`/`Symbol` 品牌——`tests/t-orch.mjs`、`t-vision-log.mjs` 用普通对象字面量充当依赖，加运行期校验会当场打碎它们。配套的 `METHOD_CATALOG` 只作文档与测试引用，不参与任何运行时分发。

长期后台任务的清点落在 `src/web/runtime/tasks.ts` 的 `LONG_TERM_TASKS`（10 行：原有 6 行 + `transcription.worker` + `hot-search.daily-broadcast` + `image-source.pic-worker` + `image-gen.worker`）。它是**纯数据**：描述 owner / 开关来源 / 配置刷新方式 / 启停入口 / 是否 unref / `conformance`，**不触发任何启停**，也不许在文件里出现调度调用；`start`/`stop` 存的是入口的名字而非函数引用，好让 `tests/t-tasks.mjs` 拿到真对象上去核对。请求作用域局部计时器不进这张表（有反向断言守），判定标准见 `docs/global-registry-design.md` §6.1。

**启停点只有一处**：长期任务一律在 `src/web/app.ts` 的 `start()` 里启动、在 `stop()` 里停止（成对出现），不靠模块加载期或构造函数副作用。**S11c 起这句话是结构性的**：`start()` 只调 `startLifecycle(deps)`、`stop()` 只调 `stopLifecycle(deps)`，顺序写在 `src/web/runtime/lifecycle.ts` 的 `LIFECYCLE` 数组里（`start` 正序、`stop` **逆序**，于是"停长期任务排在 `onebot.close()` 之前"由"`onebot.reconnect` 排第一位"自动满足）；`app.ts` 的 `lifecycleDeps()` 只负责把真模块递进去。清单的元素存**函数引用**（不是名字），`ids` 只作对账元数据，`import` 它不启动任何东西——三条都有断言（`tests/t-lifecycle.mjs` 第 2/3 段），因为"按名字分发的运行时注册表"是明令禁止的形态。配置刷新路径**不接清单**（`applyConfigPatch` 只重应用确实支持热刷新的能力；当前 9 条 entry 中有 6 条无条件，不能整表重跑）。已接管的样子参照 `price.feed`、两个 jmcomic 任务、`onebot.reconnect`、`transcription.worker`、`hot-search.daily-broadcast`（`node-cron` + `Asia/Shanghai`，配置保存经 `applyConfigPatch` 只重建自己的计划）、`image-source.pic-worker`（`imageSource.enabled` 门控，**默认 `false`**，不用搜图的部署完全不付 Python 冷启动；启动入口 `initPicImageSearch()` 预热且**预热失败只记日志、不外抛**——没装 `PicImageSearch` 是"搜图不可用"，不该掀翻 `app.start()`），以及 `image-gen.worker`（**不加清单级闸门**：队列空载时不持有任何东西，而把闸门提到清单里会让"配置关着"报成"画图服务尚未启动"）。**10 行长期任务里只剩 `jmcomic.worker` 是 `partial`**（停不掉正在执行的那一次下载），其余 9 行为 `full`。**新增长期任务要动三处**：`LONG_TERM_TASKS`、`lifecycle.ts` 的 `LIFECYCLE`、`app.ts` 的 `lifecycleDeps()`——只改一处会被对账断言拦下。

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

链路另有**三条异步回流**入口：后台转写完成后写入 `kind:'transcript'` 的【转写结果】；漫画 PDF 被 OneBot 明确接收后写入 `kind:'jmcomic-result'` 的【漫画下载结果】；出图队列把画好的图片发进群后写入 `kind:'image-result'` 的【图片生成结果】。三者都会落存档、推入窗口，再走同一套「窗口 → 响应判定 → runAgent」。区别在于那次运行**没有任何 tool result 与之对应**——任务是在更早一次运行里入队的，中间隔了一次会话收尾。所以正确性只能靠 system prompt 规则（见 5.1）与窗口判定（见 4.2）承载，不能指望上下文里还留着工具调用痕迹。

第三种的**交付物本身是文件**（与漫画的 PDF 同形、与转写不同）：图片由队列**直接发进群**，回流条目只承载"发过了"这个事实，让模型有机会补一句话——说不说由它决定，因为图已经在那里了，模型也没法"说"出一张图。

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

窗口收的是“对方发来的消息”，但三类**机器生成的条目**也必须进窗口：转写结果（`kind:'transcript'`）、漫画完成结果（`kind:'jmcomic-result'`）与出图结果（`kind:'image-result'`）。它们不是谁说的话（`senderId` 为空串，`senderName` 只用于摘要与面板显示），却必须让模型看到并开口。它们的 `read` 必须是 `false`——否则播种时 `#lastSeenId` 取的是“最长的一段 `read === true` 前缀”，条目会落在那条水位线**之下**：进程内刚写入时看得见，重启后永久不可见。

存档层因此用**两个谓词**回答两个不同的问题（此前由 `isSystemRecord` 一个函数兼任，转写结果的两个答案是相反的，所以必须拆开）：

- `isSystemRecord`：判“要不要进动态唤醒窗口”。只有 `digest` / `note` 不进，三种异步结果**天然通过**。
- `isPersonMessage`：判“算不算某人说的话”。`digest` / `note` / `transcript` / `jmcomic-result` / `image-result` 都不算，供 `activeMembers` 与记忆整理过滤幽灵成员。

归档范围（`selectArchiveRange`）仍按 `isSystemRecord` 判定，所以三种异步结果**可以被压缩归档**，不会在存档里只增不减。

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

窗口里只要有一条转写结果、漫画完成结果或出图结果，`evaluateWindowTrigger()` 就无条件返回 `shouldRespond: true`
（`reason` 分别为 `转写结果` / `漫画下载结果` / `图片生成结果`，`responseTier: 0`）。理由是它们都是**异步交付**的：到达时距离入队已经隔了一次完整的会话收尾，那次运行的 tool result 早已不在上下文里；若在低档位被判成“未触发”，它会被静默消费，模型永远看不到。`responseTier: 0` 沿用主动机会的同类先例——非档位来源共用 0，含义由 `reason` 承载。

注意出图结果那条**不是**"让模型去发那张图"（图已经由队列发进群了），它保证的是"模型有机会补一句话"。

这条规则有两条刻意保住的性质：

- 它排在“全部响应”与“被艾特”**之后**（那两种原因更具体，配了全部响应的用户仍看到“全部响应”），排在关键词/随机**之前**（后两者受档位闸门约束，而转写结果必须在**任何**档位下都触发）；
- 它**不读骰子**。`#resolvePendingResponse` 同时被 `scheduleWake`（建等待会话之前）与 `wake`（真正运行之前）调用，与随机无关才能保证两处给出同一个答案。

后果要知道：规则作用于**整批**。一条异步结果与一批无关闲聊同处窗口时，整批都会进入【本次唤醒】并被响应，模型看到的不只是任务结果。

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

`buildSystemPrompt()` 放稳定、跨会话的规则：人设与表达约束、是否应当发言的原则、工具调用与引用安全规则、表情使用策略。工具参数定义留在 tool schema，不再复制到 system/user prompt。**唯一的例外是「参数是 JSON，字符串值里需要引号时用中文引号」这条**（`toolProtocol` 第 3 条）：它不是某个参数的语义约束，而是**所有工具调用共有的传输格式**——`send_message.messages`、`sticker_note.note`、`memory_append` 的自由文本都会踩同一个坑，写进 schema 就得在每个字段里各抄一遍。模型偶尔仍会漏，所以通用解析失败的文案（`agent/tools/shared.ts`）也带上了可执行的下一步。

其中一条规则只能在 system prompt 里交代：**看到【转写结果】必须开口**。转写结果是异步到达的，到达的那次运行拿不到任何 tool result，也没有“上一轮我提交过转写”的痕迹；只有 system prompt 能跨运行把这件事说清楚（要求模型评价或转述，并禁止在没有【转写结果】时凭空评价视频内容）。

出图那条规则同样只能在 system prompt 里，但**内容与转写相反**：图由系统直接发进群，所以要求的是"别抢系统的活"——看到【图片生成结果】顺口补一句就够、也可以安静结束，**不许复述"已发送"、不许描述或评价画面**（那张图模型压根看不到）。同一处还交代了第一层提示词怎么写：`generate_image.prompt` 要的是给画图模型看的成稿描述，不是群友的原话。**第二层（管理员配的 `imageGen.stylePrompt`）一个字都不在提示词里**——它由代码拼在描述之后，写进模型看得见的地方只会让模型自己再写一遍，同一句出现两遍。

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

漫画完成结果与出图结果同形：`[时间] 【漫画下载结果】<正文>` / `[时间] 【图片生成结果】<正文>`，同样不参与触发标签判定（出图条目的正文里就带着"模型自己写的那段画面描述"，里面出现疑问句或 bot 名字同样是常事），同样不带 `#id`。

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

### 5.4 引用（`reply`）：被引用对象的 id 必须可寻址

存档里的 `ChatMessage.reply` 是结构化的 `{ mid, sender, text }`，**预览只存在这里、不拍进 `text`**：

- `mid` 是被引用消息的 QQ id（可寻址）；
- `sender` / `text` 只是给人看的预览（取不到正文时只剩 `mid`）。

渲染层把它拼成 `[引用 #-966228343 清三：[图片]]`（唯一拼法是 `prompt-builder.ts` 的 `formatReplyPrefix`，`formatEntry`、`buildTriggerBlock` 与历史压缩的输入行都用它；面板侧另有一份同形态实现，因为 `ui/js/` 够不着 `src/`）。触发标签「引用」认的是结构化 `reply`，不是文本前缀；老存档（预览还在 `text` 里、`reply` 为 `null`）仍按前缀兜底，两边渲染一致，所以不需要迁移。

**为什么非要带上 id**（这是实测踩出来的）：不带 id 时模型只看得见 `[引用 清三：[图片]]`，而 `[图片]` 是所有图片共用的占位符、同一发送者的两张图在文本上逐字相同，`get_message_images` 又只认消息 id —— 于是它只能在提示词里可见的 id 里挑一个。实测那次它挑中了同一发送者的**另一张图**，拿回来的画面与被引用的那张无关，而它没有任何线索能发现自己挑错了（工具照样返回了一张图）。被引用的对象恰好同时是"可能要引用回去"和"可能要打开看"的东西，所以它必须可寻址，与"带 #数字 的才能引用/看图"是同一条规则。

对应的第二道保险在 `get_message_images`：请求的那条消息没有图片、但它引用了某条消息时，工具顺着 `reply.mid` 去取被引用那条的图片，并在结果文本里点明图来自哪条（`消息 82 引用的消息 #81 的图片内容`）。这不是猜测——`reply.mid` 是入站时就记死的关联。引用链上都没有图时如实回"没有可查看的图片"，不返回图片内容。

### 5.5 合并转发：展开后仍是一条消息，不是几条记录

`ingest.ts` 在入站时就展开转发（`expandForwardNodes`），把那条消息的 `text` **整份替换**成：

```text
[合并转发 共10条]
航: [图片]
航: 这个笔记本怎么样
…（还有 2 条未展开）
```

存档里这仍是**转发者的一条消息**，上面那些行只是 `text` 里的换行。两个形态特征是它自带的，不是缺陷：每行 `${name}: ${body}` **不带时间戳**（OneBot 的转发节点没有时间），`name` 属于别的会话。所以平铺展示时，看起来就是"本群混进了几条不属于这里、还没有时间的记录"（实测报过一次）。

面板侧因此把它渲染成独立区块：`ui/js/views/chats.js` 的 `forwardBlockHtml`（缩进 + 左侧竖线 + 弱化，见 `style.css` 的 `.fwd-block`）。三条边界：

- 判据是 `/^\[合并转发 共\d+条\]/`，与 `read_forward` 工具那句 `entry.text.startsWith('[合并转发 共')` **同形**——两边认的必须是同一件事（工具刚写回展开文本、面板却按普通消息平铺，就是两边判据漂了）。
- 只改渲染，**不动 `text`**：模型看到的必须还是展开后的原文（它要读得懂转发内容）。
- 渲染出的仍是**一行 `<tr>`**：多渲染出行会打乱分页账本（`state.chatMsgRendered` 与滚动加载）。

已知空白：`expandForwardNodes` **没有任何套件覆盖**，`[合并转发 共N条]` 这个字面也没被钉过；且展开后的这个拼法在 `prompt-catalog.ts` 里没有说明——目录只写了未展开的 `[合并转发聊天记录]` / `[转发消息 …]`，而入站是自动展开的，模型实际看到的是第三种。

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

1. `get_message_images` 根据 QQ 消息 ID 查找存档媒体（那条消息自己没有图、但引用了某条时顺着 `reply.mid` 回退，见 5.4）。
2. `safe-fetch` 校验地址、下载二进制、识别 MIME，并转为 data URL。
3. 工具文本结果以 `role: tool` 返回。
4. 图片以紧随其后的多模态 `role: user` 消息注入，兼容不接受 tool 图片的 OpenAI 兼容端点。
5. 下一轮视觉模型产生文字理解或继续调用工具。

会话日志中的 `toolImages` 会记录图片数量。下一轮响应到达后，编排层将读图文字和同轮工具调用回填到 `toolImages.reply`；UI 在同一工具卡片中展示，并通过 `imageReply` 避免重复渲染 assistant 气泡。

视觉工具只有在全局视觉开关启用，且模型没有被明确探测为 `no-vision` 时才会提供给模型。

## 8. Agent 工具循环

`runAgent()` 每轮会调用模型、累计用量、保存 assistant 响应、解析原生或文本形式的工具调用、执行工具并追加结果。图片结果转换为额外视觉 user 消息。无工具调用、调用 `finish`、达到轮数上限或全局中止时结束。

模型普通文本本身不会自动发送到 QQ；对外动作必须通过发送类工具完成。因此最终状态按真实发送记录判断：发过消息为 `done`，未发送为正常的 `noreply`。

工具循环另有一次性的协议纠正：本次运行已经执行过至少一个工具、尚未成功产生发送动作，而下一轮模型只返回非空普通文本且没有 `tool_calls` 时，编排层不会代发那段文本，而是追加一条取自 `PROMPT_CATALOG.user.toolProtocolCorrection` 的内部 user 消息，再给模型一次独立于 `maxRounds` 的纠正轮。模型可以改为调用发送工具，也可以用 `finish`、空内容或再次不调用工具来保持沉默；纠正最多一次，第二次仍无工具调用就按既有 `noreply` 语义结束。没有先执行工具的普通文本不走这条路径，已经成功发送文本/表情或拍一拍的会话也不误触发。

注意有一类工具**不在本轮产生外部动作**：它把任务交给后台队列就立刻返回，完毕后由队列自己把结果投递回原会话。`download_jmcomic` 是这个形态：Python 用 `__QQ_AGENT_RESULT__` 结果帧通知 Node，Node 在 stdout 收到完整帧时立即结算（不再等待子进程 `close`；`close` 只作异常兜底），随后上传 PDF。OneBot 明确返回成功或文件列表核验命中后，再经注入的完成 sink 写入【漫画下载结果】并唤醒 Agent。这样即使第三方库留下未退出线程，也不会出现“PDF 已生成、任务仍永久卡在 downloading”的状态。它的产出不落在最初那轮会话记录的发送列表里，不能用“这轮没发消息”推断它没干活。

与它相邻的是**"工具自己不开口"契约**：`transcribe_video` 与 `reverse_image_source` 都**不代模型发任何消息**——工具只负责入队/查询与返回结果，说不说、怎么说由模型在这一次运行里自己决定。这条契约不是风格偏好，它有两条机制上的理由：

- **代发会写进 `ctx.session.sent`，把这一轮撑成 `done`**（`agent-runner.ts` 的收尾按发送记录判状态）。于是模型本该在失败时给群友一个交代，却因为"看着已经说过了"停在错误结果上结束，群里只剩那句占位提示——症状看起来是"任务没有正常结束"，其实是**任务被代发伪装成了已收尾**。
- **代发提示会在模型重试时重复**。工具一旦返回错误，模型会拿同一份输入再调一次，于是同一句占位提示发两遍（实测：图源接口先 HTTP 400 后成功的一轮里，「在找图源，稍等」出现了两次）。

代价是明确的：模型选择沉默时，群里在结果到达前没有任何提示。这是刻意的取舍（定死一句回执会和模型自己的发言重复），而异步结果到达的那一次运行本来就必须开口（见 5.1）。

`transcribe_video` 现在只算**半个**"交给队列就返回"形态，两条路径要分清：

- **模型自主路径**（工具调用）：工具**自己不发任何消息**，入队成功就立刻返回。要不要先说一句（例如「我先看看」）由模型在这一次运行里自己决定——想说就接着调发送类工具，不想说就直接结束。这不会影响会话收尾：工具不写 `session.sent`、不发 `session-update`，所以"这轮没发消息"如实反映为 `noreply`，而不是被代发撑成 `done`。结果**不再由队列直接贴进群**——后台把它写成一条【转写结果】并触发另一次运行，由模型结合当时的群聊记录决定说什么。所以转写的最终产出既不属于本轮，也不由队列替模型发言。代价是模型选择沉默时群里在结果到达前没有任何提示；这是刻意取舍（定死一句回执会和模型自己的发言重复）。
- **`/转写` 命令路径**：仍由后台队列直接投递（截断段 + 超长时的全文文件），确定性、不经模型、零 LLM 成本，行为逐字节不变。

队列侧的投递按 `mode` 分流（`standalone` / `assisted`），回流端口是注入的最小结构化端口，与 `jmcomic` 的 `store` 端口同款。端口抛错**必须自带 try/catch 且绝不外抛**：`#drain` 把异常一律当成“转写失败”，那会同时把任务记成 `failed` 并往群里发一条莫须有的「转写失败」，而结果其实已经拿到了。

### 8.1 斜杠命令与图像生成（Qwen-Image）

**所有 `/xxx` 命令的判定、解析调用、入队与即时回执都在 `src/web/onebot/slash-commands.ts` 一处**（当前两条：`/转写`、`/画 <描述>`）。放一处的原因是那条判据同时决定三件事——要不要并入引用消息里的附件、要不要落成已读历史（`wakeEligible:false`）、这条消息归谁处理——写在两处时漂移不会有任何报错，表现只有"命令没被认出来、消息进了 LLM"或"同一条消息被处理两次"。`ingest.ts` 只用同一个 `isSlashCommand()` 做前两项决定，用完 `if (slashCommand) { await handleSlashCommand(...); return; }` 收口。命令自己的语法（用法提示、参数解析）仍留在各自的领域模块：`media/transcription/commands.ts`、`media/image-gen/commands.ts`。

`generate_image` 与 `/画 <描述>` 走同一条队列（`src/media/image-gen/`），形状照搬转写那条，三处按"交付物是文件"改了：

- **两条路径都只入队**。工具不代模型发言（与 `transcribe_video` / `reverse_image_source` 同一契约），命令路径回一句「在画了，稍等」。
- **图片由队列自己发进群**（`SendQueue.sendImage`，因此受限频、也留 `我：[图片]` 的存档），发完再按 `mode` 决定要不要回流——`standalone`（命令）不回流，`assisted`（工具）回流成一条【图片生成结果】。
- **临时文件的生命周期归队列**，不归 `runTask`：转写的 `runTask` 返回文本，可以在自己的 `finally` 里删目录；这里返回的是文件，它必须活到投递之后，所以工作目录由 `#drain` 建、投递完删。

另外三处与转写**刻意不同**，都有理由：

1. **成本闸门在队列的 `enqueue` 里，两条入口共用**。转写的 `/转写` 命令不受闸门约束；出图按张计费，而 `/画` 是群里任何人都能敲的，命令路径不设闸门等于开一个可被刷的开支口子。放进 `enqueue` 也顺手避免了"工具先扣一次、队列再扣一次"的双记。
2. **`n` 固定为 1**（接口层仍按数组处理）。额度按"一次调用 = 一张图"记账最直观，想画三张就调三次、占三个额度。
3. **提示词分两层**：模型写"画什么"（工具 description 里要求写成给画图模型看的成稿描述），`imageGen.stylePrompt` 由后端拼在描述之后管"怎么画"，两层在 `client.ts` 的 `buildImageGenRequest()` 这一个纯函数里合并（命令路径与工具路径因此逐字节相同，有断言钉着）。

还有两条接口层的坑写在代码里：`size` 的分隔符是**星号**（OpenAI 兼容协议用字母 x，配置层会把 x 归一成星号），以及**失败可能是 HTTP 200**——接口把错误放在响应体的 `code` 里（DashScope 协议在顶层、OpenAI 兼容嵌在 `error.code`），只看状态码会把"API Key 无效"读成成功，然后卡在"没有返回图片"上。

能力型工具的依赖（`transcription` / `imageGen` / `hotSearch`）是 `ToolContext` 上的**可选**字段，从 `OrchestratorDependencies` 经 `WakeScheduler`（真正的 `AgentRunnerHost`）透传进来；缺了不做 `instanceof` 校验，由工具自己返回友好错误。未启用的能力由 `agent-runner.ts` 按配置从工具集里过滤掉，与视觉/搜索的过滤同一处。

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

长期任务与事件相关改动另有一组专项套件：`t-events.mjs`（事件名/载荷/注入类型/`session-update` 通道）、`t-sse-project.mjs`（SSE 帧逐字节）、`t-panel-wiring.mjs`（UI 订阅名跨边界 + 设置页接线：Python 工具那段的 id 解析、保存分支必须写 `patch.python.path` 且**兜底仍是空串**、两个按钮必须先 `saveConfig` 再打探测端点）、`t-ports.mjs`（跨模块端口与 `implements`；另扫 `tests/` 里每个 `new Orchestrator({…})` 是否都传了 `emit`——`.mjs` 不受 `tsc` 管，这条只能文本扫）、`t-tasks.mjs`（`LONG_TERM_TASKS` 描述符与 `conformance` 一致性）、`t-timers.mjs`（计时器句柄：起没起、停没停、有没有被"清掉又没重建"、待触发的那一次取消不取消得掉）、`t-transcription.mjs`（视频命令、SSRF、单并发状态机、凭证脱敏）、`t-jmcomic.mjs`（漫画队列按"请求者 QQ + 漫画 ID"去重：完成后记录**留在** `jobs` 里而不是即时摘除，否则"同一用户短时间内不能重复提交"对**下载成功过**的漫画失效；窗口的计时起点是上传完成时刻而非创建时刻；2026-09-29 起还守 Python 解释器的解析优先级（`python.path` > `QQ_AGENT_PYTHON` > Windows 固定环境 / conda）、每一层报出的 `source`、探测与自检模块（假 `spawn` 注入：非 JSON 输出、非零退出、超时 kill、输出截断、`--self-check` 确实进了 argv），以及旧配置迁移——`jmcomic.pythonPath` 搬进 `python.path` 后旧键必须消失，且保存一次**不会被写回**，因为 `updateConfig` 的 `deepMerge` 只加键不删键，漏掉那句 `delete` 的话内存里看着对、盘上却永远留着；安全网也换了形态：早先靠 `JMCOMIC_PYTHON` 指一个不存在的程序，现在把 `python.path` 写进夹具 `config.json`（`config` 优先级最高，不再依赖"某台机器上恰好有这个变量"），并另配一条正向断言证明安全网真的生效）、`t-jmcomic-callback.mjs`（结果帧即刻结算，不依赖 Python `close`；上传完成 sink 回流 `jmcomic-result`，最低档位仍唤醒）、`t-jmcomic-upload.mjs`（上传超时/断连与重启遗留的 `uploading` 统一进入 `upload_uncertain`：群文件按文件名和大小查群文件列表，私聊按文件名和大小查好友消息历史，核验期间不再次调用非幂等的上传动作）、`t-lifecycle.mjs`（注册层执行侧：退出路径的信号接线与幂等、装配清单 ⇄ 描述符表对账、`app.start()/stop()` 的接线与逆序、无按键分发；S11d 起还守"被删的死代码与空转事件不许长回来"——`core/config.ts` 无任何计时器、三个文件再无 `emit`、`EventMap` 与 `vision-scan` 在 `src/` 绝迹，同时**正向**钉住 `routes/providers.ts` 里那个活着的 `visionScan` 局部对象；S11e 起还守 electron 的退出等待——`before-quit` 的**函数体**里必须有 `preventDefault(`、排在它前面的 `stopping` 守卫、promise 链上的 `.catch(`，以及 `.finally` 里那次 `app.quit()`，否则桌面端要么不退要么死循环）。

每日热搜另有 `t-hot-search.mjs`，覆盖 ApiZero 匿名/Bearer 请求、429/5xx/超时重试、字段缺失与空榜、标题去重、按条目分页、白名单目标、重启后当天不重复以及手动/定时互斥。

斜杠命令分发层另有 `t-slash-commands.mjs`（21 条）：认命令的边界（`/画xx`、`/转写啦`、展开后的转发正文都不算）、`/转写[视频]` 那条分支、每条命令的回执与"不入队"的边界（`/画` 没写描述时只回用法提示）、失败时把**真实原因**原样发回群里（解析层抛的本来就是中文用户文案），以及一条源级断言：**`ingest.ts` 里不许再出现命令正则**（判据只有一份，漂移时不会有任何报错）。

图像生成另有 `t-image-gen.mjs`（91 条），起一个**本地假百炼端点**（`baseUrl` 是管理员配置、不是用户输入，所以指向 127.0.0.1 是正常用法；与「请求结构」那条同一条边界），覆盖：配置归一化与钳制（含 `x` → `*`、整条 endpoint 粘进来、`DASHSCOPE_API_KEY` 回退）、请求体形状（T2I 只有 `{text}`、I2I 参考图在前、`negative_prompt` **只在 3.0 系列出现**）、**两层提示词**（风格层留空时与模型给的描述逐字相同——这条对照必须有，否则"永远拼一层空串"看不出来）、错误映射（HTTP 400、**HTTP 200 但响应体带 `code`**、无图 URL、响应体超限、超时、abort 各一条）、队列（单并发、`stop()` 取消排队中的那一个并 abort 在途、视图不含 prompt、临时文件投递后即删）、成本闸门（每会话与全局两本账、被拒的不占额度、**两条入口共用**）、`/画` 解析与参考图定位、工具侧（不代发消息、不把任务号写进结果、messageId 取不到图时列出实际附件种类），以及端到端那一条：**命令路径与工具路径拼出来的请求体逐字节相同**（两层提示词只有一份实现）。

搜图另有 `t-image-source.mjs`，七段：① 通用 provider 的薄适配——参数按**位次**原样转发（含 `engineOptions` 里的 `apiKey`）、错误码原样透传（`RATE_LIMIT` / `QUOTA_EXHAUSTED` / `TIMEOUT`）、`test()` 走 `ping()` 且**从不抛**（ping 返回 `false` 或直接抛异常都收敛成 `false`）；② **服务层的分发第一次有了直接断言**——用注入的假 provider（`PicImageSearchPort` 是编译期端口，测试用对象字面量顶替，没有 `instanceof`）实测 `intent` 决定的先后顺序（`anime` 先 `trace.moe`、`manga` / `illustration` 先 `saucenao`、**`unknown` 直接走一般向兜底**）、专属引擎答不上（低于门槛 / 抛错 / 超时）之后**兜底真的被调用**、每一发的超时被夹住给后面留位置（预算不够则跳过并记 `NO_BUDGET`、一次调用都不发）、逐引擎的 `timeoutMs`/`maxResults`/`mime`、`similarity < minSimilarity` 过滤（**无置信度的结果只对没有门槛的引擎算命中**——`baidu` 那条被采用，而带门槛的引擎照样丢弃它，两条互为对照）、关闭或空 `apiKey` 的引擎被跳过，以及 `failures` 标签仍是 `trace:` / `sauce:` / `baidu:`（这条字符串会进模型可见文本）。**`unknown` 这条是补上来的缺口**：它此前没有任何断言，而模型判不出类型时填的就是它 —— 于是"当初与 `anime` 同序（理由只是'与改动前一致'）"这个缺陷在四套件全绿的情况下活了一整轮；夹具让 trace.moe 也自称命中（0.99 > 它自己的门槛 0.87）才可判别（顺序错则 trace 的假命中赢并拦住兜底）。为了让 `loadSafeImage` 真的下载到字节，这一段用**回环 HTTP 服务**（`security.allowPrivateImageHosts` 临时打开，跑完复原——先例是 `t-sticker.mjs`），因此它必须排在"被 SSRF 挡下"那条断言**之后**；③ 同一段窗口内另有**缓存**用例（共用同一个 service 实例才有缓存可言）：同引擎同图第二次不发远端调用、**换 intent 不会被另一个引擎的缓存顶替**（旧实现按图片 hash 缓存整轮结论，这条在旧实现下会红）、失败不进缓存、`maxResults` 与引擎参数指纹都进键；④ `formatImageSourceResult` 的输出形状（此前一条断言都没有）——集数与时间点彼此独立、`time === 0` 是合法值、缺失字段兜底而不是印出 `undefined`、**没有置信度时整行让位**（判据是"字段在不在"，`pct(undefined)` 印出来的是 `NaN%`）；另有两条文本断言钉住 `SearchIntent` 的取值域在**三处**（`types.ts` 的联合类型、工具 schema 的 `enum`、`prompt-catalog` 的 intent 描述）逐字一致 —— 少一处模型就永远填不出那一档，且没有任何报错；⑤ 文本断言钉住原生 fetch 已绝迹：`src/media/image-source/` 下不再出现 `saucenao.com` / `api.trace.moe` / `TraceMoeProvider` / `SauceNaoProvider` / `fetchImpl`，两个按引擎的 provider 文件不存在，服务层源码里不出现 `anime_trace`（它是 trace.moe 的别名，不许加成第三个引擎）；⑥ 引擎名是**跨进程的手工镜像**：worker 的 `ENGINE_CLASS_CANDIDATES` 键集合 ⇄ Node 的 `PIC_IMAGE_SEARCH_ENGINES` 逐字比对（`.py` 不进 `tsc`，没有别的套件会读它），另加 `MEASURED_CLASS_NAMES`（2026-09-29 实测到的 7 个类名）钉住它们在候选链里**够得着**；⑦（源码段 ⑩）扫 `python-tools/pic_image_search_worker.py` 的**源码文本**，钉住第三次实测抓到的那两个真机 bug 的修法——时间取自大写 `From`、取不到时**不写** `time` 键（写 0 会让 formatter 的"字段在不在"判据失效）、标题按 `title_chinese` → `title_native` → `title_romaji` 取实测平铺字段、`origin` 当标题的兜底不存在。**两条射程不同，别当同一条用**：键集合那条看不见候选类名的拼写（把 `BaiDu` 改回 `Baidu`，实测该套件全绿），实测名那条挡不住"库改名"——它只挡得住"把已经实测对的名字又改回去"。⑦ 那段还有一条通用教训：**取函数体时只按行丢了 `#` 注释，docstring 不是注释、丢不掉**，所以断言必须**锚定到具体调用**（`_pick(raw_item, "title_chinese")`）而不是裸字段名——初版写的是 `/title_chinese[\s\S]*title_native/`，把代码里那次调用删掉后它**照样绿**（名字原样躺在 docstring 里），是证伪探针撞出来的假绿。

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
