// PicImageSearch 常驻 worker 的 Node 侧客户端。
//
// 它只做四件事：**拉起进程**、**把请求编码成 JSON Lines 写进 stdin**、**把 stdout 的
// JSON Lines 分发给等待中的 Promise**、**在异常路径上把在途请求全部结束掉**。
// 缓存、队列、配额闸门、minSimilarity 过滤**不在这里** —— 它们分别归 `cache.ts`、
// `queue.ts` 与 `reverse-image-source-service.ts`。在这里再写一份只会让两边口径漂移。
//
// ── 协议（唯一契约在 python-tools/pic_image_search_worker.py 的模块头）──────────
//
//   请求  {"id","engine","imageBase64","mime","timeoutMs","maxResults","engineOptions"?}
//   探活  {"op":"probe","engine","timeoutMs","engineOptions"?}
//   取消  {"id","op":"cancel","target":"<搜索请求的 id>"}
//   关闭  {"op":"shutdown"}
//   响应  {"id","ok","statusCode","results","error","reason"?,"detail"?}
//   事件  {"event":"ready"|"fatal",…}          ← **没有 id**，靠这一点与响应区分
//
// ── 三条容易踩的约束 ────────────────────────────────────────────────────────
//
// 1. **解释器与脚本路径都从 core/python-runtime.ts 取，不许在这里写字面量。**
//    `python.path` 是唯一的解释器配置入口，脚本在 `python-tools/`。自己拼一份就会
//    造出第二个答案 —— 本项目已经为此付过代价（S11b 的 `applyEndpoint` 归一化）。
// 2. **apiKey 只走 stdin 的 engineOptions，绝不进 argv。** argv 在进程列表里可见。
// 3. **stdout 是外部输入，一律按 `unknown` 窄化。** worker 保证只写 JSON，但那是一句
//    承诺不是一个类型；库里某个 print() 就会污染它，所以解析失败只记日志、不抛异常。
//
// ⚑ 对账状态：worker 里的字段映射表（`⚑ 与真实库的对账状态` 那一段）是在**没装
// PicImageSearch 的机器上**写的，2026-09-29 已在目标解释器上用 `--self-check` 跑过三次、
// 四条已全部收口（并据此修掉了两个真机 bug：trace.moe 时间恒为 `00:00`、标题变成来源 URL）。
// 本文件把那些坑如实传出来（错误码、detail）。**仍未验证的是搜索路径的真机往返**——
// 表对了不等于远端活着，第一次真跑仍然要人工看一遍。

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../../core/config.js';
import { PIC_IMAGE_SEARCH_SCRIPT, resolvePythonCommand } from '../../core/python-runtime.js';
import type {
  ImageSourceKind,
  ImageSourceProvider,
  ImageSourceResult,
  PicImageSearchEngine,
  ProviderResponse
} from './types.js';

/**
 * worker 支持的引擎名。**这是跨进程的手工镜像**，另一侧是
 * `python-tools/pic_image_search_worker.py` 的 `ENGINE_CLASS_CANDIDATES`。
 *
 * 写成数组而不是裸的联合类型，是为了让断言套件有一个真值可比对（改名只改一端时，
 * 今天的表现是运行期报 `PROVIDER_UNAVAILABLE: 未知引擎 xxx`，看得见但来得晚）。
 *
 * 类型本身在 `types.ts`（结果数据的取值域），这里只留运行期清单。两处的对应关系由下面
 * 两条**编译期**断言守着，改错一端 `npm run typecheck` 就红，不必等运行期。
 */
export const PIC_IMAGE_SEARCH_ENGINES = [
  'saucenao',
  'trace.moe',
  'anime_trace',
  'baidu',
  'bing',
  'google_lens',
  'yandex',
  'tineye'
] as const satisfies readonly PicImageSearchEngine[];

/**
 * ✋ 这两行是**守卫，不是可以顺手删掉的死类型**。`types.ts` 的 `PicImageSearchEngine` 是
 * 手写的联合类型，清单是手写的数组，两者只能靠编译器对齐：
 * ① `satisfies` 挡住"清单里多了一个不存在/拼错的引擎"；
 * ② `AssertNever` 挡住"联合类型新增了引擎、清单忘了加"——`Exclude` 剩下的就不是 `never`，
 *    而泛型约束 `T extends never` 只接受 `never`，于是这一行自己报错。
 * 少了 ② 的话，漏掉的引擎会在运行期表现为"worker 报未知引擎"，排查方向完全错。
 * （IDE 会给 `_EnginesAllListed` 打一个"已声明但未使用"的浅色提示——**那是正常的**：
 * 它的作用就是被编译器检查一遍，运行期不需要存在。）
 */
