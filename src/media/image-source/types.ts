export type ImageSourceKind = 'anime' | 'illustration';

/**
 * worker 支持的引擎名。**这是引擎的取值域，唯一的定义处**——运行期的清单
 * （`pic-image-search-client.ts` 的 `PIC_IMAGE_SEARCH_ENGINES`）是它的手工镜像，并且带一条
 * 编译期覆盖断言：往这里加一个引擎而清单忘了跟，`npm run typecheck` 当场报错。
 *
 * 为什么拆成两处而不是让类型从数组推导：数组是**跨进程的手工镜像**（另一侧是
 * `python-tools/pic_image_search_worker.py` 的 `ENGINE_CLASS_CANDIDATES`，worker 会拿它
 * 做真实分派），它属于客户端；而"有哪些引擎"是结果数据的一部分（`ImageSourceResult.provider`
 * 的取值域就是它），属于这里。拆开就必须有守卫，否则改名只改一端时的表现是运行期
 * `PROVIDER_UNAVAILABLE: 未知引擎 xxx` —— 看得见，但来得太晚。
 *
 * 新增引擎时**只加名字是不够的**：worker 的 `ENGINE_CLASS_CANDIDATES` 与 `ENGINE_FAMILY`、
 * 客户端的 `ENGINE_DISPLAY`（`Record<…>` 会强制你补）、以及服务层的引擎表都要一起动。
 */
export type PicImageSearchEngine =
  | 'saucenao'
  | 'trace.moe'
  | 'anime_trace'
  | 'baidu'
  | 'bing'
  | 'google_lens'
  | 'yandex'
  | 'tineye';

/**
 * 结果的来源展示名 —— **就是引擎名**（同一个联合类型的别名，不是第二份清单）。
 *
 * 这里曾经是一个与引擎名逐字重复的独立联合类型，2026-09-29 收成一个别名：两份名字必须
 * 永远相等，而"忘了同步"不会有任何编译错误——正是本文件在 `ImageSourceResult` 那段
 * 批评 `sourceEngine` 的同一个毛病。真出现"展示名与引擎名不一致"的需求时（比如把
 * `google_lens` 显示成 `Google Lens`），正确落法是客户端那张
 * `Record<PicImageSearchEngine, { provider; kind }>` 里的 `provider` 字段，
 * 而不是把本类型重新拆开——那张 `Record` 会被编译器逼着随引擎表一起长。
 *
 * 这个字段今天**没有任何读取方**（只被写入），`result-formatter.ts` 只看 `kind`。
 *
 * 注意 `kind`：网页类引擎也被归进 `'illustration'`。那个字段实际决定的是**展示形态**
 * （《作品》第几集 vs 可能来源/画师），不是图片题材，所以这个归类是对的。
 */
export type ImageSourceProvider = PicImageSearchEngine;

export interface ImageSourceResult {
  /**
   * 引擎名（= `PicImageSearchEngine`）。**想要"这条结果是哪个引擎答的"就读它**，
   * 不要再加一个 `sourceEngine`：那会是同一个值的第二份拷贝，两份必须永远相等，
   * 而任何一处忘了同步都不会报错——属于净增的漂移面，零收益。
   */
  provider: ImageSourceProvider;
  kind: ImageSourceKind;
  similarity: number;
  /**
   * **可选**：worker 没给出名字时就不写这个键，不在数据层编一个「未命名结果」出来。
   * 依据是"字段不足就保留 undefined，不许编造"——编出来的名字会被当成真结果记进存档与日志，
   * 事后没人分得清"接口没给"与"接口就叫这个名"。
   *
   * 代价是**每个渲染方都要自己兜底**（`result-formatter.ts` 就是唯一那个渲染方）。
   * 展示层兜底与数据层编造的区别在于前者只在输出给模型/用户的那一刻存在，不落任何存档。
   */
  title?: string;
  author?: string;
  source?: string;
  episode?: string;
  time?: number;
  url?: string;
  previewUrl?: string;
  indexName?: string;
  characters?: string;
  /**
   * ⚠️ **刻意不提供 `raw`**（即第三方响应的原始对象）。两条理由：
   * ① 它是不可信外部数据，直接挂进结果等于把它一路带进存档与模型可见文本，而
   *    `result-formatter.ts` 只认结构化字段，"原始响应"根本无处可渲染；
   * ② 它会把 Python 侧的字段形状（版本间还会变）钉进 Node 的类型里，正是这次重构
   *    要消掉的那件事。要排查就去日志里看 worker 的 `detail`（客户端已截断到 500 字）。
   */
}

export interface ProviderResponse {
  results: ImageSourceResult[];
  statusCode: number;
  quota?: { shortRemaining?: number; longRemaining?: number };
}

export type SearchIntent = 'anime' | 'illustration' | 'unknown';

export interface ImageSourceConfig {
  enabled: boolean;
  traceMoe: { enabled: boolean; timeoutMs: number; minSimilarity: number; maxResults: number };
  sauceNao: { enabled: boolean; apiKey: string; timeoutMs: number; minSimilarity: number; maxResults: number };
  maxImageBytes: number;
  maxQueueLength: number;
  totalTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTtlMs: number;
  maxCallsPerChatPerHour: number;
  maxCallsPerDay: number;
}
