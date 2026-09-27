import { digestConfigForChat, getConfig } from '../../core/config.js';
import { PROMPT_CATALOG } from '../../core/prompt-catalog.js';
import { formatShortTime } from '../../core/util.js';
import { errorMessage, extractJsonObject } from '../shared/json-parse.js';
import type { ChatMessage } from '../../chat/types.js';
import type { ChatStore } from '../../chat/store.js';
import type { ContextWindowRegistry } from '../context/context-window.js';
import type { MemoryConsolidator } from './memory-consolidator.js';

export interface HistoryCompactorDependencies {
  store: ChatStore;
  windows: ContextWindowRegistry;
  runningChats: Set<string>;
  pendingWake: Set<string>;
  memoryConsolidator: MemoryConsolidator;
  emit(event: string, payload?: unknown): unknown;
  isPaused(): boolean;
  isAborted(): boolean;
}

export class HistoryCompactor {
  readonly running = new Set<string>();
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: HistoryCompactorDependencies) {}

  startCompactLoop() {
    this.stopCompactLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = Math.max(300000, Number(cfg.compact?.checkIntervalMs) || 3600000);
      this.timer = setTimeout(() => { tick().catch(() => {}); }, next);
      this.timer.unref?.();
      if (this.deps.isAborted() || this.deps.isPaused() || cfg.compact?.enabled !== true) return;
      await this.#compactSweep().catch((error) => console.error('[compact] 巡检失败:', error?.message ?? error));
    };
    this.timer = setTimeout(() => { tick().catch(() => {}); }, 60000);
    this.timer.unref?.();
  }

  stopCompactLoop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 巡检：挑一个够格的会话压缩。按"最久没人说话"排序（那种群最该清）。 */
  async #compactSweep() {
    const cfg = getConfig();
    if (this.deps.isAborted() || this.deps.isPaused()) return { compacted: 0 };
    const limit = Math.max(1, Number(cfg.compact?.maxChatsPerSweep) || 1);
    const minMessages = Math.max(1, Number(cfg.compact?.minMessagesToCompact) || 800);
    const cooldown = Math.max(600000, Number(cfg.compact?.minIntervalMs) || 86400000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const allowPrivate = (cfg.allow?.private ?? []).map(String);

    // 白名单：与主动开话题同一套判定。用户的改动会即时生效 ——
    // 从白名单里去掉一个群之后，它在磁盘上的存档不该再花 LLM 的钱去维护。
    const allowed = (chatKey: string) => {
      const [kind, id] = String(chatKey).split(':');
      const list = kind === 'group' ? allowGroups : allowPrivate;
      return list.length > 0 ? list.includes(id) : !!cfg.allowAllWhenEmpty;
    };

    const candidates = [];
    for (const chatKey of this.deps.store.listChats()) {
      if (!allowed(chatKey)) continue;
      if (this.running.has(chatKey)) continue;
      if (this.deps.runningChats.has(chatKey) || this.deps.pendingWake.has(chatKey)) continue;
      const meta = this.deps.store.getChatMeta(chatKey);
      if (this.deps.windows.pending(chatKey).length > 0) continue;          // 还有没处理的消息，先让它回完
      if (meta.total < minMessages) continue;                          // 条数不够，不值得花这笔钱
      if (Date.now() - this.deps.store.lastCompactedAt(chatKey) < cooldown) continue;
      candidates.push({ chatKey, lastTs: meta.lastTs });
    }
    if (!candidates.length) return { compacted: 0 };

    candidates.sort((a, b) => a.lastTs - b.lastTs);
    let compacted = 0;
    for (const c of candidates.slice(0, limit)) {
      if (this.deps.isAborted() || this.deps.isPaused()) break;
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
  async compactChat(chatKey: string, { force = false }: { force?: boolean } = {}) {
    const cfg = getConfig();
    const c = cfg.compact || {};
    if (!String(cfg.api?.model || '').trim() || !String(cfg.api?.baseUrl || '').trim()) {
      return { ok: false, note: '模型未配置，无法压缩' };
    }
    if (this.running.has(chatKey)) return { ok: false, note: '该会话正在压缩中' };
    // 这两条即使 force 也不放行：正在跑的运行依赖当前存档渲染【过去状态】，
    // 抽掉中间的条目会让它上下文错乱；等待聚批的批次同理。
    if (this.deps.runningChats.has(chatKey) || this.deps.pendingWake.has(chatKey)) {
      return { ok: false, note: '该会话正在回复或等待聚批，稍后再试' };
    }

    const keepRecent = Math.max(0, Number(c.keepRecentMessages) || 300);
    const maxMessages = Math.max(1, Number(c.maxMessagesPerRound) || 400);
    const minMessages = Math.max(1, Number(c.minMessagesToCompact) || 800);
    const cooldown = Math.max(600000, Number(c.minIntervalMs) || 86400000);

    if (!force) {
      const total = this.deps.store.getChatMeta(chatKey).total;
      if (total < minMessages) return { ok: false, note: `存档只有 ${total} 条，未到 ${minMessages} 条门槛` };
      if (this.deps.windows.pending(chatKey).length > 0) return { ok: false, note: '还有没处理的消息，先让它回复完' };
      const since = Date.now() - this.deps.store.lastCompactedAt(chatKey);
      if (since < cooldown) {
        return { ok: false, note: `距上次压缩还不到冷却时间（还需 ${Math.ceil((cooldown - since) / 60000)} 分钟）` };
      }
    }

    // 候选区间 = 最老的一段（最近 keepRecent 条原样保留）。
    // 再兜底剔除未读条目：它们还没被任何一次运行看到过，绝不能连摘要都没有就被归档。
    const raw = this.deps.store.selectArchiveRange(chatKey, { keepRecent, maxMessages });
    const entries = raw.entries.filter((m) => m.read === true);
    if (!entries.length) {
      return { ok: false, note: `最近 ${keepRecent} 条要原样保留，没有可压缩的老消息` };
    }

    this.running.add(chatKey);
    this.deps.emit('chat-update', chatKey);
    try {
      // 摘要调用本身可能失败（网络、超时、限流、模型没配好）。这里**必须**接住：
      // 让异常穿出去的话，接口会把它当成 500 报给 UI，而这里其实是一次
      // "什么都没做"的正常回绝 —— 用户该看到原因，不是一坨堆栈。
      let res = null;
      try {
        res = await this.#compactChatHistory(chatKey, entries);
      } catch (error) {
        return { ok: false, note: `摘要调用失败，本轮不改动任何数据：${errorMessage(error)}` };
      }
      // 摘要没成功 → 零改动。这是整条链路最重要的一道闸：宁可白花一次 token，
      // 也不能把原文归档掉却什么都没换回来。
      if (!res) return { ok: false, note: '模型没有返回可用摘要，本轮不改动任何数据' };

      // 先写冷归档、再重写主文件，两步之间不夹任何 await：
      // 中途崩溃只会让消息**同时存在于两处**（可恢复的重复），而不是两处都没有（丢失）。
      const archived = this.deps.store.appendArchive(chatKey, res.entries);
      res.digestEntry.digest.archivedFile = archived.file;
      const commit = this.deps.store.commitCompaction(chatKey, {
        removeIds: res.removeIds,
        digestEntry: res.digestEntry
      });

      console.log(`[compact] ${chatKey} 已摘要 ${commit.removed} 条 → 1 条纪要（原文 → ${archived.file}）`);

      // 摘要存档的总量回收。放在压缩**成功之后**（这是摘要集合唯一会变的时刻），
      // 手动「立即压缩」与定时巡检都会走到这里 —— 只认"每次压缩后"，不额外看定时开关：
      // 只认开关的话，用户设了上限却一直手动压缩时会发现它根本不生效。
      // 上限 0 = 不限（默认），也就是与改动前完全一致。
      let gc: { dropped: ChatMessage[]; keptChars: number; totalChars: number; backup?: string } = {
        dropped: [], keptChars: 0, totalChars: 0
      };
      const keepCap = digestConfigForChat(chatKey).maxKeepChars;
      if (keepCap > 0) {
        gc = this.deps.store.dropOldestDigests(chatKey, { maxChars: keepCap });
        if (gc.dropped.length) {
          console.log(`[compact] ${chatKey} 摘要存档 ${gc.totalChars} 字 > 上限 ${keepCap}，丢弃最旧的 ${gc.dropped.length} 条纪要（现 ${gc.keptChars} 字，备份 → ${gc.backup || '（无）'}）`);
        }
      }

      // 记忆那一半：压缩会稀释 #scanChatActivity 的证据（它在 recent(2000) 上计数），
      // 可能悄悄关掉"发现新人"。所以压完立刻让它整理一次 ——
      // deps.memoryConsolidator.maybeSchedule 自带开关、阈值与 6 小时冷却，不满足条件时什么都不做。
      if (c.compactMemory !== false) this.deps.memoryConsolidator.maybeSchedule(chatKey);

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
      this.running.delete(chatKey);
      this.deps.emit('chat-update', chatKey);
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
  async #compactChatHistory(chatKey: string, entries: ChatMessage[]) {
    const cfg = getConfig();
    const maxChars = Math.max(2000, Number(cfg.compact?.maxContextChars) || 24000);
    const notes = cfg.memberNotes || {};
    const nameOf = (m: ChatMessage) => (m.self ? '我' : (notes[String(m.senderId || '')] || m.senderName || String(m.senderId || '未知')));

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

    const res = await this.deps.memoryConsolidator.chat([
      {
        role: 'system',
        content: PROMPT_CATALOG.maintenance.historySystem
      },
      {
        role: 'user',
        content: PROMPT_CATALOG.maintenance.historyUser(lines.length, lines.join('\n'))
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
}
