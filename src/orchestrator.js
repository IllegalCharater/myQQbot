// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【本次唤醒】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig, storeConfigForChat, digestConfigForChat } from './config.js';
import { vendorOfConfig } from './model-prices.js';
import { sleep, randInt, createEventBus, todayKey, formatShortTime } from './util.js';
import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, isRetryableError } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
import { modelImageVerdict } from './vision-scan.js';
import { currentProviders } from './providers.js';
import { initializeJmcomicQueue } from './jmcomic.js';
import { isSystemRecord } from './store.js';

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, emit = null }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    this.toolDefs = buildToolDefs();
    initializeJmcomicQueue({ onebot, sender, store });

    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    // chatKey -> {
    //   state: 'silent' | 'replying',
    //   phase: 'waiting' | 'running' | '',
    //   since: 进入回复态的时刻（用于 UI 显示"回复中 3s"），
    //   batchStartedAt: 本批第一条消息的时刻（等待窗口硬上限的计时起点），
    //   roll: 本批固定的随机骰子（0~100，见 #predictTier 的说明），
    //   waitingSessionId: 当前"等待中"会话 id
    // }
    //
    // 为什么不从 pendingWake / runningChats 推导状态？scheduleWake 里档位预判翻转为
    // "不响应"时会丢弃等待会话（#discardWaiting），而 pendingWake 仍置位、计时器仍
    // armed —— 推导出来的状态会对一个明显什么都没做的会话报"回复态"。只有显式的
    // Map 才能让"静默态"有意义，也才能让状态跟随用户真正看得到的等待会话。
    this.chatStates = new Map();
    this.compacting = new Set();       // 正在压缩历史记录的 chatKey
    this.compactTimer = null;
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.aborted = false;
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
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
  chatState(chatKey) {
    return this.chatStates.get(chatKey) || null;
  }

  #ensureState(chatKey) {
    let st = this.chatStates.get(chatKey);
    if (!st) {
      st = { state: 'silent', phase: '', since: 0, batchStartedAt: 0, roll: null, waitingSessionId: null };
      this.chatStates.set(chatKey, st);
    }
    return st;
  }

  /** 进入回复态（幂等）。已在回复态时不重置 since —— drain 重入、waiting→running
   *  都不该让"回复中"的计时归零。 */
  #enterReplying(chatKey, { phase = undefined, waitingSessionId = undefined } = {}) {
    const st = this.#ensureState(chatKey);
    if (st.state !== 'replying') {
      st.state = 'replying';
      st.since = Date.now();
    }
    if (phase !== undefined) st.phase = phase;
    if (waitingSessionId !== undefined) st.waitingSessionId = waitingSessionId;
    this.sender.setReplying?.(chatKey, true);
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
  #exitReplying(chatKey) {
    const st = this.chatStates.get(chatKey);
    if (!st) return;
    // 连 silent 墓碑一起删：#setBatchStart 会先建出一张 state:'silent' 的表，
    // 若这批最后判定"不响应"，它就会以墓碑形态留在表里。出口统一清干净。
    this.chatStates.delete(chatKey);
    if (st.state === 'replying') this.sender.setReplying?.(chatKey, false);
  }

  /**
   * 打点"本批第一条消息"：等待窗口的硬上限（reply.maxWaitMs）从这里算起，
   * 同时作废上一批的随机骰子。
   * ⚠️ 记在 chatStates 而不是等待会话上：会话是惰性创建、且会在预判"不响应"时
   *    被丢弃重建，放在它上面会让一次"丢弃→重建"静默重启硬上限。
   */
  #setBatchStart(chatKey, ts = Date.now()) {
    const st = this.#ensureState(chatKey);
    st.batchStartedAt = ts;
    st.roll = null;   // 新批次重新掷骰子（见 #batchRoll）
    return st;
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
  #batchRoll(chatKey) {
    const st = this.#ensureState(chatKey);
    if (st.roll === null || st.roll === undefined) st.roll = Math.random() * 100;
    return st.roll;
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey) {
    if (this.paused || this.aborted) return;
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
   * 注意：这里**不消费**未读（用 peekUnread 只看不取），
   * 所以防抖窗口期间每次来新消息都可以重新预判 ——
   * 先来一句闲聊（不命中、不显示），接着有人 @ 机器人（命中、立刻显示）。
   *
   * @returns {{shouldRespond:boolean, tier:number, count:number, reason:string}}
   */
  #predictTier(chatKey) {
    const cfg = getConfig();
    const entries = this.store.peekUnread(chatKey, 200) || [];
    const r = resolveContextTier({
      triggerEntries: entries,
      selfNickname: cfg.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfg.persona?.botName || '',
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey),  // 按会话取档位：统一开关关闭时各群可以有独立滑条
      // 骰子固定：窗口内每次来消息都重判，但必须用同一颗骰子，
      // 否则随机档会随每条新消息翻来覆去（见 #batchRoll）
      roll: this.#batchRoll(chatKey)
    });
    // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
    if (entries.length === 0) return { ...r, shouldRespond: false, reason: '无未读' };
    return r;
  }

  scheduleWake(chatKey, delay = null) {
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
      const unread = this.store.peekUnread(chatKey, 3);
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
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
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
  #discardWaiting(sessionId) {
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

  #finishWaiting(sessionId, status, error = '') {
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
  forceWake(chatKey) {
    if (this.runningChats.has(chatKey)) return false;
    this.scheduleWake(chatKey, 0);
    return true;
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, waitingSessionId = null } = {}) {
    if (this.aborted) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.paused && !proactive) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
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
          this.sessions.current.get(waitingSessionId).waitUntil = Date.now() + 3000;
          this.sessions.update(waitingSessionId);
          this.emit('session-update', waitingSessionId);
        }
      }
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      return;
    }

    // ── 档位：先判断"这批消息值不值得回应"，再决定要不要取走未读 ──
    //
    // 关键顺序：判定必须发生在 drainUnread() 之前。
    // drainUnread 会把未读取走并全部置为已读（作为触发批），
    // 如果先取走再判定，未命中时就拿不到"该标记已读"的对象了。
    //
    // 未命中时：标记已读、不创建会话、不调模型 —— 这才是省 token 的关键
    // （消息内容仍留在存档里，日后被艾特时会作为"已读历史"带进提示词）。
    const cfgNow = getConfig();
    let pendingEntries = [];
    if (!proactive) {
      // peekUnread 只看不取，limit 给足以免漏判（判定用的是这批的文本）
      pendingEntries = this.store.peekUnread(chatKey, 200) || [];
      if (pendingEntries.length === 0) {
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
        return; // 没有未读就不空跑
      }

      // 复用 scheduleWake 那一份判定逻辑，避免两处各写一套、日后漂移
      const tierResult0 = this.#predictTier(chatKey);

      if (tierResult0.shouldRespond === false) {
        // 不响应：沉入历史（已读），不产生会话、不消耗 token。
        // 防抖窗口内后续到达的消息同样是"未读"状态，会在下一次唤醒时
        // 被一起判定 —— 若期间有人艾特机器人，它们会作为已读上下文带上。
        const marked = this.store.markAllRead(chatKey);
        // 关键：让等待会话**干净消失**，而不是标成"中止"留在列表里
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        this.emit('chat-update', chatKey);
        if (marked) {
          console.log(`[orchestrator] ${chatKey} ${marked} 条未命中触发条件（档位 ${tierResult0.tier}），已标记已读、不响应`);
        }
        return;
      }
    }

    // 触发批：当前所有未读（含之前积压的）—— 到这说明确定要响应了
    let triggerEntries = proactive ? [] : this.store.drainUnread(chatKey);
    if (proactive) {
      // 主动机会：不打扰、无触发批，只带状态
      this.store.drainUnread(chatKey); // 把可能的零星未读一并处理掉
    }
    if (!proactive && triggerEntries.length === 0) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return; // 没有未读就不空跑
    }

    // ── 运行时动态上下文窗口：超出上限就丢最老的 ──
    // 收口点只能在这里：drainUnread 取走的快照**就是**"本次运行的动态上下文"。
    // 关键前提是 drainUnread 返回前已把**全部**未读置为已读（store.js:123-129），
    // 所以被丢掉的条目不可能再次触发运行 —— 它们是"降级"而不是"丢失"：
    // buildPastState 的 excludeIds 拿到的是**裁剪后**的列表（prompt.js:442），
    // 被丢的 id 不再被排除，会作为已读历史出现在【过去状态】里。
    // 这正是现有"不响应→之后被 @"路径依赖的同一套降级机制（见上面 markAllRead 分支）。
    //
    // ⚠️ 不要把这个上限加到 #predictTier 的 peekUnread 上：那是艾特/关键词判定，
    //    积压几百条时埋在里面的 @ 会被漏判。
    // ⚠️ 也不要给 get_recent_messages 加钳制：那是模型主动发起的查询，
    //    钳死会让存档对唯一的消费者不可达。
    let foldedAway = 0;
    const ctxCap = Math.max(0, Number(cfgNow.store?.maxContextMessages) || 0);
    if (!proactive && ctxCap > 0 && triggerEntries.length > ctxCap) {
      foldedAway = triggerEntries.length - ctxCap;
      triggerEntries = triggerEntries.slice(-ctxCap);   // 留最新、丢最老
    }

    // ── 档位：响应时带多少条已读历史 ──
    // 在唤醒时算一次并固定下来（尤其是随机档的骰子结果），
    // 否则后续每次渲染提示词都会重新掷，会话记录与提示词会对不上。
    const tierResult = resolveContextTier({
      triggerEntries,
      selfNickname: cfgNow.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfgNow.persona?.botName || '',
      selfId: cfgNow.onebot?.selfId || this.onebot.selfId || '',
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
    const [kind, chatId] = String(chatKey).split(':');

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒）才新建
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    if (session && session.status === 'waiting') {
      this.sessions.current.get(waitingSessionId).status = 'running';
      this.sessions.current.get(waitingSessionId).waitUntil = null;
      this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
      this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
      this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(waitingSessionId);
      this.emit('session-update', waitingSessionId);
      session = this.sessions.current.get(waitingSessionId);
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
          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit: tierResult.count, tierInfo: tierResult, foldedAway });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !this.aborted;
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${error?.message ?? error}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        session.error = String(lastError?.message ?? lastError);
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
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   */
  #resetSessionForRetry(session) {
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

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null, foldedAway = 0 }) {
    const cfg = getConfig();
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || this.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = this.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // 组装提示词（无 LLM 历史）
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      selfNickname,
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      contextLimit,
      tierInfo,
      foldedAway
    });

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length;
    session.model = cfg.api.model;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: proactive
        ? `${userPrompt}\n\n【本次唤醒】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`
        : userPrompt }
    ];
    // JSON 模式需要看到输入给模型的完整 messages（去工具之前）
    session.inputMessages = structuredClone(messages.map((m) => ({ role: m.role, content: m.content })));
    this.sessions.update(session.id);

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    const searchEnabled = cfg.webSearch?.enabled !== false;
    const toolDefs = this.toolDefs.filter((d) => {
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      return true;
    });
    const openAiTools = toOpenAiTools(toolDefs);

    const ctx = {
      chatKey, kind, chatId,
      requesterId: String([...triggerEntries].reverse().find((m) => !m.self)?.senderId || ''),
      selfId: this.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      session,
      emit: (type, payload) => this.emit(type, payload)
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      if (this.aborted) { this.sessions.finish(session.id, 'aborted'); return; }
      markActivity('正在思考…');
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      const response = await chatCompletionWithRetry({ messages, tools: openAiTools });
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const assistantEntry = {
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        raw: response.raw ?? null
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        break;
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        const result = await executeTool(toolDefs, ctx, name, argsRaw);
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') finish = true;
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // ── 群友印象自动整理 ──
  // 触发条件（二者同时满足）：印象条数超过阈值，且距上次整理超过冷却时间。
  //
  // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
  // → 自动整理永远不触发。改为可配置（config.memory.consolidateMinImpressions），
  // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || Orchestrator.MEMORY_THRESHOLDS.memberImpression);
      // 触发条件二选一：
      //   A. 全群印象总数超过阈值
      //   B. 任一成员的印象条数超过上限
      // 只看总数会在"人少"的群里彻底失灵 —— 比如 3 位成员各 1 条，
      // 总数 3 永远够不到阈值，自动整理形同虚设。
      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 5);
      const anyMemberOverloaded = st.members.some((m) => m.count > maxPerMember);
      if (!(st.counts.memberImpression > minImpressions) && !anyMemberOverloaded) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  /**
   * 整理群友印象 —— 唯一入口。
   * 手动按钮、自动整理、针对特定群友，三种用法都走这里，避免逻辑分叉走样。
   *
   * @param {string} chatKey  会话 key
   * @param {object} [opts]
   * @param {string[]} [opts.userIds]  只整理这些人（指定群友时用）；不传 = 按规则筛选全部
   * @param {boolean} [opts.force]     跳过冷却/门槛检查（手动触发时用）
   * @returns {Promise<{ok, note, changed, results, skipped, failed}>}
   *
   * 身份识别（"同一个人"的判定）：
   *   1) 优先用记忆里的 userId（QQ 号）匹配聊天记录 senderId；
   *   2) 匹配不到时，用备注名/记忆名反查 senderName，命中后把 QQ 号回写进记忆；
   *   3) 仍匹配不到但有名字 → 允许整理（历史遗留的"按名字存"条目不能永远排队）；
   *   4) 既无名也无号 → 跳过。
   */
  async consolidateMemoryForChat(chatKey, { userIds = null, force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);

    // ── 选出要整理的人 ──
    const targets = [];
    const skipped = [];

    // 指定群友但记忆里还没有 → 也要能"新建"印象（这是本功能的关键价值：
    // 聊了 200 条却零印象的人，可以手动让他被分析一次）
    if (only) {
      for (const uid of only) {
        const found = existing.find((m) => String(m.userId || '') === uid);
        if (found) {
          const resolved = this.#resolveIdentity(chatKey, found, stats, notes);
          targets.push({ ...resolved, isNew: false });
          continue;
        }
        // 记忆里没有这个人：用聊天记录里的名字兜底，允许新建
        const name = stats.uidToName.get(uid) || notes[uid] || '';
        if (!name && !stats.memberMsgCount.get(uid)) {
          skipped.push({ userId: uid, name: '', reason: '聊天记录里没有此人发言' });
          continue;
        }
        targets.push({
          userId: uid,
          name: name || `QQ ${uid}`,
          impressions: [],
          isNew: true
        });
      }
    } else {
      // 先整理记忆里已有的人
      const knownUserIds = new Set();
      for (const mem of existing) {
        const resolved = this.#resolveIdentity(chatKey, mem, stats, notes);
        if (String(resolved.userId || '')) knownUserIds.add(String(resolved.userId));
        if (this.#shouldSkip(resolved, force)) {
          skipped.push({
            userId: resolved.userId,
            name: resolved.name,
            reason: this.#skipReason(resolved)
          });
          continue;
        }
        targets.push({ ...resolved, isNew: false });
      }

      // 再"发现"聊天记录里的活跃群友：他们发言很多却没有任何印象。
      // 没有这一步，记忆为空的群（如刚启用记忆的群）点整理只会得到
      // "没有可整理的群友"，功能形同虚设。
      const discoverMin = Math.max(1,
        Number(cfg.memory?.discoverMinMessages) || Orchestrator.DISCOVER_MIN_MESSAGES);
      const discoverMax = Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || Orchestrator.DISCOVER_MAX_MEMBERS);
      const discovered = [...stats.memberMsgCount.entries()]
        .filter(([uid, n]) => n >= discoverMin && !knownUserIds.has(uid))
        .sort((a, b) => b[1] - a[1])
        .slice(0, discoverMax);
      for (const [uid, n] of discovered) {
        targets.push({
          userId: uid,
          name: stats.uidToName.get(uid) || notes[uid] || `QQ ${uid}`,
          impressions: [],
          isNew: true,
          discoveredFrom: n
        });
      }
    }

    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';

    if (!targets.length) {
      return {
        ok: true,
        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,
        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }

    // ── 逐个整理 ──
    const results = [];
    const failed = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.aborted) break;
      const before = mem.impressions.map((e) => e.content);
      try {
        const next = await this.#consolidateOneMember(chatKey, mem, { force, stats });
        if (!next) { failed.push({ userId: mem.userId, name: mem.name, reason: '模型返回无法解析' }); continue; }
        const after = next.impressions.map((e) => e.content);
        const isChanged = after.length !== before.length || after.some((c, i) => c !== before[i]);
        if (isChanged) changed += 1;
        results.push({
          userId: mem.userId,
          name: mem.name,
          before: before.length,
          after: after.length,
          changed: isChanged,
          isNew: !!mem.isNew
        });
      } catch (error) {
        failed.push({ userId: mem.userId, name: mem.name, reason: String(error?.message ?? error) });
      }
    }

    const discoveredCount = targets.filter((t) => t.isNew).length;
    const note = this.#buildConsolidateNote({
      total: targets.length, changed, failed, skipped, only, discoveredCount
    });
    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    return { ok: true, note, changed, results, skipped, failed };
  }

  /** 统计会话里各成员的出现次数与名字（用于身份识别与"新建印象"）。 */
  #scanChatActivity(chatKey) {
    const memberMsgCount = new Map();
    const nameMsgCount = new Map();
    const nameToUserId = new Map();
    const uidToName = new Map();
    for (const m of this.store.recent(chatKey, { limit: 2000 })) {
      if (m.self || !m.senderId) continue;
      // 压缩摘要 / 人工备注都不是群友发言，不跳过就会造出幻影成员
      // （名字"聊天记录摘要"），进而生成"对聊天记录摘要的印象"这种幻觉。
      // 这里用条目类型判定，而不是往 PLACEHOLDER_NAMES 里塞名字：那个表是按
      // **名字**匹配的，而问题出在 kind。
      if (isSystemRecord(m)) continue;
      const uid = String(m.senderId);
      memberMsgCount.set(uid, (memberMsgCount.get(uid) || 0) + 1);
      const nm = String(m.senderName || '').trim();
      // 跳过占位名（历史脏数据：拍一拍事件曾把 senderName 写成"（拍一拍事件）"）
      if (nm && !PLACEHOLDER_NAMES.has(nm)) {
        nameMsgCount.set(nm, (nameMsgCount.get(nm) || 0) + 1);
        if (!nameToUserId.has(nm)) nameToUserId.set(nm, uid);
        if (!uidToName.has(uid)) uidToName.set(uid, nm);
      }
    }
    return { memberMsgCount, nameMsgCount, nameToUserId, uidToName };
  }

  /** 确定一个记忆条目的 QQ 号（必要时反查名字并回写记忆文件）。 */
  #resolveIdentity(chatKey, mem, stats, notes) {
    let userId = String(mem.userId || '').trim();
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    if (msgCount < Orchestrator.MEMBER_MIN_MESSAGES) {
      const candidates = [notes[userId], mem.name, userId].filter(Boolean);
      for (const name of candidates) {
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName >= Orchestrator.MEMBER_MIN_MESSAGES) {
          const matched = stats.nameToUserId.get(name) || '';
          if (matched) {
            userId = matched;
            msgCount = byName;
            try {
              this.memory.replaceMember(chatKey, userId, mem.name, mem.impressions.map((e) => e.content));
            } catch { /* 回写失败不阻塞整理 */ }
          }
          break;
        }
      }
    }
    return { ...mem, userId, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved, force) {
    if (force) return false;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved) {
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }) {
    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';
    const head = only ? '已整理指定群友' : '已整理';
    const discoverNote = discoveredCount > 0 ? `（其中 ${discoveredCount} 位是新建印象）` : '';
    const body = changed > 0
      ? `${head} ${total} 位${discoverNote}，其中 ${changed} 位印象有更新`
      : `${head} ${total} 位${discoverNote}，内容无需改动（印象已足够精简）`;
    const failNote = failed.length
      ? `；${failed.length} 位失败（已保留原印象）`
      : '';
    return body + failNote + skippedNote;
  }

  /** 记录整理时间，供冷却判断使用。 */
  #markConsolidated(chatKey, userIds) {
    const now = Date.now();
    try {
      this.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      console.warn('[memory] 记录整理时间失败:', error?.message ?? error);
    }
  }

  /**
   * 整理单个群友的印象。
   *
   * 两种模式：
   *   - 整理模式（已有印象）：合并重复、删过时，只减不增，绝不发明新事实
   *   - 新建模式（isNew，针对零印象的活跃群友）：读他最近的发言，提炼长期印象
   *
   * 新建模式是本功能的关键补充：实测有群友聊了 200+ 条却零印象，
   * 而模型日常几乎不主动调 memory_append —— 没有这个入口就永远补不上。
   */
  async #consolidateOneMember(chatKey, mem, { force = false, stats = null } = {}) {
    const existing = mem.impressions || [];
    const isNew = !!mem.isNew || (!existing.length && !!force);

    const { system, user } = isNew
      ? this.#buildNewImpressionPrompt(chatKey, mem, stats)
      : this.#buildConsolidatePrompt(mem);

    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      console.warn(`[memory] ${isNew ? '新建' : '整理'} ${chatKey}/${mem.userId || mem.name} 结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_MEMORY) {
        console.warn('[memory][debug] 原始返回 =', JSON.stringify(String(res?.message?.content ?? '')).slice(0, 1500));
      }
      return null;
    }

    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;

    // 整理模式：条数变多 = 疑似幻觉，放弃（保留原印象）
    if (!isNew && raw.length > existing.length) {
      console.warn(`[memory] 整理 ${chatKey}/${mem.userId} 结果条数变多（${existing.length}→${raw.length}），疑似幻觉，放弃`);
      return null;
    }

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content) => content.slice(0, 120));

    return this.memory.replaceMember(chatKey, mem.userId, mem.name, clean);
  }

  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`群友 QQ：${mem.userId}`, `当前名字：${mem.name}`];
    for (const e of mem.impressions) lines.push(`- ${e.content} (${fmtTs(e.createdAt)})`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 把同义/重复的印象合并成一条，以最新的观感为准。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        `3. 最多保留 ${maxKeep} 条，每条不超过 120 字。`,
        '原则：所有信息只能来自原文，语义不变，宁少勿错；没有可保留的时输出空数组。',
        '',
        ...lines
      ].join('\n')
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey, mem, stats) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    const uid = String(mem.userId || '');
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);

    return {
      system: '你是聊天机器人的记忆模块，负责从聊天记录里提炼对某一位群友的长期印象。只提炼"以后跟这个人打交道用得上"的稳定特征，严格依据给定的发言，不要编造。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        `下面是群友（QQ ${uid}${(mem.name && `，名字 ${mem.name}`) || ''}）最近的部分发言，请提炼对他的长期印象：`,
        '1. 只保留稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。',
        '2. 不要记一次性事件、临时话题，也不要记录流水账。',
        `3. 最多 ${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。`,
        '4. 宁少勿错：信息不足就少写，不要脑补。',
        '5. 若实在提炼不出任何稳定特征，输出空数组。',
        '',
        sample.length ? sample.join('\n') : '（没有抓到该群友的发言）'
      ].join('\n')
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      return chatCompletion({ messages, temperature: 0.2 });
    }    const providers = currentProviders();
    const p = providers.find((x) => x.id === mem.provider);
    if (!p?.baseURL || !p?.apiKey || !mem.model) {
      throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    return chatCompletion({
      messages,
      temperature: 0.2,
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
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
  startCompactLoop() {
    this.stopCompactLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = Math.max(300000, Number(cfg.compact?.checkIntervalMs) || 3600000);
      this.compactTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      this.compactTimer.unref?.();
      if (this.aborted || this.paused || cfg.compact?.enabled !== true) return;
      await this.#compactSweep().catch((error) => console.error('[compact] 巡检失败:', error?.message ?? error));
    };
    this.compactTimer = setTimeout(() => { tick().catch(() => {}); }, 60000);
    this.compactTimer.unref?.();
  }

  stopCompactLoop() {
    clearTimeout(this.compactTimer);
    this.compactTimer = null;
  }

  /** 巡检：挑一个够格的会话压缩。按"最久没人说话"排序（那种群最该清）。 */
  async #compactSweep() {
    const cfg = getConfig();
    if (this.aborted || this.paused) return { compacted: 0 };
    const limit = Math.max(1, Number(cfg.compact?.maxChatsPerSweep) || 1);
    const minMessages = Math.max(1, Number(cfg.compact?.minMessagesToCompact) || 800);
    const cooldown = Math.max(600000, Number(cfg.compact?.minIntervalMs) || 86400000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const allowPrivate = (cfg.allow?.private ?? []).map(String);

    // 白名单：与主动开话题同一套判定。用户的改动会即时生效 ——
    // 从白名单里去掉一个群之后，它在磁盘上的存档不该再花 LLM 的钱去维护。
    const allowed = (chatKey) => {
      const [kind, id] = String(chatKey).split(':');
      const list = kind === 'group' ? allowGroups : allowPrivate;
      return list.length > 0 ? list.includes(id) : !!cfg.allowAllWhenEmpty;
    };

    const candidates = [];
    for (const chatKey of this.store.listChats()) {
      if (!allowed(chatKey)) continue;
      if (this.compacting.has(chatKey)) continue;
      if (this.runningChats.has(chatKey) || this.pendingWake.has(chatKey)) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;                                   // 还有没处理的消息，先让它回完
      if (meta.total < minMessages) continue;                          // 条数不够，不值得花这笔钱
      if (Date.now() - this.store.lastCompactedAt(chatKey) < cooldown) continue;
      candidates.push({ chatKey, lastTs: meta.lastTs });
    }
    if (!candidates.length) return { compacted: 0 };

    candidates.sort((a, b) => a.lastTs - b.lastTs);
    let compacted = 0;
    for (const c of candidates.slice(0, limit)) {
      if (this.aborted || this.paused) break;
      const r = await this.compactChat(c.chatKey).catch((error) => {
        console.error(`[compact] ${c.chatKey} 压缩失败:`, error?.message ?? error);
        return null;
      });
      if (r?.ok) compacted += 1;
    }
    return { compacted };
  }

  /**
   * 压缩一个会话的历史记录 —— **唯一入口**（定时巡检与手动"立即压缩"都走这里）。
   *
   * @param {string} chatKey
   * @param {object} [opts]
   * @param {boolean} [opts.force] 跳过门槛/冷却/未读检查（手动触发）。只跳过"该不该压"，
   *                               绝不跳过"能不能安全压"（正在回复中一律拒绝）。
   * @returns {Promise<{ok:boolean, note:string, removed?:number, remaining?:number, droppedDigests?:number}>}
   *          droppedDigests = 本次顺带回收掉的旧纪要条数（摘要存档超出 digest.maxKeepChars 时）
   */
  async compactChat(chatKey, { force = false } = {}) {
    const cfg = getConfig();
    const c = cfg.compact || {};
    if (!String(cfg.api?.model || '').trim() || !String(cfg.api?.baseUrl || '').trim()) {
      return { ok: false, note: '模型未配置，无法压缩' };
    }
    if (this.compacting.has(chatKey)) return { ok: false, note: '该会话正在压缩中' };
    // 这两条即使 force 也不放行：正在跑的运行依赖当前存档渲染【过去状态】，
    // 抽掉中间的条目会让它上下文错乱；等待聚批的批次同理。
    if (this.runningChats.has(chatKey) || this.pendingWake.has(chatKey)) {
      return { ok: false, note: '该会话正在回复或等待聚批，稍后再试' };
    }

    const keepRecent = Math.max(0, Number(c.keepRecentMessages) || 300);
    const maxMessages = Math.max(1, Number(c.maxMessagesPerRound) || 400);
    const minMessages = Math.max(1, Number(c.minMessagesToCompact) || 800);
    const cooldown = Math.max(600000, Number(c.minIntervalMs) || 86400000);

    if (!force) {
      const total = this.store.getChatMeta(chatKey).total;
      if (total < minMessages) return { ok: false, note: `存档只有 ${total} 条，未到 ${minMessages} 条门槛` };
      if (this.store.unreadCount(chatKey) > 0) return { ok: false, note: '还有未读消息待处理，先让它回复完' };
      const since = Date.now() - this.store.lastCompactedAt(chatKey);
      if (since < cooldown) {
        return { ok: false, note: `距上次压缩还不到冷却时间（还需 ${Math.ceil((cooldown - since) / 60000)} 分钟）` };
      }
    }

    // 候选区间 = 最老的一段（最近 keepRecent 条原样保留）。
    // 再兜底剔除未读条目：它们还没被任何一次运行看到过，绝不能连摘要都没有就被归档。
    const raw = this.store.selectArchiveRange(chatKey, { keepRecent, maxMessages });
    const entries = raw.entries.filter((m) => m.read === true);
    if (!entries.length) {
      return { ok: false, note: `最近 ${keepRecent} 条要原样保留，没有可压缩的老消息` };
    }

    this.compacting.add(chatKey);
    this.emit('chat-update', chatKey);
    try {
      // 摘要调用本身可能失败（网络、超时、限流、模型没配好）。这里**必须**接住：
      // 让异常穿出去的话，接口会把它当成 500 报给 UI，而这里其实是一次
      // "什么都没做"的正常回绝 —— 用户该看到原因，不是一坨堆栈。
      let res = null;
      try {
        res = await this.#compactChatHistory(chatKey, entries);
      } catch (error) {
        return { ok: false, note: `摘要调用失败，本轮不改动任何数据：${String(error?.message ?? error)}` };
      }
      // 摘要没成功 → 零改动。这是整条链路最重要的一道闸：宁可白花一次 token，
      // 也不能把原文归档掉却什么都没换回来。
      if (!res) return { ok: false, note: '模型没有返回可用摘要，本轮不改动任何数据' };

      // 先写冷归档、再重写主文件，两步之间不夹任何 await：
      // 中途崩溃只会让消息**同时存在于两处**（可恢复的重复），而不是两处都没有（丢失）。
      const archived = this.store.appendArchive(chatKey, res.entries);
      res.digestEntry.digest.archivedFile = archived.file;
      const commit = this.store.commitCompaction(chatKey, {
        removeIds: res.removeIds,
        digestEntry: res.digestEntry
      });

      console.log(`[compact] ${chatKey} 已摘要 ${commit.removed} 条 → 1 条纪要（原文 → ${archived.file}）`);

      // 摘要存档的总量回收。放在压缩**成功之后**（这是摘要集合唯一会变的时刻），
      // 手动「立即压缩」与定时巡检都会走到这里 —— 只认"每次压缩后"，不额外看定时开关：
      // 只认开关的话，用户设了上限却一直手动压缩时会发现它根本不生效。
      // 上限 0 = 不限（默认），也就是与改动前完全一致。
      let gc = { dropped: [] };
      const keepCap = digestConfigForChat(chatKey).maxKeepChars;
      if (keepCap > 0) {
        gc = this.store.dropOldestDigests(chatKey, { maxChars: keepCap });
        if (gc.dropped.length) {
          console.log(`[compact] ${chatKey} 摘要存档 ${gc.totalChars} 字 > 上限 ${keepCap}，丢弃最旧的 ${gc.dropped.length} 条纪要（现 ${gc.keptChars} 字，备份 → ${gc.backup || '（无）'}）`);
        }
      }

      // 记忆那一半：压缩会稀释 #scanChatActivity 的证据（它在 recent(2000) 上计数），
      // 可能悄悄关掉"发现新人"。所以压完立刻让它整理一次 ——
      // #maybeConsolidateMemory 自带开关、阈值与 6 小时冷却，不满足条件时什么都不做。
      if (c.compactMemory !== false) this.#maybeConsolidateMemory(chatKey);

      return {
        ok: true,
        note: `已把 ${commit.removed} 条老消息摘要成 1 条纪要（原文归档到 ${archived.file}）`
          + (gc.dropped.length ? `；摘要存档超出上限，另丢弃了最旧的 ${gc.dropped.length} 条纪要（备份 ${gc.backup ? gc.backup.split(/[\\/]/).pop() : '见数据目录'}）` : ''),
        removed: commit.removed,
        remaining: commit.remaining,
        archiveFile: archived.file,
        droppedDigests: gc.dropped.length
      };
    } finally {
      this.compacting.delete(chatKey);
      this.emit('chat-update', chatKey);
    }
  }

  /**
   * 把一段历史交给模型摘要。
   *
   * 铁律：**绝不归档摘要没真正看到的内容**。先按字符预算从新往旧回填提示词行，
   * 据此裁剪出归档区间 —— 返回的 removeIds 恰好是模型看到的那批，多一条都不会被删。
   *
   * @returns {{entries:Array, removeIds:Set, digestEntry:object, seen:number}|null}
   *          null = 放弃（调用方必须零改动）
   */
  async #compactChatHistory(chatKey, entries) {
    const cfg = getConfig();
    const maxChars = Math.max(2000, Number(cfg.compact?.maxContextChars) || 24000);
    const notes = cfg.memberNotes || {};
    const nameOf = (m) => (m.self ? '我' : (notes[String(m.senderId || '')] || m.senderName || String(m.senderId || '未知')));

    const lines = [];
    let chars = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const text = String(e.text || '').replace(/\s+/g, ' ').slice(0, 200);
      const line = `${formatShortTime(e.ts)} ${nameOf(e)}：${text}`;
      // 至少留一行，否则一条超长消息就会让整轮空转
      if (chars + line.length > maxChars && lines.length) break;
      chars += line.length;
      lines.unshift(line);
    }
    if (!lines.length) return null;
    const range = entries.slice(entries.length - lines.length);   // 只压缩这部分
    const from = range[0].ts;
    const to = range[range.length - 1].ts;

    const res = await this.#memoryChat([
      {
        role: 'system',
        content: [
          '你是聊天机器人的聊天记录归档模块，负责把一段群聊记录压缩成可长期保留的纪要。',
          '严格要求：',
          '1. 只依据给定的聊天记录写，绝不编造，也不要用常识去补全。',
          '2. 保留：谁和谁在聊什么、聊出了什么结论、发生过的具体事件、反复出现的梗与专有名词、约定和承诺。',
          '3. 丢掉：寒暄、复读、表情包灌水、没有信息量的应答。',
          '4. 用第三人称按时间顺序分段陈述，不要逐条复述。',
          '5. 输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。',
          '格式：{"summary":"…","seen":N}。seen 必须等于你收到的消息行数 —— 它用来证明你确实读完了全部输入。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          `下面是聊天记录（共 ${lines.length} 行，按时间排序），请压缩成纪要：`,
          '',
          lines.join('\n')
        ].join('\n')
      }
    ]);

    const rawText = String(res?.message?.content ?? '');
    const parsed = extractJsonObject(rawText);
    if (!parsed) {
      console.warn(`[compact] ${chatKey} 摘要结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_COMPACT) console.warn('[compact][debug] 原始返回 =', JSON.stringify(rawText).slice(0, 1500));
      return null;
    }
    const summary = String(parsed.summary ?? '').trim();
    if (!summary) {
      console.warn(`[compact] ${chatKey} 摘要为空，本轮放弃`);
      return null;
    }
    // 幻觉守卫：模型必须自证读到了输入。比"长度/条数对比"强得多 ——
    // 摘要本来就是要压缩的，没法拿长度判断；而 seen 是让它自己数。
    const seen = Number(parsed.seen);
    if (!Number.isFinite(seen) || seen !== lines.length) {
      console.warn(`[compact] ${chatKey} 摘要自称只读了 ${parsed.seen}/${lines.length} 行，疑似未读完或幻觉，本轮放弃`);
      return null;
    }
    // 过长只截断、不丢弃：截断损失保真度，丢弃损失整轮（要和上面两种失败区分开）
    const clipped = summary.length > 4000 ? `${summary.slice(0, 4000)}…（摘要过长，已截断）` : summary;

    const digestEntry = {
      id: 0,   // 真正分配在 commitCompaction 里（取自 nextLocalId，被删掉的 id 绝不回收）
      mid: null,
      ts: to,  // 用被归档区间的最后一条：它才会成为【过去状态】里最老的一行
      senderId: 'digest',
      senderName: '聊天记录摘要',
      text: `【历史摘要 ${formatShortTime(from)} ~ ${formatShortTime(to)} · 共 ${range.length} 条】\n${clipped}`,
      self: false,
      read: true,   // 关键：read:true 保证它永远不进未读、永远不触发运行
      reply: null,
      media: [],
      kind: 'digest',
      digest: { from, to, count: range.length, archivedFile: '', model: res?.model || '', createdAt: Date.now() }
    };
    return { entries: range, removeIds: new Set(range.map((m) => m.id)), digestEntry, seen };
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
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

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 聊天记录里可能出现的占位名（非真实昵称）。
 * 来源：历史版本的拍一拍事件把 senderName 硬编码成"（拍一拍事件）"。
 * 取名字时必须跳过，否则记忆里会出现"某人的名字叫（拍一拍事件）"。
 */
