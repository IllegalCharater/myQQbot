import { getConfig } from '../../core/config.js';
import { PROMPT_CATALOG } from '../../core/prompt-catalog.js';
import { todayKey } from '../../core/util.js';
import { chatCompletion } from '../../llm/llm.js';
import { currentProviders } from '../../llm/providers.js';
import { isPersonMessage } from '../../chat/store.js';
import { errorMessage, extractJsonObject } from '../shared/json-parse.js';
import type { ChatStore } from '../../chat/store.js';
import type { MemoryStore } from '../../chat/memory.js';
import type { ChatRequestMessage } from '../../llm/types.js';

interface ImpressionLike { content: string; createdAt: number }
interface MemoryMemberLike {
  userId: string;
  name: string;
  impressions: ImpressionLike[];
  isNew?: boolean;
  msgCount?: number;
  discoveredFrom?: number;
}
interface ActivityStats {
  memberMsgCount: Map<string, number>;
  nameMsgCount: Map<string, number>;
  nameToUserId: Map<string, string>;
  uidToName: Map<string, string>;
}
interface ResolvedMember extends MemoryMemberLike { msgCount: number }
interface ConsolidateIssue { userId: string; name: string; reason: string }

export interface MemoryConsolidatorDependencies {
  store: ChatStore;
  memory: MemoryStore;
  isPaused(): boolean;
  isAborted(): boolean;
}

const PLACEHOLDER_NAMES = new Set(['（拍一拍事件）', '(拍一拍事件)', '未知', '某人']);

export class MemoryConsolidator {
  readonly running = new Set<string>();

  constructor(private readonly deps: MemoryConsolidatorDependencies) {}

  chat(messages: ChatRequestMessage[]) {
    return this.#memoryChat(messages);
  }

  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）

  maybeSchedule(chatKey: string): void {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.deps.isPaused() || this.deps.isAborted()) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.running.has(chatKey)) return;
      const st = this.deps.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || MemoryConsolidator.MEMORY_THRESHOLDS.memberImpression);
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
      this.running.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error: unknown) => console.error(`[memory] 整理 ${chatKey} 失败:`, errorMessage(error)))
        .finally(() => this.running.delete(chatKey));
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
  async consolidateMemoryForChat(chatKey: string, { userIds = null, force = false }: { userIds?: unknown[] | null; force?: boolean } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const existing: MemoryMemberLike[] = this.deps.memory.members(chatKey);

    // ── 选出要整理的人 ──
    const targets: MemoryMemberLike[] = [];
    const skipped: ConsolidateIssue[] = [];

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
        Number(cfg.memory?.discoverMinMessages) || MemoryConsolidator.DISCOVER_MIN_MESSAGES);
      const discoverMax = Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || MemoryConsolidator.DISCOVER_MAX_MEMBERS);
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
    const results: Array<Record<string, unknown>> = [];
    const failed: ConsolidateIssue[] = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.deps.isAborted()) break;
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
        failed.push({ userId: mem.userId, name: mem.name, reason: errorMessage(error) });
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
  #scanChatActivity(chatKey: string): ActivityStats {
    const memberMsgCount = new Map<string, number>();
    const nameMsgCount = new Map<string, number>();
    const nameToUserId = new Map<string, string>();
    const uidToName = new Map<string, string>();
    for (const m of this.deps.store.recent(chatKey, { limit: 2000 })) {
      if (m.self || !m.senderId) continue;
      // 压缩摘要 / 人工备注 / 转写结果都不是群友发言，不跳过就会造出幻影成员
      // （名字"聊天记录摘要"），进而生成"对聊天记录摘要的印象"这种幻觉。
      // 这里用条目类型判定，而不是往 PLACEHOLDER_NAMES 里塞名字：那个表是按
      // **名字**匹配的，而问题出在 kind。
      // （上面 `!m.senderId` 已经挡掉了转写结果，这里用 isPersonMessage 是为了
      //   让"什么算人"只有一处定义，不靠某个字段恰好为空。）
      if (!isPersonMessage(m)) continue;
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
  #resolveIdentity(chatKey: string, mem: MemoryMemberLike, stats: ActivityStats, notes: Record<string, string>): ResolvedMember {
    let userId = String(mem.userId || '').trim();
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    if (msgCount < MemoryConsolidator.MEMBER_MIN_MESSAGES) {
      const candidates = [notes[userId], mem.name, userId].filter(Boolean);
      for (const name of candidates) {
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName >= MemoryConsolidator.MEMBER_MIN_MESSAGES) {
          const matched = stats.nameToUserId.get(name) || '';
          if (matched) {
            userId = matched;
            msgCount = byName;
            try {
              this.deps.memory.replaceMember(chatKey, userId, mem.name, mem.impressions.map((e) => e.content));
            } catch { /* 回写失败不阻塞整理 */ }
          }
          break;
        }
      }
    }
    return { ...mem, userId, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved: ResolvedMember, force: boolean): boolean {
    if (force) return false;
    if (resolved.msgCount < MemoryConsolidator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < MemoryConsolidator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < MemoryConsolidator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved: ResolvedMember): string {
    if (resolved.impressions.length < MemoryConsolidator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < MemoryConsolidator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }: {
    total: number; changed: number; failed: ConsolidateIssue[]; skipped: ConsolidateIssue[];
    only: Set<string> | null; discoveredCount?: number;
  }): string {
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
  #markConsolidated(chatKey: string, userIds: string[]): void {
    const now = Date.now();
    try {
      this.deps.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      console.warn('[memory] 记录整理时间失败:', errorMessage(error));
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
  async #consolidateOneMember(chatKey: string, mem: MemoryMemberLike, { force = false, stats = null }: { force?: boolean; stats?: ActivityStats | null } = {}) {
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
      .map((value: unknown) => String(value ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content: string) => content.slice(0, 120));

    return this.deps.memory.replaceMember(chatKey, mem.userId, mem.name, clean);
  }

  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem: MemoryMemberLike) {
    const fmtTs = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`群友 QQ：${mem.userId}`, `当前名字：${mem.name}`];
    for (const e of mem.impressions) lines.push(`- ${e.content} (${fmtTs(e.createdAt)})`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    return {
      system: PROMPT_CATALOG.maintenance.consolidateSystem,
      user: PROMPT_CATALOG.maintenance.consolidateUser(maxKeep, lines)
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey: string, mem: MemoryMemberLike, stats: ActivityStats | null) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    const uid = String(mem.userId || '');
    const sample = (this.deps.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);

    return {
      system: PROMPT_CATALOG.maintenance.newImpressionSystem,
      user: PROMPT_CATALOG.maintenance.newImpressionUser({
        userId: uid,
        name: String(mem.name || ''),
        maxKeep,
        sample
      })
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages: ChatRequestMessage[]) {
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
}
