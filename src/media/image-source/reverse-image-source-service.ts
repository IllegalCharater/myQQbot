import { createHash, randomUUID } from 'node:crypto';
import { LruTtlCache } from './cache.js';
import { loadSafeImage } from './image-loader.js';
import { AsyncSingleQueue } from './queue.js';
import { getPicImageSearchClient } from './pic-image-search-client.js';
import type { PicImageSearchPort } from './pic-image-search-client.js';
import type { ImageSourceConfig, ImageSourceResult, PicImageSearchEngine, ProviderResponse, SearchIntent } from './types.js';

export interface SearchOutput { result: ImageSourceResult | null; cached: boolean; failures: string[] }

/**
 * 引擎标签。它同时是 `failures` 里那串东西的前缀与 `ORDER` 的键。
 *
 * ⚠️ 那串 failures 经 `agent/tools/image-source.ts` **原样进模型可见文本**
 * （"图源接口这次没返回结果（trace:TIMEOUT；sauce:NOT_CONFIGURED）"），所以这三个标签
 * 不能为了好看改成引擎名 —— 改它就是改用户可见行为。
 */
type EngineWhich = 'trace' | 'sauce' | 'baidu';

/** 本轮要用的一段配置 + 引擎名 + 引擎私有参数。由 `specOf` 从 `ENGINE_ROWS` 填出来。 */
interface EngineSpec {
  /** `ORDER` / `INTENT_PARAMS` 的键，也是 `failures` 里那个前缀。 */
  which: EngineWhich;
  /** 传给 worker 的引擎名，取值域见 `types.ts` 的 `PicImageSearchEngine`。 */
  engine: PicImageSearchEngine;
  /**
   * 日志里的显示名。与 `engine` / `which` 都分开：日志沿用历史写法（`SauceNAO` 大写，见
   * `ENGINE_ROWS`），而 `failures` 里那个标签**进模型可见文本**、不能动。
   */
  logName: string;
  /** 这一段配置是否允许跑（未启用、或 SauceNAO 没配 key）。 */
  ready: boolean;
  timeoutMs: number;
  maxResults: number;
  /** **可选**：该引擎不报置信度时就没有这个门槛（见 `EngineLimits`）。 */
  minSimilarity: number | undefined;
  options: Record<string, unknown> | undefined;
}

/**
 * 引擎表读得懂的最小配置形状：`traceMoe` / `sauceNao` 都满足它。
 *
 * `minSimilarity` **可选**是有意的：网页类引擎（`baidu` 那一档）不返回置信度，"这个引擎没有
 * 门槛这个概念"由**字段的缺席**表达，而不是在配置里塞一个从不被读的 `0`。判据在
 * `#perform`：没有门槛 ⇒ 有结果就算命中（它给出什么顺序，第一条就是它的答案）；有门槛 ⇒
 * 结果必须**自带**置信度且过线，**无置信度的结果照样被丢弃**（宁可空手，也不认一条无法核实的命中）。
 */
interface EngineLimits { enabled: boolean; timeoutMs: number; maxResults: number; minSimilarity?: number }

/**
 * 引擎表的一行 = **一段配置 ↔ 一个引擎**。加引擎就是加一行，循环本身不用动。
 *
 * 这里**故意不做"读配置里的任意键"**：`limits` / `ready` / `options` 都是写明的小函数，
 * 于是每一行的判据都留在代码里能被读到的地方，而不是靠一个约定俗成的字段命名去猜。
 */
interface EngineRow {
  engine: PicImageSearchEngine;
  /** 日志显示名。`SauceNAO` 维持历史写法（大写）——它只进日志，与结果数据里的 `provider` 是两回事。 */
  logName: string;
  /** 这一段配置从哪来。 */
  limits: (cfg: ImageSourceConfig) => EngineLimits;
  /** 额外的"能跑吗"条件。收整个 `cfg`，因为 SauceNAO 的判据（空 key）不在上面那个形状里。 */
  ready?: (cfg: ImageSourceConfig) => boolean;
  /** 引擎私有参数。**SauceNAO 的 apiKey 只走这里**，它经 stdin 进 worker，绝不进 argv。 */
  options?: (cfg: ImageSourceConfig) => Record<string, unknown>;
}

