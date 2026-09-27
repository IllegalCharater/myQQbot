import { getConfig, storeConfigForChat } from '../core/config.js';
import { sleep } from '../core/util.js';
import { resolveContextTier } from './prompt.js';
import { isRetryableError } from '../llm/llm.js';
import { runAgent } from './agent-runner.js';
import { errorMessage } from './json-parse.js';
import { RuntimeStateRegistry } from './runtime-state.js';
import type { AgentRunOptions } from './agent-runner.js';
import type { ChatMessage, SessionRecord } from '../chat/types.js';
import type { ChatStore } from '../chat/store.js';
import type { MemoryStore } from '../chat/memory.js';
import type { StickerManager } from '../stickers/sticker-manager.js';
import type { SendQueue } from '../qq/sender.js';
import type { SessionRegistry } from '../chat/sessions.js';
import type { OneBotClient } from '../qq/onebot.js';
import type { ContextWindowRegistry } from './context-window.js';
import type { ChatRuntimeState, ContextTierResult, ToolDefinition } from './types.js';

export interface WakeSchedulerDependencies {
  store: ChatStore;
  memory: MemoryStore;
  stickers: StickerManager;
  sender: SendQueue;
  sessions: SessionRegistry;
  onebot: OneBotClient;
  windows: ContextWindowRegistry;
  toolDefs: ToolDefinition[];
  emit(event: string, payload?: unknown): unknown;
  getChatName(groupId: string | number): Promise<string>;
  maybeConsolidateMemory(chatKey: string): void;
  isPaused(): boolean;
  isAborted(): boolean;
}

export class WakeScheduler {
  readonly store: ChatStore;
  readonly memory: MemoryStore;
  readonly stickers: StickerManager;
  readonly sender: SendQueue;
  readonly sessions: SessionRegistry;
  readonly onebot: OneBotClient;
  readonly windows: ContextWindowRegistry;
  readonly toolDefs: ToolDefinition[];
  readonly emit: (event: string, payload?: unknown) => unknown;
  readonly runtimeState: RuntimeStateRegistry;
  readonly chatStates: Map<string, ChatRuntimeState>;
  readonly wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly pendingWake = new Set<string>();
  readonly pendingSessions = new Map<string, string>();
  readonly runningChats = new Set<string>();
  readonly activeRuns = new Map<string, string>();
  readonly runSeq = new Map<string, number>();

  constructor(private readonly deps: WakeSchedulerDependencies) {
    this.store = deps.store;
    this.memory = deps.memory;
    this.stickers = deps.stickers;
    this.sender = deps.sender;
    this.sessions = deps.sessions;
    this.onebot = deps.onebot;
    this.windows = deps.windows;
    this.toolDefs = deps.toolDefs;
    this.emit = deps.emit;
    this.runtimeState = new RuntimeStateRegistry(this.sender);
    this.chatStates = this.runtimeState.states;
  }

  get aborted(): boolean {
    return this.deps.isAborted();
  }

  getChatName(groupId: string | number): Promise<string> {
    return this.deps.getChatName(groupId);
  }

