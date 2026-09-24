// 动态上下文窗口：每个会话一个「一直保持最新」的消息窗。
//
// 为什么单独成一个类（三条理由，各对应一种旧的失败）：
//  1. **上限只有一个收口点**。改造前 store.maxContextMessages 只在"要响应"那条分支里裁剪
//     触发批（orchestrator 里那段 slice(-ctxCap)），而"不响应"分支是完全另一套动作
//     （markAllRead 全量标已读）—— 两处各写一套，日后必然漂移。
//  2. **窗口必须一直是最新的**。消息一到就入窗、超上限立刻丢最老，而不是等到某次运行
//     才开始处理。这样"它此刻看到的最近聊天"在任何时刻都是真的。
//  3. **与存档解耦**。"看过没看过"由窗口自己的游标决定，不再寄存在 messages/*.json 的
//     read 字段里。存档的 read 降级成**只写不读的展示镜像**（消费时一次性下沉，供面板
//     显示未读），窗口除了"首次播种一次"和"写镜像"之外不碰存档、也不依赖它。
//
// 窗口里只放**对方发来的消息**（self / 压缩摘要 / 人工备注一律不收）：
// 【本次唤醒】的语义是"你还没看过的最新消息"，机器人自己的话由【过去状态】以"我"出现。
//
// ── 三个状态，务必分清（混淆任意两个都会出难查的 bug）──
//   win[]       最新 N 条对方消息。**永不清空**，超上限丢最老。存的是存档条目的**引用**
//               （不复制、不落盘），所以面板改文本、补媒体，窗口里立刻同步。
//   sunk[]      被挤出窗口、但**还没被任何一次运行消费**的旧条目。不能直接丢：它们同样
//               「还没看过」，既要参与判定（被艾特/关键词），也要在下次消费时一起标记已读。
//               只存引用，消费后立刻清空。
//   lastSeenId  消费游标。id ≤ 游标 = 已被某次运行"看过"（含被折进【过去状态】的）。
//
// ⚠️ **容量只管"带多少进【本次唤醒】，绝不管"值不值得回应"的判定。**
//    判定看的是 pending()（窗口内 + 窗外未消费的全部，不设上限）。若把上限加到判定上，
//    上限设小时埋在积压里的 @ 会被漏判，而且因为游标随即推进，它再也不会被考虑
//    —— 旧代码在 orchestrator 里专门警告过这个坑。
//
// ⚠️ **本类不写存档。** 唯一的下沉通道是 settled[]：消费时攒下"已看过"的 id，由调用方
//    （orchestrator 的 #consumeWindow）一次性写进存档的 read 字段。窗口自己从不读 read
//    （唯一例外：首次播种时用它还原游标）。
import { isSystemRecord } from './store.js';

export class ContextWindow {
  #capacityOf;

  /**
   * @param {object} opts
   * @param {string} opts.chatKey
   * @param {number|(() => number)} [opts.capacity] 容量，0 = 不限。
   *        传**函数**而不是数值：设置页改上限要即时生效，不能在构造时固化。
   */
  constructor({ chatKey = '', capacity = null } = {}) {
    this.chatKey = chatKey;
    this.#capacityOf = typeof capacity === 'function'
      ? capacity
      : () => Math.max(0, Number(capacity) || 0);
    this.win = [];
    this.sunk = [];
    this.lastSeenId = 0;
    this.settled = [];
    this.maxPushedId = 0;
  }

