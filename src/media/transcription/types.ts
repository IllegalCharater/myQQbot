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
 * 结果回流端口（`assisted` 模式）。
 *
 * 为什么是**注入的函数**而不是让队列直接写存档：`media` 与 `chat`/`agent` 同属 T1、
 * 严格互斥，队列不能 import `ChatStore` 或 `Orchestrator`。装配根（`web/app.ts`）
 * 把"落存档 → 入窗 → 触发一次运行"接过去。与 `jmcomic` 的 `store: { appendSelf }`
 * 是同一个形态：最小结构化端口，没有 `instanceof`、没有品牌。
 *
 * `text` 是**已被截断**（到 `resultMaxChars`）的正文；`chars` 是**原文全长**。
 */
export type TranscriptSink = (input: {
  chatKey: string;
  text: string;
  truncated: boolean;
  chars: number;
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
  /** 见 `TranscriptSink`。缺省时 assisted 任务只记一条日志、不投递。 */
  deliverTranscript?: TranscriptSink | null;
}
