// 全局事件词表与载荷类型。设计见 docs/global-registry-design.md §4.2。
//
// 为什么词表住在 core：事件生产者散在 agent(3)/llm(1)/qq(1)，而 scripts/check-layers.mjs
// 禁止任何反向依赖（agent → web 立刻红）。把词表放在层级 0，人人可以向下 import，
// 就不需要"一个装下所有领域的注册对象"——那种对象一定会被层级检查拦下（§4.1）。
//
// 代价写在明处：core 不能引用上层类型，所以**载荷只能用基础类型**——string / number /
// boolean / null / 数组 / 普通对象 / 可辨识联合。真需要引用 chat/ 或 agent/ 的领域类型时，
// 只能退化成 unknown[] 或另想办法（§10 待定 8）。
//
// 本模块是纯声明：没有函数、没有副作用、**不替换** createEventBus()。总线照旧（组装根
// `web/app.ts` 建它、把 emit 注入给各模块），类型只加在注入函数上（S6），生产者已按
// S3/S4/S5 逐个改口引用这里的常量；S10d 之后 `Orchestrator` 不再自建兜底总线，
// `emit` 是必填依赖（漏传编译不过），但总线**本体**仍是 `core/util.ts` 的那一个。

// ── 事件名 ──
/**
 * 事件名常量。值就是线上真实发的那些字符串——S3/S4 只把发射点里的字面量换成 `EVENTS.*`，
 * 不改值，所以那两步对线上零影响（唯一例外见下面 `configApplied` / `orchestratorPause`）。
 */
export const EVENTS = {
  chatUpdate: 'chat-update',
  sessionUpdate: 'session-update',
  sessionStart: 'session-start',
  sessionEnd: 'session-end',
  memoryUpdate: 'memory-update',
  stickerUpdate: 'sticker-update',
  onebotStatus: 'onebot-status',
  snowlumaStatus: 'snowluma-status',
  snowlumaLog: 'snowluma-log',
  feedback: 'feedback',
  /**
   * 下面两个是全案唯一的线上协议改名（S4）：原先 `'status'` 一个名字背着两种不兼容的
   * 载荷，拆成两条通道后订阅方按名字就能判断该刷什么。旧名 `'status'` 两端都已绝迹，
   * 界面上这两个事件的处理函数仍是同一个 refreshStatus()，所以行为不变。
   */
  configApplied: 'config-applied',
  orchestratorPause: 'orchestrator-pause'
} as const;

// ── 载荷类型 ──
// 下面每个形状都对着真实发射点核过（file:line 写在注释里）。类型与实现对不上，
// S6 把注入函数翻成 AppEmit 时就会编译不过——所以这里不写"理想形状"，只写事实。

export interface OneBotStatusPayload {
  connected: boolean;
  everConnected: boolean;
  /** 最近一次连接错误；没出错时是空串（不是 null）。 */
  error: string;
}

export interface SnowlumaStatusPayload {
  running: boolean;
  embedded: boolean;
  /**
   * embedded 进程的 pid。写成可选是因为未启动时发的是 null，而 `child.pid`
   * 在类型上是 `number | undefined`——只写 `number | null` 会让那两处发射点编译不过。
   */
  pid?: number | null;
}

export interface SnowlumaLogPayload {
  /** Date.now()。 */
  at: number;
  /** 'stdout' | 'stderr'。 */
  stream: string;
  /** 已去掉行尾换行；空行在 pushSnowlumaLog 里就被丢掉了，不会发出来。 */
  text: string;
}

export interface StickerUpdatePayload {
  /** 只有单张变动（收藏/删除）带 id；批量刷新与缓存变更发 `{}`。 */
  id?: string;
}

export interface MemoryUpdatePayload {
  chatKey: string;
  phase?: 'consolidate-start' | 'consolidate-done' | 'consolidate-error';
  /** 仅 consolidate-start：手动指定要整理的 QQ 号；null 表示全群推断。 */
  userIds?: string[] | null;
  /** 仅 consolidate-error。 */
  error?: string;
  /**
   * consolidate-done 会把 consolidateMemoryForChat 的返回值原样展开进来
   * （routes/memory.ts:84），所以这几个字段是从那条路径来的。
   * results / skipped / failed 里装的是 agent 层的领域对象，core 里只能用 unknown[]——
   * UI 实际只读 note（ui/js/main.js:307）。
   */
  ok?: boolean;
  note?: string;
  changed?: number;
  results?: unknown[];
  skipped?: unknown[];
  failed?: unknown[];
}

/**
 * session-end 的 status 取值。**这是枚举过全部 finish / #finishWaiting 调用点后定下的
 * 封闭集合**，不是照抄 SessionRecord.status：`discarded` 是事件独有态——会话被 discard 时
 * 直接从索引里删掉，从不写进 s.status（chat/sessions.ts:185-198）。
 */
export type SessionEndStatus = 'done' | 'noreply' | 'error' | 'aborted' | 'discarded';

/**
 * session-end 的收敛态。今天有四种形状（§3.4 二），S5 让四个发射点都对齐到这里。
 *
 * 载荷必须**自包含**：`sessions.finish()` 会 `current.delete(id)`（sessions.ts:155），
 * 事件发出之后再去 peek 一定是 null。所以它不能像 session-update 那样走"瘦事件 + 回读"。
 */
