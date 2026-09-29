// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 消息进动态上下文窗口（src/context-window.js，谁到就收谁、超出上限丢最老）
//   → 判定这批值不值得回应：值得就把窗口里"还没看过"的那批当【本次唤醒】；不值得就只看不答
//   → 两条分支都会推进窗口游标（看过就是看过）→ 会话弃置（不留 LLM 历史）
//   → 发现窗口还有没看过的 → drainDelayMs 后再新开会话 → …
//   → 直到没有未看过 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息照样进窗口（进 JSON、未读），
// 只是不叠加触发 —— 运行结束后 drain 会接着处理。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig } from '../../core/config.js';
import { EVENTS } from '../../core/events.js';
import type { AppEmit } from '../../core/events.js';
import { buildToolDefs } from '../tools/index.js';
import { ContextWindowRegistry } from '../context/context-window.js';
import { isRecord } from '../shared/json-parse.js';
import { ProactiveController } from '../maintenance/proactive-controller.js';
import { MemoryConsolidator } from '../maintenance/memory-consolidator.js';
import { HistoryCompactor } from '../maintenance/history-compactor.js';
import { WakeScheduler } from './wake-scheduler.js';
import type { ChatMessage } from '../../chat/types.js';
import type { ChatStore } from '../../chat/store.js';
import type { MemoryStore } from '../../chat/memory.js';
import type { StickerManager } from '../../stickers/sticker-manager.js';
import type { SendQueue } from '../../qq/sender.js';
import type { SessionRegistry } from '../../chat/sessions.js';
import type { OneBotClient } from '../../qq/onebot.js';
import type { ChatRuntimeState, OrchestratorDependencies } from '../shared/types.js';
import type { AgentControlPort } from './control-port.js';

export class Orchestrator implements AgentControlPort {
  store: ChatStore;
  memory: MemoryStore;
  stickers: StickerManager;
  sender: SendQueue;
  sessions: SessionRegistry;
  onebot: OneBotClient;
  emit: AppEmit;
  windows: ContextWindowRegistry;
  wakeTimers: Map<string, ReturnType<typeof setTimeout>>;
  pendingWake: Set<string>;
  pendingSessions: Map<string, string>;
  consolidating: Set<string>;
  memoryConsolidator: MemoryConsolidator;
  runningChats: Set<string>;
  activeRuns: Map<string, string>;
  chatStates: Map<string, ChatRuntimeState>;
  scheduler: WakeScheduler;
  compacting: Set<string>;
  historyCompactor: HistoryCompactor;
  paused: boolean;
  pauseReason: string | null;
  proactive: ProactiveController;
  aborted: boolean;

  /** 群名缓存：groupId -> name，只有 `getChatName` / `#chatName` 用，不对类外暴露。 */
  #chatNameCache = new Map<string, string>();

  constructor({ store, memory, stickers, sender, sessions, onebot, emit, windows = null, transcription, hotSearch }: OrchestratorDependencies) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.emit = emit;   // S10d：不再兜底建空总线，缺了编译不过（见 shared/types.ts 的说明）
    // 工具定义只在这里建一次、只递给下面的 WakeScheduler（它是 `AgentRunnerHost`，
    // `runAgent(this, …)` 里的 `host` 就是 scheduler，不是本类）。所以它不需要是字段。
    const toolDefs = buildToolDefs();

    // jmcomic 队列不在构造函数里启动（S10b）：长期任务一律在 app.start() 起、app.stop() 停，
    // 见 src/web/app.ts 与 AGENTS.md「事件与长期任务边界」。

    // 动态上下文窗口（每会话一个，见 src/context-window.js）。
    // 容量每次现读配置 —— 设置页改上限要即时生效，不能在构造时固化。
    this.windows = windows instanceof ContextWindowRegistry ? windows : new ContextWindowRegistry({
      store,
      capacity: () => Math.max(0, Number(getConfig().store?.maxContextMessages) || 0)
    });

