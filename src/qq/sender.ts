// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig, DEFAULT_CONFIG } from '../core/config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from '../core/util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
interface SendOptions { replyToMessageId?: unknown; atUserId?: unknown; file?: string }
interface StickerLike extends Record<string, unknown> { id: string; url: string; desc?: string; localNote?: string }
interface OneBotSender {
  sendText(kind: string, id: string, text: string, options: SendOptions): Promise<unknown>;
  sendSticker(kind: string, id: string, file: string, options: SendOptions): Promise<unknown>;
  sendImage(kind: string, id: string, file: string, options: SendOptions): Promise<unknown>;
  sendPoke(kind: string, id: string, targetUserId: unknown): Promise<unknown>;
}
interface ChatStoreWriter { appendSelf(chatKey: string, input: { text: unknown; ts?: number; mid?: string | number | null }): unknown }
type SendChain = <T>(task: () => Promise<T>) => Promise<T>;
function messageIdOf(data: unknown): string | number | null {
  const value = data && typeof data === 'object' && 'message_id' in data ? data.message_id : null;
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;

export class SendQueue {
  onebot: OneBotSender;
  store: ChatStoreWriter;
  onSent: ((event: Record<string, unknown>) => void) | null;
  chains: Map<string, SendChain>;
  minuteTimes: Map<string, number[]>;
  hourTimes: Map<string, number[]>;
  replying: Set<string>;

  constructor({ onebot, store, onSent = null }: { onebot: OneBotSender; store: ChatStoreWriter; onSent?: ((event: Record<string, unknown>) => void) | null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    // chatKey -> 正在回复态（由 orchestrator 的静默/回复状态机维护）。
    // 所有状态共用 send.maxPerMinute；回复态命中上限时可按 reply.maxLimitWaitMs 有界等待。
    this.replying = new Set();
  }

  /** 由编排器在进入/退出回复态时调用（幂等）。 */
  setReplying(chatKey: string, on: boolean) {
    if (on) this.replying.add(chatKey);
    else this.replying.delete(chatKey);
  }

  clearReplying() {
    this.replying.clear();
  }

  #chain(chatKey: string): SendChain {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey)!;
  }

  /**
   * 限频检查。**async**：回复态内命中分钟限频时会有界等待一个空位再放行
   * （见下面 maxLimitWaitMs 的说明），所以调用方必须 await。
   */
  async #checkRate(chatKey: string) {
    const now = Date.now();
    const cfg = getConfig().send;
    const rep = getConfig().reply || {};
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    // 回退值必须与 config.js 的默认值一致（80）。此前这里是 8，
    // 配置缺失/为 0 时限频突然收紧 10 倍，行为不可预测。
    const effMinute = Math.max(1, Number(cfg.maxPerMinute) || DEFAULT_MAX_PER_MINUTE);
    const replying = this.replying.has(chatKey);

    if (minute.length >= effMinute) {
      // 回复态内**有界等待**一个空位，而不是直接抛错。
      //
      // 抛错意味着模型收到工具错误且那条消息被丢弃；系统提示又明确要求模型
      //"失败的请稍后再试"，于是常见结果是重复重发再次失败，或模型放弃、
      // 在对话中途变哑巴 —— 在群里看起来就是机器人坏了。
      // 真人撞到自己的打字速度上限时做的正是有界等待：停一下再发。
      // 有界（maxLimitWaitMs，默认 20s）保证工具延迟可预测；本函数位于每会话
      // 串行 chain 内，sleep 会自动按会话串行，不会与别的发送交错。
      // 静默态维持原行为：直接抛错。
      const wait = Math.max(0, minute[0] + 60000 - Date.now() + 50);
      const grace = Math.max(0, Number(rep.maxLimitWaitMs) || 0);
      if (replying && grace > 0 && wait <= grace) {
        await sleep(wait);
        const now2 = Date.now();
        const freed = (this.minuteTimes.get(chatKey) || []).filter((t) => now2 - t < 60000);
        if (freed.length >= effMinute) {
          throw new Error(`发送频率超限（每分钟最多 ${effMinute} 条），请等一会再发`);
        }
        freed.push(now2);
        this.minuteTimes.set(chatKey, freed);
        const hour2 = (this.hourTimes.get(chatKey) || []).filter((t) => now2 - t < 3600000);
        hour2.push(now2);
        this.hourTimes.set(chatKey, hour2);
        return;
      }
      throw new Error(`发送频率超限（每分钟最多 ${effMinute} 条），请等一会再发`);
    }
    // 小时窗口维持直接报错：在工具调用里等一小时不是"速度"语义
    if (hour.length >= Math.max(1, Number(cfg.maxPerHour) || DEFAULT_MAX_PER_HOUR)) {
      throw new Error(`发送频率超限（每小时最多 ${cfg.maxPerHour} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  #gap(text: unknown, isLast: boolean) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey: string, messages: unknown[] | unknown, options: SendOptions = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts: string[] = [];
    for (const m of list) {
      const plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      // 最后防线：任何上游畸形路径漏下来的 "[object Object]" 到这儿直接拦掉，
      // 用户永远不该在 QQ 里看到这串字符。全被拦 → 下方抛"消息内容为空"回给模型。
      if (/^\[object Object\]$/.test(plain)) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const promises: Array<Promise<Record<string, unknown>>> = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      const gap = this.#gap(text, isLast);
      promises.push(chain(async () => {
        await this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);
        const data = await this.onebot.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null
        });
        const ts = Date.now();
        const messageId = messageIdOf(data);
        this.store.appendSelf(chatKey, { text, ts, mid: messageId });
        this.onSent?.({ chatKey, text, messageId });
        return { text, messageId, at: formatClockTime(ts) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent: Array<Record<string, unknown>> = [];
    const failed: Array<{ index: number; text: string; error: string }> = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') sent.push(r.value);
      // 带上 index 和原文：调用方需要知道"哪一条"失败了（才能重发或告知模型）。
      // 原先 failed 里只有 error，没有任何定位信息。
      else failed.push({ index: i, text: parts[i], error: String(r.reason?.message ?? r.reason) });
    }
    // 部分成功也要让调用方知道：原先只在"全败"时抛错，部分成功会静默丢消息
    if (failed.length > 0) {
      const detail = failed.map((f) => `第${f.index + 1}条「${String(f.text).slice(0, 20)}」：${f.error}`).join('；');
      if (sent.length === 0) throw new Error(detail);
      console.warn(`[sender] 部分发送失败（${failed.length}/${parts.length}）：${detail}`);
    }
    return { sent, failed };
  }

  /**
   * 发送一个收藏表情（独立气泡）。
   * options.file 覆盖用哪张图：默认 sticker.url，工具层会传 bot 收藏条目在
   * data/sticker-cache/ 里的**本机绝对路径**（协议端与本机同进程树，读得到）。
   */
  sendSticker(chatKey: string, sticker: StickerLike, options: SendOptions = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      await this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      const data = await this.onebot.sendSticker(kind, id, options.file || sticker.url, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      const messageId = messageIdOf(data);
      this.store.appendSelf(chatKey, { text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, ts, mid: messageId });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId, sticker: sticker.id });
      return { message_id: messageId };
    });
  }

  /**
   * 发送一张图片（本机绝对路径或公网 URL），独立气泡。
   *
   * 与 `sendSticker` 是**同一个出站动作**（图片段），差别只在留档文本与语义：
   * 这里留 `[图片]`，因为图是"模型画的"而不是"收藏的表情"，存档要能分清。
   * 限频与存档照旧（它仍是出站动作，仍要记账、仍要留 `我：[图片]`）。
   *
   * ⚠️ **刻意不走每会话串行链**（`#chain`），与转写的全文文件、漫画的 PDF 同一条口径
   * （那两处直接 `onebot.call('upload_*_file', …, 120_000)`，压根不经过 `SendQueue`）。
   *
   * 理由是实测出来的（2026-10-10）：图片段要协议端先读本机文件、再传到 QQ 图床，
   * 慢起来能到分钟级；占着会话链的后果不只是"图晚一点到"，而是**正在进行的对话整体堵住** ——
   * 模型收尾那一步正是 `send_message`，它排在链上等上传，于是工具调用不返回、本轮运行不结束，
   * 面板上那条会话一直显示"运行中"。会话的收尾不该由一张图的传输速度决定。
   *
   * 代价（与那两处上传相同、且是知情的）：图片可能与文本交错 —— 极端情况下它落在
   * 同一批多段文本的两段之间。换来的是一条卡住的上传不再冻结整个会话的发言。
   */
  sendImage(chatKey: string, file: unknown, options: SendOptions = {}) {
    const [kind, id] = String(chatKey).split(':');
    return (async () => {
      await this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 与发表情同样的真人式短暂停顿
      const data = await this.onebot.sendImage(kind, id, String(file), {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      const messageId = messageIdOf(data);
      this.store.appendSelf(chatKey, { text: '[图片]', ts, mid: messageId });
      this.onSent?.({ chatKey, text: '[图片]', messageId });
      return { message_id: messageId };
    })();
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey: string, targetUserId: unknown) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 拍一拍同样是出站动作：原先完全不走限频，回复态的限速对它形同虚设。
      await this.#checkRate(chatKey);
      await sleep(randInt(300, 900));
      const data = await this.onebot.sendPoke(kind, id, targetUserId);
      const ts = Date.now();
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts, mid: messageIdOf(data) });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
    });
  }
}
