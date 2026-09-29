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
 * （"图源接口这次没返回结果（trace:TIMEOUT；sauce:NOT_CONFIGURED）"），所以这两个标签
 * 不能为了好看改成引擎名 —— 改它就是改用户可见行为。
 */
type EngineWhich = 'trace' | 'sauce';

/** 本轮要用的一段配置 + 引擎名 + 引擎私有参数。由 `specOf` 从 `ENGINE_ROWS` 填出来。 */
interface EngineSpec {
  /** 传给 worker 的引擎名，取值域见 `types.ts` 的 `PicImageSearchEngine`。 */
  engine: PicImageSearchEngine;
  /** 日志里的显示名。与 `engine` 分开是因为日志沿用历史写法（见 `ENGINE_ROWS`）。 */
  logName: string;
  /** 这一段配置是否允许跑（未启用、或 SauceNAO 没配 key）。 */
  ready: boolean;
  timeoutMs: number;
  maxResults: number;
  minSimilarity: number;
  options: Record<string, unknown> | undefined;
}

/** 引擎表读得懂的最小配置形状：`traceMoe` / `sauceNao` 都满足它。 */
interface EngineLimits { enabled: boolean; timeoutMs: number; maxResults: number; minSimilarity: number }

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
  }
};

/**
 * **顺序是语义**：intent 决定先问哪一类引擎，命中就不再问下一个（下面那个 `if (result) break`）。
 *
 * 写成显式两张表（而不是"按 kind 排个序算出来"）是有意的：加引擎的人**必须自己决定它排在
 * 哪**，那是一个决定，不该由一条现成的规则替他做。
 *
 * **`unknown` 不是 `anime` 的同义词。** 这两行最初写成同序，理由是"与改动前一致"——那是沿袭
 * 旧实现，不是一个决定。它的代价是：模型判不出类型时填的正是 `unknown`，于是**最常出现的那个
 * 值在顺序上等于"这是一张动画截图"**（真机实测：一张梗图走的就是动画那条路）。判据是引擎的
 * **覆盖面**：trace.moe 只索引动画帧，是窄域专用引擎；SauceNAO 面广（画师/同人/漫画/动画源图
 * 都在）。窄域引擎只有在**类型已确认**时才该先问 —— 否则它对非动画图要么白烧一次调用，要么
 * 给出一个假命中、并因此**拦住**后面那个面广的引擎（`break` 之后不再问）。
 */
const ORDER: Record<SearchIntent, readonly EngineWhich[]> = {
  anime: ['trace', 'sauce'],
  illustration: ['sauce', 'trace'],
  // 与 `illustration` 同序是**当前**的结论，不是"这两个 intent 是一回事"：`unknown` 的输入里
  // 非动画占绝大多数，所以面广的引擎先问。将来若按 intent 分化门槛/条数，这一行要自己走。
  unknown: ['sauce', 'trace']
};

function specOf(which: EngineWhich, cfg: ImageSourceConfig): EngineSpec {
  const row = ENGINE_ROWS[which];
  const limits = row.limits(cfg);
  return {
    engine: row.engine,
    logName: row.logName,
    ready: limits.enabled && (row.ready?.(cfg) ?? true),
    timeoutMs: limits.timeoutMs,
    maxResults: limits.maxResults,
    minSimilarity: limits.minSimilarity,
    options: row.options?.(cfg)
  };
}

/**
 * 缓存键 = **引擎 + 图片 hash + maxResults + 引擎参数指纹**。
 *
 * 三条都要在键里，缺一条就有一类串台（都是实测过的形态）：
 * - 引擎：同一张图在 `anime` 与 `illustration` 两种 intent 下会先问不同的引擎。键里不带引擎
 *   的话，先问的那个引擎的结论会替另一个引擎作答 —— 用户看到的是"换了个问法，答案没变"。
 * - maxResults：它在设置页可调。换个条数就是在问不同的问题，不该命中上一次的响应。
 * - 参数指纹：`apiKey` 这类引擎私有参数变了（换号、清空又填回）时不该复用上一次的响应。
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
    try {
      return await Promise.race([
        this.#perform(url, intent, cfg, taskId, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TOTAL_TIMEOUT')); }, cfg.totalTimeoutMs); timer.unref?.(); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.deps.log?.(`[image-source] task=${taskId} durationMs=${Date.now() - started} done`);
    }
  }

  async #perform(url: string, intent: SearchIntent, cfg: ImageSourceConfig, taskId: string, signal: AbortSignal): Promise<SearchOutput> {
    const { buffer, mime } = await loadSafeImage(url, cfg.maxImageBytes);
    const hash = createHash('sha256').update(buffer).digest('hex');
    const provider = this.deps.provider || getPicImageSearchClient();
    const failures: string[] = []; let result: ImageSourceResult | null = null;
    let remoteCalls = 0; let cacheHits = 0;
    for (const which of ORDER[intent]) {
      const spec = specOf(which, cfg);
      if (!spec.ready) continue;
      try {
        const key = cacheKey(spec.engine, hash, spec.maxResults, spec.options);
        let response = cfg.cacheEnabled ? this.#cache.get(key) : undefined;
        if (response) cacheHits++;
        else {
          remoteCalls++;
          response = await provider.search(spec.engine, buffer, mime, spec.timeoutMs, spec.maxResults, signal, spec.options);
          // **只缓存成功的响应**：失败（限流/超时/配额）是远端此刻的状态，不是这张图的属性。
          // 上一版的 `cached:true` 路把失败也写进去，一次超时能冻结这张图 24 小时。
          if (cfg.cacheEnabled) this.#cache.set(key, response, cfg.cacheTtlMs);
        }
        result = response.results.find((x) => x.similarity >= spec.minSimilarity) || null;
        this.deps.log?.(`[image-source] task=${taskId} provider=${spec.logName} bytes=${buffer.length} status=${response.statusCode}${cacheHits > 0 && remoteCalls === 0 ? ' cache=hit' : ''}`);
        if (result) break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'UNKNOWN'; failures.push(`${which}:${reason}`);
        this.deps.log?.(`[image-source] task=${taskId} provider=${which} bytes=${buffer.length} failure=${reason}`);
      }
    }
    // `cached` 的含义：本次**一次远端调用都没发**（全部由缓存答复）。部分命中不算 —— 那个词只
    // 用来回答"这次有没有花钱"，半张缓存半张真查的情况下答案是有花钱。
    return { result, cached: cacheHits > 0 && remoteCalls === 0, failures };
  }
}
