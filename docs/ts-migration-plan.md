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
├─ extra/      扩展能力：声明静态、按需装载、空闲 dispose（不识别 web）
│  ├─ types.ts        扩展契约（ExtraSpec / ExtraRuntime / ExtraCommandSpec / ExtraPromptContribution），纯类型
│  ├─ prompts.ts      扩展的固定指令（EXTRA_PROMPT_TEXT 按工具名 / EXTRA_PROMPT_SECTIONS 按扩展 id）
│  │                  —— **必须无 import**，是全仓库唯一的反向依赖例外（见 §2 下方）
│  ├─ registry.ts     静态清单，每行 { ...xSpec, load: () => import('./x/impl.js') }
│  ├─ runtime.ts      ExtrasRuntime：装载表 + 工具表/命令表/提示词计划三张派生表 + 校验
│  ├─ clock/          参考扩展：spec.ts（纯数据，含一条 `/时间` 命令）+ impl.ts（按需加载的实现）
│  └─ trpg/           跑团：第一个**接管模式**的完整扩展（七个子目录，见 §10）
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
   ├─ routes/           领域路由（11 个领域 + index）
   ├─ onebot/           OneBot 接入侧（"那个 OneBot 端"自己的状态，与 `src/qq/` 的传输客户端分开）
   │  ├─ snowluma.ts    SnowLuma 程序目录、子进程、日志环形缓冲、端口探活与 WebUI 地址
   │  ├─ tokens.ts      令牌桥：候选收集、401 轮换、限频与去重签名
   │  ├─ commands.ts    命令的**唯一落点**（判定 / 解析调用 / 入队 / 即时回执；2026-10-16 从 `slash-commands.ts` 改名）
   │  └─ ingest.ts      入站事件摄取：白名单、@ 名字解析、引用解析（结构化 reply）、合并转发展开、拍一拍、B 站卡片补成视频媒体、扩展拦截（落档之前）
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
extra
  ↓
web
```

`scripts/check-layers.mjs` 会阻止反向依赖。领域共享类型分别放在各自的 `types.ts` 中，不建立全局巨型类型文件。

`extra` 插在 `agent` 与 `web` 之间（2026-10-15 加的档，`web` 因此从 4 顶到 5），于是机检自动给出三条规则：`extra → {core, media, chat, qq, agent}` 合法；`web → extra` 合法（组装根 import 注册表）；**`extra → web` 被拦**（扩展不认识 web，组装是 web 的活，这条同时排除了 web ↔ extra 成环）。反方向同理：`agent → extra` 也是反向依赖，所以扩展工具的 schema 由 `web/app.ts` 递进 `Orchestrator`（`OrchestratorDependencies.extraToolDefs`），`buildToolDefs(extra)` 只负责拼。完整设计见 `docs/extras-design.md`。

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
- **解释器只从 `python.path` 读**，解析链唯一实现在 `resolvePythonCommand()`：**随包内置的运行时**（`src/core/paths.ts` 的 `PYTHON_RUNTIME_DIR`，只有打包时带了 `--with-python` 才存在；目录不在就跳过这一层）→ `python.path` → `QQ_AGENT_PYTHON` → `conda run`（环境由 `python.condaEnv` 决定：环境名走 `-n`、环境目录走 `-p`、留空则不带选择器用 conda 当前环境），返回值带 `source`（`bundled`/`config`/`env-primary`/`conda`）供面板显示"当前生效的是哪一层"。**内置层排在链首是有意的**（2026-10-13 定）：它是我们自己装好依赖、跟着包发出去的那一份，也是唯一"确定能用"的解释器，而后面三层都是这台机器上的猜测；代价是**带内置运行时的包里 `python.path` 不生效** —— 所以设置页那一栏的提示、使用说明与 README 都写明了这句话与两条出路（删掉 `resources/app/python-runtime/`，或换一个不带 `--with-python` 的包），否则就是本项目最忌讳的那类故障（填了、看着生效、实际用别的）。后三层相对顺序不变（配置 > 环境变量 > conda），且**必须**排在 conda 之前：conda 那一级的 command 是未必存在的命令名（`conda`/`conda.exe`），解析永不失败、失败发生在 `spawn` 那一刻，排在它之后的层在"什么都没装"的机器上永远不会被用到。**源码里不再有任何机器相关的绝对路径**：conda 那一级原是一行写死的 `E:\anaconda\envs\my_bot\python.exe`（存在就直用，否则退回 conda），只有作者的机器上成立，现已整级交给 `python.condaEnv`（出厂值就是原来那个 `my_bot`，所以升级本身不改变既有机器上的行为）。**不要给新工具另加解释器环境变量**——两个工具用同一个解释器，各加一个的结果是"装了 A 库的环境跑不了 B"，报错却指向库缺失。旧别名 `JMCOMIC_PYTHON` 已于 2026-09-29 **正式废弃并从链上删除**，同一原因。
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

链路另有**四条异步回流**入口（前三条是后台任务的产物，第四条是跑团扩展在工具调用或运行收尾的当场产生的机器条目）：后台转写完成后（**或识别失败时**）写入 `kind:'transcript'` 的【转写结果】/【转写失败】；漫画 PDF 被 OneBot 明确接收后（**或下载失败时**）写入 `kind:'jmcomic-result'` 的【漫画下载结果】/【漫画下载失败】；出图队列把画好的图片发进群后（**或没画成/没发出去时**）写入 `kind:'image-result'` 的【图片生成结果】；跑团扩展揭示信息、或 DM 整轮沉默时兜底生成行动方向时写入 `kind:'trpg-note'` 的【跑团笔记】/【行动建议】。四者都会落存档、推入窗口，再走同一套「窗口 → 响应判定 → runAgent」。区别在于那次运行**没有任何 tool result 与之对应**——任务是在更早一次运行里入队的，中间隔了一次会话收尾。所以正确性只能靠 system prompt 规则（见 5.1）与窗口判定（见 4.2）承载，不能指望上下文里还留着工具调用痕迹。

第三种的**交付物本身是文件**（与漫画的 PDF 同形、与转写不同）：图片由队列**直接发进群**，回流条目承载**三态结局**（`sent` 已发送 / `unsent` 画好了没发出去 / `failed` 没画成），标签分别为【图片生成结果】/【图片发送失败】/【图片生成失败】。**成功与失败走同一条回流通道，队列不代模型说话**：这条路模型只调了一次工具就结束本轮，随后那次运行才是它开口的地方；代说会让它以为"群里已经说过了"而不再开口。只有"确定没人接"时才退回贴一句（`/画` 命令路径没有模型、assisted 没装回流端口、回流端口抛错）。

## 4. 新消息窗口与历史深度

这两个概念职责不同，不能混用。

### 4.1 `ContextWindow`

每个 `chatKey` 有一个窗口，只管理对方发来的当前新消息：

- 私有滑动窗口：最新的驻留消息，容量由 `store.maxContextMessages` 控制，`0` 表示不限。**容量按会话取**（2026-10-16 起）：`ContextWindowRegistry` 的 `capacity` 收 `数字 | ((chatKey) => number)`，`Orchestrator` 递进去的是 `configFor(chatKey)` 读出来的那个数 —— 于是扩展的运行期配置覆盖能把**某一个群**的窗口拓宽而别的群不动（跑团 DM 模式就靠这条）。
- 折叠 id 账本：因容量不足被滑出的消息 ID，不保留消息内容；`takeFoldedIds()` 将新滑出的 ID 立即同步为已读历史，折叠计数则保留到本轮消费。
- 私有消费游标：已经由某次调度处理到的位置。
- 私有结算队列：等待同步到存档 `read` 镜像的消息 ID。

主要读取接口：

- `pending()` / `batch()`：窗口中尚未消费消息的深拷贝，严格受容量限制；用于响应判断并进入【本次唤醒】。
- `foldedCount()`：已滑出但尚未结算的 id 数，用于提示模型较早消息已降级到历史。
- `seen()`：推进水位线。回复与不回复都会消费，避免旧消息反复成为“新消息”。

窗口收的是“对方发来的消息”，但四类**机器生成的条目**也必须进窗口：转写结果（`kind:'transcript'`）、漫画完成结果（`kind:'jmcomic-result'`）、出图结果（`kind:'image-result'`）与跑团扩展的机器条目（`kind:'trpg-note'`，2026-10-16 加：扩展揭示信息时是【跑团笔记】，DM 整轮沉默时兜底生成的行动方向是【行动建议】—— 同一种 kind、两个标签，按 `extra.trpgNote.kind` 分）。它们不是谁说的话（`senderId` 为空串，`senderName` 只用于摘要与面板显示），却必须让模型看到并开口。它们的 `read` 必须是 `false`——否则播种时 `#lastSeenId` 取的是“最长的一段 `read === true` 前缀”，条目会落在那条水位线**之下**：进程内刚写入时看得见，重启后永久不可见。

存档层因此用**两个谓词**回答两个不同的问题（此前由 `isSystemRecord` 一个函数兼任，转写结果的两个答案是相反的，所以必须拆开）：

- `isSystemRecord`：判“要不要进动态唤醒窗口”。只有 `digest` / `note` 不进，三种异步结果**天然通过**。
- `isPersonMessage`：判“算不算某人说的话”。`digest` / `note` / `transcript` / `jmcomic-result` / `image-result` / `trpg-note` 都不算，供 `activeMembers` 与记忆整理过滤幽灵成员。

归档范围（`selectArchiveRange`）仍按 `isSystemRecord` 判定，所以三种异步结果**可以被压缩归档**，不会在存档里只增不减。

**这三种条目还额外享受一条豁免：它们不参与窗口滑出**（`ContextWindow.#trim` 里对 `isAsyncResult` 的豁免）。窗口超上限时会滑出最老成员，而被滑出的未消费条目会经 `takeFoldedIds()` 直接标成已读历史、从此不参与响应判定 —— 对普通闲聊这是对的取舍（新消息更重要），对异步结果就是**静默丢失**：它是"你的任务结束了"的唯一凭据，被滑出后模型只会看到群里凭空多了一张图，**而且日志里一条线索都没有**（2026-10-10 真机报告 + 探针复现：容量 3、图到达后群里再说 5 句，那一轮不由它触发；`t-window.mjs` 第 18/19 段钉住，含"普通消息照旧滑出"的对照）。代价是窗口长度可短暂超过 `cap`，超出的只是异步结果本身，数量由各能力的调用闸门兜住。

### 4.2 独立历史策略

响应档位只决定当前窗口是否值得响应；`store.historyCount` 独立决定读取多少条窗口之前的历史。二者没有数据或策略依赖。

响应档位的持久化事实源只有 `store.contextSliderPos`。`contextTier` 与
`randomPercent` 仅在运行时由滑条位置计算，不再写入配置；加载旧配置时会一次性把
旧字段迁移成滑条位置。全局滑条与 `groupSliderPos` 也遵循同一换算规则。

**取档位的唯一入口是 `responseConfigForChat(chatKey, source)`**，`source` 缺省才是全局那份。
调度器（`#resolvePendingResponse`，`scheduleWake` 与 `wake` 共用它）传的是
`configFor(chatKey)` —— 那是**这一轮运行真正生效的那份配置**，扩展的运行期覆盖（`configPatch`）
就叠在它上面。跑团靠这一点把被接管的会话**覆盖成 4 档**（滑条 100 = 全部响应），所以"玩家说的
每一句话 DM 都看得见"；调用点读 `getConfig()` 会让那次覆盖在这一处**静默失效**（症状是"配了、
看着生效、实际用的是别的"）。同一条纪律的另外两处是窗口容量与历史深度，见
`docs/extras-design.md` §5。

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

工具 description 在这份目录里分成**两块**：`TOOL_PROMPT_TEXT`（每一项对应 `agent/tools/index.ts` 里内置拼装的一个工具，名字与顺序是硬约束）与 `src/extra/prompts.ts` 的 `EXTRA_PROMPT_TEXT`（`src/extra/` 的扩展工具，随时可加）。`TOOL_PROMPT_TEXT` 里为扩展留的那几行是**转发到 `EXTRA_PROMPT_TEXT` 的同一个对象引用**，于是 `PROMPT_CATALOG.tools.<工具名>` 对两类工具是同一条取法。完整理由见 `docs/extras-design.md` §3.1 与 §5。

**system prompt 现在是"段名 → 正文"**：段名与段序由 `SYSTEM_SECTION_IDS` 定（在 `prompt_catalog.ts`，agent 与 extra 都 import 得到），段落之间用一个空行分隔。这样扩展才能**按段名覆盖**某一段。

哪些段是**框架契约**（`security` 安全规则、`toolProtocol` 工具调用协议）由"**接管时该不该让它消失**"这条判据定：它们不是"功能"，是运行契约，任何模式下都不许被扩展覆盖、接管模式下也只有它们强制保留。

