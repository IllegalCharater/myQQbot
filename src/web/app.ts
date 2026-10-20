// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import type { ServerResponse } from 'node:http';
import { getConfig, updateConfig } from '../core/config.js';
import { EVENTS } from '../core/events.js';
import type { AppEmit } from '../core/events.js';
import { OneBotClient } from '../qq/onebot.js';
import { ChatStore } from '../chat/store.js';
import type { ChatMessage } from '../chat/types.js';
import { MemoryStore } from '../chat/memory.js';
import { StickerManager } from '../stickers/sticker-manager.js';
import { SendQueue } from '../qq/sender.js';
import { SessionRegistry } from '../chat/sessions.js';
import { Orchestrator } from '../agent/runtime/orchestrator.js';
import { initPriceFeed, stopPriceFeed } from '../llm/price-feed.js';
import { addUsage, chatCompletion, emptyUsage } from '../llm/llm.js';
import { initJmcomicQueue, stopJmcomicQueue, enqueueJmcomicDownload } from '../media/jmcomic/index.js';
import type { JmcomicCompletion } from '../media/jmcomic/index.js';
import { VideoTranscriptionQueue } from '../media/transcription/index.js';
import type { TranscriptStatus } from '../media/transcription/index.js';
import { ImageGenQueue } from '../media/image-gen/index.js';
import type { ImageResultStatus } from '../media/image-gen/index.js';
import { createEventBus } from '../core/util.js';
import { projectSse, writeSse } from './http/event-projector.js';
import { startLifecycle, stopLifecycle } from './runtime/lifecycle.js';
import type { LifecycleDeps } from './runtime/lifecycle.js';
import { createSnowlumaController } from './onebot/snowluma.js';
import { createTokenBridge } from './onebot/tokens.js';
import type { OneBotRuntime } from './onebot/tokens.js';
import { createIngest } from './onebot/ingest.js';
import { createCommandDispatcher } from './onebot/commands.js';
import { createConsole } from './http/console.js';
import { errorMessage, isRecord } from './http/http.js';
import type { AppHandle, CreateAppOptions } from './types.js';
import { HotSearchScheduler } from '../media/hot-search/scheduler.js';
import { createHotSearchAdminActions } from '../media/hot-search/admin-actions.js';
import { initPicImageSearch, closePicImageSearchClient } from '../media/image-source/index.js';
import { buildToolDefs } from '../agent/tools/index.js';
import { createExtrasRuntime } from '../extra/runtime.js';
import { EXTRA_REGISTRY } from '../extra/registry.js';
import type { ExtraNote } from '../extra/types.js';

export type { AppHandle, CreateAppOptions } from './types.js';


// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', errorMessage(error));
}

