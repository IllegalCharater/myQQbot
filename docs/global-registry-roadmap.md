# 全局事件、方法与定时任务注册表路线图（延期）

> **状态：设计已产出 → [`docs/global-registry-design.md`](global-registry-design.md)（2026-09-28）。**
> 该文档逐条回答了下面的 7 个问题，并给出事件全表、计时器全表、死代码登记三份清单，以及 S0–S9 的渐进式迁移步骤。
> **迁移进度：S0–S9 全部完成，本阶段的设计目标已交付完毕。** S1（抽 `web/http/event-projector.ts`）、S2（落 `core/events.ts` 词表与载荷类型）、S3（61 个发射点里的 59 处字符串字面量 → `EVENTS.*`）、S4（拆 `status` → `config-applied` / `orchestrator-pause`，全案唯一的线上协议改名）、S5（收敛 `session-end` 四形状到 `SessionEndPayload`，`sent` → `sentCount`）、S6（13 处 `emit` 注入类型 → `AppEmit`，全部生产者从此受编译期检查）、S7（12 处 `session-update` 裸串 → `{ sessionId }`，**激活一条自初始提交起就从未通电的通道**）、S8（`AgentControlPort` + `METHOD_CATALOG`，`Orchestrator implements`，`web/` 与 Electron 改依赖接口而非具体类）、S9（`web/runtime/tasks.ts` 的 6 行长期任务描述符表，纯数据、不启停、局部计时器不进表，由 `t-tasks.mjs` 反向断言守住）。**注册层仍未实现**（这句描述的是 S0–S9 收官时的状态；它**已被下面 S11a–S11c 作废**——注册层 = 四件产物的合称）。
>
> **S10+ 已全部落地（比 S0–S9 多了两条被解除的禁令，见下）**：**S10a** —— 新增 `stopPriceFeed()`、修掉 `price-feed` 里"同 URL 早退却已清掉定时器"那个**小时级刷新静默停摆的真 bug**、把价格表的启动点从 `createApp()` 收进 `app.start()`、接线 `app.stop()`；`price.feed` 升到 `conformance: 'full'`；新增 `tests/t-timers.mjs`（计时器句柄断言，ASSERT，22 套件）。**S10b** —— 新增 `stopJmcomicQueue()`（置空 `runtime` + 清两个计时器，**不清 `jobs`**）、把 `initJmcomicQueue` 从 `Orchestrator` 构造函数搬进 `app.start()`、接线 `app.stop()`；补上 `scheduleNextWake()` 的 `!runtime` 早退（否则 worker 的 `finally` 会把队列自己排回来）；`jmcomic.cleanup` → `full`、`jmcomic.worker` → `partial`（**停不掉正在跑的那一次下载**，用户已确认接受，如实写在 `note` 里）；`t-timers.mjs` 13 → 21 条断言。**S10c** —— `src/qq/onebot.ts` 新增 `#reconnectTimer` + `#scheduleReconnect()` / `#cancelReconnect()`，两处裸 `setTimeout` 改走它、`close()`/`connect()`/`reconnect()` 三处都取消待触发的那一次（**刻意不 unref**）；`onebot.reconnect` → `full`——**至此 6 行长期任务全部有摸得到的启停入口**；顺带堵掉一条真实的重复连接泄漏路径；`t-timers.mjs` 21 → 30 条断言。**S10d** —— 删掉 `Orchestrator` 的兜底事件总线（`createEventBus` 的 import 一并移除），`OrchestratorDependencies.emit` 从可选改**必填**，8 个 `.mjs` 构造点补上 `emit`；`t-ports.mjs` 新增第 1c 段（两条文本断言：`orchestrator.ts` 不再引用 `createEventBus`；`tests/` 里每个 `new Orchestrator({…})` 都含 `emit`——`.mjs` 不受 `tsc` 管，且实测**真正纯静默的只有 `t-ports.mjs` 自己那一个**）。S10+ 全程没有一步触碰 `src/qq` 入站解析，也没有建任何按名字分发的运行时注册表。
>
> **S11a–S11e 是"注册层的第四条腿"**（详见 `design` §0.1）：**S11a** —— 新增 `src/web/runtime/shutdown.ts`，无头入口的 `SIGINT`/`SIGTERM` 走同一个幂等关停（重复信号立即强退、`stop()` 抛错也照常退出）；**S11b** —— `OneBotClient.applyEndpoint()` + `applyConfigPatch` 比较后重连（改端点热生效、没动端点不断连），删死常量 `RECONNECT_MAX_MS`；**S11c** —— 新增 **`src/web/runtime/lifecycle.ts`**：`LIFECYCLE` 是**有序的函数引用数组**，`startLifecycle` 正序、`stopLifecycle` **逆序**，`app.start()`/`stop()` 改走它，`app.ts` 里不再有任何一条硬编码的任务启停调用；新增 `tests/t-lifecycle.mjs`（ASSERT，23 套件）。
>
> **S11d 收掉附录 C 剩下的死代码与一条空转事件**：`core/config.ts` 的 `scheduleConfigSave` + `saveTimers`（该文件从此**没有任何计时器**）、`agent/shared/types.ts` 的 `AgentEventMap`（带索引签名的旧事件映射，已被 `AppEventMap` 取代）、`MemoryConsolidatorDependencies.emit`（只声明、从未调用）连同 `orchestrator.ts` 的传参、以及 **`vision-scan` 整条事件**（词表键 + `VisionScanPayload` + `llm/vision-scan.ts` 两个发射点与 `emit` 参数 + `/api/vision/scan` 的三处发射与传参）——**它是全案唯一"有发射点、零消费者"的事件**，删它而不是给它补面板消费者（能力已由 HTTP 的 `visionData.scanning` 提供）。守护加在 `tests/t-lifecycle.mjs` 第 4 段（5 条，**全是文本断言**：被删的东西零调用者/零消费者，删与不删运行期完全一样，行为断言写不出来），并同步删掉 `tests/t-events.mjs` 的 `TYPED_FILES` 里两个文件名（注入点从 9 个文件降到 **7 个文件 / 10 处标注行**；"处"的两个口径见 `design` §4.3 末——**以文件集合为准**）。**注意区分同名异物**：`routes/providers.ts` 里那个 `const visionScan = { running: false }` 是**活的**（挡 409、喂面板），删它会静默把面板"扫描中"永远显示成 false——只有一条正向文本断言守着它，套件区分不出"删事件"与"删这个对象"。**S11e（electron `before-quit` 真正 await `stop()`）也就位了**：`quitting = true` → `if (stopping) return;` → `event.preventDefault()` → `Promise.resolve().then(() => core.stop()).catch(…).finally(() => app.quit())`。三条"缺了就挂"的不变量：`quitting` 先置位（否则关窗缩托盘把退出挂住）、`stopping` 守卫（否则第二次 `app.quit()` 拦下自己 → 死循环）、`.finally` 里自己再退一次（否则 `preventDefault` 之后**永远不退**）。守护是 `tests/t-lifecycle.mjs` 第 5 段（6 条文本断言，套件 33 → **39**）——`electron/main.js` import 不了，这三件事只有文本看得见。
>
> **因此"注册层仍未实现"这句话到此作废。** 注册层的实际形态是**四件产物的合称**（events 词表 / `AgentControlPort` 端口 / `LONG_TERM_TASKS` 描述表 / `LIFECYCLE` 执行清单），**不是**一个统一对象——这正是本路线图"不能是一个对象"那条约束的最终落法。它仍然**没有**按名字分发的运行时分发：执行清单只做"有序的直接调用"，`id` 仅作对账元数据，`tests/t-lifecycle.mjs` 有文本扫描专门钉这条边界（删掉那条扫描，一个 `startById(id)` 式的按键分发能在所有行为断言全绿的情况下长回来——§9.5 第 20 项⑤ 是实证）。前三条禁令（不替换事件总线、不建字符串式注册表、不动 `src/qq` 入站解析）**仍然有效**。
> 未尽事项三项，都只能人工真机确认：① S7 的面板冒烟（SSE 与 4s 轮询双写下的表现）；② S8 之后真机跑一遍桌面端控制入口（暂停/恢复、手动压缩）——编译器只保证"接线没接错"，保证不了"点下去真的有反应"；③ S9 之后真机确认 6 个长期任务的启停行为与表里写的一致（尤其是 `proactive.bubble` 会不会真的钉住进程退出）。**S11e 追加一项**：托盘"退出"要看到**窗口先关、进程等关停日志打完才消失**（而不是窗口一没进程就没了），再回头验一次"退出期间关窗不再缩托盘"；**顺便把③的 `proactive.bubble` 定性做掉**——它在 `stop()` 里会被停掉，所以正常退出观察不到，要观察得临时把 `stop()` 从 `before-quit` 里拿掉、本机试一次再还原（做法与"别把它留在代码里"写进 `design` §9.4）。**S11c 追加一项**：退出时 `jmcomic` 与 `price.feed` 的停止次序互换（逆序的结果，两者互不依赖），确认进程干净退出、无残留 interval、无在途上传被打断。