2026-10-15 按这条判据把"**某个能力的用法**"拆了出去 —— 漫画搜索/下载、转写、出图那四条本来挤在 `toolProtocol` 里，于是接管会话必然带着"调用 `download_jmcomic`"这类指令，而那个工具不在接管者的表里（模型调一次拿到"未知工具"，再重试一次）。现在它们住在**新段 `capabilityProtocol`**：不是框架契约 ⇒ 接管时自动让位，也因此**可以被扩展按段名覆盖**。**往 `toolProtocol` 里加"某个工具的用法"就等于把它变成框架契约，接管扩展再也甩不掉它。**

同一次改动让**框架段的工具名变成参数**：`toolProtocol` 第 2 条要写"要发言必须调用 X"，而接管会话里内置工具整体让位，X 缺省那个 `send_message` 不在表里。签名因此是 `toolProtocol({ sendTool, finishTool })`，由接管扩展在 `spec.overrideTools` 里声明（`finishTool: null` = 没有收尾工具，本段就不提它）。`mode: 'override'` **必须**声明 `sendTool`，且两个名字都必须真的在该扩展的 `tools` 里 —— `validateRegistry` 在装配期拒绝装载。细节见 `docs/extras-design.md` §5。⚠️ 段序断言（`indexOf` 递增）**证明不了分隔符**：实测把 `join('\n\n')` 改成 `join('\n')` 之后 59 条断言全绿，所以另有一条专钉分隔符的断言。

`src/extra/prompts.ts` 留在 `src/extra/` 里，代价是 `core/prompt-catalog.ts → extra/prompts.js` 成为**全仓库唯一一条低层 import 高层**——它登记在 `scripts/check-layers.mjs` 的 `LAYER_ALLOW` 里，且闸门自带守卫：这条例外的目标必须是叶子模块（出现任何相对 import 直接报错）。那条依赖之所以不成环，全靠这一点。

扩展的**装载入口是人**（群里的 `/能力` 命令），模型一个装载入口都没有 —— 未装载的扩展，它的工具不在工具表里。所以 `toolDefs` / `commandDefs` / `promptPlan` 都是**按会话取**的函数（`host.toolDefsFor(chatKey)`），语义是"下一次运行生效"；命令表则按"已启用"（判据是 spec 里的静态纯函数，`isSlashCommand()` 不可能去问异步的装载表）。**接管（`spec.mode: 'override'`）是唯一按会话隔离的东西**：三张表都随会话变，同一个进程里 A 群可以让位而 B 群照常。这条不对称是刻意的，完整推导见 `docs/extras-design.md` §2 与 §6。

斜杠命令只声明**一个词形列表** `names`（第一个是主命令词），判定、规范化与日志标签**三样都从它派生** —— 没有第二种判据（曾经是 `name` + `aliases` + 一个 `match` 正则，三份）。命中非首位词形时把开头那个词换成 `names[0]` 再交给处理函数，于是每个解析器只认识自己那一个词。判定的边界是**一条**：`词` 后面跟空白、**`[`**、或直接结束 —— `[` 也算边界，是因为协议端把媒体段渲染成紧贴着的占位符（`segmentsToText` 用 `out.join('')`），"发视频 + 打 `/转写`"送来的就是 `/转写[视频]`；统一成边界规则之后，原先为它单开的那条 `/转写[视频]` 词形被删掉了。见 `docs/extras-design.md` §3.3–§3.4。

**扩展还能拦下普通消息**（`ExtraRuntime.intercept`）：入站链路在**落档之前**问一遍"这条你要不要自己接"，拦下的消息照常存档、照常上面板，但落成**已读**历史（`wakeEligible: !slashCommand && !intercepted`）—— 与斜杠命令并列的第二条确定性快路径，只是不需要群友敲斜杠。回执由**宿主**发（扩展碰不到 `sender`）。返回 `{}` 是"**全拦**"那一档（跑团助手模式正靠它：那个群里一次模型调用都不会发生）；**推论是"响应档位"在那条路上彻底不相干** —— 拦下的消息落成已读、`wakeEligible: false`，窗口判定根本走不到它，所以低档位群里助手模式照样掷骰。DM 模式 2026-10-19 起也不再受档位约束：它用的是**准入**（开跑之后只有这一局的人的消息会惊动 DM，返回 `{}` 拦下旁观者）**加上**把档位覆盖成 4 档。

**扩展还能给"这一轮运行"叠一层配置补丁**（`ExtraRuntime.configPatch(chatKey)`）：`runAgent` 开头调一次 `host.configFor(chatKey)` 算出一份**叠过的配置**，那一轮读到的每一处都是它。它**不改全局、不落盘**（`core/config.ts` 的 `mergeConfigPatch`），所以接管的会话与别的会话各看各的。⚠️ 这份 `cfg` **必须一路传到提示词拼装里**（`buildSystemPrompt` / `buildUserPrompt` / `buildPastState` / `formatEntry` / `triggerLabels` / `digestConfigForChat` 都收 `config`，内部不再自己读 `getConfig()`）—— 漏一处就是"覆盖了、只生效一半"。见 `docs/extras-design.md` §3.5–§3.6。

**窗口容量与历史深度 2026-10-16 起也在这份 `cfg` 的射程里**（此前不在），代价是**两个读取点**：① `Orchestrator` 建 `ContextWindowRegistry` 时按 `configFor(chatKey)` 取容量（`capacity` 因此从"数字"变成 `数字 | ((chatKey) => number)`，`capacityFor(chatKey)` 是唯一入口）；② `wake-scheduler` 算历史深度时读 `this.configFor(chatKey)` 而不是 `getConfig()`。**两处缺一，症状都是"配了、看着生效、实际用的是别的"**（探针实测：只改第二处时，容量那条断言照样绿）。跑团用它把"够跑一局"的三个数抬到下限（`maxContextMessages` 200 / `historyCount` 200 / `promptContextMaxChars` 60000，**只抬不降、`0` = 不限原样留着**）。

工具**结果**串通常是动态返回值（含错误文案），留在各自工具文件里；唯一例外是
`transcribe_video` 的回执话术（`TOOL_PROMPT_TEXT.transcribe_video.receipt`）：它没有任何动态成分，
且它要解决的问题是"**诱导模型说哪句话**"而不是"返回什么数据"，所以按固定指令处理。这一条特别值得
放在目录里，因为它是纯话术、需要反复调——它和 `description`、`capabilityProtocol` 第 2 条是同一件事的
三个面，分居两地就永远调不齐。

### 5.1 System prompt

`buildSystemPrompt()` 放稳定、跨会话的规则：人设与表达约束、是否应当发言的原则、工具调用与引用安全规则、表情使用策略。工具参数定义留在 tool schema，不再复制到 system/user prompt。**唯一的例外是「参数是 JSON，字符串值里需要引号时用中文引号」这条**（`toolProtocol` 第 3 条）：它不是某个参数的语义约束，而是**所有工具调用共有的传输格式**——`send_message.messages`、`sticker_note.note`、`memory_append` 的自由文本都会踩同一个坑，写进 schema 就得在每个字段里各抄一遍。模型偶尔仍会漏，所以通用解析失败的文案（`agent/tools/shared.ts`）也带上了可执行的下一步。

其中一条规则只能在 system prompt 里交代：**看到【转写结果】必须开口**。转写结果是异步到达的，到达的那次运行拿不到任何 tool result，也没有“上一轮我提交过转写”的痕迹；只有 system prompt 能跨运行把这件事说清楚（要求模型评价或转述，并禁止在没有这两种条目时凭空评价视频内容）。**失败那条路同样只能写在这里**（2026-10-10 统一）：识别失败不再由队列代模型往群里贴「转写失败」，而是回流一条 `status:'failed'` 的条目（标签【转写失败】），由模型自己交代一句——所以这条规则必须把两种结局都交代到（成功转述内容 / 失败如实交代、**不要自动重试**），`transcribe_video` 的 `description` 与 `receipt` 也各写一遍；不写的话模型看到失败标签会以为那是系统故障、自己插不上话，而那正是它唯一该开口的时刻。

出图那条规则同样只能在 system prompt 里，但**内容与转写相反**：图由系统直接发进群，所以要求的是"别抢系统的活"——看到【图片生成结果】顺口补一句就够、也可以安静结束，**不许复述"已发送"、不许描述或评价画面**（那张图模型压根看不到）。同一处还交代了第一层提示词怎么写：`generate_image.prompt` 要的是给画图模型看的成稿描述，不是群友的原话。**第二层（管理员配的 `imageGen.stylePrompt`）一个字都不在提示词里**——它由代码拼在描述之后，写进模型看得见的地方只会让模型自己再写一遍，同一句出现两遍。

### 5.2 User prompt

`buildUserPrompt()` 按**稳定度降序**（易变的靠后）构造动态内容：

1. 【历史印象】——历史压缩产生的摘要（只在压缩后变）
2. 可用表情目录（只在发送或标注表情后变）
3. 【记忆】——仅与本轮可见成员相关的长期印象（半变：取决于本轮谁在说话）
4. 【过去状态】——窗口之外、独立历史策略允许读取的原始历史（每轮都变）
5. 【此刻状态】（分钟级）
6. 【当前时间】（秒级）
7. 【本次唤醒】——当前新消息窗口的未消费批次（每条消息都变）
8. 【本轮决策】（固定，**刻意留在末尾**）

**为什么是这个顺序**（2026-10-10 调整，2026-10-10 之前是"当前时间在最前、记忆与表情目录在唤醒之后"）：
这套 bot 走 OpenAI 兼容端点，各家都是**自动前缀缓存**，命中判据是从第 0 个 token 开始的
**最长公共前缀**——第一处不同点之后全部作废。所以段落的先后直接决定命中率，**不要按"读起来顺"重排**：
把秒级的【当前时间】放在第一行，就让整段用户提示词没有任何可命中的前缀；而摘要/表情目录/记忆
这三段本来慢变，却被排在每条消息都在变的【本次唤醒】之后。

- 【本轮决策】固定不变、本可以搬到最前吃进缓存，**刻意不搬**：紧贴生成位置的"提醒"对行为有用，
  而它只有一百来字。
- 与统一字符预算**无关**：`joinPromptWithinBudget` 按 priority 删段落、用 `optionalParts.index` 回指，
  与段落位置无关 —— 搬家不改变"超限时先收缩谁"。
- 守护在 `tests/t-digest.mjs` 第 E 段：它断言的就是这个顺序（谁按可读性重排回去，那里会红）。

避免重复的规则：

- 当前窗口全部从【过去状态】排除。
- 已进入【历史印象】的摘要条目从【过去状态】排除。
- 成员记忆只按 `triggerEntries + 实际注入的 past.messages` 选人。
- 成员备注直接替换消息显示名，不再额外生成重复段落。
- 参与度与工具细则只保留一个权威注入位置。

**system prompt 整段是稳定前缀**（人设/安全/工具协议/场景规则、收藏夹名单都只随配置变），
位置又在第 0 条消息上，所以它已经是缓存最优的 —— 报告缓存命中率时先确认这一点没被破坏
（例如别把会话相关的动态内容塞进 system prompt）。

- 当前窗口全部从【过去状态】排除。
- 已进入【历史印象】的摘要条目从【过去状态】排除。
- 成员记忆只按 `triggerEntries + 实际注入的 past.messages` 选人。
- 成员备注直接替换消息显示名，不再额外生成重复段落。
- 参与度与工具细则只保留一个权威注入位置。

转写结果在【本次唤醒】与【过去状态】两处用同一段渲染：`[时间] 【转写结果】<正文>`，正文被截断时前缀里写明原文全长；**失败条目换成 `[时间] 【转写失败】<正文>`**（正文是 "视频转写失败：<原因>"，与漫画/出图同形——标签不分开，模型就分不出"该转述内容"还是"该交代一句"）。它不参与触发标签判定——不因为正文里有“吗/呢”被标成「提问」，也不因为正文提到 bot 名字被标成「提到我」（转写正文里出现这两样是常事）；它也不带 `#id` 前缀（`mid` 为 `null`，没有可引用的消息号）。失败条目的 `chars` 记 `0`、`truncated` 恒为 `false`：它是"压根没有原文"，不是"原文 0 字"。

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

