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
// 窗口里只放**可唤醒的对方消息**（self / 压缩摘要 / 人工备注 / 已由确定性处理器
// 接管的 wakeEligible:false 消息一律不收）：
// 【本次唤醒】的语义是"你还没看过的最新消息"，机器人自己的话由【过去状态】以"我"出现。
//
// ── 三个状态，务必分清（混淆任意两个都会出难查的 bug）──
//   #win        最新 N 条对方消息的私有快照。超上限滑出最老成员（**异步任务结果除外**）。
//   #foldedIds  被滑出、但还没被消费的消息 id。只保留结算账本，不再保留窗口外消息内容，
//               因而响应判定和【本次唤醒】都严格只看最长 N 条。
//   lastSeenId  消费游标。id ≤ 游标 = 已被某次运行"看过"（含被折进【过去状态】的）。
//
// ⚠️ 容量同时限定【本次唤醒】和响应判定的可见范围；滑出成员只留下结算 id。
//
// ⚠️ **本类不写存档。** 唯一的下沉通道是 settled[]：消费时攒下"已看过"的 id，由调用方
//    （orchestrator 的 #consumeWindow）一次性写进存档的 read 字段。窗口自己从不读 read
//    （唯一例外：首次播种时用它还原游标）。
import { isAsyncResult, isWakeEligibleIncoming } from '../../chat/store.js';
import type { ChatStore } from '../../chat/store.js';
import type { ChatMessage } from '../../chat/types.js';

type Capacity = number | (() => number) | null;
interface WindowOptions {
  chatKey?: string;
  capacity?: Capacity;
  initialEntries?: ChatMessage[];
  initialFoldedIds?: number[];
}
interface RegistryOptions { store?: ChatStore | null; capacity?: Capacity }

export class ContextWindow {
  #capacityOf: () => number;
  #win: ChatMessage[];
  #foldedIds: number[];
  #uncommittedFoldedIds: number[];
  #lastSeenId: number;
  #settled: number[];
  #maxPushedId: number;
  readonly chatKey: string;