> **同日的另一次改动与注册层无关，仅记录以免路径对不上**：`web/` 按功能与层级搬进 `http/` 与 `runtime/` 两个子目录（纯搬运，不改文件名、不改函数体），并把"根目录只留组装/入口/领域类型/读模型"写成 `check-layers.mjs` 的机检规则。八个文件的映射表与一条**必须记住的操作事实**（`npm run build` 不清理 `dist/`，搬完文件必须先 `rm -rf dist`）见 `design` §7.6，证伪探针见 §9.5 第 25 项。本条**不属于任何迁移步骤**，没有新增或删除任何事件、端口、长期任务。

> **同日的又一次改动（同样不属于迁移步骤，记录以免路径对不上）**：搜图链路收敛成"**Node 一个通用 provider + 引擎知识在 Python**"——`saucenao-provider.ts` 与 `trace-moe-provider.ts` 两个原生 fetch 实现**整体删除**，改由 `src/media/image-source/pic-image-search-provider.ts`（唯一 provider，只做转发）驱动常驻 worker（`python-tools/pic_image_search_worker.py`，引擎的类名/家族/字段归一化都在它那里）。**`LONG_TERM_TASKS` 因此多出第 9 行** `image-source.pic-worker`（宿主 `src/media/image-source/pic-image-search-client.ts`，`imageSource.enabled` 门控、**默认 `false`**，`conformance: 'full'`——`close()` 关子进程并 fail 掉在途请求），`LIFECYCLE` 加一条排在**最后**（于是逆序停止时第一个被收掉，不拖 OneBot 传输层），`app.ts` 的 `lifecycleDeps()` 相应加 `imageSource`，`t-tasks.mjs` / `t-lifecycle.mjs` 的期望清单同步登记。**注册层四件产物的形态没有任何变化**（没有新事件、没有新端口、没有按键分发）。它给"局部计时器 vs 长期任务"的分界带来一个新形态：这一行的长期资源是**子进程**，不是计时器，而 `t-tasks.mjs` 第 2 段那条"owner 文件里必须有 `setInterval(`/`setTimeout(`"只能扫到该文件里的**请求超时**——**为错误的理由通过**，`design` 附录 B 末尾的增量说明已如实记下。