- **模型自主路径**（工具调用）：工具**自己不发任何消息**，入队成功就立刻返回。要不要先说一句（例如「我先看看」）由模型在这一次运行里自己决定——想说就接着调发送类工具，不想说就直接结束。这不会影响会话收尾：工具不写 `session.sent`、不发 `session-update`，所以"这轮没发消息"如实反映为 `noreply`，而不是被代发撑成 `done`。结果**不再由队列直接贴进群**——后台把它写成一条条目（成功【转写结果】、失败【转写失败】）并触发另一次运行，由模型结合当时的群聊记录决定说什么。所以转写的最终产出既不属于本轮，也不由队列替模型发言。代价是模型选择沉默时群里在结果到达前没有任何提示；这是刻意取舍（定死一句回执会和模型自己的发言重复）。
- **`/转写` 命令路径**：仍由后台队列直接投递（截断段 + 超长时的全文文件），确定性、不经模型、零 LLM 成本，行为逐字节不变（包括失败时那句「转写失败（阶段）：原因」——这条路上没有模型可交代，所以 `#fail` 里的 `mode` 闸门就是它沉默与否的唯一开关）。

队列侧的投递按 `mode` 分流（`standalone` / `assisted`），回流端口是注入的最小结构化端口，与 `jmcomic` 的 `store` 端口同款。**成功与失败都走这条分流**（2026-10-10 统一）：assisted 失败时端口收到 `status:'failed'`、`text` 为空串、`reason` 带原因，队列一个字都不贴（代发的后果实测过：消息写进 `session.sent`、这一轮按"发过消息"收尾成 `done`，模型以为群里已经知道了，于是不再开口）。回流端口是**同一条退路规则**的两处落点：没人接（缺端口 / 端口抛错）时**成功与失败都退回 standalone 行为**，否则群友什么都等不到。端口抛错**必须自带 try/catch 且绝不外抛**：`#drain` 把异常一律当成“转写失败”，那会同时把任务记成 `failed` 并往群里发一条莫须有的「转写失败」，而结果其实已经拿到了。结局是**两态**（`sent`/`failed`）而不是出图/漫画的三态，判据与取舍见 `chat/types.ts` 的 `TranscriptStatus`：转写的交付物是文本、开口的是模型，`unsent` 在这条路上无处可记。

### 8.1 斜杠命令与图像生成（Qwen-Image）

**所有命令的判定、解析调用、入队与即时回执都在 `src/web/onebot/commands.ts` 一处**（2026-10-16 从 `slash-commands.ts` 改名 —— 命令不再只有 `/` 一族：主流程三条是 `/转写`、`/画 <描述>`、`/漫画 <ID>`，扩展那族以 `.` 开头，另有永远在的 `/能力` 管装载）。放一处的原因是那条判据同时决定三件事——要不要并入引用消息里的附件、要不要落成已读历史（`wakeEligible:false`）、这条消息归谁处理——写在两处时漂移不会有任何报错，表现只有"命令没被认出来、消息进了 LLM"或"同一条消息被处理两次"。`ingest.ts` 只用**同一个** `isCommandEntry()` 做前两项决定（它多收一个会话参数，因为命令表按会话取），用完 `await commands.handleCommandEntry(...)` 收口。命令自己的语法（用法提示、参数解析）仍留在各自的领域模块：`media/transcription/commands.ts`、`media/image-gen/commands.ts`、`media/jmcomic/commands.ts` 的 `parseJmcomicCommand`、扩展的 `extra/<x>/impl.ts`。加一条内置命令 = 在 `BUILTIN_COMMANDS` 表里**加一行**（存函数引用、按数组顺序匹配，与装配清单同形，**不是**按键分发的注册表）。**命令层还要带上发起者 QQ**（`senderId`）：`/漫画` 的去重键是**请求者 + 漫画 ID**，少了它全群共用一个额度，表现是"甲刚下过、乙再下就被判成重复提交"。

**`commandText` 上还有一处只属于 ingest 的规范化：掐掉开头那串「@机器人自己」的段**（`stripLeadingSelfMentions`，2026-10-19 加）。群友很自然的输入是「先 @ 机器人、再敲命令」，而协议端把 @ 段渲染成紧贴的 `@名字`（`segmentsToText` 的 `out.join('')`），于是拿到的文本是 `@Zarathustra /转写` —— 命令词不在开头，`startsWithWord` 认不出来。**实测（真机）**：`@bot /能力` 被当成普通消息进了 LLM，群里收到一句模型自己编的「？又发什么暗号」，白多花一次模型调用（`wakeEligible` 也跟着变 true），而**不报任何错**。四条边界：① **只掐指向机器人自己的那一串**（比对 `onebot.selfId`），不是"任何开头的 @" —— `@小明 /画 猫` 是在跟别人说话，顺手把命令执行掉是误伤；② `selfId` 为空（还没握手）时**原样不掐**，退回改动前的行为而不是猜；③ **引用段在协议端报文里排在 @ 之前**（`[reply, at, text]`），要先跳过它，否则"引用一条消息 + @机器人 + 敲命令"这条最常见的形态一个都掐不掉；④ 掐掉的只是**命令判定用的那一份**，进存档的 `text` 仍带着 @（那是群友真正说的话）—— 与「合并转发展开只替换 `text`」是同一条分工的另一个方向。扩展的 `intercept` 读的也是这份文本，所以 `@bot 3d6` 同样能被骰子拦下。

**⚠️ 掐掉的那串 @ 不能顺手丢掉**：`CommandInput.mentionedSelf` 就是"这条消息有没有 @ 机器人自己"，由 ingest 从**原始段**算出来一并递下去（`text` 里已经看不出 @ 过）。它今天只有一个用处 —— **群里的斜杠命令要先 @ 机器人**（2026-10-19，用户要求）：主流程那四条（`/能力` `/转写` `/画` `/漫画`）**一律要**，扩展自己的命令由 `ExtraCommandSpec.requiresMention` 逐个声明（缺省 `true`；`clock` 要、`trpg` 那族不要）。判据看**会话类型 + `mentionedSelf`**，不是"没有 @ 就拒绝"（私聊根本没有 @ 段，那样会把私聊堵死）。**没 @ 时 `matchesCommand` 直接返回 `false` —— 压根不是命令**（用户选的"完全不管"），消息照常落档、照常参与响应判定，只是不进命令层。⚠️ 回执里**不把 `@我` 拼进命令行**：`@我 /能力 加载 x` 里的 `@我` 只是示意，真敲时用户点的是 QQ 的 @ 选人 —— 把它当文本打进去，命令词就不在开头、**静默失效**，那正是"教用户敲一条敲不动的命令"。命令照旧只印 `/能力 加载 <id>`，@ 的要求写成单独一句说明。

**同一轮还改了装载的入口**：敲扩展自己的命令**不再**把它拉起来（`#runCommand` 的 `autoLoad` 参数连同那条装载分支一起删了）。未加载时命令照旧认得出（消息落成已读、不惊动模型），但只回一句「先 /能力 加载」。装载的唯一入口因此只剩 `/能力 加载 <id>` 与配置 `extras.override` 的启动播种。**认得出但不装载是有意的**：命令若干脆不在表里，那条消息会静默地进 LLM —— 群里什么都看不到，比一句可执行的下一步难查得多。

**顺带纠正一句写在设置页上的错话**：`extras.enabled` **保存后立即生效，不用重启**（`isExtraEnabled` 在每个判据点上现读）。真正要重启的只有 `extras.override`。

### 8.2 异步任务的共同骨架

转写 / 漫画 / 出图是**同一条流程的三份实现**（工具或命令 → 立刻回执 → 单并发队列干活 → 队列直接交付 → 回流一条未读条目唤醒模型）。四件共用产物与四条边界写在 `AGENTS.md` 的「异步任务的共同骨架」那一节，这里只记落点：`media/task-queue.ts`（队列机械 + 单并发 + 关停语义）、`media/task-error.ts`（错误类型）、`chat/store.ts` 的 `appendAsyncResult` + `web/app.ts` 的 `deliverAsyncResult`（回流落库与入窗）、`agent/tools/async-task.ts`（工具外壳）。**计时器不进核心**（owner 语义要求它落在各能力文件里）、**每个能力的 `execute` 自己干完整件事**、**闸门在 `enqueue` 里两条入口共用**、**失败一律回流给模型**（只有"确定没人接"时才退回贴一句；转写 2026-10-10 补齐了这半条，三条能力现在一个形状）。

`generate_image` 与 `/画 <描述>` 走同一条队列（`src/media/image-gen/`），形状照搬转写那条，三处按"交付物是文件"改了：

- **两条路径都只入队**。工具不代模型发言（与 `transcribe_video` / `reverse_image_source` 同一契约），命令路径回一句「在画了，稍等」。**两条入口都走 `assisted`**（`generate_image` 与 `/画` 做的是同一件事，图发出去之后总得有人知道 —— 用户明确要求"两边行为统一"，代价是每条 `/画` 多一次 LLM 运行）；`mode` 的**默认值也是 `assisted`**，静默那条路（`standalone`）要显式写，今天只有测试会写它。
- **图片由队列自己发进群**（`SendQueue.sendImage`，因此受限频、也留 `我：[图片]` 的存档），发完再按 `mode` 决定要不要回流——`standalone`（命令）不回流，`assisted`（工具）回流成一条 `image-result` 条目。
- **成功与失败都走这条回流通道**（`#reportFailure`）。失败不再由队列代说一句「画图失败」：那条路的模型只调了一次工具就结束本轮，随后那次运行才是它开口的地方，代说会让它以为"群里已经说过了"而不再开口（与"工具代模型发言"是同一个病）。条目三态分开——【图片生成结果】/【图片发送失败】（画好了没发出去，消息甚至可能已经在群里）/【图片生成失败】（压根没画出来），`prompt-catalog` 里三种结局各自要做什么也分开写了（补一句 / 交代一句 / **不要自动重画**）。只有"确定没人接"时才退回贴一句：`/画` 命令路径（没有模型）、assisted 没装回流端口、回流端口抛错。
- **临时文件的生命周期归队列**，不归 `runTask`：转写的 `runTask` 返回文本，可以在自己的 `finally` 里删目录；这里返回的是文件，它必须活到投递之后，所以工作目录由 `#drain` 建、投递完删。

另外三处与转写**刻意不同**，都有理由：

1. **成本闸门在队列的 `enqueue` 里，两条入口共用**（转写 2026-10-10 也挪到了同一处，`/转写` 因此**也受额度约束**——这是有意的行为变更，与 `/画` 对齐）。出图按张计费、而 `/画` 是群里任何人都能敲的，命令路径不设闸门等于开一个可被刷的开支口子。放进 `enqueue` 也顺手避免了"工具先扣一次、队列再扣一次"的双记。
2. **`n` 固定为 1**（接口层仍按数组处理）。额度按"一次调用 = 一张图"记账最直观，想画三张就调三次、占三个额度。
3. **提示词分两层**：模型写"画什么"（工具 description 里要求写成给画图模型看的成稿描述），`imageGen.stylePrompt` 由后端拼在描述之后管"怎么画"，两层在 `client.ts` 的 `buildImageGenRequest()` 这一个纯函数里合并（命令路径与工具路径因此逐字节相同，有断言钉着）。

还有两条接口层的坑写在代码里：`size` 的分隔符是**星号**（OpenAI 兼容协议用字母 x，配置层会把 x 归一成星号），以及**失败可能是 HTTP 200**——接口把错误放在响应体的 `code` 里（DashScope 协议在顶层、OpenAI 兼容嵌在 `error.code`），只看状态码会把"API Key 无效"读成成功，然后卡在"没有返回图片"上。

失败路径还有一条硬要求：**链路上不许有裸异常穿到 `#drain` 的兜底文案**。兜底那条会把阶段固定成 `generating`、把那句话固定成"画图失败，稍后再试"，于是"写不进临时文件"和"协议端拒收这张图"会被说成同一句谁也排查不了的话（**真机实测**撞到过：群里那句是「画图失败（画图）：画图失败，稍后再试」）。现在写盘归 `downloading`（带 errno）、`sender.sendImage` 的失败归 `uploading`，未分类异常把码写进群里那句、把洗过的原文（去 URL 与本机路径）写进日志。顺带照 stickers 的先例加了一步兜底：协议端**明确拒绝**本机路径（`retcode=`）时，用接口给的结果图链接重发一次；超时那类不重发（说不清消息到底发出去没有）。

还有一条是**真机（2026-10-10）逼出来的**：图片段此前继承 `OneBotClient.call()` 的 15 秒默认超时，而它要协议端先读本机文件、再传到 QQ 图床 —— 一台 VPS 上稳定超 15 秒，于是每次出图都死在最后一步，**而协议端其实正在传**：群里先收到「画图失败」，紧接着那张图又到了。修法是 `SEGMENT_UPLOAD_TIMEOUT_MS = 120s`（`sendImage` 与 `sendSticker` 共用，与转写 `upload_group_file` 的口径一致），外加一条话术规则：**上传阶段不说"画图失败"**（图确实画好了，且消息可能已经在群里），改用「图已经画好了，但没能发到群里：…」。超时被单独归成 `SEND_TIMEOUT`（`AbortSignal.timeout()` 抛的 `DOMException` 其 `name` 就是 `TimeoutError`）。