/**
 * 「配置段 ↔ 引擎」的**唯一绑定处**，也就是分发策略的落点。
 *
 * 分工（2026-09-29 定）：**跑哪些引擎、什么顺序、门槛多少在 Node**（这里），
 * **引擎怎么构造、字段叫什么在 Python**（worker）。Node 只交出引擎名。
 *
 * `Record<EngineWhich, …>` 而不是数组：键是编译期检查的联合类型，不是运行期字符串分发；
 * 顺序由下面的 `ORDER` 单独表达（顺序是语义，见那一段）。
 *
 * **AnimeTrace 不在这里，是有意的**：worker 的 `ENGINE_CLASS_CANDIDATES` 里
 * `anime_trace` 的候选是 `("TraceMoe", "AnimeTrace")`，注释写着"AnimeTrace 是它的中文叫法"
 * ——它是**同一个远端服务的别名**，不是第三个引擎。真把它加成第三行，两个都打开时会对
 * 同一个接口打两次、白烧一份配额。
 */
const ENGINE_ROWS: Record<EngineWhich, EngineRow> = {
  trace: {
    engine: 'trace.moe',
    logName: 'trace.moe',
    limits: (cfg) => cfg.traceMoe
  },
  sauce: {
    engine: 'saucenao',
    logName: 'SauceNAO',
    limits: (cfg) => cfg.sauceNao,
    // 空 key 视同没开：把这个交给 worker 去报会把"配置没填"伪装成"接口出错"。
    ready: (cfg) => Boolean(cfg.sauceNao.apiKey),
    // **apiKey 只走这里**，它经 stdin 进 worker，绝不进 argv。
    options: (cfg) => ({ apiKey: cfg.sauceNao.apiKey })
  },
  /**
   * 一般向兜底引擎（百度识图）。**无 `options`、无 `ready`**：
   * - 它不需要 API Key（worker 只对 `saucenao` 读 `apiKey`），所以"能不能跑"只有 `enabled` 一个条件，
   *   与 `trace` 同形；`ready` 这个钩子是给 SauceNAO 那种"配置不全也算没开"的行用的。
   * - 它**不返回置信度**，所以它那段配置里根本没有 `minSimilarity`（见 `EngineLimits`）。
   *   别为了"对齐其它两行"补一个 `0`：那个 0 会被读成"相似度门槛为零"，下一轮有人
   *   把判据改成"统一比门槛"时，它就从"没有这个概念"变成一个真实的、永远为真的门槛。
   */
  baidu: {
    engine: 'baidu',
    logName: 'baidu',
    limits: (cfg) => cfg.baidu
  }
};

/**
 * **顺序是语义**：intent 决定先问哪一类引擎，命中就不再问下一个（下面那个 `if (result) break`）。
 *
 * 结构（2026-09-29 定）：**每个类型先问它的专属引擎，答不上或超时（或答案不过门槛）再问一般向
 * 兜底，兜底也失败就结束 —— 链上最多两发，没有第三发**。设计全文见
 * `docs/image-source-routing-design.md`。
 *
 * 写成显式两张表（而不是"按 kind 排个序算出来"）是有意的：加引擎的人**必须自己决定它排在
 * 哪**，那是一个决定，不该由一条现成的规则替他做。
 *
 * 四条判据都是**写出来的决定**，不是从别处推出来的：
 * - `anime` 的专属是 trace.moe：它给**集数与时间点**，那是 `kind:'anime'` 与 formatter 动画分支
 *   存在的全部理由；换成别的等于让那条分支变成死代码。
 * - `manga` / `illustration` 的专属同为 SauceNAO：两者都是"二次元来源站/画师/作品"这一类问题，
 *   而它的库覆盖面最广。
 * - **`unknown` 没有专属引擎**：模型判不出类型时填的正是它，所以"不知道是什么"不该等于
 *   "这是一张动画截图"。上一轮这两行同序，代价是**最常出现的那个值在顺序上等于 anime**：
 *   trace.moe 只索引动画帧（窄域），它对非动画图要么白烧一次调用，要么给一个假命中、并因为
 *   `break` **拦住**后面那个面广的引擎（真机实测：一张梗图走的就是动画那条路）。
 * - **一般向（`baidu`）恒在末位**：它是兜底，不是主力。
 *
 * 两个推论不需要额外代码：SauceNAO 没配 key 时 `manga`/`illustration` 的链自动缩成 `['baidu']`，
 * trace.moe 关掉时 `anime` 的链自动缩成 `['baidu']`（`ready === false` 的那一发等于不存在）。
 */