## 目标

未来建立一个静态、强类型的全局注册层，集中描述核心事件与业务方法绑定，并统一管理真正的长期后台任务。该工作必须先完成协议与生命周期设计，本阶段不新增注册表代码。

> **S1–S9 与这条禁令的关系**：它们新增的是**词表（`core/events.ts`）、类型化端口（`agent/runtime/control-port.ts`）、纯数据描述符表（`web/runtime/tasks.ts`）**，都不是注册表实现——没有一处是"按名字查表调用"的运行时分发（S8/S9 各有断言钉住这一点）。**S10a/S10b/S10c 也没有建注册表**：它们做的是"给模块级单例（或单例式的类）补上显式停止入口，并把启停点收进 `app.start()`/`app.stop()`"，比注册表低一档——**入口是硬编码的调用，不是查表分发的**。S10b 顺手消掉了最后一处"构造函数副作用启动长期任务"（`Orchestrator` 里的 `initJmcomicQueue`），S10c 把最后一个只能"阻止下一次、取消不掉待触发的那一次"的停止入口（`OneBotClient.close`）补成了真能取消的；于是"长期任务在 `start()` 起、在 `stop()` 停"从要求变成了现行事实，且 `LONG_TERM_TASKS` 的 6 行里 `stopCancelsPending: false` 只剩 `jmcomic.worker` 一行（成因是"停不掉**正在执行**的那一次下载"，与"取消不掉等待中的那一次"是两回事）。
>
> **S11c 补上的第四条腿（`web/runtime/lifecycle.ts`）同样不是注册表**，理由与上面几条一致且更具体：`LIFECYCLE` 的元素存的是**函数引用**，运行期只有一次 `for...of` 遍历，没有任何 `LIFECYCLE[动态键]` / `.find(` / `.get(`；`ids` 字段只是给套件与文档用的对账元数据，**运行期从不读它**；`import` 该文件不启动任何东西（有假计时器下的断言）。**边界的机检落点只有一处**：`tests/t-lifecycle.mjs` 第 3 段的三条文本扫描（`LIFECYCLE` 只许出现在 `lifecycle.ts`、不许出现按键下标、遍历函数只许有两个调用点）。这三条断不出任何功能问题，只断"架构还能不能长回去"——**这正是它们必须存在的原因**。

