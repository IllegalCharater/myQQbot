// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import { OneBotClient } from './onebot.js';
import { getConfig } from './config.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, formatStickerAdminList, applyStickerNote, markStickerUsed,
  removeSticker, resolveStickerRef, selectEvictions
} from './stickers.js';
import { ensureCached, dropCached, cachedPath, sweepOrphans } from './sticker-cache.js';

export class StickerManager {
  /**
   * @param {object} onebot
   * @param {{onChange?: () => void}} [opts] onChange：库被改动时回调（面板推 SSE 用）。
   *   可选参数——不传就是个纯粹的库管理器，测试里的 `new StickerManager(fake)` 照旧。
   */
  constructor(onebot, { onChange = null } = {}) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
    this.onChange = typeof onChange === 'function' ? onChange : null;
    // 上一次 collect 淘汰掉的条目（工具回执要照实说删了谁；每次 collect 重置）
    this.lastEvicted = [];
  }

  /** 库有变动（改/删/收藏/发过）时通知外面一次。绝不抛错出去影响写盘。 */
  #changed() {
    try { this.onChange?.(); } catch { /* 通知失败不影响库本身 */ }
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        this.entries = mergeStickerLibrary(this.entries, fetched);
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        this.#changed();
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  /** 面板管理页：完整字段（含图片地址）。force 用于"从 QQ 刷新"按钮。 */
  async adminList(query = '', limit = 500, force = false) {
    const synced = await this.sync(force);
    return { ...formatStickerAdminList(synced.entries, query, limit), fromCache: !!synced.fromCache, syncError: synced.error || '' };
  }

  /**
   * 删除一条表情。返回 { removed, refused }。
   *
   * refused 专指 source === 'qq'：QQ 收藏是真正的源，本地删掉下次 sync 就并回来了
   * （mergeStickerLibrary 会按 fetchedIds 重新收编），所以这里不装作能删 —— 让
   * 调用方回一句"去 QQ 里取消收藏"。删除交给用户自己做，比给个假按钮诚实。
   */
  remove(ref) {
    const result = removeSticker(this.entries, ref);
    if (!result.removed) return { removed: null, refused: '' };
    if (result.removed.source === 'qq') return { removed: null, refused: 'qq' };
    this.entries = result.entries;
    dropCached(result.removed);   // 条目走了，它在本地的图也不该留着
    saveStickerStore(this.entries);
    this.#changed();
    return { removed: result.removed, refused: '' };
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  /**
   * 认 id/resId/md5/url，也认备注/标签（唯一命中时）—— send_sticker / get_sticker_image 用它。
   * 与 find() 的区别：find 是"按 id 精确取"，返回条目或 null；这个返回 { entry, ambiguous }，
   * 让工具能把"说不清是哪个"如实报回去（多命中时报候选 id，不猜）。
   */
  async resolve(ref) {
    const synced = await this.sync(false);
    return resolveStickerRef(synced.entries, ref);
  }

  /**
   * 把某一条的图补进本地缓存（面板「缓存图片」按钮用）。已经有的不重下。
   * 返回 { entry, cached, error }：error 是人话，面板要照实说"哪几条没补上、为什么"。
   */
  async cacheOne(ref) {
    const entry = await this.find(ref);
    if (!entry || entry.source === 'qq') return { entry: entry || null, cached: false, error: '' };
    if (cachedPath(entry)) return { entry, cached: true, error: '' };
    const error = await this.#cacheEntry(entry);
    if (entry.cacheFile) {
      saveStickerStore(this.entries);
      this.#changed();
    }
    return { entry, cached: !!entry.cacheFile, error };
  }

  /** 删掉没人认领的缓存文件（手改过库、写盘写一半崩了的残留），返回删了几个。 */
  sweep() {
    return sweepOrphans(this.entries);
  }

  /** 改备注。ref 可以是 id，也可以是备注/标签（唯一命中时）。返回整个结果，供工具报歧义。 */
  noteVerbose(ref, patch) {
    const result = applyStickerNote(this.entries, ref, patch);
    this.entries = result.entries;
    if (result.entry) { saveStickerStore(this.entries); this.#changed(); }
    return result;
  }

  note(id, patch) {
    return this.noteVerbose(id, patch).entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) { saveStickerStore(this.entries); this.#changed(); }
    return result.entry;
  }

  /** 把图落到本地缓存并把文件名写回条目。返回错误信息（'' = 成功）。绝不抛 —— 收藏本身已经成了。 */
  async #cacheEntry(entry) {
    try {
      const cached = await ensureCached(entry);
      if (!cached) return '';
      entry.cacheFile = cached.name;
      entry.cachedAt = new Date().toISOString();
      return '';
    } catch (error) {
      return String(error?.message ?? error);   // 图床取不到就算了，发送时会退回原链接
    }
  }

  /**
   * 超出 sticker.maxKeepCount 时，删掉 bot 自己收藏里"使用频率最低、保存时间最早"的那些
   * （条目和它的本地图片一起走）。返回被删的条目。
   *
   * 只在**收藏新条目之后**调一次，正是用户要的"当有新的表情包保存时"——
   * 把上限调小不会立刻删东西，得等下一次收藏。QQ 收藏既不算进上限也一条不动（见 selectEvictions）。
   */
  #enforceCap() {
    const cap = Math.max(0, Number(getConfig().sticker?.maxKeepCount) || 0);
    const { keep, drop } = selectEvictions(this.entries, cap);
    if (!drop.length) return [];
    for (const entry of drop) dropCached(entry);
    this.entries = keep;
    return drop;
  }

  /**
   * 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。
   *
   * 顺带把图落到本地缓存（见 sticker-cache.js）：收藏这一刻的图床链接最新鲜，是下载
   * 成功率最高的时机，之后发送就给协议端一个本机路径，不再看那条会过期的链接的脸色。
   * 所以要等这次下载 —— 失败也只是没有缓存，收藏本身照成。
   */
  async collect(messageId, { url, note = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    // 限频
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      this.lastEvicted = [];
      return this.note(id, { note: String(note || '') });
    }
    const entry = {
      id,
      resId: id,
      url,
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cacheFile: '',
      cachedAt: ''
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    await this.#cacheEntry(entry);
    this.lastEvicted = this.#enforceCap();
    saveStickerStore(this.entries);
    this.#changed();
    return entry;
  }
}