const ORDER: Record<SearchIntent, readonly EngineWhich[]> = {
  anime: ['trace', 'baidu'],
  manga: ['sauce', 'baidu'],
  illustration: ['sauce', 'baidu'],
  unknown: ['baidu']
};

/**
 * 按搜索类型固定的**引擎参数**（与 `ORDER` 并列的第二张 intent 表）。
 *
 * 为什么不把它做成设置页上的一个档位：模型每次调用都已经给出了"这是什么图"，而一张图该
 * 不该看到 R18 结果正取决于它 —— 找番时 R18 番剧是**正确答案**（藏掉就是误杀），找插画或
 * 说不清是什么时 R18 同人图多半是**错答案**。一个全局档位做不到这件事：它只能同时错杀一边。
 *
 * `hide` 的四档语义（0 全部 / 1 隐藏预期 R18 / 2 隐藏预期存疑 / 3 只留预期安全）与整条
 * `SauceNAO.__init__` 签名实测自 PicImageSearch 3.12.11，结论写在 worker 头部 ⚑ f 条。
 * **它是构造参数，不是 `search()` 的 kwargs** —— 递下去的路由见 worker 的
 * `_saucenao_constructor_args`（那里必须白名单，理由在函数文档里）。
 *
 * **今天两行都是 `0`，这是实测撞出来的，不是"照默认值不动"**：`unknown` 曾是 `1` → 真机反馈
 * "图源接口响应太慢/没结果"，排查结论是它把原本匹配上的同人志图（Madokami 那次）**藏掉了**，
 * 于是这一路不再短路、必须去问 trace.moe，而后者答不了漫画。`hide` 是**服务端按它自己的判定**
 * 过滤的，我们无法复核"它凭什么认为这张是预期 R18"，一次误判的代价是**整条结果消失**，而收益
 * （少几条 R18）在"只在群里报来源"的场景里并不明确。
 *
 * 这张表保留的不是两个不同的值，而是**唯一那个"按类型收紧过滤"的落点**：它的穷尽性
 * （`Record<SearchIntent, …>`）会在第五个 intent 出现时**逼出一次决定**，而不是让它悄悄变成
 * "没有掩码"；`hide` 是**显式传**的，不依赖库的构造默认值（默认值是库的实现细节，变了我们不会
 * 知道）。将来要收紧（例如"只有 `illustration` 藏 R18"）：把那一行从 `0` 改成 `1`，**只改这一处**。
 *
 * `Partial<Record<EngineWhich, …>>` 让"给哪个引擎加参数"也受编译期检查。
 */
const INTENT_PARAMS: Record<SearchIntent, Partial<Record<EngineWhich, Record<string, unknown>>>> = {
  anime: {},                             // 不问 SauceNAO → 无参数
  manga: { sauce: { hide: 0 } },         // 找漫画：不藏（R18 同人志是合法答案）
  illustration: { sauce: { hide: 0 } },  // 找插画：也不藏（判据见上）
  unknown: {}                            // 不问 SauceNAO → 无参数
};

/**
 * 预算的四个常量。**都是写明的常量，不是新配置项** —— 设置页上多一个旋钮就等于多一个
 * "用户自己能调坏、而我们收到的是调坏之后的现象"的面。改它们等于改行为，所以集中在这里写明理由。
 *
 * 为什么需要预算划分（这是本次设计的技术核心）：`cfg.totalTimeoutMs`（默认 35000）是**整轮**的
 * 死线，**包含图片下载**。历史上那次真机 `TOTAL_TIMEOUT` 的算术就是 `20000 + 15000 = 35000`，
 * **零余量**。若每一发都拿满自己配置的 `timeoutMs`，那么"专属引擎超时 → 用兜底"在**最需要它的
 * 那一刻恰恰不会发生**：专属引擎把预算吃光，兜底根本没机会开火。所以每一发的时间必须**从同一个
 * 死线倒推**（见 `#perform` 里那段算术）。
 */