  get capacity() {
    return Math.max(0, Number(this.#capacityOf()) || 0);
  }

  /**
   * 收一条消息进窗（只收对方的消息；self / 摘要 / 备注直接忽略）。
   *
   * 幂等：id ≤ 已入窗的最大 id 一律忽略。播种时可能已经把它收进来了，
   * 重复投递（例如既走过 push 又被播种覆盖）不该产生第二份。
   *
   * @returns {boolean} 是否真的收进来了
   */
  push(entry) {
    if (!entry || entry.self || isSystemRecord(entry)) return false;
    const id = Number(entry.id) || 0;
    if (id <= 0 || id <= this.maxPushedId) return false;
    this.maxPushedId = id;
    this.win.push(entry);
    this.#trim();
    return true;
  }

  /**
   * 超上限就丢最老。**分流是关键**：
   *   已消费的（id ≤ 游标）→ 直接丢，它们已经在【过去状态】里了；
   *   还没消费的          → 移进 sunk[]，它们**仍然算"没看过"**。
   *
   * 这条分流保证了两件事：调小上限不会追溯性地毁掉积压（下次运行照样消费它们），
   * 以及容量 0（不限）时 sunk 永远为空。
   */
  #trim() {
    const cap = this.capacity;
    if (cap <= 0) return;
    while (this.win.length > cap) {
      const e = this.win.shift();
      if ((Number(e.id) || 0) > this.lastSeenId) this.sunk.push(e);
    }
  }

  /**
   * 「还没被任何一次运行看过」的全部消息（旧→新，**不设上限**）。
   * 触发判定（被艾特/关键词）用它 —— 见文件头那条警告。
   */
  pending() {
    const out = [];
    for (const e of this.sunk) if ((Number(e.id) || 0) > this.lastSeenId) out.push(e);
    for (const e of this.win) if ((Number(e.id) || 0) > this.lastSeenId) out.push(e);
    return out;
  }

  /**
   * 本次运行要带进【本次唤醒】的那批：窗口内还没看过的（≤ 容量）。
   * 与 pending() 的差集就是这次被折进【过去状态】的条数，见 foldedCount()。
   */
  batch() {
    return this.win.filter((e) => (Number(e.id) || 0) > this.lastSeenId);
  }

  /** 被折走的条数（窗外、且还没消费）—— 喂提示词的 foldedAway。 */
  foldedCount() {
    let n = 0;
    for (const e of this.sunk) if ((Number(e.id) || 0) > this.lastSeenId) n++;
    return n;
  }

  /**
   * 消费：游标推到窗口末尾，把「还没看过」的全部记进 settled（待写存档镜像），清空 sunk。
   *
   * 响应与不响应**两条分支都调它** —— 这就是"不论响应还是不响应，都要更新上下文窗口"：
   * 看过就是看过，不然被跳过的老消息下次会被当成"刚发生的"重新塞进【本次唤醒】。
   *
   * ⚠️ 必须与 batch()/foldedCount() 在同一个同步块里调用（中间不夹 await），
   *    否则"取批"和"消费"之间窗口会动。
   *
   * @returns {object[]} 本次跨过的条目（旧→新）
   */
  seen() {
    const crossed = this.pending();
    let maxId = this.lastSeenId;
    for (const e of crossed) {
      const id = Number(e.id) || 0;
      this.settled.push(id);
      if (id > maxId) maxId = id;
    }
    this.lastSeenId = maxId;
    this.sunk = [];      // 全部 ≤ 游标了（它们刚才已经在 crossed 里）
    return crossed;
  }

  /** 取走并清空"待写进存档 read 的 id"。 */
  takeSettled() {
    if (!this.settled.length) return [];
    const out = this.settled;
    this.settled = [];
    return out;
  }

  /**
   * 面板把某条消息删了：窗口和 sunk 里都得跟着去掉。
   * 不动游标 —— 游标是"看到哪了"的水位线，删一条不该让它退回去
   * （id 由存档单调发放，水位线只需要单调）。
   */
  remove(id) {
    const target = Number(id) || 0;
    if (!target) return false;
    const before = this.win.length + this.sunk.length;
    this.win = this.win.filter((e) => (Number(e.id) || 0) !== target);
    this.sunk = this.sunk.filter((e) => (Number(e.id) || 0) !== target);
    return this.win.length + this.sunk.length !== before;
  }

  /**
   * 用存档播种（只在窗口刚建出来时调用一次）。
   *
   * 游标不能瞎猜：它是"已经被处理过"的水位线，播种错了要么把老消息重跑一遍，
   * 要么把没处理过的消息永久吞掉。所以按**前缀已读**规则还原：
   * 从最老往新扫，连续 read===true 的最后一条就是游标。这条规则成立的前提是
   * 所有标记路径都只会"整批往下压"（drainUnread/markAllRead/面板标已读都是全量，
   * 新消息一律 read:false 排在最后），read 必然是存档里的一个前缀。
   *
   * @param {object[]} winEntries 窗口内容（最新 N 条对方消息，旧→新）
   * @param {object[]} sunkEntries 比窗口更老、且 still 未读的对方消息（旧→新）
   */
  seed(winEntries = [], sunkEntries = []) {
    this.win = Array.isArray(winEntries) ? [...winEntries] : [];
    this.sunk = Array.isArray(sunkEntries) ? [...sunkEntries] : [];
    // 全是已读 → 游标停在最后一条（窗口内容全部算"看过"）；
    // 没有任何 read 前缀（全新会话 / 全部未读）→ 游标停在 0，全部算"没看过"，
    // 与改造前 drainBacklogAfterResume 的行为一致。
    let cursor = 0;
    for (const e of this.win) {
      if (e.read !== true) break;
      cursor = Number(e.id) || 0;
    }
    this.lastSeenId = cursor;
    // ⚠️ 不用 Math.max(...ids)：容量 0（不限）时这里可能有十万级元素，展开会爆栈。
    let maxPushed = 0;
    for (const e of this.win) maxPushed = Math.max(maxPushed, Number(e.id) || 0);
    for (const e of this.sunk) maxPushed = Math.max(maxPushed, Number(e.id) || 0);
    this.maxPushedId = maxPushed;
    this.#trim();   // 播种时容量可能已被调小，补齐一次裁剪
    return this;
  }

  /** 诊断用快照（日志/接口/测试）。 */
  stats() {
    return {
      chatKey: this.chatKey,
      capacity: this.capacity,
      win: this.win.length,
      sunk: this.sunk.length,
      pending: this.pending().length,
      batch: this.batch().length,
      cursor: this.lastSeenId
    };
  }
}

/**
 * 每会话一个窗口的注册表（门面）。
 *
 * ⚠️ **push() 是唯一的入窗入口**：任何"消息写进存档"的新路径都必须同时调它，
 *    否则窗口与存档会静默分叉（那条消息既不进【本次唤醒】，也不会被标记已读）。
 *    #sync() 是兜底：发现存档里有窗口没见过的消息（播种之后仍出现的新消息，
 *    例如测试直接写 store、或将来新增的入口）就顺手补齐。
 */
export class ContextWindowRegistry {
  #store;