type MissingEngine = Exclude<PicImageSearchEngine, (typeof PIC_IMAGE_SEARCH_ENGINES)[number]>;
type AssertNever<T extends never> = T;
type _EnginesAllListed = AssertNever<MissingEngine>;

/**
 * 本模块可能抛出的错误码。前 5 个是**协议词表**（worker 只会回这 5 个，外加一个可选的
 * `reason`）；后 3 个是 **Node 本地**产生的，永远不会跨过管道。
 */
export type PicImageSearchErrorCode =
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'PROVIDER_UNAVAILABLE'
  | 'QUOTA_EXHAUSTED'
  | 'ABORTED'
  | 'NOT_CONFIGURED';

/** worker 的 stdout 单行上限，与 Python 侧 `MAX_LINE_BYTES` 是同一个数。 */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/**
 * 搜图能力的**最小结构化端口**：谁要调引擎，只需要这两件事。
 *
 * 声明在本文件（而不是 provider 文件）是为了让 `PicImageSearchClient implements` 它 ——
 * 这样客户端签名一变，`npm run typecheck` 立刻报错。放到 provider 那侧就只能靠 `.mjs`
 * 用例在运行期发现，而 `tests/` 不受 `tsc` 管（见 AGENTS.md 的那条推论）。
 *
 * **纯编译期**：只有 `implements` 与结构化匹配，没有 `instanceof`、没有 `Symbol` 品牌、
 * 没有运行期校验 —— 所以测试可以用普通对象字面量直接顶替，不必先 new 一个真的客户端
 * （与 `agent/runtime/control-port.ts` 同一形态、同一理由）。
 */
export interface PicImageSearchPort {
  search(
    engine: PicImageSearchEngine,
    buffer: Buffer,
    mime: string,
    timeoutMs: number,
    maxResults: number,
    signal?: AbortSignal,
    engineOptions?: Record<string, unknown>
  ): Promise<ProviderResponse>;
  ping(
    engine?: PicImageSearchEngine,
    timeoutMs?: number,
    signal?: AbortSignal,
    engineOptions?: Record<string, unknown>
  ): Promise<boolean>;
}

/** 等 worker 变得可用的默认预算（`ping` 探活用）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * 预热（`start()`）的预算，**刻意比探活大一个量级**。
 *
 * 冷启动要付两笔不相干的钱：解释器自己的启动，和 `import PicImageSearch`（连带 httpx）。
 * 而本项目默认走的是 `conda run -n my_bot python`（见 `core/python-runtime.ts` 的解析链），
 * conda 本身启动就要几秒 —— 实测那条链明显慢于直接调 `python.exe`。用 5s 去预热会在
 * "配置完全正确、只是慢"的机器上失败，而失败长得跟"没装库"一模一样，排查方向会完全错。
 * 宁可等得久一点：这一步在启动路径上，不在任何人的请求路径上。
 */
const DEFAULT_START_TIMEOUT_MS = 20_000;

/** `close()` 里等进程自己退出的宽限；超时就强杀。 */
const CLOSE_GRACE_MS = 3000;

/** 日志里保留的 detail 长度上限，避免一行超长的第三方报错刷屏。 */
const DETAIL_MAX_CHARS = 500;

export interface PicImageSearchClientDeps {
  /** 解释器路径的来源。默认读真实的 `getConfig()`；测试可注入最小对象。 */
  getConfig?: () => { python?: { path?: unknown } };
  /** 日志出口。默认 `console.error` —— worker 的启动失败必须有人看得见。 */
  log?: (message: string) => void;
}

/** 引擎 → 展示名与展示形态。`Record<…>` 逼着这张表随引擎表一起长。 */
const ENGINE_DISPLAY: Record<PicImageSearchEngine, { provider: ImageSourceProvider; kind: ImageSourceKind }> = {
  saucenao: { provider: 'saucenao', kind: 'illustration' },
  // anime_trace 与 trace.moe 归**同一个归一化家族**（worker 的 `ENGINE_FAMILY` 两者都映射到
  // `trace_moe`），但那说的是"结果形状像"，不是"同一个服务"：候选表里 anime_trace 是
  // `("TraceMoe", "AnimeTrace")`，也就是**先拿 TraceMoe 顶**，只在库里没有它时才用 AnimeTrace。
  // 早先两者都展示成 `'trace.moe'`，于是"这次到底哪个类答的"在结果里完全看不见。
  // 现在各给各的名字：同一个家族，两个来源，出问题时才分得清该找谁。
  'trace.moe': { provider: 'trace.moe', kind: 'anime' },
  anime_trace: { provider: 'anime_trace', kind: 'anime' },
  baidu: { provider: 'baidu', kind: 'illustration' },
  bing: { provider: 'bing', kind: 'illustration' },
  google_lens: { provider: 'google_lens', kind: 'illustration' },
  yandex: { provider: 'yandex', kind: 'illustration' },
  tineye: { provider: 'tineye', kind: 'illustration' }
};