/** 留给**每一发后续引擎**的下限。网页类搜图典型 3–8s，低于它兜底形同虚设。 */
const FALLBACK_RESERVE_MS = 8000;
/**
 * **我们能匀给这一发的时间**低于这个数就不开这一枪，宁可记 `NO_BUDGET`。
 *
 * 它比的是"匀得出的时间"（`available`），**不是**比引擎配置里的 `timeoutMs` —— 后者是用户自己
 * 的决定（配置钳制在 1000–60000，配 1000 合法），我们不去替他收回；拿最终预算来比会把"用户把
 * 超时配小了"报成 `NO_BUDGET`，那是一句关于我们自己的陈述，却说着用户的配置。
 *
 * 这个区分是给排查用的：`NO_BUDGET`（"我们没给它时间"）与 `TIMEOUT`（"它太慢"）指向完全不同的
 * 方向 —— 前者要调 `totalTimeoutMs` 或裁剪前面的引擎，后者要去问那个引擎怎么了。混成一句话就是
 * 把一个我们自己的决定，说成对方的过错。
 */
const MIN_ENGINE_MS = 3000;
/**
 * 让**引擎自己的超时**先于**整轮死线**触发。否则两者同时到期，报出来的是 `TOTAL_TIMEOUT`，
 * 而那时看不出是谁慢 —— 失败就无法归因到具体引擎。
 */
const DEADLINE_EDGE_MS = 500;
/**
 * 图片下载最多占多少预算（下载没有自己的配置项）。
 *
 * 加了这一片之后，"下载慢"与"引擎慢"才第一次能被分开：前者报 `IMAGE_TIMEOUT`，
 * 后者报 `<which>:TIMEOUT`。在此之前两者在结果里长得一模一样，而文案写的是"图源接口响应太慢"
 * —— **归因是错的**。再多就说明链路有问题，应当让人去查链路，而不是让引擎饿死。
 */
const DOWNLOAD_MAX_MS = 15000;

function specOf(which: EngineWhich, cfg: ImageSourceConfig, intent: SearchIntent): EngineSpec {
  const row = ENGINE_ROWS[which];
  const limits = row.limits(cfg);
  const base = row.options?.(cfg);
  const extra = INTENT_PARAMS[intent][which];
  return {
    which,
    engine: row.engine,
    logName: row.logName,
    ready: limits.enabled && (row.ready?.(cfg) ?? true),
    timeoutMs: limits.timeoutMs,
    maxResults: limits.maxResults,
    minSimilarity: limits.minSimilarity,
    // 两边都没有时必须是 `undefined`，**不能是 `{}`**：`{}` 会让没有任何私有参数的引擎
    // （trace.moe）凭空多出一个 engineOptions，缓存键也从 `-` 变成一个散列值。
    // 现成守护：`tests/t-image-source.mjs` 的"trace.moe 没有私有参数"那条。
    options: base || extra ? { ...base, ...extra } : undefined
  };
}

/**
 * 一条结果算不算这个引擎的命中 —— **门槛是引擎级的**。
 *
 * - 该引擎**没有**门槛（`minSimilarity === undefined`，网页类引擎不返回置信度）：它给出什么顺序，
 *   第一条就是它的答案。这不是"放宽标准"，而是**没有可比的东西**：拿一个引擎从没报过的分数去
 *   比一个我们自己定的线，比出来的只是"我们替它编的那个 0 不够高"。
 * - 该引擎**有**门槛：结果必须**自带**置信度且过线。所以**无置信度的结果对它们照样被丢弃** ——
 *   宁可空手，也不认一条无法核实的命中（判据是"字段在不在"，`0` 是合法值，与 formatter 里
 *   `time` 那个 `00:00` 是同一条规矩）。
 */
function passes(spec: EngineSpec, x: ImageSourceResult): boolean {
  return spec.minSimilarity === undefined || (x.similarity !== undefined && x.similarity >= spec.minSimilarity);
}