export function createApp({ log = console.log }: CreateAppOptions = {}): AppHandle {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set<ServerResponse>();

  const emit: AppEmit = (type, payload) => {
    bus.emit(type, payload);
    // 帧的拼装（含 session-update 的会话投影）在 event-projector.ts 里，
    // 是纯函数、可单测；这里只负责"广播给所有 SSE 客户端"。
    writeSse(sseClients, projectSse(type, payload, { sessions }));
  };

  // SnowLuma 的程序目录、子进程、日志环形缓冲、端口探活与 WebUI 地址都在
  // `web/onebot/snowluma.ts` 里 —— 组装根只留接线，不再自带那台机器的任何状态。
  // 在这里构造是因为它要靠 `emit` 发 `snowluma-log` / `snowluma-status`。
  const snowluma = createSnowlumaController({
    getConfigDir: () => String(getConfig().snowluma?.dir || ''),
    emit,
    log
  });

  // ── 组件 ──
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  // `onFinish` 是"一次 agent 运行结束了"的唯一通知点（收尾在 `SessionRegistry.finish`）。
  // 跑团的兜底建议挂在这上面：**DM 整轮一句话没说、而且这一轮是真人推动的**时，才生成
  // 几个方向交回流条目，由下一轮的 DM 自己说出来（判据全在 `extra/trpg/impl.ts` 的 `onRunEnd`）。
  //
  // 用函数声明（会提升）：`extras` 要到下面才构造，而这个函数体要等真的有一次运行收尾
  // 才会执行，那时它早就建好了（与 `deliverAsyncResult` 同一个理由）。
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0, {
    onFinish: (session) => extras.runEnded({
      chatKey: session.chatKey,
      status: session.status,
      sentCount: session.sent.length,
      // `trigger` 在类型上是 `unknown`（面板/投影按需读），这里按数组收窄 —— 收窄失败时
      // 给空数组（"没有触发消息"），扩展那边就会因为"不是真人推动的"而不动作。
      trigger: Array.isArray(session.trigger) ? (session.trigger as ChatMessage[]) : []
    })
  });   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => ingest.handle(event).catch((error: unknown) => log('[ingest] 处理事件出错:', errorMessage(error)))
  }) as OneBotRuntime;
  onebot.tokenCandidates = [];
  // onChange：bot 自己改库（收藏/改备注/发过）时也让面板那页刷新 —— 否则用户正看着
  // 表情页，模型在群里偷偷收藏了一张，页面不会动。
  const stickers = new StickerManager(onebot, { onChange: () => emit(EVENTS.stickerUpdate, {}) });
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  // ── 异步回流的**共同接线**（转写 / 漫画 / 出图三条共用）──
  //
  // 顺序照 ingest：先落存档 → 再入窗（`onIncoming` 会推窗口并按防抖唤醒）→ 最后通知面板。
  // 三条只差"用哪个 append* 落库、正文怎么写"，那部分在各自的 sink 里一行说完。
  //
  // 为什么这段留在组装根：它同时碰 store、orchestrator 端口与 emit —— **它就是共享组件图**，
  // 按"只碰共享图的不搬"的判据不搬。web/ 根目录白名单也不允许新开文件；onebot/ 是入站侧、
  // runtime/ 是长期任务与退出路径，都不合适。
  //
  // 用函数声明（会提升）：下面传给各队列时 `orchestrator` 这个 const 还没初始化，
  // 但函数体要等到 `start()` 之后、队列真正投递时才会执行，那时它早就建好了。
  function deliverAsyncResult(chatKey: string, entry: ChatMessage) {
    orchestrator.onIncoming(chatKey, entry);
    emit(EVENTS.chatUpdate, chatKey);
  }

  // 转写结果的回流。**成功与失败都走这一条**（`status` 两态，与出图/漫画同形，2026-10-10 统一）：
  // 识别失败时同样落成一条未读条目，让模型自己给群友一句交代 —— 队列不再代它往群里贴
  // 「转写失败」，否则那一轮会按"已经发过消息"收尾成 done，模型以为群里已经知道了。
  function deliverTranscript({ chatKey, text, status, truncated, chars, reason }: {
    chatKey: string; text: string; status: TranscriptStatus;
    truncated: boolean; chars: number; reason: string;
  }) {
    deliverAsyncResult(chatKey, store.appendTranscript(chatKey, { text, status, truncated, chars, reason }));
  }

  // 漫画队列的完成回流与转写同形：文件仍由队列确定性上传；OneBot 确认接收后，
  // 再把一条未读机器结果送进窗口，触发 Agent 给请求者自然收尾。
  // **失败也走这条路**（2026-10-10 统一）：队列不再往群里贴 ❌/⚠️ 文案，改由模型交代。
  function deliverJmcomicCompletion({ chatKey, comicId, cached, status, reason }: JmcomicCompletion) {
    deliverAsyncResult(chatKey, store.appendJmcomicResult(chatKey, { comicId, cached, status, reason }));
  }

  // 出图结果的回流：图片由队列直接发进群（图片就是交付物，模型没法"说"出一张图），
  // 条目承载"画好了 / 没发成 / 没画成"这个事实，触发一次运行让模型有机会开口 ——
  // 说不说、说什么由它自己决定。**失败也走这条路**（不是队列代它往群里贴一句）：
  // 这条路上模型只调了一次工具就结束本轮，随后那次运行才是它开口的地方。
  function deliverImageResult({ chatKey, prompt, status, reason }: {
    chatKey: string; prompt: string; status: ImageResultStatus; reason: string;
  }) {
    deliverAsyncResult(chatKey, store.appendImageResult(chatKey, { prompt, status, reason }));
  }

  // 出图的**提示词编译端口**（可选，见 `media/image-gen/compile.ts`）。
  //
  // 为什么在组装根建：`llm` 与 `media` 同属 T1、严格互斥（`check-layers.mjs` 的
  // `T1_ALLOW` 是空集），队列 import 不了 `llm/`。所以"真的去调一次模型"只能由这里接过去，
  // 与扩展那几个口子（`deliverNote` / `sendPrivate` / `sendFile`）是同一条分工。
  //
  // 三条边界：
  // ① **温度 0.2**：这是**转换**不是创作 —— 同一个需求编译两次该得到同一个结果
  //    （同跑团抽取管线与剧本格式整理那条）；
  // ② **用量走 `sessions.addExtraUsage`**（只叠增量）：编译跑在后台队列里，多半已经在那次
  //    会话 `finish()` 之后，而 `#persist` 对已结束的会话会整份重复累加（同跑团的兜底建议
  //    与暗骰叙事那两次独立调用）；
  // ③ **这里只交回原始字符串**，正/负两段的解析归 `compile.ts` —— 假端口才不必模拟一套解析。
  async function compileImagePrompt(
    { system, user }: { system: string; user: string }, signal: AbortSignal
  ) {
    try {
      const result = await chatCompletion({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.2,
        signal
      });
      if (result.usage) sessions.addExtraUsage(addUsage(emptyUsage(), result.usage));
      return { ok: true as const, content: String(result.message?.content ?? '') };
    } catch (error) {
      // 交回原始 message：`compile.ts` 会过一道 `safeErrorDetail`（去 URL 与本机路径）
      // 再进日志。这里自己洗一遍就等于有两份洗法，必然漂移。
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
    }
  }

  // 扩展递进来的机器条目（跑团的【跑团笔记】/【行动建议】）。与上面三条**走同一条路** ——
  // 落存档 → 入窗 → 通知面板，因为它要的正是同一件事：让模型看到并自己开口。
  //
  // 扩展只说"这是一条什么、正文是什么"（`ExtraNote`），**怎么落库在这里决定** —— 那一层
  // 不该知道 `ChatMessage` 的形状（它连 `chat/store.js` 都不必认识）。
  function deliverNote(chatKey: string, note: ExtraNote) {
    deliverAsyncResult(chatKey, store.appendTrpgNote(chatKey, { noteKind: note.kind, text: note.text }));
  }

  // 扩展运行时（`src/extra/`）：工具**声明**在这里静态拼进工具表，**实现**等模型首次调用那个
  // 工具时才 `import()`；空闲超过 `extras.idleUnloadMs` 就 dispose 掉重资源（工具仍留在表里）。
  //
  // 为什么在组装根建：它同时要 `getConfig`、要"内置工具名"（查重用）、要把工具表递给 Orchestrator，
  // 还要进装配清单的启停 —— 它**就是共享组件图**，按"只碰共享图的不搬"的判据留在 app.ts。
  // `builtinToolNames` 用 `buildToolDefs()` 再算一次是刻意的：这样 extra 层不必认识 agent 层
  // （反向依赖会被 check-layers 拦），而这里的两次调用共用同一份无参语义，不会漂移。
  const extras = createExtrasRuntime(EXTRA_REGISTRY, {
    getConfig,
    builtinToolNames: buildToolDefs().map((def) => def.name),
    log,
    // 扩展把机器条目送回会话的口子（跑团的【跑团笔记】/【行动建议】）。
    // 只有它需要：`deliverNote` 是**宿主才知道怎么做**的事（要落 `ChatStore`、要入窗），
    // 而扩展那一层连 `chat/store.js` 都不必认识。
    deliverNote,
    // 私聊投递（跑团的暗骰）。`SendQueue` 本来就收 `private:<QQ>` 这种键，
    // 所以这里只是把它包一层 —— 扩展那一侧只说"给谁、说什么"。
    sendPrivate: async (targetUserId: string, text: string) => {
      await sender.sendTextBatch(`private:${targetUserId}`, text);
    },
    // 群文件投递（跑团的 `.log export`）。同一条分工：扩展只说"文件名 + 正文"，
    // 落临时文件、`upload_*_file`、留档都在 `SendQueue` 里。
    sendFile: async (chatKey: string, fileName: string, content: string) => {
      await sender.sendFile(chatKey, fileName, content);
    },
    // 往会话里补一句话（跑团的 `.trpg scenario` 用它发"抽完了"的第二条回执）。
    // 与 `deliverNote` 不是一回事：那个是给模型的机器条目（会唤醒一次运行），这个只是发进群。
    sendText: async (chatKey: string, text: string) => {
      await sender.sendTextBatch(chatKey, text);
    },
    // 记一次**不在任何会话里**的模型调用用量（跑团的兜底建议与暗骰叙事那两次独立调用）。
    // 它们发生在 `finish()` 之后，所以走的是"只叠增量"的那个入口 —— 会话那条记账路对
    // 已结束的会话会整份重复累加（见 `chat/sessions.ts` 的 `addExtraUsage`）。
    recordUsage: (usage) => sessions.addExtraUsage(usage)
  });
  // 内置工具表算一次就够（它是常量，只有扩展那部分是变的）—— 上面那次调用只是为了拿名字。
  const BUILTIN_TOOLS = buildToolDefs();

  const transcription = new VideoTranscriptionQueue({ onebot, sender, getConfig, log, deliverTranscript });
  const imageGen = new ImageGenQueue({
    sender, getConfig, log, deliverImageResult, compilePrompt: compileImagePrompt
  });
  const hotSearchScheduler = new HotSearchScheduler({ getConfig, updateConfig, sender, log });
  // 这三个能力对象先建、再交给 Orchestrator：模型的三个工具（transcribe_video /
  // generate_image / get_hot_search）需要它们，而依赖是从 Orchestrator → WakeScheduler
  // （`AgentRunnerHost`）→ ToolContext 透传的。
  const orchestrator = new Orchestrator({
    store, memory, stickers, sender, sessions, onebot, emit,
    transcription, imageGen, hotSearch: hotSearchScheduler,
    // 工具表**是按会话算的函数**：扩展由 `/能力` 命令装载/卸载，而**未装载的扩展工具不在表里**；
    // **接管还按会话隔离** —— 被接管的那个会话只剩接管者的工具（内置那部分整体让位），
    // 别的会话照常。`runAgent` 每次运行开头读一次，所以语义是"下一次运行生效"。
    toolDefs: (chatKey) => {
      const mine = extras.toolDefs(chatKey);
      return extras.isOverridden(chatKey) ? mine : [...BUILTIN_TOOLS, ...mine];
    },
    // 提示词计划同理，每次运行现读：它取决于这个会话此刻的状态。
    extraPrompt: (chatKey) => extras.promptPlan(chatKey),
    // **这一轮运行读的配置**：全局那份叠上本会话里可用扩展的运行期覆盖（不落盘、不外溢）。
    // `agent-runner` 开头算一次、一路传下去 —— 提示词那边也收这一份，不再自己读全局。
    configFor: (chatKey) => extras.configFor(chatKey)
  });
  const hotSearch = createHotSearchAdminActions(hotSearchScheduler);

  // 长期任务一律在 start() 里启动、在 stop() 里停止（见 src/web/tasks.ts）。
  // 这里不启动任何后台任务 —— 构造对象图不该有副作用，而且真正需要它们的是
  // "端口监听成功 + 已连上 OneBot"之后的那个时刻。

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit(EVENTS.onebotStatus, status));

  // ── SnowLuma 令牌桥 ──
  // 候选收集、401 轮换、限频与去重签名都在 `web/onebot/tokens.ts` 里；组装根只把它
  // 接到实例上（`start()` 里 `sync()` 一次，`watch()` 装 401 监听）。
  const tokens = createTokenBridge({ onebot, snowlumaDir: () => snowluma.dir(), getConfig, updateConfig, log });
  tokens.watch();


  // ── 斜杠命令 ──
  // 命令表**是 provider 而不是数组**：扩展命令与"是否接管中"都会在运行期变（`/能力` 装载/卸载）。
  // `/能力` 那条主流程命令拿到的是 `extras` 的三个口子，与 `/漫画` 只拿 `enqueue` 同形。
  const commands = createCommandDispatcher(
    (chatKey) => ({ override: extras.isOverridden(chatKey), commands: extras.commandDefs(chatKey) }),
    // `/能力` 的几个口子。装载/卸载只在这里接出去 —— **模型侧没有任何口子**；
    // `load`/`unload` 带上会话，是因为**接管按会话隔离**（附加模式用不到它）。
    {
      list: () => extras.list(),
      load: (id, reason, chatKey) => extras.load(id, reason ?? 'command', chatKey ?? ''),
      unload: (id, chatKey) => extras.unload(id, chatKey ?? '')
    },
    // 主流程命令的执行记录（会话页）。只有 `/转写` `/画` `/漫画` `/能力` 会走到它，
    // 判据在 `CommandEntry.recordSession` —— 扩展命令不进会话页。
    {
      begin: (input) => sessions.beginCommand(input),
      stage: (id, name, detail) => sessions.stageCommand(id, name, detail),
      end: (id, status, receipt) => sessions.finishCommand(id, status, receipt)
    }
  );

  // ── 入站事件处理 ──
  // 白名单判断、@ 名字解析、引用预览、合并转发展开与拍一拍都在 `web/onebot/ingest.ts`
  // 里（`atNameCache` 与引用预览上限是摄取器自己的状态，组装根不需要知道）。
  // 组装根只把 OneBot 的入站回调接到 `ingest.handle()` 上。
  const ingest = createIngest({
    onebot, store, sender, orchestrator, transcription, imageGen, commands, emit, getConfig, log,
    // 扩展拦普通消息的口子（`ExtraRuntime.intercept`）。与 `/漫画` 只拿 `enqueue` 同形：
    // 接入层只拿它要用的那一个方法，不把整个扩展运行时塞进去。
    extras: { intercept: (chatKey, input) => extras.intercept(chatKey, input) },
    // `/漫画 <ID>` 只拿到"入队"这一个口子；`onebot/sender/store` 在这里补齐 ——
    // 漫画队列的运行时依赖本来就是这么绑的（与工具路径同一个 `enqueueJmcomicDownload`）。
    jmcomic: {
      enqueue: ({ chatKey, kind, chatId, requesterId, comicId }) =>
        enqueueJmcomicDownload({ onebot, sender, store, chatKey, kind, chatId, requesterId }, comicId)
    }
  });

  // ── 控制台 HTTP 表面 ──
  // SSE 端点、鉴权、路由分发、静态文件、状态快照（`buildStatus`）与配置脱敏
  // （`sanitizeConfig`）都在 `web/console.ts` 里 —— 它们既不是组件的新建/组装，
  // 也不是事件绑定，只回答"外部请求进来时怎么答"。组装根只拿自己需要的两样。
  // 留在本地的两样各有理由：`sseClients` 要跟 `emit` 闭包共用同一个集合；
  // `applyConfigPatch` 是"把配置变更接到组件上"（与 `start()` 同类），以依赖形式转交。
  const { server, listenOn } = createConsole({
    sseClients, store, memory, sessions, onebot, sender, stickers, orchestrator,
    emit, snowluma, hotSearch, getConfig, updateConfig, applyConfigPatch, log
  });

  function applyConfigPatch(patch: unknown) {
    const next = updateConfig(patch as Record<string, unknown>);
    store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
    if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
    if (next.compact?.enabled) orchestrator.startCompactLoop(); else orchestrator.stopCompactLoop();
    initPriceFeed(next.api?.priceRemoteUrl || '');
    // 运行期配置保存只重建热搜自己的 cron 句柄；不重跑整张 LIFECYCLE（其中还有无条件任务）。
    void hotSearchScheduler.refresh().catch((error) => log('[hot-search] 重建计划失败:', errorMessage(error)));
    // 端点（ws/http 地址与令牌）变了就重连 —— S11b 补上的缺口：以前改 snowluma.wsUrl
    // 保存之后实例还指着旧地址，必须重启应用才生效。**只在真的变了时重连**：applyEndpoint
    // 拿同一份归一化做比较，所以"保存了一次没动端点的设置"不会断连。
    // httpToken 的"留空沿用 accessToken"与构造函数同一规则，在这里解析（见 applyEndpoint 注释）。
    if (onebot.applyEndpoint({
      wsUrl: next.snowluma?.wsUrl,
      httpUrl: next.snowluma?.httpUrl,
      accessToken: next.snowluma?.accessToken,
      httpToken: next.snowluma?.httpAccessToken || next.snowluma?.accessToken
    })) onebot.reconnect();
    // 与 orchestrator 的暂停事件曾共用 `'status'` 一个名字（§3.4 一），S4 拆开
    emit(EVENTS.configApplied, { configUpdated: true });
    return next;
  }

  // 剩下的两样只作指针：`buildStatus`（面板状态快照，控制台的读模型）与
  // `openSnowlumaFolder`/`openSnowlumaWebui`（`web/onebot/snowluma.ts` 的 `openFolder`/`openWebui`）
  // 都在 `createConsole` 的 ctx 里就地适配，组装根本地不再各自留一份。

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  /**
   * 装配清单（`web/lifecycle.ts`）要的能力。**这是"装的是什么"的唯一落点**：
   * 清单只管顺序与开关，真模块函数在这里递进去。
   * `tests/t-lifecycle.mjs` 第 3 段会扫这段文本，确认递的确实是真东西而不是空实现
   * （模块级的清单测试用的是假 deps，证明不了这一点）。
   */
  function lifecycleDeps(): LifecycleDeps {
    return {
      getConfig,
      onebot,
      orchestrator,
      sender,
      store,
      priceFeed: { init: initPriceFeed, stop: stopPriceFeed },
      jmcomic: { init: initJmcomicQueue, stop: stopJmcomicQueue, onCompleted: deliverJmcomicCompletion },
      transcription: { start: () => transcription.start(), stop: () => transcription.stop() },
      imageGen: { start: () => imageGen.start(), stop: () => imageGen.stop() },
      hotSearch: { start: () => hotSearchScheduler.start(), stop: () => hotSearchScheduler.stop() },
      // 搜图 worker 自己吞掉预热失败（没装库不该掀翻 app.start()），所以这里直接递真函数即可。
      imageSource: { start: initPicImageSearch, stop: () => closePicImageSearchClient() },
      // 扩展运行时：start 只清装载状态（懒加载不预加载），stop 清空闲计时器并 dispose 全部已装载项。
      extras: { start: () => extras.start(), stop: () => extras.stop() }
    };
  }

  async function start() {
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (!isRecord(error) || error.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const servicePort = snowluma.servicePort();
        if (!(await snowluma.isPortOpen('127.0.0.1', servicePort))) {
          const r = await snowluma.launch();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await snowluma.isPortOpen('127.0.0.1', servicePort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', errorMessage(error));
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (tokens.sync()) {
      const c = getConfig();
      // accessToken/httpToken 已由 applyTokens 直接挂到实例（候选[0]），这里只补两个 URL。
      // 走 applyEndpoint 而不是直接赋值：归一化规则从此只有一份（S11b），
      // "配置里的地址"与"实例上的地址"在比较口径上是一致的。
      onebot.applyEndpoint({ wsUrl: c.snowluma?.wsUrl || onebot.wsUrl, httpUrl: c.snowluma?.httpUrl || onebot.httpUrl });
    }
    // 长期任务一律走装配清单（S11c）：顺序写死在 `web/lifecycle.ts` 的数组里，
    // 这里只负责把真模块递进去。原先这里是从 `onebot.connect()` 到
    // `initJmcomicQueue(...)` 的六行硬编码调用——那种写法少一行、多一行、
    // 调换两行的顺序都不会有任何编译错误，只有行为变了。
    await startLifecycle(lifecycleDeps());
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    await orchestrator.abortAll();
    // 长期任务一律**逆序**拆（清单第一位是 `onebot.reconnect`，逆序后它就是最后被拆的）。
    // 于是"停长期任务必须排在 `onebot.close()` 之前"（在途的 QQ 上传还依赖传输层）
    // 是顺序自动保证的，不再靠谁记得住；`server.close()` 仍在其后。
    // 注意 proactive / compact 会被停两次（`abortAll()` 一次、清单一次）——两者的 stop
    // 都是幂等的（只清句柄置 null），S11c 落地时逐条核过。
    await stopLifecycle(lifecycleDeps());
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程。
    // 注意：SnowLuma 退出时不一定能立刻把 config 落盘，但我们的 stop 不会再去读它，
    // 下次启动会读到完整文件。
    try { snowluma.stop(); } catch { /* ignore */ }
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, applyConfigPatch, launchSnowluma: () => snowluma.launch(), stopSnowluma: () => snowluma.stop(), snowlumaStatus: () => snowluma.status() };
}