/** worker 的一行响应。字段全部可选 —— 它是外部输入，不给任何字段担保。 */
interface WorkerResponse {
  ok?: unknown;
  statusCode?: unknown;
  results?: unknown;
  error?: unknown;
  reason?: unknown;
  detail?: unknown;
}

interface Pending {
  /** 单一结算点。错误优先——传了 error 就忽略 response。 */
  settle: (error: Error | null, response?: WorkerResponse) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 造一个带错误码的 `Error`。
 *
 * **`message` 只放错误码本身**，`detail` / `reason` / `statusCode` 挂成属性 —— 这是为了
 * 守住既有契约：`reverse-image-source-service.ts` 的 `failures` 记的是
 * `` `${provider}:${error.message}` ``，改动 message 的拼法会静默改掉那串排查文本。
 * 接线那一步要把 `detail` 带进给模型的失败说明（见 AGENTS.md「工具不得代模型发言」）。
 */
function makeError(
  code: PicImageSearchErrorCode,
  detail?: string,
  statusCode?: number,
  reason?: string
): Error {
  const error = new Error(code);
  if (detail) (error as { detail?: string }).detail = detail.slice(0, DETAIL_MAX_CHARS);
  if (typeof statusCode === 'number') (error as { statusCode?: number }).statusCode = statusCode;
  if (reason) (error as { reason?: string }).reason = reason;
  return error;
}

/** 给一个 promise 套上超时。超时抛出的码由调用方给（本地码，不跨管道）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: PicImageSearchErrorCode): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError(code, `等待 ${timeoutMs}ms 仍未就绪`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * 把 worker 的归一化条目映射成 `ImageSourceResult`。
 *
 * Python 侧刻意用了同一套字段名（它已经有 `_drop_empty` 把空值变成「键不存在」），
 * 所以这里只需要补两个**只有 Node 才知道**的字段：`provider`（展示名）与 `kind`。
 *
 * `similarity` 必须兜 0：它在 `ImageSourceResult` 里是必填的，而网页类引擎
 * （baidu/bing/google_lens/yandex/tineye）**刻意不给相似度**（见 worker 的
 * `_normalize_web`）。兜 0 的结果是它们会被服务层的 `similarity >= minSimilarity`
 * 全部滤掉 —— 这正是 worker 想要的：宁可返回空，也不要编一个置信度出来。
 */
function toImageSourceResult(raw: unknown, engine: PicImageSearchEngine): ImageSourceResult {
  const row = asRecord(raw);
  const display = ENGINE_DISPLAY[engine];
  const text = (key: string): string => {
    const value = row[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const num = (key: string): number | undefined => {
    const value = row[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };

  // 必填字段只有这三个。`title` **不在其中**：worker 没给名字时就不写这个键，
  // 不在数据层编一个「未命名结果」—— 编出来的名字会被当成真结果，事后分不清
  // "接口没给"与"接口就叫这个名"。兜底归 result-formatter（展示层）。
  const result: ImageSourceResult = {
    provider: display.provider,
    kind: display.kind,
    similarity: num('similarity') ?? 0
  };

  // 可选字段一律「取到才写」：`?:` 在 Node 侧表示「没有」，而 result-formatter 的
  // .filter(Boolean) 依赖「没有」与「空串」的区别。
  const title = text('title'); if (title) result.title = title;
  const author = text('author'); if (author) result.author = author;
  const source = text('source'); if (source) result.source = source;
  const episode = text('episode'); if (episode) result.episode = episode;
  const url = text('url'); if (url) result.url = url;
  const previewUrl = text('previewUrl'); if (previewUrl) result.previewUrl = previewUrl;
  const indexName = text('indexName'); if (indexName) result.indexName = indexName;
  const characters = text('characters'); if (characters) result.characters = characters;
  const time = num('time'); if (time !== undefined) result.time = time;

  return result;
}

/** 把一行响应变成 `ProviderResponse`；`ok:false` 时抛出带码的错误。 */
function toProviderResponse(response: WorkerResponse, engine: PicImageSearchEngine): ProviderResponse {
  const statusCode = typeof response.statusCode === 'number' ? response.statusCode : 0;
  const detail = typeof response.detail === 'string' ? response.detail : undefined;
  if (response.ok !== true) {
    const rawCode = typeof response.error === 'string' ? response.error : '';
    const reason = typeof response.reason === 'string' ? response.reason : undefined;
    // worker 用一个可选的 `reason` 承载「统一 5 码装不下」的细分。目前唯一取值是
    // QUOTA_EXHAUSTED（SauceNAO 配额耗尽）—— 在这里还原成既有的独立错误码，
    // **不靠匹配 detail 文案**（文案一改就会静默失效）。
    const code: PicImageSearchErrorCode = reason === 'QUOTA_EXHAUSTED'
      ? 'QUOTA_EXHAUSTED'
      : (rawCode as PicImageSearchErrorCode) || 'INVALID_RESPONSE';
    throw makeError(code, detail, statusCode || undefined, reason);
  }
  const list = Array.isArray(response.results) ? response.results : [];
  return {
    results: list.map((raw) => toImageSourceResult(raw, engine)),
    statusCode: statusCode || 200
  };
}

/**
 * 常驻 worker 的单例客户端。
 *
 * 类本身可以 new（测试要用），生产路径走文件末尾的 `getPicImageSearchClient()`。
 * **所有对外方法都不会因为内部状态而抛同步异常** —— 一律返回 rejected promise。
 *
 * `implements PicImageSearchPort` 是**唯一的守卫**，别删（删掉不报任何错，端口会静默退化成
 * 注释）：它让 `search`/`ping` 的签名漂移在 `npm run typecheck` 就被拦住，而不是等到
 * provider 或某个 `.mjs` 用例在运行期才发现。
 */
export class PicImageSearchClient implements PicImageSearchPort {
  readonly #log: (message: string) => void;
  readonly #getConfig: () => { python?: { path?: unknown } };

  #child: ChildProcess | null = null;
  /** 当前进程「已报 ready」。进程一死就归 false。 */
  #isReady = false;
  /** 当前进程的 ready 等待器。每次 spawn 新建一个。 */
  #ready: Deferred<void> | null = null;
  /** 在途请求，key 是请求 id。 */
  readonly #pending = new Map<string, Pending>();
  /** stdout 的行缓冲（chunk 不保证按行切）。 */
  #stdoutBuffer = '';
  /** 已经为「这一次意外退出」自动重启过了。ready 时归零。 */
  #restartAttempted = false;
  /** 关闭闩。置位后不再自动重启，且拒绝新请求。 */
  #closing = false;
  #closePromise: Promise<void> | null = null;

  constructor(deps: PicImageSearchClientDeps = {}) {
    this.#log = deps.log ?? ((message) => console.error(message));
    this.#getConfig = deps.getConfig ?? (() => getConfig());
  }

  /** 当前是否有一个已就绪的 worker 进程（诊断用）。 */
  get ready(): boolean { return this.#isReady; }

  /** 在途请求数（诊断用）。 */
  get pendingCount(): number { return this.#pending.size; }

  /**
   * 预热：确保 worker 进程已经起来。对应长期任务表里的启动入口（见文件末尾的
   * `initPicImageSearch`）。
   *
   * **只做"把进程拉起来"这一件事。** `search`/`ping` 的懒启动语义不受影响 —— 它们各自仍会
   * `#ensureStarted`，所以预热失败不会让后续搜索永久失效。
   *
   * 也正因如此这里**允许抛**：真错误要能被调用方看见。"失败只记日志"是 `initPicImageSearch`
   * 对退出路径的取舍，不该由这个方法替它决定（那会让"客户端起不来"这件事在启动期彻底静音）。
   */
  async start(timeoutMs: number = DEFAULT_START_TIMEOUT_MS): Promise<void> {
    await this.#ensureStarted(timeoutMs);
  }

  /**
   * 搜一张图。签名按既定要求：引擎在前，图片在后。
   *
   * 第 6、7 个参数是**追加**的可选项，所以既有调用点不受影响：
   * - `signal` —— 取消。中止时同时通知 worker 取消那一侧的任务（见 `#request`）。
   * - `engineOptions` —— 引擎私有参数。**SauceNAO 的 apiKey 走这里**，它只进 stdin。
   *   worker 侧还有 `SAUCENAO_API_KEY` 环境变量兜底，但项目的 key 存在配置里而不是
   *   环境里，所以正常路径必须由调用方把 `cfg.sauceNao.apiKey` 递进来。
   */
  async search(
    engine: PicImageSearchEngine,
    buffer: Buffer,
    mime: string,
    timeoutMs: number,
    maxResults: number,
    signal?: AbortSignal,
    engineOptions?: Record<string, unknown>
  ): Promise<ProviderResponse> {
    const response = await this.#request(
      {
        engine,
        imageBase64: buffer.toString('base64'),
        mime,
        timeoutMs,
        maxResults,
        ...(engineOptions ? { engineOptions } : {})
      },
      timeoutMs,
      signal
    );
    return toProviderResponse(response, engine);
  }

  /**
   * 探活，对应旧 provider 的 `test()`。**任何失败都返回 false，从不抛异常。**
   *
   * 注意 worker 侧 `probe` 的**刻意取舍**：它只验证「库里有这个引擎、参数能构造出对象」，
   * **不发真实请求**（设置页的「测试连接」是个能随便点的按钮，烧 SauceNAO 免费额度不合适）。
   * 所以 `true` 的含义是「配置对」，**不是「远端活着」**。这个区别要一路带到设置页文案上。
   *
   * ⚠ **测 SauceNAO 时必须把 key 递进来**（`engineOptions = { apiKey }`）。worker 的
   * `SAUCENAO_API_KEY` 环境变量只是兜底，而项目的 key 存在配置里 —— 实测：进程健康、
   * 库也装了，但没传 key 时这里返回 `false`，报的却是「未配置 API Key」。
   * 将来的「测试连接」按钮如果不传 `cfg.sauceNao.apiKey`，就会在配置完全正确时显示失败。
   */
  async ping(
    engine: PicImageSearchEngine = 'saucenao',
    timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
    signal?: AbortSignal,
    engineOptions?: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const response = await this.#request(
        { op: 'probe', engine, timeoutMs, ...(engineOptions ? { engineOptions } : {}) },
        timeoutMs,
        signal
      );
      return response.ok === true;
    } catch (error) {
      this.#log(`[image-source] worker probe ${engine} 失败：${messageOf(error)}`);
      return false;
    }
  }

  /**
   * 优雅关闭。幂等 —— 重复调用返回同一个 promise，不会杀第二遍。
   *
   * 三条退出路径按顺序用，缺一不可（worker 的模块头写了为什么）：
   * 1. 协议里的 `shutdown`，让它自己关掉 Network 连接池与临时目录；
   * 2. `stdin.end()` → worker 的读取线程收到 EOF 就退出。**Windows 下这是唯一可靠的
   *    一条**：`TerminateProcess` 不走信号处理器，`SIGTERM` 送不到；
   * 3. 宽限期过后强杀，保证 `close()` 一定收敛（不能返回一个永远 pending 的 promise，
   *    否则退不掉的就是我们这一侧了 —— 参考 S11e 教训）。
   */
  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<void> {
    const child = this.#child;
    const closed = makeError('PROVIDER_UNAVAILABLE', '客户端已关闭');
    this.#failPending(closed);
    // 让还在等 ready 的调用方立刻拿到结论，而不是等它的 timeoutMs 慢慢烧完。
    this.#ready?.reject(closed);
    this.#ready = null;
    this.#isReady = false;
    if (!child) return;

    try { child.stdin?.write(`${JSON.stringify({ op: 'shutdown' })}\n`); } catch { /* 管道可能已经断了 */ }
    try { child.stdin?.end(); } catch { /* 同上 */ }

    const exited = await this.#waitForExit(child, CLOSE_GRACE_MS);
    if (!exited) {
      this.#log(`[image-source] worker 未在 ${CLOSE_GRACE_MS}ms 内退出，强制结束`);
      try { child.kill(); } catch { /* 已经死了 */ }
    }
    if (this.#child === child) this.#child = null;
  }

  #waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
  }

  // ── 启动与进程生命周期 ────────────────────────────────────────────────────

  /**
   * 确保有一个就绪的进程，没有就起一个。
   *
   * 冷启动要 import Python 与 PicImageSearch，可能花掉几秒。这里的 `timeoutMs` 只约束
   * **等待启动**这一段；随后那次请求还有它自己完整的一份 `timeoutMs`。刻意不共用一份
   * 预算 —— 让冷启动吃掉本次请求的预算会表现成「第一次搜图必然超时」。总上限由调用方
   * 的 `totalTimeoutMs` / AbortSignal 兜住。
   */
  async #ensureStarted(timeoutMs: number): Promise<void> {
    if (this.#closing) throw makeError('PROVIDER_UNAVAILABLE', '客户端已关闭');
    if (this.#isReady) return;
    if (!this.#child) this.#spawn();
    const ready = this.#ready;
    if (!ready) throw makeError('PROVIDER_UNAVAILABLE', 'worker 进程不存在');
    await withTimeout(ready.promise, timeoutMs, 'PROVIDER_UNAVAILABLE');
  }

  #spawn(): void {
    const { command, prefix } = resolvePythonCommand(this.#getConfig());
    const args = [...prefix, PIC_IMAGE_SEARCH_SCRIPT];
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        // stdin/stdout 是协议通道，stderr 是日志通道（worker 保证 stdout 只有 JSON）。
        stdio: ['pipe', 'pipe', 'pipe'],
        // Electron 下别闪出一个控制台窗口。
        windowsHide: true
      });
    } catch (error) {
      // spawn 只会在参数本身非法时同步抛（可执行文件不存在走的是异步的 'error' 事件）。
      throw makeError('PROVIDER_UNAVAILABLE', `无法启动 Python（${command}）：${messageOf(error)}`);
    }

    this.#child = child;
    this.#isReady = false;
    this.#stdoutBuffer = '';

    const ready = deferred<void>();
    // 没人 await 时（自动重启的路径就是这样）不能让这个 rejection 变成
    // unhandledRejection。挂一个空的 catch，真正的等待者仍然能拿到这次 rejection。
    ready.promise.catch(() => { /* 由等待者处理，或由日志记录 */ });
    this.#ready = ready;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    // 两条数据流都按**自己的那个 child** 过滤：进程死后 stdout 里可能还有一批已在管道中
    // 的数据（见下面 'close' 的说明）。没有这道闸门的话，旧进程的迟到消息会被当成新进程的
    // 消息处理 —— 而 `#child` 那时已经指向新进程了。
    child.stdout?.on('data', (chunk: string) => { if (this.#child === child) this.#onStdout(chunk); });
    child.stderr?.on('data', (chunk: string) => { if (this.#child === child) this.#onStderr(chunk); });
    // 'error'（拉不起来）与 'close'（拉起后又死了）走同一条收尾路径：两者之后都不会再有
    // stdout，在途请求必须立刻结束，不能干等到超时。
    child.on('error', (error) => {
      this.#onProcessGone(child, makeError('PROVIDER_UNAVAILABLE', `无法启动 Python（${command}）：${error.message}`));
    });
    // 用 'close' 而不是 'exit'：'exit' 可能在 stdio 还没排空时就触发了，那时管道里还可能
    // 躺着一行**已经写出来的响应**。用 'exit' 收尾会把那次成功的查询判成
    // PROVIDER_UNAVAILABLE（结果明明已经算出来了）。'close' 在 stdio 全部送达之后才触发，
    // 届时应答过的请求早已从 #pending 里结算掉了，剩下的才是真的没人管。
    child.on('close', (code, signal) => {
      this.#onProcessGone(child, makeError('PROVIDER_UNAVAILABLE', `worker 进程退出（code=${code} signal=${signal}）`));
    });

    this.#log(`[image-source] worker 已拉起：${command} ${args.join(' ')}`);
  }

  /**
   * 进程没了（启动失败、崩溃、被外部杀掉都走这里）。
   *
   * 顺序很重要：先把在途请求全部结束掉，再决定要不要重启 —— 反过来会让那几个请求
   * 一直挂在 `#pending` 里直到各自的超时。
   */
  #onProcessGone(child: ChildProcess, error: Error): void {
    // 迟到的旧进程事件：`#child` 已经指向新进程了，别让它把新进程的状态清掉。
    if (this.#child !== child) return;
    this.#child = null;
    this.#isReady = false;
    const ready = this.#ready;
    this.#ready = null;
    ready?.reject(error);
    this.#failPending(error);

    if (this.#closing) return;
    if (this.#restartAttempted) {
      // 自动重启的那一次**也没能走到 ready** 就又死了。继续重试只会变成 spawn 风暴，
      // 所以停在这里；下一次显式请求（search/ping）会再起一次，代价由调用方承担。
      this.#log(`[image-source] worker 自动重启后仍未就绪，停止重试：${error.message}`);
      return;
    }
    this.#restartAttempted = true;
    this.#log(`[image-source] worker 意外退出，自动重启一次：${error.message}`);
    try {
      this.#spawn();
    } catch (spawnError) {
      this.#log(`[image-source] worker 自动重启失败：${messageOf(spawnError)}`);
    }
  }

  // ── stdout 解析 ──────────────────────────────────────────────────────────

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let index = this.#stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      // Windows 的文本模式可能把行尾写成 \r\n（worker 用的是二进制写出，理论上不会，
      // 但这里是外部输入，剥掉一个 \r 的成本是零）。
      const line = this.#stdoutBuffer.slice(0, index).replace(/\r$/, '');
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      if (line.trim()) this.#handleLine(line);
      index = this.#stdoutBuffer.indexOf('\n');
    }
    // 防御：协议彻底错位时（比如某个引擎往 stdout 灌了一大段没有换行的东西），
    // 不能让这个缓冲区无限长下去。
    if (this.#stdoutBuffer.length > MAX_LINE_BYTES) {
      this.#log(`[image-source] worker stdout 单行超过 ${MAX_LINE_BYTES} 字节，丢弃缓冲`);
      this.#stdoutBuffer = '';
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // worker 承诺 stdout 只有 JSON。走到这里说明那句话不成立（库里的 print() 之类），
      // 记一行日志就好 —— 抛异常会顺着事件处理器变成进程级崩溃。
      this.#log(`[image-source] worker stdout 出现非 JSON 行：${line.slice(0, DETAIL_MAX_CHARS)}`);
      return;
    }
    const message = asRecord(parsed);
    const id = typeof message.id === 'string' ? message.id : '';

    if (id) {
      const pending = this.#pending.get(id);
      if (!pending) {
        this.#log(`[image-source] 收到未知 id 的响应（可能已超时/被取消）：${id}`);
        return;
      }
      pending.settle(null, message);
      return;
    }

    const event = typeof message.event === 'string' ? message.event : '';
    if (event === 'ready') {
      this.#isReady = true;
      // 走到 ready 才算「这一次重启成功」，于是下一次意外退出又有一次自动重启的机会。
      this.#restartAttempted = false;
      this.#log(`[image-source] worker 就绪：python=${String(message.python ?? '?')} PicImageSearch=${String(message.version ?? '?')}`);
      const ready = this.#ready;
      this.#ready = null;
      ready?.resolve();
      return;
    }
    if (event === 'fatal') {
      // worker 会紧接着 exit(2)。启动期的致命错误（库没装、Network 构造不出来）是
      // **确定性**的，重启一次必然同样失败，所以直接把重启额度用掉，别浪费那次 spawn。
      const detail = typeof message.detail === 'string' ? message.detail : '';
      const code = typeof message.error === 'string' ? message.error : 'PROVIDER_UNAVAILABLE';
      const error = makeError(code as PicImageSearchErrorCode, detail || undefined);
      this.#restartAttempted = true;
      this.#log(`[image-source] worker 启动失败：${error.message}${detail ? ` ${detail}` : ''}`);
      const ready = this.#ready;
      this.#ready = null;
      this.#isReady = false;
      ready?.reject(error);
      this.#failPending(error);
      // 主动收掉这个进程，**不要等它自己退**。实测（2026-09-29，Python 3.11）：
      // 启动失败路径上 worker 会卡在解释器关停里吐
      // `Fatal Python error: _enter_buffered_busy: could not acquire lock for
      //  <_io.BufferedReader name='<stdin>'> … possibly due to daemon threads`
      // —— stdin 读取线程还阻塞在 readline()、握着 BufferedReader 的锁，于是进程不退出，
      // 'close' 也就永远不来，`#child` 会一直挂着。杀掉它既清干净状态，也让下一次请求
      // 能正常重新拉起（`#restartAttempted` 已经在上面置位，所以不会立刻又起一个）。
      // `#handleLine` 只可能经由 `#onStdout` 同步到达，而那条路径已经确认过
      // `this.#child === 产生这一行的进程`，所以这里直接用 `this.#child` 就是对的那个。
      const child = this.#child;
      if (child) {
        try { child.kill(); } catch { /* 已经死了 */ }
      }
      return;
    }
    this.#log(`[image-source] 无法识别的 worker 消息：${line.slice(0, DETAIL_MAX_CHARS)}`);
  }

  #onStderr(chunk: string): void {
    // worker 的日志走 stderr。逐行加前缀转出去，方便和 Node 侧日志分开看。
    for (const line of chunk.split('\n')) {
      if (line.trim()) this.#log(`[image-source:py] ${line.replace(/\r$/, '')}`);
    }
  }

  // ── 请求 ────────────────────────────────────────────────────────────────

  /**
   * 发一条请求并等它的响应。
   *
   * 结算点只有一个：超时、中止、进程死亡、收到响应，四者先到先算，后到的被 `done` 挡掉。
   * 超时与中止**都会顺手通知 worker 取消**那一侧的任务 —— 否则那个请求会在 Python 里
   * 继续跑到底，白烧一次第三方配额（SauceNAO 的免费额度尤其紧）。
   */
  #request(
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<WorkerResponse> {
    const id = randomUUID();
    return new Promise<WorkerResponse>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (error: Error | null, response?: WorkerResponse) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(response ?? {});
      };

      const cancelRemote = () => {
        this.#sendCancel(id);
        settle(makeError('TIMEOUT'));
      };

      const onAbort = () => {
        this.#sendCancel(id);
        settle(makeError('ABORTED', '调用方中止了这次请求'));
      };

      // 顺序要紧：`settle` 的体内引用了 `onAbort`，所以**任何**调用它的路径都必须排在
      // `onAbort` 的初始化之后。这三条语句的相对位置不要动。
      if (signal?.aborted) {
        settle(makeError('ABORTED', '调用方在请求发出前就已中止'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      void (async () => {
        await this.#ensureStarted(timeoutMs);
        if (done) return;

        const line = JSON.stringify({ id, ...payload });
        // worker 对超长行是**静默丢弃**（记一行 stderr 就 continue），也就是说这种请求
        // 在那边根本不存在，我们这边只能等到超时。所以在这里本地拦下，给一个能看懂的错。
        const bytes = Buffer.byteLength(line, 'utf8') + 1;
        if (bytes > MAX_LINE_BYTES) {
          throw makeError('INVALID_RESPONSE', `请求 ${bytes} 字节超过 worker 的 ${MAX_LINE_BYTES} 上限，图片过大`);
        }

        this.#pending.set(id, { settle });
        timer = setTimeout(cancelRemote, timeoutMs);
        timer.unref?.();
        this.#writeLine(line);
      })().catch((error: unknown) => {
        settle(error instanceof Error ? error : makeError('PROVIDER_UNAVAILABLE', String(error)));
      });
    });
  }

  #writeLine(line: string): void {
    const child = this.#child;
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed || !stdin.writable) {
      throw makeError('PROVIDER_UNAVAILABLE', 'worker 的 stdin 不可写');
    }
    // 返回 false 只表示「超过高水位了」，Node 会自己缓冲；被卡住的那次由本次请求的
    // timeoutMs 兜底，所以这里不额外处理背压。
    stdin.write(`${line}\n`);
  }

  /**
   * 告诉 worker 取消某个搜索请求。
   *
   * 这是**尽力而为**的：进程已经死了就直接跳过。cancel 命令本身 worker 一定会回一行
   * 响应（协议里它是命令不是通知），所以顺手给它占一个空表项 —— 不占的话那一行会掉进
   * 「未知 id」的日志噪音里，而超时是常规路径，噪音会非常多。
   */
  #sendCancel(target: string): void {
    if (!this.#child) return;
    const id = randomUUID();
    // **必须自己把自己从表里摘掉** —— 实测踩到过：这里写成一个空的 settle（`() => {}`），
    // 于是那个占位表项永远留在 `#pending` 里。超时与中止都是常规路径，一个长时间运行
    // 的 bot 每超时一次漏一条，`pendingCount` 只增不减。
    this.#pending.set(id, { settle: () => { this.#pending.delete(id); } });
    try {
      this.#writeLine(JSON.stringify({ id, op: 'cancel', target }));
    } catch (error) {
      this.#pending.delete(id);
      this.#log(`[image-source] 发送 cancel 失败：${messageOf(error)}`);
    }
  }

  #failPending(error: Error): void {
    // 先快照：settle 会改 #pending，边遍历边改会让部分表项漏掉。
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const pending of entries) pending.settle(error);
  }
}

// ── 单例 ────────────────────────────────────────────────────────────────────
//
// 常驻进程意味着**全进程只有一个客户端**：每 new 一个就会多拉起一个 Python 进程，
// 而每个进程都持有自己的 Network 连接池。

let singleton: PicImageSearchClient | null = null;

/** 取（必要时创建）进程级单例。**不启动进程** —— 第一次 search/ping 才 lazily spawn。 */
export function getPicImageSearchClient(): PicImageSearchClient {
  singleton ??= new PicImageSearchClient();
  return singleton;
}

/**
 * 关闭单例并丢弃引用。**必须在退出路径上调用**（长期任务表 / LIFECYCLE 那一侧）。
 *
 * 这里刻意把单例置空：`close()` 之后这个实例是终态（`#closing` 已经闩住，不再接受请求），
 * 留着它只会让下一次调用拿到一个已死的客户端。
 */
export function closePicImageSearchClient(): Promise<void> {
  const client = singleton;
  singleton = null;
  return client ? client.close() : Promise.resolve();
}

/**
 * 长期任务表里登记的那个**启动入口**（`LONG_TERM_TASKS` 里 `image-source.pic-worker` 的
 * `start`）。由 `web/runtime/lifecycle.ts` 在 `app.start()` 里调用，受
 * `imageSource.enabled` 闸门约束 —— 不用搜图的人因此完全不必付这次冷启动。
 *
 * 存在的理由有两条，缺一不可：
 *
 * 1. **进程生命周期 = 应用生命周期。** 在此之前 worker 是"谁先搜图谁负责把它拉起来"，
 *    没有一个地方能回答"它该在什么时候起"。显式入口把这件事从副作用变成装配。
 * 2. **首次搜图不再付冷启动。** 反过来，懒启动意味着群里第一张图要额外等一次解释器 +
 *    库的 import，而那次等待算在用户请求的 `totalTimeoutMs` 里。
 *
 * **失败只记日志、绝不外抛。** 这台机器可能压根没装 PicImageSearch、也可能 `python.path`
 * 没配好，那是"搜图不可用"，不是"应用起不来"：`initPicImageSearch` 抛出去会掀翻
 * `app.start()`，连带把 QQ 连接、聊天、记忆全都拖下水。预热失败之后 `search()` 仍会自己
 * 重试 `#ensureStarted`，所以这不影响"配置修好之后重新保存设置就能用"。
 */
export async function initPicImageSearch(): Promise<void> {
  try {
    await getPicImageSearchClient().start();
  } catch (error) {
    console.error(`[image-source] 预热 PicImageSearch worker 失败（首次搜图时会再试一次）：${messageOf(error)}`);
  }
}