同一次测试还暴露了第二个症状：**出图的发送不该占每会话串行链**。`SendQueue.sendImage` 走的是与 `sendTextBatch` 同一条 chain，而上传一旦慢到分钟级，**正在进行的对话就整体堵住**——模型收尾那一步正是 `send_message`，它排在链上等上传，于是工具调用不返回、本轮运行不结束、面板上那条会话一直显示"运行中"。现在 `sendImage` 是链外实现（限频与 `我：[图片]` 的存档照旧），与转写全文文件、漫画 PDF 那条"大上传直接 `onebot.call`"的口径一致。代价是图片可能与文本交错，换来的是一条卡住的上传不再冻结会话；**sticker 不在豁免之列**（它是运行内动作，模型本来就在等它的结果，且是本地小文件）。

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

### 9.1 主流程命令的执行记录（2026-10-20）

命令走**确定性快路径**（不进模型），所以它原本在「会话」页上是空的 —— 用户敲了 `/转写`，
存档页看得到、会话页什么都没有。现在四条主流程命令（`/转写` `/画` `/漫画` `/能力`）各留一条
`trigger: 'command'` 的会话记录：

- **判据是 `CommandEntry.recordSession`**（内置四条 `true`，扩展命令 `false`）：扩展命令不记，
  因为 `.r 3d6` 那种一局几百条会把真会话挤出 `keepSessionFiles` 的额度。
- **生命周期**：`runCommand` 进入时 `beginCommand`（记 `command` 与**用户敲的原文**）→ 命令体用
  `stage(name, detail)` 上报每一步 → 回执发出后 `finishCommand`。**回执发出即闭合，不跟后台队列**：
  转写/出图/漫画的活儿由各自的异步结果回流承载，它们完成时会另行触发一轮运行（那是另一条记录）。
- **三种结局**：发了回执 `done` / 不吭声 `noreply` / 抛错（错误文案已发进群）`error`。
- **两个必须的例外**：`#persist` **不累加 `runs`**（命令没有模型调用，否则用量页的"今日运行次数"
  虚高）；`finish()` **不触发 `onFinish`**（那是扩展的 `runEnded`，跑团拿它判"DM 整轮沉默"，
  命令记录混进去只会制造幽灵触发）。