  abortPending(): void {
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.runtimeState.clear();
  }

  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.windows.pending(chatKey).length > 0) this.scheduleWake(chatKey, 0);
    }
  }

  // ── 静默态 / 回复态 ────────────────────────────────────────────────────
  //
  // 静默态 = 没有在对这个会话作答（不在表里或 state==='silent'）
  // 回复态 = 已经从这批消息里判定"要回应"，正在等待窗口里聚批或正在跑 agent
  //
  // 转换点（全部幂等，重入不会重置时钟）：
  //   静默→回复：scheduleWake 真正建出"等待中"会话时 / wake 开始跑 agent 时
  //   回复→静默：wake 的 finally / 等待会话被丢弃或终结的每一个出口
  //
  // 这一组只是"状态的表达"，不改变原有的触发逻辑；它存在的意义是让
  // ①回复态限速 ②等待窗口的硬上限 ③UI/接口能如实说出"它现在在干嘛"。

  /** 当前状态；null = 静默态。 */
  chatState(chatKey: string): ChatRuntimeState | null {
    return this.runtimeState.get(chatKey);
  }

  #ensureState(chatKey: string): ChatRuntimeState {
    return this.runtimeState.ensure(chatKey);
  }

  /** 进入回复态（幂等）。已在回复态时不重置 since —— drain 重入、waiting→running
   *  都不该让"回复中"的计时归零。 */
  #enterReplying(chatKey: string, { phase = undefined, waitingSessionId = undefined }: { phase?: ChatRuntimeState['phase']; waitingSessionId?: string | null } = {}): void {
    this.runtimeState.enterReplying(chatKey, { phase, waitingSessionId });
  }

  /**
   * 回到静默态（幂等）。
   *
   * **直接删键**（而不是留着写 state='silent'）：本 Map 的契约就是
   * 「有 = 回复态，无 = 静默态」，/api/status 又把它整表透出。留墓碑的话，
   * 每个曾经醒过的会话都会在状态里永久占一行空壳，越跑越多。
   * 下次 scheduleWake 会经 #setBatchStart 重新建，代价为零。
   *
   * ⚠️ 刻意不 clearTimeout(this.wakeTimers)：计时器归 scheduleWake/wake 管，
   *    在这里杀它会让防抖窗口内后续到达的消息失去触发。这里只表达"状态"。
   */
  #exitReplying(chatKey: string): void {
    this.runtimeState.exitReplying(chatKey);
    return;
    // 连 silent 墓碑一起删：#setBatchStart 会先建出一张 state:'silent' 的表，
    // 若这批最后判定"不响应"，它就会以墓碑形态留在表里。出口统一清干净。
  }

  /**
   * 打点"本批第一条消息"：等待窗口的硬上限（reply.maxWaitMs）从这里算起，
   * 同时作废上一批的随机骰子。
   * ⚠️ 记在 chatStates 而不是等待会话上：会话是惰性创建、且会在预判"不响应"时
   *    被丢弃重建，放在它上面会让一次"丢弃→重建"静默重启硬上限。
   */
  #setBatchStart(chatKey: string, ts = Date.now()): ChatRuntimeState {
    return this.runtimeState.startBatch(chatKey, ts);
  }

  /**
   * 取本批**固定**的随机骰子；不存在则掷一次并固定下来。
   *
   * #predictTier（防抖窗口内每次来消息都会调）与 wake（真正运行前）共用它，
   * 这样随机档在一次批次里只掷一次骰子。此前两处各自 Math.random()，
   * 结果是 randomPercent:10 的 3 档群在窗口内每来一条消息就重掷一次，
   * 在"响应/不响应"之间反复横跳（UI 上表现为状态闪烁 + 会话记的档位理由
   * 与放行它的那次判定对不上）。resolveContextTier 本来就支持传入 roll。
   */
  #batchRoll(chatKey: string): number {
    return this.runtimeState.roll(chatKey);
  }

  // ── 动态上下文窗口的消费 ───────────────────────────────────────────────

  /**
   * 把窗口里"还没看过"的消息一次性消费掉：推进游标 + 把存档的 read 下沉成镜像。
   *
   * **这是写 read 镜像的唯一出口**（别再在别处动存档的 read）。响应与不响应两条分支
   * 都走它 —— 这就是"不论响应还是不响应，都要更新上下文窗口"：看过就是看过，
   * 否则被跳过的老消息下次会被当成"刚发生的"重新塞进【本次唤醒】。
   *
   * ⚠️ 与 windows.batch()/foldedCount() 必须同处一个同步块（中间不夹 await）：
   *    Node 单线程下这才是原子的，一让出事件循环，新消息就会挤进窗口。
   *
   * @returns {number} 本次消费掉的条数
   */
  #consumeWindow(chatKey: string): number {
    const crossed = this.windows.seen(chatKey);
    const ids = this.windows.takeSettled(chatKey);
    if (ids.length) this.store.markRead(chatKey, { ids });
    return crossed.length;
  }

  /**
   * 面板「全部标为已读」/ 恢复时丢弃积压：等价于"机器人看过这批了"。
   *
   * 必须走这里（而不是直接改存档的 read）：窗口游标才是"看过没看过"的真相，
   * 只改存档的话那些消息下一次还会被当成待回应重新处理。
   * @returns {number} 消费掉的条数
   */
  markChatSeen(chatKey: string): number {
    const n = this.#consumeWindow(chatKey);
    this.emit('chat-update', chatKey);
    return n;
  }

  /** 面板把某条消息删了：窗口也得跟着忘掉它（否则会把它当新消息递给模型）。 */
  forgetMessage(chatKey: string, id: unknown): boolean {
    return this.windows.remove(chatKey, id);
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /**
   * 收到新消息（已通过白名单校验并写入 store）。
   *
   * ⚠️ **必须传 entry**（store.appendIncoming 的返回值）：窗口靠它保持最新。
   * ⚠️ push 必须排在两个早退**之前**：暂停期间和运行期间到达的消息同样要进窗口，
   *    否则恢复后的补处理、以及"运行结束后 drain 掉运行期间的新消息"都会看不到它们。
   */
  onIncoming(chatKey: string, entry: ChatMessage | null = null): void {
    this.windows.push(chatKey, entry);
    if (this.deps.isPaused() || this.deps.isAborted()) return;
    if (this.runningChats.has(chatKey)) return;   // 运行结束后 drain 会接管
    this.scheduleWake(chatKey);
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。 */
  /**
   * 对"当前这批未读"做档位预判：这批消息值不值得机器人响应？
   *
   * scheduleWake（建等待会话前）与 wake（真正运行前）共用这一个函数，
   * 避免两处各写一份判定、日后逻辑漂移。
   *
   * 注意：这里**不消费**（窗口只看不推游标），
   * 所以防抖窗口期间每次来新消息都可以重新预判 ——
   * 先来一句闲聊（不命中、不显示），接着有人 @ 机器人（命中、立刻显示）。
   *
   * 判据是窗口的 pending()：**窗口内 + 被挤出窗口但还没消费**的全部消息，不设上限。
   * 别改成窗口内容（batch()）—— 上限设小时，埋在积压里的 @ 会被漏判（见上下文窗口的注释）。
   *
   * @returns {{shouldRespond:boolean, tier:number, count:number, reason:string}}
   */
  #predictTier(chatKey: string): ContextTierResult {
    const cfg = getConfig();
    const entries = this.windows.pending(chatKey);
    const r = resolveContextTier({
      triggerEntries: entries,
      selfNickname: cfg.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfg.persona?.botName || '',
      selfId: String((cfg as unknown as { onebot?: { selfId?: unknown } }).onebot?.selfId || this.onebot.selfId || ''),
      cfg: storeConfigForChat(chatKey),  // 按会话取档位：统一开关关闭时各群可以有独立滑条
      // 骰子固定：窗口内每次来消息都重判，但必须用同一颗骰子，
      // 否则随机档会随每条新消息翻来覆去（见 #batchRoll）
      roll: this.#batchRoll(chatKey)
    });
    // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
    if (entries.length === 0) return { ...r, shouldRespond: false, reason: '无未读' };
    return r;
  }

  scheduleWake(chatKey: string, delay: number | null = null): void {
    const cfg = getConfig();
    // delay 显式传入 = 调用方自己定节奏（跑后 drain / 手动唤醒 / 恢复补处理 / 并发满重试），
    // 不是"静默→回复"的转换，因此跳过等待窗口的硬上限与批次打点，用给多少就是多少。
    const explicit = delay !== null && delay !== undefined;
    const immediateMs = explicit ? Math.max(0, Number(delay) || 0) : Math.max(0, Number(cfg.wakeDelayMs) || 2000);
    const maxWaitMs = explicit ? 0 : Math.max(0, Number(cfg.reply?.maxWaitMs) || 0);

    const alreadyWaiting = this.pendingWake.has(chatKey);
    if (alreadyWaiting) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);

    // 批次打点：只在"本批第一条消息"上打。窗口内的后续消息只重置尾沿计时器，
    // 不重置硬上限的起点 —— 否则连发不停就永远等不到触发，这正是要解决的问题。
    if (!alreadyWaiting) this.#setBatchStart(chatKey);

    // 等待窗口 = 尾沿防抖（immediateMs，每条新消息重置）+ 硬上限（maxWaitMs，不重置）。
    // 只用一个计时器：把延迟钳到"距硬上限还剩多久"即可 —— 为
    // min(immediateMs, 剩余) armed 的计时器恰好在上限时刻触发。
    // 比"再加一个不重置的计时器"严格更优：单计时器不可能双触发，也不会留下过期回调。
    // maxWaitMs === 0 时 ms === immediateMs，与改造前逐字节一致。
    let ms = immediateMs;
    if (maxWaitMs > 0) {
      const startedAt = this.chatStates.get(chatKey)?.batchStartedAt || Date.now();
      ms = Math.max(0, Math.min(immediateMs, startedAt + maxWaitMs - Date.now()));
    }

    // 等待窗口 > 0：在会话页立刻创建“等待中”会话，并随新消息重置倒计时
    //
    // ⚠️ 先预判再创建：档位非 4 时，若这批消息确定不会响应，
    //    就**不创建**"等待中"会话 —— 否则用户会在会话页看到一堆
    //    等半天最后变成"中止"的条目，既干扰又让人以为出了错。
    //    窗口结束前若来了新消息且命中，届时再创建（见下面 pendingSessions 分支）。
    if (ms > 0 && !this.runningChats.has(chatKey)) {
      const predicted = this.#predictTier(chatKey);
      if (predicted.shouldRespond === false) {
        // 不响应：把已存在的等待会话撤掉（例如刚被艾特、随后判定又不成立的情况）
        const stale = this.pendingSessions.get(chatKey);
        if (stale) {
          this.#discardWaiting(stale);   // 干净消失，不留"中止"（内部会退回静默态）
          this.pendingSessions.delete(chatKey);
        }
        this.emit('chat-update', chatKey);
        // 定时器仍然保留：窗口内可能来新消息，届时重新预判
        // （批次打点不重置 —— 判定翻转不该让硬上限重新计时）
      } else {
      const unread = this.windows.pending(chatKey).slice(0, 3);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const waitUntil = Date.now() + ms;
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        // ⚠️ 必须取**活对象**（sessions.current），不能用 sessions.get()：
        //    get() 返回的是 structuredClone，改它等于改一份抛弃的副本 ——
        //    下面 sessions.update() 读的又是活对象，于是 waitUntil/trigger 的刷新
        //    静默失效。原先就是 get()，导致"等待中"会话的倒计时永远停在第一次
        //    算出的时刻（本文件的其它地方早就在用 sessions.current.get 这个写法）。
        const s = this.sessions.current.get(existing);
        if (s && s.status === 'waiting') {
          s.waitUntil = waitUntil;
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        const session = this.sessions.create({
          chatKey,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      // 静默→回复：真正出现"等待中"会话才算进入回复态，
      // 与上面的反闪烁规则一致（没有可见的等待会话就对外维持静默）。
      this.#enterReplying(chatKey, { phase: 'waiting', waitingSessionId: this.pendingSessions.get(chatKey) ?? null });
      this.emit('chat-update', chatKey);
      }
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      // 并发满时 wake 会调 scheduleWake(chatKey, 0)，ms===0 从不写 pendingSessions，
      // 只认 pendingSessions 会让原等待会话变成孤儿（永远停在 waiting）。
      // chatStates 里记着它，优先取那边。
      const waitingId = this.chatStates.get(chatKey)?.waitingSessionId ?? this.pendingSessions.get(chatKey);
      this.pendingSessions.delete(chatKey);
      if (this.deps.isPaused() || this.deps.isAborted() || this.runningChats.has(chatKey)) {
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        return;
      }
      this.wake(chatKey, { waitingSessionId: waitingId ?? null })
        .catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用于档位判定"这次不响应"的场景 —— 用户看到的应该是"什么都没发生"，
   * 而不是一条等了半天最后标着"中止"的条目（那会让人以为机器人坏了）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #discardWaiting(sessionId: string): void {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    // 回复态的出口之一：等待会话没了，就该对外回到静默态
    if (s?.chatKey) this.#exitReplying(s.chatKey);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  #finishWaiting(sessionId: string, status: string, error = ''): void {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    // 所有中止路径的公共出口：暂停 / 未设模型 / 无未读 / 计时器触发时已暂停
    if (s.chatKey) this.#exitReplying(s.chatKey);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /** 手动触发一次处理（UI 按钮）。 */
  forceWake(chatKey: string): boolean {
    if (this.runningChats.has(chatKey)) return false;
    this.scheduleWake(chatKey, 0);
    return true;
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey: string, { proactive = false, waitingSessionId = null }: { proactive?: boolean; waitingSessionId?: string | null } = {}): Promise<void> {
    if (this.deps.isAborted()) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.deps.isPaused() && !proactive) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.runningChats.has(chatKey)) {
      // 该会话已在跑（例如并发满的重试撞上了新的一轮）。
      // 必须终结等待会话再走 —— 原先这里是裸 return，等待会话会被永久滞留在
      // waiting，会话页永远挂着一条不会前进的条目，状态机也退不回静默态。
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return;
    }

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return;
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      if (waitingSessionId) {
        const s = this.sessions.get(waitingSessionId);
        if (s && s.status === 'waiting') {
          s.waitUntil = Date.now() + 3000;
          this.sessions.update(waitingSessionId);
          this.emit('session-update', waitingSessionId);
        }
      }
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.deps.isPaused() && !this.deps.isAborted()) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      return;
    }

    // ── 档位：先判断"这批消息值不值得回应"，再决定要不要消费窗口 ──
    //
    // 关键顺序：判定必须发生在消费之前。消费（#consumeWindow）会把游标推到底并把
    // 这批标记已读，如果先消费再判定，未命中时就拿不到"该标记已读"的对象了。
    //
    // 未命中时：推进游标、不创建会话、不调模型 —— 这才是省 token 的关键
    // （消息内容仍留在存档里，日后被艾特时会作为"已读历史"带进提示词）。
    const cfgNow = getConfig();
    if (!proactive) {
      // 窗口的 pending()：窗口内 + 被挤出窗口但还没消费的全部（不设上限，判定用）。
      // 空就早退 —— 防抖窗口刚建立时会空转一次。
      if (this.windows.pending(chatKey).length === 0) {
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
        return; // 没有没看过的消息就不空跑
      }

      // 复用 scheduleWake 那一份判定逻辑，避免两处各写一套、日后漂移
      const tierResult0 = this.#predictTier(chatKey);

      if (tierResult0.shouldRespond === false) {
        // 不响应：推进窗口游标（"看过就是看过"）+ 下沉存档镜像，不产生会话、不消耗 token。
        // 防抖窗口内后续到达的消息会在下一次唤醒时被一起判定 ——
        // 若期间有人艾特机器人，它们会作为已读上下文带上。
        const marked = this.#consumeWindow(chatKey);
        // 关键：让等待会话**干净消失**，而不是标成"中止"留在列表里
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        this.emit('chat-update', chatKey);
        if (marked) {
          console.log(`[orchestrator] ${chatKey} ${marked} 条未命中触发条件（档位 ${tierResult0.tier}），已标记已读、不响应`);
        }
        return;
      }
    }

    // ── 取批 + 消费：这一段**必须同步**（中间不夹 await），
    //    否则"取的批"和"消费掉的范围"会错位（见 context-window.js 的警告）──
    //
    // 触发批 = 窗口里还没看过的那批（≤ 上限）；被挤出窗口、还没消费的条数算进 foldedAway。
    // 上限现在由窗口在**入窗时**维护（超上限丢最老），不再在这里对触发批切片 ——
    // 两条分支（响应 / 不响应）从此走的是同一套窗口逻辑。
    let triggerEntries: ChatMessage[] = [];
    let windowEntryIds: number[] = [];
    let foldedAway = 0;
    if (proactive) {
      // 主动机会：不打扰、无触发批，只带状态；顺手把零星没看过的消费掉
      this.#consumeWindow(chatKey);
    } else {
      // tier 读取的是窗口之外的历史；先拍下整个驻留窗口，避免已消费但尚未被挤出的
      // 消息再次出现在【过去状态】中。
      windowEntryIds = this.windows.ensure(chatKey).win.map((entry) => Number(entry.id) || 0).filter(Boolean);
      triggerEntries = this.windows.batch(chatKey);
      foldedAway = this.windows.foldedCount(chatKey);
      this.#consumeWindow(chatKey);
    }
    if (!proactive && triggerEntries.length === 0) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return; // 没有没看过的消息就不空跑
    }

    // ⚠️ 不要给 get_recent_messages 加钳制：那是模型主动发起的查询，
    //    钳死会让存档对唯一的消费者不可达。

    // ── 档位：响应时带多少条已读历史 ──
    // 在唤醒时算一次并固定下来（尤其是随机档的骰子结果），
    // 否则后续每次渲染提示词都会重新掷，会话记录与提示词会对不上。
    const tierResult = resolveContextTier({
      triggerEntries,
      selfNickname: cfgNow.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfgNow.persona?.botName || '',
      selfId: String((cfgNow as unknown as { onebot?: { selfId?: unknown } }).onebot?.selfId || this.onebot.selfId || ''),
      cfg: storeConfigForChat(chatKey),  // 与 #predictTier 同一来源，保证预判/实跑一致
      // 与 #predictTier 用**同一颗**固定骰子 —— 否则预判放行了、实跑又掷一次，
      // 可能出现"窗口显示等待中、真要跑时却判成不响应"（反之亦然）。
      roll: this.#batchRoll(chatKey)
    });

    this.runningChats.add(chatKey);
    // 状态机：静默→回复。phase 转 running；since 若已是回复态则保留（drain 重入不重置时钟）
    this.#enterReplying(chatKey, { phase: 'running', waitingSessionId });
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);
    const [kind = '', chatId = ''] = String(chatKey).split(':');

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒）才新建
    const waitingSession = waitingSessionId ? this.sessions.current.get(waitingSessionId) : undefined;
    let session: SessionRecord;
    if (waitingSession && waitingSession.status === 'waiting') {
      session = waitingSession;
      session.status = 'running';
      session.waitUntil = null;
      session.trigger = triggerEntries;
      session.triggerSummary = triggerSummary;
      session.triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
      this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    }
    this.activeRuns.set(chatKey, session.id);
    this.emit('chat-update', chatKey);

    // ── 会话级重试 ──
    // 单次 API 请求内部已经会重试（见 chatCompletionWithRetry），
    // 这里处理的是"整轮都救不回来"的情况：清干净上下文从头再来一次。
    //
    // ⚠️ 只在**一次都没发出过消息**时才重试 —— 否则重试会导致重复发言。
    // 已经说过话的会话宁可记为 error，也不能让群里看到两遍同样的话。
    const MAX_SESSION_ATTEMPTS = 3;   // 用户要求：自行重试两次，两次都失败才停
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
        try {
          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, historyLimit: tierResult.historyCount, windowEntryIds, tierInfo: tierResult, foldedAway });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !this.deps.isAborted();
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${errorMessage(error)}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        session.error = errorMessage(lastError);
        this.sessions.finish(session.id, 'error');
        this.emit('session-end', { sessionId: session.id, chatKey, status: 'error', error: session.error });
        console.error(`[orchestrator] 运行 ${session.id} 出错:`, lastError);
      }
    } finally {
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      // 状态机：回复→静默。放在 finally 且循环之外 —— 3 次重试共用这一次转移，
      // 重试不可能重复进出状态。下面的 drain 会以 phase:'waiting' 再进来，
      // 所以"还在答话"期间状态并不会真正掉回静默（符合预期）。
      this.#exitReplying(chatKey);
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.deps.isAborted() && !this.deps.isPaused()) {
      const unread = this.windows.pending(chatKey).length;
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.deps.maybeConsolidateMemory(chatKey);
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   */
  #resetSessionForRetry(session: SessionRecord): void {
    const live = this.sessions.current.get(session.id) || session;
    live.messages = [];
    live.sent = [];
    live.feedbacks = [];
    live.rounds = 0;
    live.error = null;
    live.finishReason = null;
    live.activity = '';
    live.inputMessages = [];
    live.usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
  }

  async #runAgent(session: SessionRecord, options: AgentRunOptions): Promise<void> {
    return runAgent(this, session, options);
  }

}