    this.memoryConsolidator = new MemoryConsolidator({
      store: this.store,
      memory: this.memory,
      isPaused: () => this.paused,
      isAborted: () => this.aborted
    });
    this.consolidating = this.memoryConsolidator.running;
    // chatKey -> {
    //   state: 'silent' | 'replying',
    //   phase: 'waiting' | 'running' | '',
    //   since: 进入回复态的时刻（用于 UI 显示"回复中 3s"），
    //   batchStartedAt: 本批第一条消息的时刻（等待窗口硬上限的计时起点），
    //   roll: 本批固定的随机骰子（0~100，见 #resolvePendingResponse 的说明），
    //   waitingSessionId: 当前"等待中"会话 id
    // }
    //
    // 为什么不从 pendingWake / runningChats 推导状态？scheduleWake 里档位预判翻转为
    // "不响应"时会丢弃等待会话（#discardWaiting），而 pendingWake 仍置位、计时器仍
    // armed —— 推导出来的状态会对一个明显什么都没做的会话报"回复态"。只有显式的
    // Map 才能让"静默态"有意义，也才能让状态跟随用户真正看得到的等待会话。
    this.scheduler = new WakeScheduler({
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      sessions: this.sessions,
      onebot: this.onebot,
      windows: this.windows,
      toolDefs,
      emit: (event, payload) => this.emit(event, payload),
      getChatName: (groupId) => this.getChatName(groupId),
      // 群友印象自动整理：触发条件是"印象条数超过阈值 **且** 距上次整理超过冷却时间"，
      // 判定本身在 `MemoryConsolidator.maybeSchedule()` 里。
      // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
      // → 自动整理永远不触发。改为可配置（`config.memory.consolidateMinImpressions`）
      // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
      maybeConsolidateMemory: (chatKey) => this.memoryConsolidator.maybeSchedule(chatKey),
      isPaused: () => this.paused,
      isAborted: () => this.aborted,
      // 能力型工具依赖原样透传（本类不用它们，`runAgent` 的 `host` 是上面的 scheduler）。
      transcription,
      hotSearch
    });
    // 下面这 6 行是**引用拷贝**，不是再建一份：`abortAll()` 里的 `chatStates.clear()`、
    // 测试里的 `orc.pendingWake` 能生效，全靠门面与 scheduler 指的是同一个 Set/Map。
    // 因此 scheduler 侧只能**改写容器内容**，绝不能替换容器本身
    // （写成 `this.pendingWake = new Set()` 会让这里静默指向旧容器，而 `tsc` 不会报错）。
    this.wakeTimers = this.scheduler.wakeTimers;
    this.pendingWake = this.scheduler.pendingWake;
    this.pendingSessions = this.scheduler.pendingSessions;
    this.runningChats = this.scheduler.runningChats;
    this.activeRuns = this.scheduler.activeRuns;
    this.chatStates = this.scheduler.chatStates;
    this.historyCompactor = new HistoryCompactor({
      store: this.store,
      windows: this.windows,
      runningChats: this.runningChats,
      pendingWake: this.pendingWake,
      memoryConsolidator: this.memoryConsolidator,
      emit: (event, payload) => this.emit(event, payload),
      isPaused: () => this.paused,
      isAborted: () => this.aborted
    });
    this.compacting = this.historyCompactor.running;
    this.paused = false;
    this.pauseReason = null;
    this.proactive = new ProactiveController({
      store: this.store,
      windows: this.windows,
      runningChats: this.runningChats,
      isPaused: () => this.paused,
      isAborted: () => this.aborted,
      // 主动冒泡的唤醒**刻意**不同于普通唤醒，`{ proactive: true }` 是这个区别的唯一载体
      // （`wake-scheduler.ts` 的 `wake()`：`isPaused() && !proactive` 才早退、跳过响应档位
      // 判定、不取触发批只带状态）。以前这里绕了一层 `this.wake(chatKey, {proactive:true})`，
      // 那个门面方法没有任何别的调用者，且它多暴露了一个只有 scheduler 自己用的
      // `waitingSessionId` —— 直接打给 scheduler，语义不变、对外面收窄。
      wake: (chatKey) => this.scheduler.wake(chatKey, { proactive: true })
    });
    this.aborted = false;
  }

  get proactiveTimer(): ReturnType<typeof setTimeout> | null {
    return this.proactive.timer;
  }

  get compactTimer(): ReturnType<typeof setTimeout> | null {
    return this.historyCompactor.timer;
  }

  /**
   * 恢复后处理：所有当前有未处理消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未处理，不丢失）。
   *
   * 判据是**窗口里还没看过的消息**（不是存档的 read 字段）：暂停期间消息照样进窗口，
   * 进程重启后窗口由存档播种，两种情况下这里的判断都成立。
   */
  drainBacklogAfterResume(): void {
    this.scheduler.drainBacklogAfterResume();
  }

  chatState(chatKey: string): ChatRuntimeState | null {
    return this.scheduler.chatState(chatKey);
  }

  markChatSeen(chatKey: string): number {
    return this.scheduler.markChatSeen(chatKey);
  }

  reloadWindow(chatKey: string): void {
    this.scheduler.reloadWindow(chatKey);
  }

  onIncoming(chatKey: string, entry: ChatMessage | null = null): void {
    this.scheduler.onIncoming(chatKey, entry);
  }

  scheduleWake(chatKey: string, delay: number | null = null): void {
    this.scheduler.scheduleWake(chatKey, delay);
  }

  forceWake(chatKey: string): boolean {
    return this.scheduler.forceWake(chatKey);
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId: string | number): Promise<string> {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId: string | number): Promise<string> {
    const key = String(groupId);
    if (this.#chatNameCache.has(key)) return this.#chatNameCache.get(key) ?? '';
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (isRecord(info) && info.group_name) {
        this.#chatNameCache.set(key, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop(): void {
    this.proactive.start();
  }

  consolidateMemoryForChat(
    chatKey: string,
    options: { userIds?: unknown[] | null; force?: boolean } = {}
  ) {
    return this.memoryConsolidator.consolidateMemoryForChat(chatKey, options);
  }

  stopProactiveLoop() {
    this.proactive.stop();
  }

  // ── 定时压缩：摘要入档 + 原文冷归档 ─────────────────────────────────────
  //
  // 长期运行的群里存档只增不减：磁盘慢慢变大，【过去状态】也越来越贵。
  // 压缩把最老的一段交给模型摘要成一段纪要写回存档，原文移到冷归档（**不删除**）。
  //
  // 安全姿态（每一处都是刻意的）：
  //   - 摘要在**前面**：模型必须先返回可用摘要，此后才删任何东西；摘要失败 = 整轮零改动。
  //   - 只归档"模型真正看到的那部分"：先按字符预算从新往旧回填提示词，据此裁剪区间。
  //   - 按显式 id 集合删，不按下标（LLM 调用期间新到的消息会让下标错位）。

  /**
   * 启动压缩巡检（自重新调度的 setTimeout 链，镜像 startProactiveLoop）。
   * 区别：补上了 unref()（姿态同 price-feed.js）—— 巡检是纯维护任务，
   * 不该因为它一个 timer 把进程钉住不让退出。首次延迟也错开（60s vs proactive 15s）。
   */
  startCompactLoop(): void {
    this.historyCompactor.startCompactLoop();
  }

  stopCompactLoop(): void {
    this.historyCompactor.stopCompactLoop();
  }

  compactChat(chatKey: string, options: { force?: boolean } = {}) {
    return this.historyCompactor.compactChat(chatKey, options);
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused: boolean, reason = 'manual'): void {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    // 曾经与 app.ts 的配置变更共用 `'status'` 一个名字，载荷却互不相容（§3.4 一），
    // S4 拆成独立通道：订阅方按名字就能判断该刷什么。
    this.emit(EVENTS.orchestratorPause, { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    this.scheduler.abortPending();
    this.stopProactiveLoop();
    this.stopCompactLoop();
    // 状态与限速标记一并清空：进程要停了，留着只会让下次启动读到脏状态
    this.chatStates.clear();
    this.compacting.clear();
    this.sender.clearReplying?.();
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      consolidating: [...this.consolidating],
      // 静默态/回复态（供 UI 与 /api/status 显示"它现在在干嘛"）
      chatStates: [...this.chatStates.entries()].map(([chatKey, s]) => ({
        chatKey,
        state: s.state,
        phase: s.phase || '',
        since: s.since || 0
      })),
      compacting: [...this.compacting],
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}