/**
 * 缓存键 = **引擎 + 图片 hash + maxResults + 引擎参数指纹**。
 *
 * 三条都要在键里，缺一条就有一类串台（都是实测过的形态）：
 * - 引擎：同一张图在 `anime` 与 `illustration` 两种 intent 下会先问不同的引擎。键里不带引擎
 *   的话，先问的那个引擎的结论会替另一个引擎作答 —— 用户看到的是"换了个问法，答案没变"。
 * - maxResults：它在设置页可调。换个条数就是在问不同的问题，不该命中上一次的响应。
 * - 参数指纹：引擎私有参数变了时不该复用上一次的响应。两个例子都在这里：`apiKey` 换号，
 *   以及 `hide` 随 intent 变（`anime` 的 `hide=0` 与 `illustration` 的 `hide=1` 是**两个不同
 *   的问题**，共用一个槽位会让先问的那种 intent 替另一种作答）。反过来，参数逐字节相同的两种
 *   intent（今天 `illustration` 与 `unknown`）**共享**槽位 —— 请求一样，共享是对的。
 *
 * 指纹只取散列前 16 位，且只在内存里做键；key 本身不进日志、不落盘。
 */
function cacheKey(engine: PicImageSearchEngine, hash: string, maxResults: number, options: Record<string, unknown> | undefined): string {
  const opts = options ? createHash('sha256').update(JSON.stringify(options)).digest('hex').slice(0, 16) : '-';
  return `${engine}|${hash}|${maxResults}|${opts}`;
}

export class ReverseImageSourceService {
  readonly #queue = new AsyncSingleQueue();
  /**
   * 缓存的是**单个引擎的响应**，不是最终结论。
   *
   * 上一版缓存的是 `SearchOutput`（已经挑完、滤完的最终结果），于是同一张图的两种 intent 只
   * 先到的那个引擎的结论被复用，第二个引擎根本不会被问；键里也没有引擎维度。更糟的是
   * `cached:true` 那条路**连失败一起缓存**：一次"两个引擎都超时"会让这张图在 `cacheTtlMs`
   * （默认 24 小时）内**永远**返回失败，而远端可能早就好了。
   *
   * 现在换成：键里带引擎（见 `cacheKey`），挑结果与相似度过滤**每次重新算**（它们依赖本次的
   * `minSimilarity` 与 intent 顺序，属于便宜且必须正确的步骤），**失败从不写缓存**。
   * 于是"缓存"只回答一个问题：**这个引擎、这张图、这个条数，上次问到的响应是什么**。
   */
  readonly #cache = new LruTtlCache<ProviderResponse>(100);
  constructor(private readonly deps: {
    getConfig: () => ImageSourceConfig;
    /**
     * 注入点。默认取进程级单例客户端（**不启动进程** —— 第一次请求或 `initPicImageSearch`
     * 预热时才 spawn）。
     *
     * 今天生产代码里没有任何调用方传它（`agent/tools/image-source.ts` 只传 `getConfig` 与
     * `log`）。它存在的理由是让测试能在**不联网、不起 Python**的前提下驱动整套分发与过滤
     * —— 这段逻辑此前一条断言都没有。
     */
    provider?: PicImageSearchPort;
    log?: (message: string) => void;
  }) {}