const PLACEHOLDER_NAMES = new Set([
  '（拍一拍事件）',
  '(拍一拍事件)',
  '未知',
  '某人'
]);

/**
 * 从模型输出里稳健提取 JSON 对象。
 *
 * 模型并不总会乖乖只吐 JSON，常见变体：
 *   1) ```json\n{...}\n```            —— Markdown 代码块
 *   2) "好的，这是整理结果：\n{...}"   —— 前后带解释文字
 *   3) '{"impressions":[...]}'        —— 用了单引号
 *   4) 结尾多了个逗号                  —— 尾随逗号
 * 原实现只会剥掉"整段被 ``` 包裹"这一种，其余全部解析失败 → 整理静默放弃。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 1) 先尝试直接解析
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }

  // 2) 剥掉 ``` 代码块（可能在中间任意位置）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());

  // 3) 取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    // 修正常见瑕疵后重试：尾随逗号、单引号
    try {
      const fixed = cand
        .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
        .replace(/'/g, '"');                     // 单引号 → 双引号
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
    // 兜底：只抽 impressions 数组
    const arrMatch = cand.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrMatch) {
      try {
        const items = JSON.parse('[' + arrMatch[1].replace(/,\s*$/, '') + ']');
        return { impressions: items };
      } catch { /* 继续 */ }
    }
  }
  return null;
}