  constructor({ store, capacity = null, windows = null } = {}) {
    this.#store = store;
    this.#capacityOf = typeof capacity === 'function'
      ? capacity
      : () => Math.max(0, Number(capacity) || 0);
    this.windows = windows instanceof Map ? windows : new Map();
  }

  #capacityOf;

  get capacity() {
    return Math.max(0, Number(this.#capacityOf()) || 0);
  }

  has(chatKey) {
    return this.windows.has(chatKey);
  }

  /** 取窗口（不存在就播种建出来）。所有访问都从它进。 */
  ensure(chatKey) {
    let w = this.windows.get(chatKey);
    if (!w) {
      w = new ContextWindow({ chatKey, capacity: () => this.capacity });
      this.windows.set(chatKey, w);
      this.#seed(w);
    }
    this.#sync(w);
    return w;
  }

  /** 只看不建（用于"这个会话有没有窗口"这类判断）。 */
  get(chatKey) {
    return this.windows.get(chatKey) || null;
  }

  /** 收消息进窗（唯一的入窗入口，见类注释）。 */
  push(chatKey, entry) {
    if (!entry) return false;
    return this.ensure(chatKey).push(entry);
  }

  pending(chatKey) { return this.ensure(chatKey).pending(); }
  batch(chatKey) { return this.ensure(chatKey).batch(); }
  foldedCount(chatKey) { return this.ensure(chatKey).foldedCount(); }
  seen(chatKey) { return this.ensure(chatKey).seen(); }
  takeSettled(chatKey) { return this.ensure(chatKey).takeSettled(); }

  remove(chatKey, id) {
    const w = this.windows.get(chatKey);
    return w ? w.remove(id) : false;
  }

  /** 未消费条数（门禁用：它还有几批没处理）。 */
  pendingCount(chatKey) {
    return this.ensure(chatKey).pending().length;
  }

  stats(chatKey) {
    const w = this.windows.get(chatKey);
    return w ? w.stats() : null;
  }

  /**
   * 首次播种。**只在窗口刚建出来时跑一次**，之后再不看存档。
   *
   * 窗口 = 最新 N 条对方消息；比窗口更老、且仍未读的 → sunk（它们照样算"没看过"，
   * 下次运行会一并消费）；游标 = read 前缀的水位线（见 ContextWindow#seed）。
   *
   * 容量 0（不限）时窗口即全部，sunk 恒空。
   */
  #seed(w) {
    const cap = this.capacity;
    const all = this.#store?.recentIncoming
      ? this.#store.recentIncoming(w.chatKey, { limit: 0 })
      : [];
    if (!all.length) return;
    const cut = cap > 0 ? Math.max(0, all.length - cap) : 0;
    const sunk = [];
    for (let i = 0; i < cut; i++) {
      if (all[i].read !== true) sunk.push(all[i]);
    }
    w.seed(all.slice(cut), sunk);
  }

  /**
   * 兜底补齐：存档里出现了窗口没见过的对方消息（id 比窗口最大的还大）就补收进来。
   * 正常情况下 onIncoming 的 push 已经收过了，这里是"漏了 push 也不会静默分叉"的保险。
   */
  #sync(w) {
    const store = this.#store;
    if (!store?.lastIncomingId) return;
    const last = store.lastIncomingId(w.chatKey);
    if (last <= w.maxPushedId) return;
    const all = store.recentIncoming ? store.recentIncoming(w.chatKey, { limit: 0 }) : [];
    for (const e of all) if ((Number(e.id) || 0) > w.maxPushedId) w.push(e);
  }
}