- 面板：列表用 `kind: 'command'` 区分"运行"与"命令"（不显示 token/轮数），详情页渲染 `stages`
  时间线与回执，JSON 模式带 `command` / `commandText` / `stages`。守护是 `tests/t-command-record.mjs`。

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
npm run dist:desktop    # 打包绿色版桌面应用（scripts/build-desktop.mjs）
```

**桌面版打包**（`scripts/build-desktop.mjs`，零依赖，只在本平台打包本平台的运行时）产出的是"解压即用"的绿色目录，不是安装包：`release/qq-agent-<版本>-<平台>-<架构>/` 里是 Electron 运行时 + `resources/app/`（我们的代码）。四条设计边界写在该脚本头部，其中三条是硬约束：**不打 asar**（`python-tools/*.py` 要 spawn、SnowLuma 要执行、`ui/` 与 `data/` 必须是真文件）、**白名单拷贝**（只有点名的目录与生产依赖闭包进包，`data/`、日志、`.env` 天然进不来）、**不改 `electron/main.js`**（它的"数据目录 = exe 旁边"正是绿色版要的形状，而 `before-quit` 那段被 `t-lifecycle.mjs` 按函数体钉着）。脚本末尾自带校验：必需文件清单、`src/**/*.ts` ⇄ `dist/**/*.js` 对账、敏感文件扫描，以及用产物里那份 `dist/` 真跑一遍 `createApp → start → stop`（数据目录指向临时目录）——打包是唯一会让"某个模块没被搬进包"这种错误走到用户面前的出口，所以校验不是可选项。

`--with-python` 额外把一份最小 Python 运行时放进 `resources/app/python-runtime/`（默认从 python-build-standalone 取当前平台的 `install_only_stripped`，剪掉 test/tkinter/tcl 这类与两个工具无关的东西，再把 `python-tools/requirements.txt` 装进那一份里；装不上只警告，使用说明里给了补装命令）。它由**同一条解析链**接管（链首的 `bundled` 层，见 §2），所以"这一份压过用户填的路径"与"没带内置运行时就用用户的"这两件事都不需要在打包脚本里再实现一遍 —— 判据只有一处落点。打包侧另有三条实测坑记在脚本注释里：`--skip-build` 时产物里是**旧 dist**（内置层看着"不生效"，其实是源码没编译）、GNU tar 会把 `C:\…` 当成远程主机（解压必须只给它相对文件名）、内置运行时的 `*.pyc` **不是垃圾**（正好对应我们带的那版解释器，留着首次 import 更快，所以敏感文件扫描对 `python-runtime/` 下的 `.pyc` 网开一面）。

测试通过 `tests/lib/src.mjs` 加载 `dist/`，确保验证的是实际运行产物。新增 `t-*.mjs` 必须在 `tests/run.mjs` 的 ASSERT 或 DIAG 中显式归类，否则 runner 直接失败。runner 另有一条**清单自身诚实性**的扫描：每个 ASSERT 套件里必须存在一个参数不是字面量 `0` 的 `process.exit(` 调用。因为判定只看子进程退出码，而 `checker().done()` 只返回布尔值、自己从不退出——一句裸 `done();` 会让整个套件**永远退 0**，断言红成一片而 runner 照样打 ✅（实测曾如此：`t-image-source.mjs` 一次 30 通过 / 5 失败的运行被报成全绿）。这是文本扫描，证明不了那条 `exit` 在运行期真会被走到；它只堵"压根没有非零退出路径"这一种形态。DIAG 脚本按定义永远退 0，不在此列。

当前重点回归包括动态窗口语义、摘要去重、当前窗口与独立历史分离、统一预算保护本轮消息、读图结果回填、`memory_query` 定向查询、主动冒泡的唤醒语义（`t-window.mjs` 第 15 段），以及 Web/UI 模块接线。

长期任务与事件相关改动另有一组专项套件：`t-events.mjs`（事件名/载荷/注入类型/`session-update` 通道）、`t-sse-project.mjs`（SSE 帧逐字节）、`t-panel-wiring.mjs`（UI 订阅名跨边界 + 设置页接线：Python 工具那段的 id 解析、保存分支必须写 `patch.python.path` 且**兜底仍是空串**、两个按钮必须先 `saveConfig` 再打探测端点）、`t-ports.mjs`（跨模块端口与 `implements`；另扫 `tests/` 里每个 `new Orchestrator({…})` 是否都传了 `emit`——`.mjs` 不受 `tsc` 管，这条只能文本扫）、`t-tasks.mjs`（`LONG_TERM_TASKS` 描述符与 `conformance` 一致性）、`t-timers.mjs`（计时器句柄：起没起、停没停、有没有被"清掉又没重建"、待触发的那一次取消不取消得掉）、`t-transcription.mjs`（视频命令、SSRF、单并发状态机、凭证脱敏、**失败回流与两态条目**：`status:'failed'` 进端口 + standalone 失败照旧贴文案 + 端口抛错/缺端口时退回贴文本且全文文件不重发）、`t-jmcomic.mjs`（漫画队列按"请求者 QQ + 漫画 ID"去重：完成后记录**留在** `jobs` 里而不是即时摘除，否则"同一用户短时间内不能重复提交"对**下载成功过**的漫画失效；窗口的计时起点是上传完成时刻而非创建时刻；2026-09-29 起还守 Python 解释器的解析优先级（`python.path` > `QQ_AGENT_PYTHON` > 随包内置运行时 > `conda run`）、每一层报出的 `source`、conda 环境可配置的三种形态（环境名 `-n` / 环境目录 `-p` / 留空不带选择器，见第 1b-3 段）、探测与自检模块（假 `spawn` 注入：非 JSON 输出、非零退出、超时 kill、输出截断、`--self-check` 确实进了 argv），以及旧配置迁移——`jmcomic.pythonPath` 搬进 `python.path` 后旧键必须消失，且保存一次**不会被写回**，因为 `updateConfig` 的 `deepMerge` 只加键不删键，漏掉那句 `delete` 的话内存里看着对、盘上却永远留着；安全网也换了形态：早先靠 `JMCOMIC_PYTHON` 指一个不存在的程序，现在把 `python.path` 写进夹具 `config.json`（`config` 优先级最高，不再依赖"某台机器上恰好有这个变量"），并另配一条正向断言证明安全网真的生效）、`t-jmcomic-callback.mjs`（结果帧即刻结算，不依赖 Python `close`；上传完成 sink 回流 `jmcomic-result`，最低档位仍唤醒）、`t-jmcomic-upload.mjs`（上传超时/断连与重启遗留的 `uploading` 统一进入 `upload_uncertain`：群文件按文件名和大小查群文件列表，私聊按文件名和大小查好友消息历史，核验期间不再次调用非幂等的上传动作）、`t-lifecycle.mjs`（注册层执行侧：退出路径的信号接线与幂等、装配清单 ⇄ 描述符表对账、`app.start()/stop()` 的接线与逆序、无按键分发；S11d 起还守"被删的死代码与空转事件不许长回来"——`core/config.ts` 无任何计时器、三个文件再无 `emit`、`EventMap` 与 `vision-scan` 在 `src/` 绝迹，同时**正向**钉住 `routes/providers.ts` 里那个活着的 `visionScan` 局部对象；S11e 起还守 electron 的退出等待——`before-quit` 的**函数体**里必须有 `preventDefault(`、排在它前面的 `stopping` 守卫、promise 链上的 `.catch(`，以及 `.finally` 里那次 `app.quit()`，否则桌面端要么不退要么死循环）。

每日热搜另有 `t-hot-search.mjs`，覆盖 ApiZero 匿名/Bearer 请求、429/5xx/超时重试、字段缺失与空榜、标题去重、按条目分页、白名单目标、重启后当天不重复以及手动/定时互斥。

命令分发层另有 `t-commands.mjs`（50 条，2026-10-16 从 `t-slash-commands.mjs` 改名 —— 命令不再只有 `/` 一族）：认命令的边界（`/画xx`、`/转写啦`、`/漫画123`、展开后的转发正文都不算）、`/转写[视频]` 那条分支、每条命令的回执与"不入队"的边界（`/画` 没写描述时只回用法提示）、失败时把**真实原因**原样发回群里（解析层抛的本来就是中文用户文案）、**`/漫画` 要把请求者 QQ 递下去**（去重键是"请求者 + 漫画 ID"，漏了会退化成全群共用一个额度）、`/能力` 的用法与失败话术、**按会话取命令表**（接管会话只看得到接管者的命令 + 永远在的 `/能力`）、扩展命令走同一只 `runCommand` 外壳、扩展遮蔽不了内置，以及一条源级断言：**`ingest.ts` 里不许再出现命令正则**（判据只有一份，漂移时不会有任何报错）。

图像生成另有 `t-image-gen.mjs`（115 条），起一个**本地假百炼端点**（`baseUrl` 是管理员配置、不是用户输入，所以指向 127.0.0.1 是正常用法；与「请求结构」那条同一条边界），覆盖：配置归一化与钳制（含 `x` → `*`、整条 endpoint 粘进来、`DASHSCOPE_API_KEY` 回退）、请求体形状（T2I 只有 `{text}`、I2I 参考图在前、`negative_prompt` **只在 3.0 系列出现**）、**两层提示词**（风格层留空时与模型给的描述逐字相同——这条对照必须有，否则"永远拼一层空串"看不出来）、错误映射（HTTP 400、**HTTP 200 但响应体带 `code`**、无图 URL、响应体超限、超时、abort 各一条）、队列（单并发、`stop()` 取消排队中的那一个并 abort 在途、视图不含 prompt、临时文件投递后即删）、成本闸门（每会话与全局两本账、被拒的不占额度、**两条入口共用**）、`/画` 解析与参考图定位、工具侧（不代发消息、不把任务号写进结果、messageId 取不到图时列出实际附件种类），以及端到端那一条：**命令路径与工具路径拼出来的请求体逐字节相同**（两层提示词只有一份实现）。

搜图另有 `t-image-source.mjs`，七段：① 通用 provider 的薄适配——参数按**位次**原样转发（含 `engineOptions` 里的 `apiKey`）、错误码原样透传（`RATE_LIMIT` / `QUOTA_EXHAUSTED` / `TIMEOUT`）、`test()` 走 `ping()` 且**从不抛**（ping 返回 `false` 或直接抛异常都收敛成 `false`）；② **服务层的分发第一次有了直接断言**——用注入的假 provider（`PicImageSearchPort` 是编译期端口，测试用对象字面量顶替，没有 `instanceof`）实测 `intent` 决定的先后顺序（`anime` 先 `trace.moe`、`manga` / `illustration` 先 `saucenao`、**`unknown` 直接走一般向兜底**）、专属引擎答不上（低于门槛 / 抛错 / 超时）之后**兜底真的被调用**、每一发的超时被夹住给后面留位置（预算不够则跳过并记 `NO_BUDGET`、一次调用都不发）、逐引擎的 `timeoutMs`/`maxResults`/`mime`、`similarity < minSimilarity` 过滤（**无置信度的结果只对没有门槛的引擎算命中**——`baidu` 那条被采用，而带门槛的引擎照样丢弃它，两条互为对照）、关闭或空 `apiKey` 的引擎被跳过，以及 `failures` 标签仍是 `trace:` / `sauce:` / `baidu:`（这条字符串会进模型可见文本）。**`unknown` 这条是补上来的缺口**：它此前没有任何断言，而模型判不出类型时填的就是它 —— 于是"当初与 `anime` 同序（理由只是'与改动前一致'）"这个缺陷在四套件全绿的情况下活了一整轮；夹具让 trace.moe 也自称命中（0.99 > 它自己的门槛 0.87）才可判别（顺序错则 trace 的假命中赢并拦住兜底）。为了让 `loadSafeImage` 真的下载到字节，这一段用**回环 HTTP 服务**（`security.allowPrivateImageHosts` 临时打开，跑完复原——先例是 `t-sticker.mjs`），因此它必须排在"被 SSRF 挡下"那条断言**之后**；③ 同一段窗口内另有**缓存**用例（共用同一个 service 实例才有缓存可言）：同引擎同图第二次不发远端调用、**换 intent 不会被另一个引擎的缓存顶替**（旧实现按图片 hash 缓存整轮结论，这条在旧实现下会红）、失败不进缓存、`maxResults` 与引擎参数指纹都进键；④ `formatImageSourceResult` 的输出形状（此前一条断言都没有）——集数与时间点彼此独立、`time === 0` 是合法值、缺失字段兜底而不是印出 `undefined`、**没有置信度时整行让位**（判据是"字段在不在"，`pct(undefined)` 印出来的是 `NaN%`）；另有两条文本断言钉住 `SearchIntent` 的取值域在**三处**（`types.ts` 的联合类型、工具 schema 的 `enum`、`prompt-catalog` 的 intent 描述）逐字一致 —— 少一处模型就永远填不出那一档，且没有任何报错；⑤ 文本断言钉住原生 fetch 已绝迹：`src/media/image-source/` 下不再出现 `saucenao.com` / `api.trace.moe` / `TraceMoeProvider` / `SauceNaoProvider` / `fetchImpl`，两个按引擎的 provider 文件不存在，服务层源码里不出现 `anime_trace`（它是 trace.moe 的别名，不许加成第三个引擎）；⑥ 引擎名是**跨进程的手工镜像**：worker 的 `ENGINE_CLASS_CANDIDATES` 键集合 ⇄ Node 的 `PIC_IMAGE_SEARCH_ENGINES` 逐字比对（`.py` 不进 `tsc`，没有别的套件会读它），另加 `MEASURED_CLASS_NAMES`（2026-09-29 实测到的 7 个类名）钉住它们在候选链里**够得着**；⑦（源码段 ⑩）扫 `python-tools/pic_image_search_worker.py` 的**源码文本**，钉住第三次实测抓到的那两个真机 bug 的修法——时间取自大写 `From`、取不到时**不写** `time` 键（写 0 会让 formatter 的"字段在不在"判据失效）、标题按 `title_chinese` → `title_native` → `title_romaji` 取实测平铺字段、`origin` 当标题的兜底不存在。**两条射程不同，别当同一条用**：键集合那条看不见候选类名的拼写（把 `BaiDu` 改回 `Baidu`，实测该套件全绿），实测名那条挡不住"库改名"——它只挡得住"把已经实测对的名字又改回去"。⑦ 那段还有一条通用教训：**取函数体时只按行丢了 `#` 注释，docstring 不是注释、丢不掉**，所以断言必须**锚定到具体调用**（`_pick(raw_item, "title_chinese")`）而不是裸字段名——初版写的是 `/title_chinese[\s\S]*title_native/`，把代码里那次调用删掉后它**照样绿**（名字原样躺在 docstring 里），是证伪探针撞出来的假绿。

跑团（TRPG）的规则引擎是**纯函数**，住在 `src/extra/trpg/rules/`（`dice.ts` 骰子表达式、`percentile.ts` 奖惩骰、`check.ts` 检定等级表、`condition.ts` 条件表达式求值、`chargen.ts` 属性生成与派生值、`combat.ts` 先攻排序与指针推进、`economy.ts` 行动经济账本的纯逻辑、`rule-set.ts` 规则扩展的编译与穷举校验）。它刻意与对话链无关：掷骰是跑团里唯一"错了会毁掉整局信任"的东西，所以它先独立稳住、再谈接入。**这一层的纯度是机检的**（`scripts/check-layers.mjs`：相对 import 不许离开该目录、非相对 import 一律禁止，连 `node:` 都不许），判据是"它必须能脱离平台独立测试"——所以真熵源住在 `../entropy.ts`、由调用方**注入**。**⚠️ 伤害刻意不在这一层**（留在 `tools/character.ts`）：扣血要碰卡上的 `hp` / `hpMax` 上限与"倒下"的判定，那是领域模型与存储的活；判据同 `chargen` —— **掷法/排序法属于规则书（数据），"扣多少、扣到哪算倒下"属于代码**。

四条设计约束：**可复现**（`DiceRng` 是**必填**参数，没有默认值——默认值会让"忘了注入"变成静默的，而症状恰好是"掷骰可被预测"；生产用 `crypto.randomInt`）、**可复核**（`DiceRoll.dice` 保留**每一颗**骰面、**含被 `kh`/`kl` 丢掉的**，`detail` 给出算式明细；只给一个总数的话玩家无从验算）、**失败可解释**（`DiceError(code, 中文文案)`，工具会把 `message` 原样回给模型，所以文案里必须带"支持的形态 + 该怎么做"）、**有界**（单组颗数/面数、**整个表达式**的总颗数、乘方规模三层；`^` 的规模在**计算之前**估算，否则 `9^9^9` 会耗尽内存）。

文法采用 [OneDice 标准](https://github.com/OlivOS-Team/onedice)的子集，用**递归下降**而不是正则（正则处理不了 `(2d6+3)*2`，也给不出出错位置）：`AdB`、`( )`、`+ - * / ^`、`kh`/`kl`（`k`/`q` 是等价简写，与 DiceRobot 只用 `q` 有意不同 —— 本模块不做多元组，`kl` 没有冲突语义）、`b`/`p` 奖惩骰（固定 d100）、多组相加。不做骰池(a)/双重十字(c)/命运骰(f)，遇到会**明确说"不支持"**而不是一句含糊的语法错。⚠️ **奖惩骰必须先组合成十位+个位的结果再比大小**：个位 0 配十位 {0,9} 的候选是 100 与 90，比十位数字会取到 0 反而得出 100，**大成功从此永远掷不出来**。

检定这一层是**有序等级表**而不是单个函数：`CheckRule.levels` 的顺序即优先级（取首个匹配），**最后一条必须无条件匹配**。2026-10-16 起**表本身是数据**（`data/trpg/rules/<id>.json`，管理员可加可改）：`check.ts` 只做三件纯事 —— 把数据**编译**成闭包（`compileRule`，条件表达式由 `rules/condition.ts` 求值：手写 tokenizer + 递归下降，白名单之外的一切（函数调用、属性访问、下标、赋值、分号、注释、字符串）**一律拒绝并指出位置**，**绝不用 `eval` / `new Function`** —— 规则文件是用户内容；七个变量 `total / target / count / faces / roll / max / min`，`/` 是真除法、`//` 是向下取整，除零抛错而不是给个 `Infinity`）、**穷举校验**（`verifyRule`：报"某组取值一个等级都匹配不上"与"某个等级永远匹配不到"两类 —— 两者都是不跑就发现不了、跑了也要等玩家恰好掷出那个点数才暴露的；取样域是写明的常量，规则用 `requires` 声明"不管这个形状"时那个取样点被跳过）、按顺序**取档**。内置 `generic`（掷高为佳，四档，等价于原来的 `defaultJudge`）与 `coc7`（六级）退成**种子数据**，由 `rule-store.ts` 懒补齐（首次用到规则时才写盘，已存在的一律不动；读取按 **mtime** 缓存，所以改了文件不重启也生效）。**表的选择仍是显式参数**（`campaign.rule`，**不再是 schema 里的 `enum`** —— 磁盘上有什么不是静态数据能表达的）。`coc7` 的 `requires` 还留着一个前提：选了它却掷 `3d6` 会**明确拒绝**，而不是给出一个"看起来正常"的错误档位（静默算错是这一层最坏的失败模式）。坏表**拒绝**，只有"引用的表不存在"才回落 `generic`，且那句话会进回执。

**规则文件里另有三个"规则书字段"**，判据同形（**"该拿什么"是数据，"怎么算"是代码**），且都在**编译期**被校验（拼错的表现本来是"群友点一下命令报个看不懂的语法错"）：`dice` 说技能检定掷什么骰（`.ra` / `.rh` 拿它去掷；缺省 `1d100`；写死 d100 等于让所有用 d20 的团永远用不了 `.ra`），`initiative` 说排先攻按哪个属性（缺省 `DEX`），`chargen.attributes` 说每个属性怎么掷（`STR: '3d6*5'` 这样，`.pc roll` 逐个掷；**没有这一栏就没有属性生成这件事**，内置的 `generic` 因此没有它）。⚠️ `dice` 与 `requires` 是**两件事**：前者说"该掷什么"，后者说"接不接受"。

`t-trpg-rules.mjs`（289 条）逐面核对解析与求值、`kh`/`kl` 与 `k`/`q` 等价、多组/括号/四则/乘方、奖惩骰的 `combine` 两条边界、21 种非法输入的 `code` 与文案、200 组不变式（颗数 / 留下+丢掉 = 总数 / `total = Σkept + mod` / 面值落在 `[1, faces]`）、坏随机源（越界 / `NaN` / `Infinity`）被夹回合法区间、**穷举校验真的抓得住两类坏表**（漏兜底 / 顺序写反 —— 只报前一类的话有一条断言会红）、**条件表达式的白名单与拒绝路径**（函数调用、属性访问、下标、赋值、分号、注释、字符串一律拒，除零抛错）、**规则表存储**（懒补齐种子、坏表拒绝且照样列表、改了文件不重启也生效 —— 那是设置页那句承诺的唯一凭据）、**属性生成与派生值**（DB 表每一档的两个端点、`missing` 不短路）、**先攻排序与指针推进**（按 `initiative` 降序、同值稳定、卡上没那个属性按 0 排后面、`clampTurn` / `advance` 的绕回）、**规则扩展的编译**（三种降级各自成 `narrate`、`MAX_MECHANICS` 超限那条**真的没进集合**、`describeMechanic` 是唯一一份人话），以及"同一个骰面在两种判定下结论相反"——那是"接缝真的存在"的判据。

读文档（`read_document` 工具 + `src/media/document/`）把一份文件读成文本交给模型，支持 **pdf / docx / txt / md**。四种格式**全走一个 Python worker**（`python-tools/document_extract.py`）：分"文本在 Node、PDF 在 Python"那种写法会让"这个后缀归谁"变成两份知识，它们必然漂移，而漂移的表现是**同一个文件改个后缀就从能读变成不能读**、且没有任何报错。但**只有 PDF 需要外部库**（`pypdf`）—— `.docx` 走标准库 `zipfile` + `xml.etree`，纯文本直接解码，所以没装 pypdf 时读 txt/md/docx 照常，只有 PDF 会明确回一句 `MISSING_PDF_LIB` + "怎么装"。四条边界：**字节走 stdin 不落临时文件**（于是没有"什么时候删""路径越界"这两件事，argv 里只有脚本与 `--max-chars`，不含任何用户内容）；**格式靠嗅探字节不靠后缀**（`%PDF-` → OLE2 → `PK` → 最后才是"NUL 判文本"，**顺序即语义**）；**编码阶梯 `utf-8 → gbk` 且用哪一档要如实报出去**（乱码判据同时要绝对量与占比，猜错的表现是通顺的乱码）；**这一层只管"字节 → 文本"**，取字节归调用方（上限与超时两条路完全不同）。工具两个入口（消息里的文件 / 网页直链）共用一个实现，`required` 因此为空、靠执行体的报错兜住"二选一"；`messageId` 那条**顺着 `reply.mid` 回退**（同 `get_message_images`）。它走 `webSearch` 那本调用额度。跑团的 `.trpg scenario` 现在也用它（剧本因此能直接传 pdf/docx），而**那一步不在 `scenario/parse.ts` 里** —— 那里留着收 `DocumentText` 的纯函数 `saveScenarioText`（在 `scenario/save.ts`），于是剧本那一层仍能在不启动解释器的前提下被测。抽出文本之后还有一步**格式匹配**（`parse.ts` 的 `isFormattedScenario`：开头有没有 frontmatter、整份能不能解析）——**格式本来就对的文件一次模型调用都不发**，不对的（PDF 模组、裸设定、frontmatter 里 JSON 写坏）**先走抽取管线**（P7-a，见下面「抽取管线」那一段），**管线没成才退回 `scenario/format.ts` 让模型整理一遍**（一次调用，只做格式整理）；两条路产出的正文都要**再过一遍 `parseScenario` 才落库**（后置条件是"返回的一定是规定格式"，不满足就如实报错，否则会变成"开局了但什么都没注入"）。那一次的指令在 `EXTRA_PROMPT_JOBS.trpg.formatScenario`（扩展的第三张提示词表：按扩展 id 索引，管的是扩展自己发起的一次模型调用），抽取管线的几次调用则在 `EXTRA_PROMPT_JOBS.trpg.extractChunk` / `.mergeExtract`。

跑团（TRPG）是 `src/extra/` 的**第一个功能完整的接管扩展**（`src/extra/trpg/`），也是"接管模式"这套东西存在的理由：它换掉一个会话的**整个人格**（DM 叙事 + 一套只管状态的工具）。它从 17 个平铺文件长到 30+ 之后按职责落进七个子目录（2026-10-16 重构），**根目录白名单是机检的**（`scripts/check-layers.mjs`，判据与 `web/` / `agent/` 那两条逐字相同：没有闸门，搬进子目录的东西会一个一个搬回来）：

```text
extra/trpg/
├─ index.ts      桶文件（**只给 web 路由与套件用**；内部一律 import 具体文件）
├─ types.ts      领域类型（零 import 本模块）+ HIDDEN_FIELDS
├─ spec.ts       声明（纯数据：tools + commands + subs；一个字的重东西都不许有）
├─ impl.ts       接线（ExtraRuntime 的实现，薄）
├─ entropy.ts    真熵源（必须在 rules/ 之外，由调用方注入）
├─ suggest.ts    兜底建议（一次独立模型调用）
├─ rules/        【纯函数】不得 import 到本目录之外（连 node: 都不许）
├─ model/        【领域模型】纯数据变换；**不许出现 node:fs / node:path**，读写收 store 端口
├─ store/        【存储】真正做 I/O 的那一层
├─ scenario/     【剧本格式】字节/文本 ↔ 领域对象，纯函数（`acts.ts` = 分幕的运行期助手）
│  └─ extract/    【抽取管线】P7 的四级流水线（切片 / 逐片抽取 / 归并 / 校验），同 model/ 那条纪律
├─ commands/     【玩家命令】入口是人：零 LLM 成本、只返回回执文本、不碰 sender
├─ tools/        【模型工具】入口是模型：改状态、写日志、要求模型自己开口
└─ render/       【展示】受众不同就必须是两份实现（模型 / 玩家）
```

**归置的判据是"改动理由"而不是"长得像不像"**：碰外部世界的进 `store/`（`campaign-store.ts` / `rule-store.ts` / `scenario-store.ts` / `mode-store.ts` / `journal-store.ts`），纯数据变换进 `model/`（`campaign.ts` 归一化与日志、`character.ts`、`combat.ts`、`session.ts` 开局建卡、`mode.ts`、`limits.ts` 各项上限、`paths.ts` 两个纯字符串变换、`rule-set.ts` 把 `ruleExt` 的 `unknown` 解释成运行期规则集），纯函数进 `rules/`（骰子、检定、条件表达式、属性生成、先攻、行动经济，以及 P7 的 `rule-set.ts` —— 机制的**编译**：把草稿编译成能参与判定的闭包、穷举校验、`describeMechanic` 那唯一一份人话）。实测踩过一次：`campaignFile()` 因为要 `path.join` 所以只能住 `store/campaign-store.ts`，而 `model/paths.ts` 里只有 `safeName` / `safeFileName` —— 把它放进 `model/paths.ts` 会被闸门打红，而那正是闸门存在的意义。**四条闸门**：① `rules/**` 的相对 import 不许离开该目录、非相对 import 一律禁止（连 `node:` 都不许）；② 根目录白名单 + 七个子目录缺一报错；③ **`model/**` 里不许出现 `node:fs` / `node:path`**（"这一层能不能脱离磁盘被测"必须是有答案的）；④ **`scenario/extract/**` 与 ③ 逐字同形**（P7-a 加）—— 它嵌套在 `scenario/` 里，而 ② 只管 `scenario/` 那一层，所以不单开这一条的话"顺手 import 一个 `node:fs` 把切片写出去"不会有任何报错，而破坏是静默的：套件会从纯函数断言慢慢退化成集成测试。落盘一律交给 `store/scenario-store.ts` 的 `writeExtras`。③ 允许 import `agent` 的 `ok`/`err`（`extra → agent` 是合法方向）。

⚠️ **`safeFileName` 与 `safeName` 判据不同**（两者都住在 `model/paths.ts`，注释里写明了为什么）：`safeName` 把所有非 ASCII 换成 `_`（会话存档名用），`safeFileName` 只清"当文件名不安全"的东西、中文原样保留（剧本名用）—— 用错那个会让 `灯塔` 与 `雨港` **撞成同一个文件**，那是数据丢失。

**剧本**（2026-10-16 加）是「结构化骨架 + 自由正文」：`data/trpg/scenarios/<名字>.md`，极简 frontmatter（一行一个 `key: value`，`flags` / `characters` 的值是一段 JSON）+ 正文。**不用真 YAML**（零依赖），**也不用纯 JSON**（正文要写多行，JSON 里得逐行转义 `\n`，人写不了）；frontmatter **可省**（就贴一段设定也能用）。**文件名 = 用户起的名字**，过的是 `safeFileName`（中文原样保留）。开局时由 `beginCampaign` **快照**进这一局（骨架落进状态、正文复制进 `campaign.scenario`，此后与那个文件再无关系）；命令 `.trpg start <剧本> [规则]` 与工具 `campaign action=start` **共用这一个实现**。⚠️ **文件里写 `visible`（与工具参数同词），而字段叫 `discovered`** —— `parseScenario` 必须做那次映射；不做的表现是 `"visible": false` 被当成"没写"、默认成 true：**藏了、没藏住，而且不报错**。正文超 `MAX_SCENARIO_CHARS` **当场拒绝**而不是截断（截断是在人还能改的时候不说、跑起来才少半段）。正文与"可用剧本 / 可用规则"的清单一起进 system prompt 的**中间段**（`prompt(chatKey)` 的 body 现在是三段：人格 → 清单+正文 → 状态；顺序即缓存，段内也是清单在前正文在后；**中间段永远非空**，所以 `body.length === 3` 恒定 —— `promptPlan()` 会滤掉空串，段数飘忽会让断言变成"有时 2 有时 3"）。剧本清单只有一份拼法（`render/status.ts` 的 `renderScenarioList`），向导、`.trpg scenario` 与 `.trpg start` 三处共用；**它进 system prompt**，所以写错词形等于教模型敲一条不存在的命令。

**抽取管线（P7-a）是"格式不对"那一档的现在时**。`.trpg scenario` 仍然只有**一个分档判据**（`isFormattedScenario`：有没有 frontmatter、整份能不能解析），真 → 一次调用都不发；假 → 走四级流水线 `scenario/extract/`：L1 `outline.ts` **纯函数切片** → L2 每片一次调用抽一份部分结构 → L3 **归并是纯代码**（`mergeStructs`，六份合成一份是机械判据：同名合并、去重、按上限截断）再来**一次**调用合成正文 → L4 校验回填（引文核对、超限标进 `warnings`、机制编译成规则扩展草稿、**合成正文必须过 `isFormattedScenario`**）。判据是**只抽不扩**：`MAX_SCENARIO_CHARS` 不动（正文那个数每轮都进提示词，是成本不是洁癖），30 页模组的细节进 `.struct.json`（有独立预算）、原文进 `raw/`。四条边界：① **不引入第三个档**；② 管线失败时**退回 `formatScenarioText`**（只整理格式，一次调用），两条都失败就把**两条原因都说出来**（只说一句会丢掉一半事实）；③ `writeExtras` 写失败**不回滚**（`.md` 已经是好的，旁路文件坏了不该让整份剧本白传一次），回执里如实说；④ **一条机制都没抽到时不传 `ruleExt`**（判据是"有没有"而不是"传 `null`"）—— 落一个写着 `null` 的 `.rule.json` 会让 `.trpg check` 报"0 条机制"，看起来像抽坏了。产物是三份伴生文件：`<id>.struct.json`（剧情结构 + 待核项）、`<id>.rule.json`（规则扩展草稿）、`<id>.raw/`（原文切片，保底、人可读）；`.md` 仍是**唯一进 system prompt 的正文**。预算纪律同 image-source：`EXTRACT_TOTAL_BUDGET_MS` 是**整条管线**的死线，每一发从它倒推，剩余不够就**不发**那一发并把"少抽了几片"如实说出来（原文在 `raw/` 里没丢）。

**规则扩展（P7-c/d/e）是"模组自己的规矩"落成能参与判定的东西**。抽取时机制连同**原文引文**一起抽出来（引文是 L4 唯一能核对的东西），`rules/rule-set.ts` 的 `compileRuleSet` 把它编译成运行期规则集：每条的 `effect.handler` 决定它**真的改检定/伤害**还是**只作叙事提示**（`narrate`）—— 分档在编译期定死，展示层不猜。⚠️ **判定的那几条一条都不许截断**（`describeStruct` 每类封顶 8 条，机制不行：少一条意味着"目标值被改了而 DM 不知道为什么"）。`renderRuleNotes` 把机制清单**并进中间段**（不新开一段 —— 它与正文同稳定度，而且段数一变，"body 恒为 3 段"那条断言就废了），措辞是「**没能编译成判定**」而不是「没编译进来」：四种 warning 里只有"超过 `MAX_MECHANICS`"那一种是**真的没进集合**，另外三种都降级成了 `narrate` 机制、确实在集合里，而这句话是模型判断"我到底该不该照那条设定来"的唯一依据。`.trpg check`（P7-b）是**第三份渲染**（受众是管理员）：只读目录与三个伴生文件，**零模型调用、零写入**，所以随时可敲；它不复用 `describeStruct`（那一份是给模型的压缩视图），因为漂移的表现恰恰是"管理员看到的与模型看到的不是同一件事"，那正是这份回执要回答的问题本身。逐幕的"群里会看到什么"见 `docs/trpg-dialogue-expectations.md` 的第二幕与第十三幕。

**规则的判定在两条路上必须同源**（2026-10-19 补）：`roll` 工具多了 `skill`（原先恒传空串，于是 `{op:'skill'}` 机制只在 `.ra` / `.rh` 那条路上生效 —— 实测同一张卡同一技能，工具判成功、命令判失败）；`describeCheckModifiers(mods, { secretFlags })` 多了暗线遮挡（`triggerFlagNames` 走触发树，不在拼好的那句人话上匹配），**命令与日志那一份遮、模型那一份不遮** —— 因为同一条文本有三个出口：`.ra` 的群回执、`campaign.log` → `.trpg status` 印给全群、战报 → `.log export` 发进群。`.trpg scenario` 另拆成 `openScenario`（下载 + 解字节）+ `finishScenario`（可能发 7 次调用），需要模型时**交后台**并用宿主端口 `sendText` 补回执 —— 命令是被 `enqueueIngest` 按会话串行 await 的，就地跑完会把整个群的入站堵住最多 90 秒。两本调用额度（`SCENARIO_BUDGET` / `SECRET_ROLL_BUDGET`）写在 `model/limits.ts`，与 `EXTRACT_TOTAL_BUDGET_MS` 同一取舍。**限流数的是「份」（触发次数）而不是模型调用次数** —— 一份的成本在 0 / 1 / 7 之间浮动，而闸门排在下载之前，所以上界要按 7 倍折算（35 次调用/时、700 次/天）。

**推进保证（P8-b）**：`campaign.advancement` 记三个指标（场景 / 旗标 / 幕）"距上次变化几轮"，每轮收尾 +1、变更点归零并置 `dirty`（否则变更那一轮会被记成 1）；只数**真人推动**且 `done`/`noreply` 的运行。阈值默认 8 / 12 / 20，规则扩展的 `advancement_threshold` 覆盖；超阈值落一条 `kind:'advance'` 的【推进提示】（陈述事实、**不含 keeperNotes**），冷却 5 轮/指标且落盘，**与兜底建议互斥**。`campaign action=advance` 校验当前幕的 `exitCondition`（`null` 无条件放行），不满足时用 `explainUnmet` 逐条说"还差什么"，**不占行动配额**。`stage_advance` 声明完成条件满足时 `hint`（缺省）还是 `auto`（一次运行最多切一幕）。两条新类型把数据放在机制的 `advance` 字段里而不是 `effect.params`（`narrate` 的 params 会被丢掉），`MECHANIC_TYPES` 因此十种。

**结局（P8-c）**：`ScenarioStruct.endings`（`id / name / trigger / readAloud / rewards / keeperNotes`），`trigger` 复用 `TriggerNode`、抽取时就编译；`rewards` 是自由文本（代码不结算）。两条收团路径语义不同：人敲的 `.trpg end` **跳过校验、立刻删存档**（剧本有 endings 时回执末尾多一句「这是强制收团」），模型的 `campaign action=end` 校验 endingId 与 trigger（不满足用 `explainUnmet` 说「还差什么」），写 `campaign.ended` 标记并**在这一轮收尾才删存档**（处理器里删会被 `withCampaign` 的写回复活）。摘要由 `campaign.ended` 驱动，结局段从剧本快照算、「没解开的事」排除结局 trigger 点到的旗标；战报多一条 `kind:'ending'` 的 `[结局]`（只有模型路径）。briefing 注入结局清单（名字/触发/奖励），`readAloud` 只在收团回执里出现一次、`keeperNotes` 哪儿都不去。

**分幕（P8）**：`ScenarioStruct.acts`（`id / name / order / goal / keeperNotes / entryCondition / exitCondition / scenes / visible`）由 L2 抽、L3 按 id 合并（`visible` 取 AND）、L4 交叉校验（引用了结构里没有的场景 → 待核项）。条件**复用机制的 `TriggerNode`**（`rules/rule-set.ts` 新导出 `compileTrigger` / `triggerMatches`），抽取时就编译，坏条件当场丢掉。运行期是 `campaign.currentAct`（`''` = 不分幕，旧存档与旧 `.struct.json` 都读成它），**`model/` 只当字符串**，语义在三个消费点（开局 / 换场景 / 渲染）里由 `scenario/acts.ts` 统一裁决。换幕判据是确定性的：场景名命中（精确 → 去空白标点后比较，**不做双向包含**）→ 当前幕的 `exitCondition` → 不动；未知场景**保持当前幕**。渲染分两份：DM 的状态段多一个阶段块（含 `keeperNotes`、下一幕只给名字），玩家只看到「第 N 幕 / 共 M 幕」（只数可见幕，当前幕不可见时整段不出现）。`.trpg check` 印幕名/序号/场景/完成条件，**不印 `goal` 与 `keeperNotes`**（那条命令在群里敲）。

**"玩家看得见"的出口在 2026-10-19 的审阅里被逐一核过**，补了两条真泄漏：`.combat next` 原先直接从 `combat.order` 印名字（开打之后被 `visible:false` 的人照样出现，而 `.trpg status` 会滤掉），现在与 `render/players.ts` 的 `combatLines` 共用 `discovered` 判据、当前行动者被藏时整句不出现；`campaignSummary` 的"走过的场景"原先靠排除 `开团：` 来筛，而 `setFlags` 也把 `旗标：X = 是（暗线）` 记成 `kind:'scene'`，于是暗线旗标名被当成一处场景印进收团摘要 —— 改成只收 `场景：` 开头的白名单。同一轮还让 `roll` 在漏填 `skill` 时给模型一句固定提醒（否则回执与一次完整的技能检定逐字同形），并让 `actionSource` 在日志里留一条 `visible:false` 的痕（规则书允不允许代码判不了，但事后要查得到）。

**群文件的形态是探针实测定的**（2026-10-16，SnowLuma）：消息里就是一个 `file` 段，带 `file` / `file_id` / `name` / `size` / `url`（带签名的 http 直链）/ `file_hash` —— 所以 `extractMediaFromSegments` 加一支就够，`.trpg scenario` 也只要在 `input.media` 里找 `kind: 'file'`（被引用那条的媒体已经由 `ingest.ts` 并进来了），不需要任何新口子。两条边界：**`url` 是临时直链**（带签名），要下就当场下、别存起来等下次用；判据与 `record` 那条一致 —— **既没 url 又没 file_id 才不产出条目**。已知代价：白名单群里任何群友都能存剧本、也能覆盖同名剧本。见 `AGENTS.md`「跑团（TRPG）」的已知边界。

几条边界。**叙事归模型、状态归代码**：HP/SAN/MP/属性/技能/旗标/可见性由代码钳制，模型只能通过工具**请求**改动，请求连同"从多少变到多少"进日志。**四个工具不是七个**（`say`/`campaign`/`character`/`roll`）：合并的判据是"参数互不重叠、机械部分相同"，收益是工具 schema 属于**每次请求前缀**的一部分；代价是 `required` 不能按 `action` 分支，只能靠点明"这个 action 需要什么"的中文错误文案补救。**`say` 是接管会话唯一的发言通道**，所以它同时是会话账本的入口（`sendTextBatch` + `recordSent`，少一步就是"说了话却被记成 noreply"）。**`say` 的 `atUserId` 修掉了"DM 物理上无法 @ 人"**：在 `text` 里写 `@阿飞` 只是一串**普通文字**，协议端不会把它变成真正的 @（对方收不到提醒，而模型会以为自己叫到了），所以 schema 里有纯数字的 `atUserId`，`tools/say.ts` 把它透传给 `sendTextBatch` 的选项。**叙事的记档由代码做**（`say` 里顺手 `appendLog`），不另开"记日志"的工具——那等于给模型一个"可以说但不记"的口子。**状态的上限全是成本**（它每一轮都进 system prompt），逐项在 `model/limits.ts`、总闸门在 `render/model.ts`（超预算从最老的日志开始丢）。**`prompt(chatKey)` 的人格在前、状态在后**（顺序即缓存）。**状态文件一个会话一个**（`data/trpg/<会话>.json`），读写都归一化（坏文件 / 旧版本 / 手改过的一律夹回合法区间）；**读不到返回 `null` 而不是空对象** —— "还没开团"与"开了个空团"是两件事，前者要提示模型去 `campaign action=start`。

**信息隔离是三级 + 两份投影**（2026-10-16 加）：实体级 `discovered`（玩家见没见过这个人）、旗标级 `visible`（暗线）、字段级 `hidden`（`stats`/`pools`/`notes` → 玩家看到 `???`）。`render/model.ts` 的 `renderForModel` 全量且逐项标注 `[对玩家隐藏: …]`/`[暗线]`（外加一个"玩家已经知道的"小节），`render/players.ts` 的 `renderForPlayers` 让隐藏的东西**根本不出现**（不是印成 `???` —— 一条全是问号的旗标本身就是一次泄漏）；两份是**两份独立函数**，不是"一份 + 开关"（共用会漂移，而漂移的表现是"DM 以为藏住了、玩家其实看得见"）。隐藏规则有两条细节：**`pools` 隐藏覆盖 MP**（它和 HP/SAN 是同一类：一条会被消耗的资源条），**`stats` 隐藏覆盖 DB/Build/MOV**（它们是"属性那一类"的派生物 —— 藏属性却露 DB 等于没藏）。⚠️ 玩家那份**只印 `roll`/`check` 两类日志**：`state`/`scene` 是 DM 的记账，正文里混着隐藏卡与暗线的名字——整段喂过去就是把刚藏好的东西又说一遍（套件抓出来的真泄漏）。揭示走 `campaign action=reveal`，成功时顺手落一条 `trpg-note` 回流条目。

**行动经济的"回合"= 一次 agent 运行**：`ctx` 每次运行新建、整个工具循环共用，所以扩展持一个 `WeakMap<ToolContext, ActionLedger>` 就免费得到"运行结束自动清零"。两道闸门：同参数去重（**这才是拦"把失败结果重掷到成功"的那一条**，掷骰不改状态、配额管不到它）+ 主行动配额（写状态类每行动者每回合 1 次，具名 `actionSource` 另算）。来源是自由文本——枚举规则书的行动名就是把规则书知识漏进领域层。

**一局有两种起步，差别是"谁决定开局"**（`TrpgCampaign.status`）：**人**敲 `.trpg new` 建出 `preparing`（`join` → `.pc new` → `.pc confirm` → `.trpg start`，`canActivate` 逐人查确认、挡住并报缺谁），**模型**调 `campaign action=start` 建出 `active`（DM 说开就开 —— 那是"AI 主持一局"那条路，不该被建卡流程卡住）。**两个入口共用 `beginCampaign`**，差别**只有 `status` 一个参数**，判据（已经开过局怎么拒、剧本读不到怎么办、规则表坏了怎么办）仍是一份。⚠️ **迁移：旧存档缺 `status` 一律读成 `active`** —— 升级不该把正在跑的团退回建卡阶段（那会让 DM 的每一次工具调用都被状态机拦下）；同 `normalizeFlag` 对旧旗标形状的取舍：**缺省取"更宽"的那一边**。`active` 之后仍允许 `.trpg join`（"来晚了"是常态，只是回执会说清），满员 `MAX_PLAYERS = 8` 仍然拦住 —— 那个数同时是成本（玩家名单一路进提示词）。`.trpg end` **删掉存档**（不是封存）：不删的话下一局只能靠 `restart` 清，而那条路会连带清掉人物卡；删掉才让"`new` → 玩 → `end`"成为一个**能循环**的动作。

**属性生成与派生值（P4）：掷法是数据、公式是代码**。`RuleFile.chargen.attributes` 写在规则文件里（掷法属于规则书），`.pc roll` 逐个掷、**确认之前可以无限重掷**；派生公式在 `rules/chargen.ts`（HP=`(CON+SIZ)/10`、MP=`POW/5`、SAN=`POW`、DB/Build 查 STR+SIZ 表、MOV 按 STR/DEX 与 SIZ 的关系给 7/8/9）—— 这些是 COC7 的知识，写成数据要另发明一套表达式语言，所以是代码。⚠️ **代价说清**：派生公式**认死那几个属性名**，管理员把 `CON` 改名成 `体质` 就派生不出来，那种情况 `derive()` 返回 `missing` 并**明说缺谁**（不是算出一个错数），且 `missing` **不短路**（一组里缺两个就报两个）。⚠️ **印不印 DB/Build/MOV 要用 `db` 那条字符串判，不能用 `build === 0`**：COC7 里 `Build 0` 是一个**合法取值**，0 分不出"算出来是 0"与"没算过"。

**战斗与先攻（P5）：排序是纯函数、指针是领域模型、两条路共用**。`rules/combat.ts` 只做两件纯事（按 `initiative` 属性**降序排一次名字**、同值按卡在名单里的原顺序稳定；`clampTurn` / `advance` 推指针，越界绕回），`model/combat.ts` 才是领域模型（`normalizeCombat` 把旧存档/手改过的一律夹回合法区间、`currentActor`、`immobileNames`、`advanceCombat`）。⚠️ **群里只印名字顺序，不印先攻数值**（那个数就是卡上的属性，而 `hidden: ['stats']` 存在的理由正是藏属性；模型那一侧照常带数值，因为它本来就看得到全量状态）—— 这一处分岔是有意的。⚠️ **倒下的人自动跳过，判据是"那个人现在什么样"而不是"顺序里记着什么"**：HP 掉到 0 或那张卡被删了就不算可行动，所以 DM 刚把一个人打趴、下一次推进就会跳过它，**不需要任何一处额外记账**；**`hpMax` 为 0 的卡不算倒下**（那是"这套规则没有 HP 概念"的写法）。⚠️ **"行动即推进"按名字匹配**（`character` / `campaign` 的写动作收尾时 `actors` 里有当前行动者才推指针）：写成"有写动作就推"会在极常见的"玩家掷一次骰、DM 接着给敌人记伤害"里**连推两格**。**`combat` 这条不占行动配额**（指针不是任何角色的行动，占配额的话 DM 会刚好在"轮到某个人、该给他记伤害"那一刻被自己的记账锁在门外）。**代码不拦越权行动**（知情取舍）：它只管"轮到谁"，所以两边回执**每次都把当前行动者念出来**，让 DM 手里有一个可以对的锚。

**战报是 append-only 的旁路（P2 落写侧，P6 做导出）**：`data/trpg/journal/<会话>.jsonl`，一行一条。**为什么不把 `campaign.log` 存久一点**：那个数组**每一轮都进 system prompt**，60 条的上限是成本不是洁癖；而"这一局打过什么"要给**人**看，要求的是完整 —— 两个需求挤在一个数组上只能二选一。`mirrorLog(campaign, beforeSeq, journal)` 在 `store.write(campaign)` 之后调，传的是**改动之前**的 `seq`，语义是"只记**真的落盘了**的日志"。⚠️ **`visible` 是 P6 补上的那条判据，由写入侧决定**：`false` = 这一条不许出群；`mirrorLog` 按条滤、`.log export` 在**发布边界上再查一遍同一条判据**（战报文件要发进群，而 `state`/`scene` 两类日志的正文里混着 `隐藏：pools/notes`、`旗标：真凶是医生 = 是（暗线）`——整段喂出去就是把刚藏好的东西又说一遍）。`JournalStore.append` **永不抛**（战报是旁路，磁盘满不该让群友那次操作看起来失败），`read` **跳过坏行**（append-only 的代价是最后一行可能是半截）。**导出走宿主递进来的 `sendFile`**（`ExtraRuntimeDeps`）：`SendQueue.sendFile` → `upload_group_file | upload_private_file`，超时 **120 秒**（从 `qq/onebot.ts` 导出 `SEGMENT_UPLOAD_TIMEOUT_MS`），与 `sendImage` 一样**在每会话串行链之外**（会话收尾不该由一次上传的速度决定），并顺手写一条 `我：[文件:名字]` 的存档。三条"导不了"分开说：**没有战报** / **没接上传通道** / **导出失败**。**面板上「跑团」那一栏列的是三类**（剧本 / 规则表 / 战报），战报那一类的 confirm 文案与另两类**说的是相反的话**（剧本与规则表删掉还能再传，战报删掉就没了）。

**兜底建议挂在一个新增的"运行结束"端口上**（`ExtraRuntime.onRunEnd`）：通知点是 `SessionRegistry.finish()`（一次运行唯一的收尾处），经构造参数回调交给 `web/app.ts` 接线（低层不 import 高层），再由 `extras.runEnded()` 转给**正在接管那个会话**的实现（判据复用 `#overrideEntry`，所以附加模式的扩展收不到 —— 它们没有"这一轮"）。⚠️ **不要动 `app.ts` 的 `const emit = (type, payload) =>` 闭包**（`t-sse-project.mjs` 按字面切它的源码文本钉"只许委托"）。触发判据三条（`status === 'noreply'` + 触发批里有真人消息 + 冷却），产物是一条 `trpg-note`（`kind:'suggest'`）**由下一轮的主 DM 自己说出来**——扩展不代它发群。**"触发批里有真人消息"那条同时是循环终止的证明**（兜底条目唤醒的那一轮触发批里只有机器条目）。正常路径零成本：提示词要求 DM 自己每轮给 2-4 个选项。**用量 2026-10-17 起进账了**：那一次调用（与 `.rh` 的暗骰叙事）发生在 `finish()` **之后**，借不了会话那条记账路（`#persist` 对已结束的会话每次都会把整份 `usage` 再累加一遍），所以宿主另开了一个**只叠增量**的入口 `SessionRegistry.addExtraUsage`（**不动 `runs`**、全零早退），由组装根接在 `ExtraRuntimeDeps.recordUsage` 上；缺省（测试、未接线的宿主）时只是不记账，调用照常。⚠️ 它的参数是**结构类型**而不是 `extra` 的类型：`chat`(1) 比 `extra`(4) 低，反向 import 会被 `check-layers.mjs` 拦。

**这几条命令只出现在被接管的那个会话里**（`commandDefs()` 对非接管会话直接跳过 override 模式的扩展），`.r` 的非法表达式**抛**出去让 `runCommand` 把中文原样发进群（`.r` **不做**助手模式 `intercept` 那层"整条消息就是一个骰子表达式"的判据 —— 想听到"看不懂"就走它）。开启要三步：设置页打开（`extras.enabled.trpg`，**改完重启**）→ 写 `config.json` 的 `extras.override` 开机播种，或群里敲 `/能力 加载 trpg`（内存绑定、不落盘）。**默认关**是刻意的：跑团比搜图/转写/出图更重（换的是整个人格）。

**每个会话还能再选一种模式**（`.trpg mode 助手` / `DM`，按群记在 `data/trpg/modes.json`，**下一轮运行生效**；缺省是 `dm`，所以没切过的会话在文件里没有记录）：DM 是上面这一整套，**助手模式只掷骰**。**模式决定五件事，而五件事必须按同一个会话取**：`toolsFor`（工具表收成 `say`+`roll` —— 核心为此加的按会话取子集的钩子）、`prompt`（返回**空 body**，见下）、`onRunEnd`（不跑兜底建议）、`intercept`（把每一条消息都拦下）、`configPatch`（`{}`，不抬上下文）。它们都收 `chatKey`，所以这件事不需要任何跨会话机制 —— 但也正因为分散在五处，`impl.ts` 里那个 `TrpgModeStore` **只有一个实例**。判据是"模型看到的与它真能用的必须是同一套东西"：**不收窄工具表**的话就得靠提示词求模型别调另外两个，而它们仍然占着每轮的请求前缀、还留给它一次调错的机会。

**DM 模式下挂载期间会把上下文抬到下限**（`configPatch`）：`store.maxContextMessages` / `store.historyCount` / `store.promptContextMaxChars` **至少**抬到 200 / 200 / 60000。跑团比闲聊吃上下文得多（人物卡、旗标、剧本正文与日志每轮都要带上），默认那点窗口会让 DM 看不见自己十分钟前说过什么。三条边界：**语义是下限不是覆盖**（`lift()`，用户配得比下限宽就照用户的）、**`0`（不限）原样留着**（它已经是最宽的那一档，写成 200 反而是把它变窄）、**不落盘不外溢**（走 `configPatch` → `mergeConfigPatch`，**别在这里 `updateConfig`** —— 那会改掉所有群）。⚠️ **这条能生效是因为同时改了两个读取点**（`Orchestrator` 建窗口注册表时按 `configFor(chatKey)` 取容量、`wake-scheduler` 算历史深度时读 `this.configFor(chatKey)`），**缺一处只生效一半**，而症状是"配了、看着生效、实际用的是别的"。**助手模式不抬**（`{}`）：它不跑模型，抬了只是白占内存。

**助手模式为什么连人格都不给**（2026-10-16 改，原先是一段"骰子助手"）：普通消息全被 `intercept` 拦下，模型只在**绕不过去的唤醒**上才会跑（全局主动冒泡、异步结果回流 —— 比如群里发视频敲 `/转写`，结果回来时唤醒它）。而那两种情况下**什么都不说**正是要的行为，一份"你是骰子助手"的人格反而在邀请它开口。**空的 body 不等于没有系统提示**：`buildSystemPrompt` 的 override 分支是 `[...SYSTEM_FRAMEWORK_SECTIONS, ...body]`，所以安全规则与工具协议两段照旧。**那份人格是从 `extra/prompts.ts` 里删掉的，不是留着不用** —— 没人读的固定指令就是谎话。

**命令面是 `.` 前缀的四个族 + 四条单命令**（2026-10-16 定型，2026-10-19 加 `.trpg check`；`spec.ts` 里 12 条声明展开成 25 条词形）：`.trpg new|join|status|start|end|mode|scenario|check` · `.pc new|roll|confirm|show|save` · `.combat start|next|end` · `.log export`，每族外加一条**裸命令兜底**（排在该族子命令**之后**，只在"一个子命令都没匹配上"时命中，回用法清单 —— 静默忽略的话群友只会看到一张状态卡，**不知道自己敲的那条为什么没生效**）；另有 `.ra`（公开检定）· `.rh`（暗骰）· `.st`（确认前改属性）· `.r 3d6`（自己掷）。**前缀是 `.`**（OneDice 的手感），也是这一族与主流程 `/转写` `/画` `/漫画` `/能力` 分开的标记。

**子命令是声明期的糖**（`ExtraCommandSpec.subs`）：`runtime.ts` 把它们展开成 `.trpg start` 这样的**普通命令词**，此后没有任何地方知道"子命令"这个概念。**为什么这么切**：动作曾经挂在一条命令下当 `words[0]` 分支，**那张分支表就是 `spec.commands` 词形列表的第二份定义** —— 而词形列表只有那一处（`names[0]` 同时是 `commandHandlers` 的键）。改成 `subs` 之后加一个动作 = 加一行声明 + 一个 handler。**旧词形一律不留**（`/跑团`、`/模式`、`/剧本`、`/开局`、`/掷骰` 全部作废）。⚠️ **词形共用一个命名空间**，注册表自检按**展开后**的串查重 —— 将来别的扩展想要 `.trpg start` 会被**装配期拒掉**（那是有意的护栏，不是意外）。`.trpg start` 与 DM 的 `campaign action=start` **共用 `beginCampaign`**，剧本清单也**只有一份拼法**（`renderScenarioList`）。**所有用户可见的命令引用都必须跟着改**（`renderWizard` 是**五步**、`renderScenarioList`、`COMMAND_USAGE`、助手模式那条"怎么切回 DM"、`.trpg scenario` 的落库回执末尾那句、以及**面板那两句** —— 漏掉面板那处的表现是**设置页教用户敲一条不存在的命令**，而它不会有任何报错）。完整约束、守护与探针结论见 AGENTS.md「跑团（TRPG）」，逐幕的"群里会看到什么"见 `docs/trpg-dialogue-expectations.md`。

**守护**：`t-trpg.mjs`（**709 条**）覆盖状态层上限与归一化（**含旧形状迁移**）、4 个工具的正反路径、**剧本解析与开局注入**（骨架落进状态、正文快照、改了文件不影响正在跑的团）、**规则表回落与拒绝**、`.trpg start` 命令与工具共用实现、工作台列表与删除、**两种模式**（`toolsFor` 的工具子集、`prompt` 的**空 body**、`.trpg mode` 的四种回答、`onRunEnd` 的"助手不兜底"+对照组、以及**真起 app** 断言助手会话只拿到 `say`/`roll`、system prompt **一份人格都没有**）、**`.trpg scenario` 的早退分支与格式匹配/模型整理/抽取管线三条**（含"格式本来就对 → 一次调用都不发"这条**成本性质**，以及抽取与整理那两次调用**真的进账**）、**`.trpg check` 的三段回执与三条"做不了"**、`prompt` 的三段段序、**可见性两套投影（含一条专门的泄漏断言）**、行动经济（去重/配额/新 ctx 即新回合）、`reveal` 与它的回流条目、**`onRunEnd` 的六条判据**（起真假模型端点 —— "没发条目"在生成失败时也是绿的，那是假绿）、**源级断言**（掷骰路径上不许出现 `Math.random`、`node:crypto` 只在 `entropy.ts`）、**助手模式的拦截**（判据逐条、掷骰与静默两种返回、越界表达式回可读原因、DM 模式不拦）、**`configPatch` 的五条**、**命令面的流程形状**（25 条 handler 键、`subs` 展开后子命令优先于裸命令、向导的五步段序）、**5h 段的会话全链路**（建局 → 报名 → 建卡 → 确认 → 开跑 → 收团 → 战报）、**5i 段的检定与暗骰**、**P5/P6 段**（三条回执与三条"做不了"、倒下的人自动跳过、「行动即推进」按名字匹配、`combat` 不占配额、战报的 `visible` 判据与 `.log export` 的三条"导不了"、面板第三列），**7b 段的独立用量记账**（进 `usage-today.json`、不动 `runs`、叠增量、全零不写、真会话照常加 `runs`、两条源级接线断言），以及真起 `createApp()` 的端到端（接管会话的模型请求里只剩跑团那 4 个、system prompt 是跑团人格且不含主人格、能力段让位、`say` 那一轮真的被判成 `done`、`trpg-note` 能唤醒一轮并把标签送进正文、`/api/extras` 标成 override、**接管群的窗口容量与历史深度都被抬到下限而对照群一点没变**）。另有 `t-trpg-extract.mjs`（**104 条**，P7 的四级流水线：L1 切片的确定性与 `droppedChars` 计数、L2 每片的 payload 逐字对得上与脚本式假端点的调用次数、L3 归并的每条判据、L4 四条校验、`.struct.json` / `.rule.json` 的读写与坏文件拒绝、预算降级那一路的产物）—— 两条纪律：**纯函数直接取 `scenario/extract/*.js` 而不走桶文件**（桶不转发它们，改了导出名会当场炸、不会静默退化），且每个"本该不调用模型"的用例都要**重装一份全新的脚本数组**（假端点是消耗式的，复用引用等于没装）。完整清单与逐条探针结论见 AGENTS.md「跑团（TRPG）」。

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