export interface SessionEndPayload {
  /** 必填：tests/lib/harness.mjs 的 readArchivedSession 就是按它取留档会话的。 */
  sessionId: string;
  chatKey: string;
  status: SessionEndStatus;
  /**
   * ⚠️ 写成 `unknown` 不是偷懒，是**事实**：来源 `SessionRecord.error`（chat/types.ts:68）
   * 本身就是 `unknown`。运行时的真实取值只有 string 与 null，但把这里写成 `string | null`
   * 会让两个发射点编译不过（S5 实测：`s.error || null` 推成 `{} | null`、
   * 出错路径直接是 `unknown`），于是 S6 会被迫在那儿加 as 断言——那比写 unknown 更糟。
   * 同款处理见 `SessionStartPayload.status` 与 `FeedbackPayload.level`。
   */
  error?: unknown;
  /** 原 agent-runner.ts:336 的 `sent`（数字，已发送条数）。与 SSE 投影里的 `sent`（数组）同名异物，S5 改名。 */
  sentCount?: number;
  /** 同 `error`：来源 `SessionRecord.finishReason` 是 `unknown`（chat/types.ts:69），运行时是 string | null。 */
  finishReason?: unknown;
  usage?: unknown;
  /** #discardWaiting 的显式标记：压根没开始，与 'aborted' 的"开始了但没成"是两回事。 */
  discarded?: true;
}

export interface SessionStartPayload {
  sessionId: string;
  chatKey: string;
  /** 今天只发 'waiting'。 */
  status?: string;
  triggerSummary?: string;
}

export interface FeedbackPayload {
  sessionId: string;
  chatKey: string;
  /** 领域上是 info | warning | error，但工具里那个局部变量是 string，收窄会让发射点编译不过。 */
  level: string;
  message: string;
}

export interface ConfigAppliedPayload {
  configUpdated: true;
}

export interface OrchestratorPausePayload {
  paused: boolean;
  pauseReason: string | null;
}

// ── 事件名 → 载荷 ──
/**
 * **刻意不写索引签名。** `[event: string]: unknown` 会让 `keyof` 退化成 string，
 * 于是新增或改名事件永远不会报错，强类型映射等于没做。反过来说，"没有索引签名"这道
 * 护栏只挡得住**声明**：护栏两侧（`EVENTS` 的值 与 `AppEventMap` 的键）由文件末尾的
 * `EveryEventNameHasPayload` / `EveryPayloadHasEventName` 双向钉住，加一个事件名却忘了
 * 加载荷类型（或反过来）都编译不过。
 *
 * 同一个反面教材曾经真的存在过：`agent/shared/types.ts` 的 `AgentEventMap` 就带着索引
 * 签名，一整套"新事件不用登记"的静默退化因此合法。它已被 `AppEventMap` 取代并删除（S11d）。
 *
 * 键必须是 EVENTS 里的值，缺一个会被下面的编译期护栏拦下。
 */
export interface AppEventMap {
  'chat-update': string;                                    // chatKey，或 '*' 表示全局刷新
  /**
   * 瘦事件：只带 sessionId，富对象由 SSE 投影现读 `sessions.peek()`（§4.4）。
   *
   * S7 之前这里写的是 `string`——那是**当时的事实**：12 个发射点发的是裸字符串，
   * 而投影入口要求 `isRecord(payload) && payload.sessionId`，UI 同样在 `!data.sessionId`
   * 时 early-return。三方从未对齐，所以这条通道**自初始提交起就没通过电**（§3.4 三）。
   * S7 让 12 个发射点改发对象，投影的富帧分支才第一次真的跑起来。
   *
   * 别退回裸串：类型一改，编译器只会拦下"发裸串"，拦不下"忘了带 sessionId"以外的
   * 退化载荷——真正兜住的是 `tests/t-events.mjs` 第 6 段（真起 Orchestrator，把载荷
   * 喂给真投影函数，断言出来的是**富帧**而不是退化的 `{"sessionId":…}`）。
   */
  'session-update': { sessionId: string };
  'session-start': SessionStartPayload;
  'session-end': SessionEndPayload;
  'memory-update': MemoryUpdatePayload;
  'sticker-update': StickerUpdatePayload;
  'onebot-status': OneBotStatusPayload;
  'snowluma-status': SnowlumaStatusPayload;
  'snowluma-log': SnowlumaLogPayload;
  'feedback': FeedbackPayload;
  'config-applied': ConfigAppliedPayload;
  'orchestrator-pause': OrchestratorPausePayload;
}

export type AppEventName = (typeof EVENTS)[keyof typeof EVENTS];

/**
 * 类型化发射器。S6 把现有的 7 处 `(event: string, payload?: unknown) => unknown`
 * 注入类型换成它，生产者从此在编译期被检查（§3.3）。
 *
 * 在 S6 落地之前，发射点靠 `tests/t-events.mjs` 在文本层守着——注入类型不检查，
 * 手写字面量编译器不会报错。
 */
export type AppEmit = <K extends AppEventName>(event: K, payload: AppEventMap[K]) => void;

/**
 * 类型化订阅。服务端当前零消费者（§3.1 的实测），仅供测试与后续消费者使用。
 * ⚠️ 迁移期间**不得把业务正确性挂在 on() 上**。
 */
export type AppOn = <K extends AppEventName>(event: K, fn: (payload: AppEventMap[K]) => void) => () => void;

// ── 编译期护栏：词表与载荷表不许各自漂移 ──
// 只用类型，不产生任何运行时代码。少了任一侧，编译直接报错，不需要额外套件守。
type Assert<T extends true> = T;

/** 往 EVENTS 里加了名字却忘了登记载荷 → 这里报错。 */
export type EveryEventNameHasPayload =
  Assert<Exclude<AppEventName, keyof AppEventMap> extends never ? true : false>;

/** 加了载荷类型却忘了往 EVENTS 加常量 → 这里报错。 */
export type EveryPayloadHasEventName =
  Assert<Exclude<keyof AppEventMap, AppEventName> extends never ? true : false>;
