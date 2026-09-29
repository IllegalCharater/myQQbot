// 能力调用的滑动窗口闸门（搜图、转写共用）
//
// 有些能力会消耗**外部配额或真金白银**（SauceNAO 免费额度极紧、trace.moe 按 IP 按天限流、
// 腾讯云录音文件识别按次计费），而"这一次该不该调用"这个语义判断已经交回模型
// （工具 description 里写清了适用场景）。这里只做一件事：**限制单位时间内的调用次数**，
// 不判断调用是否合理。
//
// 形态照抄 `src/qq/sender.ts` 的每键滑动窗口（`Map<chatKey, number[]>` + 按窗口过滤时间戳），
// 不另造抽象。两个窗口各管一件事：
//   · 每会话每小时 —— 防单个群刷屏；
//   · 全局每天     —— 防所有会话加起来刷爆配额。
//
// 构造函数只收一个 `getLimits`，不认具体的配置形状——搜图与转写的字段名虽然一样，
// 但归属不同的配置块，由调用方各自投影成 `BudgetLimits`，这个模块不认识它们。
//
// 进程内内存态，重启即清零（与 `image-source/cache.ts` 的 LRU 缓存一致）。
// 已知取舍：调用方在**真正发请求之前**记账，所以命中缓存的重复查询也会占额度；
// 方向偏保守，而这道闸门本意就是压制刷屏。

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface BudgetLimits {
  /** 单个会话（chatKey）每小时最多调用几次 */
  perChatPerHour: number;
  /** 所有会话合计每天最多调用几次 */
  perDay: number;
}

export class SlidingWindowBudget {
  readonly #chatTimes = new Map<string, number[]>();
  #dayTimes: number[] = [];

  constructor(private readonly deps: {
    getLimits: () => BudgetLimits;
    now?: () => number;
  }) {}

  /** 消耗一次调用额度；超限抛 `Error('RATE_LIMITED')`。 */
  take(chatKey: string): void {
    const now = this.deps.now ? this.deps.now() : Date.now();
    const limits = this.deps.getLimits();
    // 与 sender.ts 的回退口径一致：配置缺失或非正数时回退到 1，而不是当成"不限"。
    const hourly = Math.max(1, Math.trunc(Number(limits.perChatPerHour)) || 1);
    const daily = Math.max(1, Math.trunc(Number(limits.perDay)) || 1);
    // 先按窗口裁掉过期时间戳，顺带把空掉的键删掉，避免 Map 随历史会话数无界增长。
    const chat = (this.#chatTimes.get(chatKey) || []).filter((t) => now - t < HOUR_MS);
    const day = this.#dayTimes.filter((t) => now - t < DAY_MS);
    if (chat.length) this.#chatTimes.set(chatKey, chat);
    else this.#chatTimes.delete(chatKey);
    this.#dayTimes = day;
    if (chat.length >= hourly || day.length >= daily) throw new Error('RATE_LIMITED');
    // 两个窗口都放行之后才记账：被拒绝的那一次不占额度。
    chat.push(now);
    day.push(now);
    this.#chatTimes.set(chatKey, chat);
    this.#dayTimes = day;
  }
}