  /**
   * @param {object} opts
   * @param {string} opts.chatKey
   * @param {number|(() => number)} [opts.capacity] 容量，0 = 不限。
   *        传**函数**而不是数值：设置页改上限要即时生效，不能在构造时固化。
   */
  constructor({ chatKey = '', capacity = null, initialEntries = [], initialFoldedIds = [] }: WindowOptions = {}) {
    this.chatKey = chatKey;
    this.#capacityOf = typeof capacity === 'function'
      ? capacity
      : () => Math.max(0, Number(capacity) || 0);
    this.#win = structuredClone(initialEntries);
    this.#foldedIds = initialFoldedIds.map(Number).filter((id) => id > 0);
    this.#uncommittedFoldedIds = [...this.#foldedIds];
    this.#lastSeenId = 0;
    for (const entry of this.#win) {
      if (entry.read !== true) break;
      this.#lastSeenId = Number(entry.id) || 0;
    }
    this.#settled = [];
    this.#maxPushedId = 0;
    for (const entry of this.#win) this.#maxPushedId = Math.max(this.#maxPushedId, Number(entry.id) || 0);
    for (const id of this.#foldedIds) this.#maxPushedId = Math.max(this.#maxPushedId, id);
    this.#trim();
  }

  get capacity() {
    return Math.max(0, Number(this.#capacityOf()) || 0);
  }

  /** 注册表同步存档时使用的只读水位线。 */
  get maxPushedId() { return this.#maxPushedId; }

  /**
   * 收一条消息进窗（只收对方的消息；self / 摘要 / 备注直接忽略）。
   *
   * 幂等：id ≤ 已入窗的最大 id 一律忽略。播种时可能已经把它收进来了，
   * 重复投递（例如既走过 push 又被播种覆盖）不该产生第二份。
   *
   * @returns {boolean} 是否真的收进来了
   */
  push(entry: ChatMessage | null | undefined): boolean {
    if (!isWakeEligibleIncoming(entry)) return false;
    const id = Number(entry.id) || 0;
    if (id <= 0 || id <= this.#maxPushedId) return false;
    this.#maxPushedId = id;
    this.#win.push(structuredClone(entry));
    this.#trim();
    return true;
  }

  /**
   * 超上限就滑出最老成员 —— 但**异步任务结果永不滑出**。
   *
   * 为什么给它们豁免（2026-10-10 真机 + 探针实测）：被滑出的未消费条目会经
   * `takeFoldedIds()` **直接标成已读历史**（见 `#commitFolded`），从此不再参与响应判定。
   * 对普通闲聊这是对的取舍（新消息更重要），但对异步结果就是**静默丢失**：那是"你的任务
   * 结束了"的唯一凭据，模型只会看到群里凭空多了一张图，永远不知道那是自己画的。
   * 探针实测（容量 3、图到达后群里再说 5 句）：条目被滑出 → 那一轮**不由它触发**，
   * 只剩在【过去状态】的历史里露一面，连一条日志都没有。
   *
   * 代价是窗口长度可以短暂超过 `cap`（超出的是异步结果本身，数量由各能力的调用闸门兜住：
   * 每群每小时最多几次）。已消费的直接丢；未消费的只留下 id，供本批消费时
   * 下沉 read 镜像和报告 foldedAway —— 这条对普通消息**逐字未变**。
   */
  #trim() {
    const cap = this.capacity;
    if (cap <= 0) return;
    let normal = this.#win.filter((e) => !isAsyncResult(e)).length;
    while (normal > cap) {
      const at = this.#win.findIndex((e) => !isAsyncResult(e));
      if (at < 0) break;   // 理论到不了：normal > cap ≥ 0 说明一定有普通成员
      const [e] = this.#win.splice(at, 1);
      normal--;
      const id = Number(e?.id) || 0;
      if (id > this.#lastSeenId) {
        this.#foldedIds.push(id);
        this.#uncommittedFoldedIds.push(id);
      }
    }
  }

  /**
   * 当前滑动窗口中还没被运行看过的消息快照（旧→新，严格不超过容量）。
   * 返回深拷贝，调用方无法修改窗口成员。
   */
  pending(): ChatMessage[] {
    this.#trim();
    return structuredClone(this.#win.filter((e) => (Number(e.id) || 0) > this.#lastSeenId));
  }

  /**
   * 本次运行要带进【本次唤醒】的那批：窗口内还没看过的（≤ 容量）。
   * 与 pending() 的差集就是这次被折进【过去状态】的条数，见 foldedCount()。
   */
  batch(): ChatMessage[] {
    return this.pending();
  }

  /** 被折走的条数（窗外、且还没消费）—— 喂提示词的 foldedAway。 */
  foldedCount(): number {
    this.#trim();
    return this.#foldedIds.length;
  }

  /**
   * 取走本次新滑出、尚未同步到 ChatStore.read 的消息 id。
   *
   * 与 foldedCount() 刻意分离：取走待提交 id 后，本轮折叠数量仍要保留到 seen()，
   * 供 foldedAway 和会话日志使用；只有“尚未落已读”的队列会被清空。
   */
  takeFoldedIds(): number[] {
    this.#trim();
    if (!this.#uncommittedFoldedIds.length) return [];
    const out = [...new Set(this.#uncommittedFoldedIds)];
    this.#uncommittedFoldedIds = [];
    return out;
  }

  /**
   * 消费：游标推到窗口末尾，把窗口成员和折叠 id 记进 settled（待写存档镜像）。
   *
   * 响应与不响应**两条分支都调它** —— 这就是"不论响应还是不响应，都要更新上下文窗口"：
   * 看过就是看过，不然被跳过的老消息下次会被当成"刚发生的"重新塞进【本次唤醒】。
   *
   * ⚠️ 必须与 batch()/foldedCount() 在同一个同步块里调用（中间不夹 await），
   *    否则"取批"和"消费"之间窗口会动。
   *
   * @returns {object[]} 本次跨过的条目（旧→新）
   */
  seen(): ChatMessage[] {
    this.#trim();
    const crossed = this.pending();
    let maxId = this.#lastSeenId;
    for (const id of this.#foldedIds) if (id > maxId) maxId = id;
    for (const e of crossed) {
      const id = Number(e.id) || 0;
      this.#settled.push(id);
      if (id > maxId) maxId = id;
    }
    this.#lastSeenId = maxId;
    this.#foldedIds = [];
    return crossed;
  }

  /** 取走并清空"待写进存档 read 的 id"。 */
  takeSettled(): number[] {
    if (!this.#settled.length) return [];
    const out = this.#settled;
    this.#settled = [];
    return out;
  }

  /** 诊断用快照（日志/接口/测试）。 */
  stats() {
    return {
      chatKey: this.chatKey,
      capacity: this.capacity,
      win: this.#win.length,
      folded: this.#foldedIds.length,
      pending: this.pending().length,
      batch: this.batch().length,
      cursor: this.#lastSeenId
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
  #store: ChatStore | null;
  #capacityOf: () => number;
  #windows: Map<string, ContextWindow>;

  constructor({ store = null, capacity = null }: RegistryOptions = {}) {
    this.#store = store;
    this.#capacityOf = typeof capacity === 'function'
      ? capacity
      : () => Math.max(0, Number(capacity) || 0);
    this.#windows = new Map();
  }

  get capacity() {
    return Math.max(0, Number(this.#capacityOf()) || 0);
  }

  has(chatKey: string): boolean {
    return this.#windows.has(chatKey);
  }

  /**
   * 存档发生删除等结构变化后，从事实源整体重建窗口。
   * 外部只能请求重建，不能指定、读取或修改某个窗口成员。
   */
  reload(chatKey: string): void {
    const w = this.#createSeeded(chatKey);
    this.#windows.set(chatKey, w);
    this.#commitFolded(w);
  }

  /** 取窗口（不存在就播种建出来）。所有访问都从它进。 */
  ensure(chatKey: string): ContextWindow {
    let w = this.#windows.get(chatKey);
    if (!w) {
      w = this.#createSeeded(chatKey);
      this.#windows.set(chatKey, w);
    }
    this.#sync(w);
    // foldedCount() 同时让动态调小的容量立即生效；随后把新滑出的 id 直接沉入历史。
    w.foldedCount();
    this.#commitFolded(w);
    return w;
  }

  /** 收消息进窗（唯一的入窗入口，见类注释）。 */
  push(chatKey: string, entry: ChatMessage | null | undefined): boolean {
    if (!entry) return false;
    const w = this.ensure(chatKey);
    const pushed = w.push(entry);
    this.#commitFolded(w);
    return pushed;
  }

  pending(chatKey: string) { return this.ensure(chatKey).pending(); }
  batch(chatKey: string) { return this.ensure(chatKey).batch(); }
  foldedCount(chatKey: string) { return this.ensure(chatKey).foldedCount(); }
  seen(chatKey: string) { return this.ensure(chatKey).seen(); }
  takeSettled(chatKey: string) { return this.ensure(chatKey).takeSettled(); }

  /** 未消费条数（门禁用：它还有几批没处理）。 */
  pendingCount(chatKey: string): number {
    return this.ensure(chatKey).pending().length;
  }

  stats(chatKey: string) {
    if (!this.#windows.has(chatKey)) return null;
    const w = this.ensure(chatKey);
    return w.stats();
  }

  /**
   * 首次播种。**只在窗口刚建出来时跑一次**，之后再不看存档。
   *
   * 窗口 = 最新 N 条对方消息；比窗口更老且仍未读的只留下 id 结算账本，
   * 不再把完整消息暴露成第二个窗口。
   *
   * 容量 0（不限）时窗口即全部，折叠账本恒空。
   */
  #createSeeded(chatKey: string): ContextWindow {
    const cap = this.capacity;
    const all = this.#store?.recentIncoming
      ? this.#store.recentIncoming(chatKey, { limit: 0 })
      : [];
    const cut = cap > 0 ? Math.max(0, all.length - cap) : 0;
    const foldedIds: number[] = [];
    for (let i = 0; i < cut; i++) {
      if (all[i].read !== true) foldedIds.push(Number(all[i].id) || 0);
    }
    return new ContextWindow({
      chatKey,
      capacity: () => this.capacity,
      initialEntries: all.slice(cut),
      initialFoldedIds: foldedIds
    });
  }

  /**
   * 兜底补齐：存档里出现了窗口没见过的对方消息（id 比窗口最大的还大）就补收进来。
   * 正常情况下 onIncoming 的 push 已经收过了，这里是"漏了 push 也不会静默分叉"的保险。
   */
  #sync(w: ContextWindow): void {
    const store = this.#store;
    if (!store?.lastIncomingId) return;
    const last = store.lastIncomingId(w.chatKey);
    if (last <= w.maxPushedId) return;
    const all = store.recentIncoming ? store.recentIncoming(w.chatKey, { limit: 0 }) : [];
    for (const e of all) if ((Number(e.id) || 0) > w.maxPushedId) w.push(e);
  }

  /** 折叠 ID 的唯一落盘出口：滑出窗口即标为已读历史。 */
  #commitFolded(w: ContextWindow): void {
    const ids = w.takeFoldedIds();
    if (ids.length) this.#store?.markRead(w.chatKey, { ids });
  }
}
