// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import type { ServerResponse } from 'node:http';
import { getConfig, updateConfig } from '../core/config.js';
import { EVENTS } from '../core/events.js';
import type { AppEmit } from '../core/events.js';
import { OneBotClient } from '../qq/onebot.js';
import { ChatStore } from '../chat/store.js';
import { MemoryStore } from '../chat/memory.js';
import { StickerManager } from '../stickers/sticker-manager.js';
import { SendQueue } from '../qq/sender.js';
import { SessionRegistry } from '../chat/sessions.js';
import { Orchestrator } from '../agent/runtime/orchestrator.js';
import { initPriceFeed, stopPriceFeed } from '../llm/price-feed.js';
import { initJmcomicQueue, stopJmcomicQueue } from '../media/jmcomic.js';
import { VideoTranscriptionQueue } from '../media/video-transcription.js';
import { createEventBus } from '../core/util.js';
import { projectSse, writeSse } from './http/event-projector.js';
import { startLifecycle, stopLifecycle } from './runtime/lifecycle.js';
import type { LifecycleDeps } from './runtime/lifecycle.js';
import { createSnowlumaController } from './onebot/snowluma.js';
import { createTokenBridge } from './onebot/tokens.js';
import type { OneBotRuntime } from './onebot/tokens.js';
import { createIngest } from './onebot/ingest.js';
import { createConsole } from './http/console.js';
import { errorMessage, isRecord } from './http/http.js';
import type { AppHandle, CreateAppOptions } from './types.js';
import { HotSearchScheduler } from '../media/hot-search/scheduler.js';
import { createHotSearchAdminActions } from '../media/hot-search/admin-actions.js';

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
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
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
  const transcription = new VideoTranscriptionQueue({ onebot, sender, getConfig, log });
  const hotSearchScheduler = new HotSearchScheduler({ getConfig, updateConfig, sender, log });
  // 这两个能力对象先建、再交给 Orchestrator：模型的两个工具（transcribe_video / get_hot_search）
  // 需要它们，而依赖是从 Orchestrator → WakeScheduler（`AgentRunnerHost`）→ ToolContext 透传的。
  const orchestrator = new Orchestrator({
    store, memory, stickers, sender, sessions, onebot, emit,
    transcription, hotSearch: hotSearchScheduler
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


  // ── 入站事件处理 ──
  // 白名单判断、@ 名字解析、引用预览、合并转发展开与拍一拍都在 `web/onebot/ingest.ts`
  // 里（`atNameCache` 与引用预览上限是摄取器自己的状态，组装根不需要知道）。
  // 组装根只把 OneBot 的入站回调接到 `ingest.handle()` 上。
  const ingest = createIngest({ onebot, store, sender, orchestrator, transcription, emit, getConfig, log });

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
      jmcomic: { init: initJmcomicQueue, stop: stopJmcomicQueue },
      transcription: { start: () => transcription.start(), stop: () => transcription.stop() },
      hotSearch: { start: () => hotSearchScheduler.start(), stop: () => hotSearchScheduler.stop() }
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
