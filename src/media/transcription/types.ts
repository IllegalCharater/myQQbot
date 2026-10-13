// 转写模块的共享类型。
//
// 这一层**不 import 本模块任何文件**：它是所有别的文件的公共依赖，一旦它反向依赖
// 就会形成环（`errors.ts` 要用 `FailureStage`，`primitives.ts` 要用 `TranscriptionError`…）。
import type { AppConfig } from '../../core/config.js';

export type TranscriptionStatus = 'queued' | 'extracting' | 'uploading' | 'recognizing' | 'done' | 'failed';
export type FailureStage = 'validation' | 'extracting' | 'uploading' | 'recognizing';

/** 结果的投递方式，见 `InternalJob.mode`。 */
export type DeliveryMode = 'standalone' | 'assisted';

/** 能被转写的媒体条目形状（存档 `MediaEntry` 的最小子集）。 */
export interface TranscriptionMedia extends Record<string, unknown> { kind: string; url?: string }

/** 发送端口：只要 `sendTextBatch`，不依赖 `SendQueue` 具体类。 */
export interface TranscriptionSender {
  sendTextBatch(chatKey: string, messages: unknown, options?: {
    replyToMessageId?: unknown; atUserId?: unknown; file?: string;
  }): Promise<unknown>;
}

/** OneBot 文件上传端口（只用到 `call`）。 */
export interface OneBotFileClient {
  call(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

/**
 * 转写结果的结局。
 *
 * **只有两态，没有 `unsent`** —— 这一点与出图/漫画刻意不同，判据是"交付物是不是文件"：
 * 那两条的交付物是**由队列自己发出去的文件**，所以"做好了但没能发出去"是一件真实、
 * 且与"没做成"完全不同的事（那份东西**可能已经在群里了**）。转写这条路的交付物是**文本**，
 * 而 assisted 模式下开口的是**模型**：结果要么交到回流端口（= 条目存在 = 模型会看到它），
 * 要么无人接单 —— 而"无人接单"时队列退回 standalone 的投递行为（自己贴文本），
 * **压根不产生条目**，所以那个中间态在这条路上既不可达、也无处可记。
 * 少了的那一档由**成员的缺席**表达（同 `EngineLimits.minSimilarity` 与 `ImageSourceResult.time` 那条规矩）。
 *
 * 三态在出图那边**不能合成一个"失败"**；这里反过来 —— **不许为了对齐形状凭空补一个 `unsent`**：
 * 一个没有人能产生的取值，读代码的人分不清它是"暂未使用"还是"忘了实现"。
 */
export type TranscriptStatus = 'sent' | 'failed';

/**
 * 结果回流端口（`assisted` 模式）：**成功与失败都走它**。
 *
 * 为什么是**注入的函数**而不是让队列直接写存档：`media` 与 `chat`/`agent` 同属 T1、
 * 严格互斥，队列不能 import `ChatStore` 或 `Orchestrator`。装配根（`web/app.ts`）
 * 把"落存档 → 入窗 → 触发一次运行"接过去。与出图/漫画两条同款：最小结构化端口，
 * 没有 `instanceof`、没有品牌。
 *
 * **失败也走这条**（`status: 'failed'`，`text` 为空串、`reason` 带原因）：这样模型才有机会
 * 用自己的话给群友一个交代，而不是由队列代它贴一句机器文案 —— 代发的后果实测过：
 * 消息写进 `session.sent` 之后这一轮按发送记录收尾成 `done`，模型以为"群里已经说过了"
 * 于是不再开口（见 `prompt-catalog` 的 `toolProtocol` 第 8 条与 `Agent` 的收尾判定）。
 * 只有"确定没人接"时才退回贴文案：端口缺失或抛错。
 *
 * `sent` 时 `text` 是**已被截断**（到 `resultMaxChars`）的正文、`chars` 是**原文全长**；
 * `failed` 时 `chars` / `truncated` 无意义（队列一律给 0 / `false`）。
 */
export type TranscriptSink = (input: {
  chatKey: string;
  status: TranscriptStatus;
  /** 识别正文（`sent`）；失败时为空串 —— 失败条目承载的是"没转成"这个事实，没有正文可载。 */
  text: string;
  truncated: boolean;
  chars: number;
  /** `failed` 时给模型看的原因（一句话）；`sent` 时为空串。 */
  reason: string;
  replyToMessageId?: string | number | null;
}) => void | Promise<void>;

/** 归一化后的生效配置。 */
export interface EffectiveConfig {
  enabled: boolean;
  appId: string;
  secretId: string;
  secretKey: string;
  engineType: string;
  ffmpegPath: string;
  ffmpegTimeoutMs: number;
  flashTimeoutMs: number;
  maxDurationSeconds: number;
  maxAudioBytes: number;
  maxSourceBytes: number;
  resultMaxChars: number;
  maxCallsPerChatPerHour: number;
  maxCallsPerDay: number;
}

export interface InternalJob {
  id: string;
  chatKey: string;
  sourceUrl: string;
  replyToMessageId: string | number | null;
  /**
   * 结果投递方式。
   *
   * - `standalone`（默认，`/转写` 命令路径）：队列自己把识别文本贴进原会话。
   *   确定性、零 LLM 成本，也是既有断言守着的路径。
   * - `assisted`（模型自主调用 `transcribe_video` 的路径）：结果交给注入的回流端口，
   *   由它落成一条存档条目并唤醒 Agent，**由模型自己决定说什么**。队列不再贴文本。
   *   **只有"确定没人接"时才退回 `standalone` 的行为**：没装回流端口、或端口抛错
   *   （那时再说一遍群里已经说过的话，也比什么都不说好）。
   *
   * 归一化只发生在 `enqueue` 一处，投递侧保证拿到的是确定值。
   */
  mode: DeliveryMode;
  status: TranscriptionStatus;
  failedStage?: FailureStage;
  createdAt: number;
  updatedAt: number;
  audioBytes?: number;
  elapsedMs?: number;
  errorCode?: string;
}

/** 对外的任务视图（`InternalJob` 去掉 `sourceUrl` —— URL 不进对外读模型）。 */
export interface TranscriptionJobView {
  id: string;
  chatKey: string;
  status: TranscriptionStatus;
  failedStage?: FailureStage;
  createdAt: number;
  updatedAt: number;
  audioBytes?: number;
  elapsedMs?: number;
  errorCode?: string;
}

/**
 * 队列的可注入操作（测试用）。
 *
 * 三个都是"整段替换实现"的粒度，而不是"回调埋点"：套件要能假造一次完整的
 * 提取/识别/投递，而不必去 mock `spawn` 与 `https`。
 */
export interface QueueOperations {
  checkFfmpeg?: (ffmpegPath: string) => Promise<void>;
  runTask?: (
    job: Readonly<InternalJob>,
    signal: AbortSignal,
    setStatus: (status: TranscriptionStatus, extra?: Partial<InternalJob>) => void,
    config: EffectiveConfig
  ) => Promise<string>;
  deliver?: (job: Readonly<InternalJob>, text: string, config: EffectiveConfig) => Promise<void>;
}

/** 队列构造参数。 */
export interface QueueDeps {
  sender: TranscriptionSender;
  onebot: OneBotFileClient;
  getConfig: () => AppConfig;
  log?: (...args: unknown[]) => void;
  operations?: QueueOperations;
  /** 见 `TranscriptSink`。缺省时 assisted 任务退回 standalone 的投递行为（贴文本 / 贴失败文案）。 */
  deliverTranscript?: TranscriptSink | null;
}
