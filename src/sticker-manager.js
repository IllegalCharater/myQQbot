// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import { OneBotClient } from './onebot.js';
import { getConfig } from './config.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, formatStickerAdminList, applyStickerNote, markStickerUsed,
  removeSticker
} from './stickers.js';

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
    saveStickerStore(this.entries);
    this.#changed();
    return { removed: result.removed, refused: '' };
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
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

  /** 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。 */
  collect(messageId, { url, note = '' } = {}) {
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
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);
    this.#changed();
    return entry;
  }
}