  search(url: string, intent: SearchIntent): Promise<SearchOutput> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return Promise.reject(new Error('DISABLED'));
    return this.#queue.enqueue(cfg.maxQueueLength, () => this.#run(url, intent, cfg));
  }

  async #run(url: string, intent: SearchIntent, cfg: ImageSourceConfig): Promise<SearchOutput> {
    const taskId = randomUUID(); const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 这一轮的死线。`#perform` 里每一发的预算都从它倒推，所以整轮**按构造**不会超过
    // `totalTimeoutMs`（下载也被同一片预算夹住）。
    const deadline = started + cfg.totalTimeoutMs;
    try {
      return await Promise.race([
        this.#perform(url, intent, cfg, taskId, controller.signal, deadline),
        // 外层这条 race 因此退化成**兜底中的兜底**：它防的是 provider 不守时这类 bug
        // （给了 `signal` 与 `timeoutMs` 却照样挂着不返回），正常路径不会再触发它。
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TOTAL_TIMEOUT')); }, cfg.totalTimeoutMs); timer.unref?.(); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.deps.log?.(`[image-source] task=${taskId} durationMs=${Date.now() - started} done`);
    }
  }

  /**
   * 图片下载自己的一片预算。
   *
   * 超时由**这里**抛 `IMAGE_TIMEOUT`（而不是让 loader 自己抛）：预算是服务层的概念，loader 只
   * 负责"安全地下载一张图"，它不知道也不该知道整轮还剩多少时间。于是同一句"没拿到图"被分成
   * 两种可归因的失败：下载慢（`IMAGE_TIMEOUT`）与下载本身不成立（`IMAGE_*` 那几条）。
   */
  async #loadImage(url: string, cfg: ImageSourceConfig, signal: AbortSignal, deadline: number): Promise<{ buffer: Buffer; mime: string }> {
    const budget = Math.max(0, Math.min(DOWNLOAD_MAX_MS, deadline - Date.now()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        loadSafeImage(url, cfg.maxImageBytes, signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('IMAGE_TIMEOUT')), budget); timer.unref?.(); })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async #perform(url: string, intent: SearchIntent, cfg: ImageSourceConfig, taskId: string, signal: AbortSignal, deadline: number): Promise<SearchOutput> {
    const failures: string[] = [];
    const provider = this.deps.provider || getPicImageSearchClient();
    // 先造出这一轮**完整**的链（ready 的那几发），再逐发算预算。分两步是有理由的：每一发的预算
    // 取决于"它后面还有几发要留时间"，而那只有在链定下来之后才知道。
    const chain = ORDER[intent].map((which) => specOf(which, cfg, intent)).filter((spec) => spec.ready);
    // 下载与引擎共用同一条死线：下载吃掉的每一毫秒都直接从引擎的预算里扣（`IMAGE_TIMEOUT` 是
    // "下载吃光了它那一片"的唯一出口）。
    const { buffer, mime } = await this.#loadImage(url, cfg, signal, deadline);
    const hash = createHash('sha256').update(buffer).digest('hex');
    let result: ImageSourceResult | null = null;
    let remoteCalls = 0; let cacheHits = 0;
    for (let i = 0; i < chain.length; i++) {
      const spec = chain[i];
      // 这一发之后还没试过的引擎数 —— 每一个都要留够 `FALLBACK_RESERVE_MS`，否则"专属引擎超时 →
      // 用兜底"在最需要它的那一刻恰恰不会发生（专属引擎把预算吃光，兜底根本没机会开火）。
      const rest = chain.length - i - 1;
      // **判据落在"我们还能匀出多少"上，不是落在最终预算上**：`MIN_ENGINE_MS` 要拦的是"剩下的时间
      // 薄到开这一枪没意义"，不是"用户把超时配小了"（配置侧的钳制是 1000–60000，配 1000 是合法的
      // 决定，我们不去替他收回）。两者混在一处的话，一个 1 秒的超时会被报成 `NO_BUDGET` ——
      // 一句关于我们自己的陈述，说的是用户的配置。
      const available = deadline - Date.now() - FALLBACK_RESERVE_MS * rest - DEADLINE_EDGE_MS;
      if (available < MIN_ENGINE_MS) { failures.push(`${spec.which}:NO_BUDGET`); continue; }
      const budget = Math.min(spec.timeoutMs, available);
      try {
        const key = cacheKey(spec.engine, hash, spec.maxResults, spec.options);
        let response = cfg.cacheEnabled ? this.#cache.get(key) : undefined;
        if (response) cacheHits++;
        else {
          remoteCalls++;
          response = await provider.search(spec.engine, buffer, mime, budget, spec.maxResults, signal, spec.options);
          // **只缓存成功的响应**：失败（限流/超时/配额）是远端此刻的状态，不是这张图的属性。
          // 上一版的 `cached:true` 路把失败也写进去，一次超时能冻结这张图 24 小时。
          if (cfg.cacheEnabled) this.#cache.set(key, response, cfg.cacheTtlMs);
        }
        result = response.results.find((x) => passes(spec, x)) || null;
        this.deps.log?.(`[image-source] task=${taskId} provider=${spec.logName} bytes=${buffer.length} status=${response.statusCode}${cacheHits > 0 && remoteCalls === 0 ? ' cache=hit' : ''}`);
        if (result) break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'UNKNOWN'; failures.push(`${spec.which}:${reason}`);
        this.deps.log?.(`[image-source] task=${taskId} provider=${spec.which} bytes=${buffer.length} failure=${reason}`);
      }
    }
    // `cached` 的含义：本次**一次远端调用都没发**（全部由缓存答复）。部分命中不算 —— 那个词只
    // 用来回答"这次有没有花钱"，半张缓存半张真查的情况下答案是有花钱。
    return { result, cached: cacheHits > 0 && remoteCalls === 0, failures };
  }
}