## 需要覆盖的对象

- 将 SnowLuma 入站基础事件包装为项目内部通用事件接口，再交给业务消费者。
- 盘点群聊消息、通知、连接状态、会话、聊天、记忆、表情、视觉扫描等核心事件。
- 盘点事件生产者、消费者、载荷类型以及核心业务方法的绑定边界。
- 盘点群聊冒泡、历史压缩、缓存清理、价格刷新等长期定时任务。
- 明确区分全局长期任务与请求超时、重试退避、聊天防抖、单次扫描轮询等局部计时器。

## 后续专项计划必须回答

7 个问题在 `docs/global-registry-design.md` 的落点：

| 问题 | 答案所在章节 |
|---|---|
| 1. SnowLuma 原始事件结构、版本差异与规范化失败策略 | §2（入站事件盘点；沿用 `src/qq` 既有防御点，只包装已解析结果） |
| 2. 通用事件接口、事件名、载荷类型及生产者/消费者清单 | §3 现状 + §4 设计；全表见附录 A（12 个事件、61 个发射点） |
| 3. 哪些核心方法允许注册，如何避免字符串式动态调用 | §5（结论：端口而非注册表；三处字符串键分发均为外部契约，保留） |
| 4. 每个长期任务的所有者、启动条件、配置刷新、停止与清理 | §6 + 附录 B（**6 个长期任务** + 17 个局部计时器） |
| 5. 注册顺序、重复注册、异常隔离、关闭顺序、退出语义 | §7 |
| 6. 现有总线与分散计时器的分阶段迁移、兼容与回滚 | §8（S0–S9，每步含守护套件与回滚方式） |
| 7. 单元/集成/假时钟测试与真机冒烟范围 | §9（含 harness 无假时钟这一缺口的两种补法） |

原文（保留作验收清单）：

1. SnowLuma 各类原始事件的结构、版本差异和规范化失败策略。
2. 通用事件接口、事件名、载荷类型及生产者/消费者清单。
3. 哪些核心方法允许注册，以及如何避免字符串式动态调用削弱类型安全。
4. 每个长期任务的所有者、启动条件、配置刷新行为、停止条件和资源清理方式。
5. 注册顺序、重复注册、异常隔离、关闭顺序和应用退出语义。
6. 现有事件总线与分散计时器的分阶段迁移、兼容和回滚方案。
7. 单元测试、集成测试、假时钟测试和真机冒烟范围。

## 本阶段明确禁止

> **S10+ 的解禁范围（附条件）**：下面第 4 条（定时器生命周期）与第 5 条（启动/配置刷新/退出流程）**已在 S10+ 阶段有条件解除**——只允许为"让长期任务能被显式启停"而改动，且每步必须同时给出计时器/接线的守护与证伪探针。**其余四条仍然有效**，尤其第 2 条：删的是 `Orchestrator` 的**兜底**总线，`createEventBus()` 本体保留。解禁**不**包括"把长期任务收进一个按名字分发的运行时注册表"——那还是禁止的。

- 不新增事件或方法注册表实现。
- 不替换现有事件总线。
- 不修改 SnowLuma 入站事件处理。
- ~~不移动或统一现有定时器生命周期。~~（**S10+ 有条件解除**，见上）
- ~~不修改应用启动、配置刷新或退出流程。~~（**S10+ 有条件解除**，见上）
- 不为业务方法增加字符串注册或运行时热替换机制。
