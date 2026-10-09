// 图像生成模块的共享类型。
//
// 这一层**不 import 本模块任何文件**：它是所有别的文件的公共依赖，一旦反向依赖就会成环
// （`errors.ts` 要用 `FailureStage`，`config.ts` 要用 `EffectiveConfig`…）。与
// `media/transcription/types.ts` 同一条规矩。
import type { AppConfig } from '../../core/config.js';

/** 任务的对外状态。`fetching` 指"正在取参考图"，不是"在出图"。 */
export type ImageGenStatus = 'queued' | 'fetching' | 'generating' | 'downloading' | 'uploading' | 'done' | 'failed';

/**
 * 失败阶段，决定失败文案写的是哪一段。
 *
 * 五个阶段是**各自可归因**的：`fetching` 指向参考图那条链接，`generating` 指向百炼接口，
 * `downloading` 指向结果图那条 24 小时链接，`uploading` 指向 QQ 上传。
 * 合成一句「画图失败」的话，排查方向就完全靠猜了（搜图那条链路踩过同型的坑：
 * "下载慢"被说成"接口慢"）。
 */
export type FailureStage = 'validation' | 'fetching' | 'generating' | 'downloading' | 'uploading';

/** 结果的投递方式，见 `InternalJob.mode`。 */
export type DeliveryMode = 'standalone' | 'assisted';

/**
 * 发送端口：出图链路只用到这两样，不依赖 `SendQueue` 具体类。
 *
 * `sendImage` 收的是**本机文件路径**（出图结果是临时文件），不是 URL —— QQ 的图片段
 * 两种都认，而结果 URL 只有 24 小时有效期，落盘再发才不会"发出去时已经过期"。
 */
export interface ImageGenSender {
  sendTextBatch(chatKey: string, messages: unknown, options?: {
    replyToMessageId?: unknown; atUserId?: unknown; file?: string;
  }): Promise<unknown>;
  sendImage(chatKey: string, file: string, options?: {
    replyToMessageId?: unknown; atUserId?: unknown;
  }): Promise<unknown>;
}

/**
 * 交付结果的三态。**`unsent` 与 `failed` 必须分开**：前者图已经画好了（消息甚至可能已经在群里），
 * 后者压根没画出来 —— 对模型这是两件不同的事，对群友也是。
 *
 * 与 `chat/types.ts` 的同名联合类型**各写一份**：`media` 与 `chat` 同属 T1、严格互斥，
 * 队列不能 import 聊天领域（同 `TranscriptionMedia` 与 `MediaEntry` 的关系）。
 */
export type ImageResultStatus = 'sent' | 'unsent' | 'failed';

/**
 * 结果回流端口（成功与失败共用）。
 *
 * 为什么是**注入的函数**而不是让队列直接写存档：`media` 与 `chat`/`agent` 同属 T1、严格互斥，
 * 队列不能 import `ChatStore` 或 `Orchestrator`。装配根（`web/app.ts`）把
 * "落存档 → 入窗 → 触发一次运行"接过去，形态与 `TranscriptSink` 完全一致。
 *
 * ⚠️ **成功与失败走同一条通道**，这是出图这条路的硬规则：模型只调了一次工具就结束本轮，
 * 随后那次运行才是它开口的地方。只有两种结果都从这里进上下文，它才有机会用自己的话交代；
 * 由队列代它往群里贴一句"画图失败"，就回到了"工具代模型发言"那条禁令要防的形态 ——
 * 模型看着已经说过了，于是不再开口（聊天那次"任务被代发伪装成已收尾"是同一个病）。
 *
 * `prompt` 是**模型给的那段描述**（不含后端叠加的风格层）；`reason` 是给模型看的**事实**
 * （一句话，不含"你该说什么"那种指令 —— 那是 `prompt-catalog` 的事）。
 */
export type ImageResultSink = (input: {
  chatKey: string;
  prompt: string;
  status: ImageResultStatus;
  /** `sent` 时为空串。 */
  reason: string;
  replyToMessageId?: string | number | null;
}) => void | Promise<void>;

/** 归一化后的生效配置。 */
export interface EffectiveConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  size: string;
  promptExtend: boolean;
  watermark: boolean;
  negativePrompt: string;
  stylePrompt: string;
  timeoutMs: number;
  maxPromptChars: number;
  maxStyleChars: number;
  maxRefImageBytes: number;
  maxDownloadBytes: number;
  maxCallsPerChatPerHour: number;
  maxCallsPerDay: number;
}

export interface InternalJob {
  id: string;
  chatKey: string;
  /** 模型/命令给的画面描述。**不进对外读模型**（见 `ImageGenJobView`）。 */
  prompt: string;
  /** 图生图（I2I）的参考图地址；空串 = 文生图。 */
  referenceUrl: string;
  replyToMessageId: string | number | null;
  /**
   * 结果投递方式。
   *
   * - `standalone`（`/画` 命令路径）：只把图发进群，外加一句回执。确定性、零 LLM 成本。
   * - `assisted`（模型自主调用 `generate_image` 的路径）：图同样由队列发出，发完再交给
   *   注入的回流端口，**由模型自己决定**要不要补一句话。
   *
   * 归一化只发生在 `enqueue` 一处，投递侧保证拿到的是确定值。
   */
  mode: DeliveryMode;
  status: ImageGenStatus;
  failedStage?: FailureStage;
  createdAt: number;
  updatedAt: number;
  imageBytes?: number;
  elapsedMs?: number;
  errorCode?: string;
}

/** 对外的任务视图（去掉 `prompt` 与 `referenceUrl` —— 用户内容不进对外读模型）。 */
export interface ImageGenJobView {
  id: string;
  chatKey: string;
  status: ImageGenStatus;
  failedStage?: FailureStage;
  createdAt: number;
  updatedAt: number;
  imageBytes?: number;
  elapsedMs?: number;
  errorCode?: string;
}

/**
 * 一次出图的产物：本机文件路径与字节数。
 *
 * ⚠️ 文件的生命周期**由队列掌握**（`#drain` 建临时目录、投递完删掉），不归 `runTask`：
 * 转写那条链路里 `runTask` 返回的是文本，可以在自己的 `finally` 里删目录；这里返回的是**文件**，
 * 它必须活到投递之后。所以 `workDir` 是队列递进去的，`runTask` 只负责往里写。
 *
 * `remoteUrl` 是接口给的结果图地址（**24 小时后失效**），只在**协议端明确拒绝本机路径**时
 * 被用来兜底重发一次 —— 本机路径是"协议端认不认"这件事唯一没法在本机验证的地方，
 * 与 stickers 那条退回原链接的兜底同一条判据（见 `queue.ts` 的 `#deliver`）。
 */
export interface ImageArtifact {
  filePath: string;
  bytes: number;
  remoteUrl?: string;
}

/**
 * 队列的可注入操作（测试用）。
 *
 * 两个都是"整段替换实现"的粒度，而不是"回调埋点"：套件要能假造一次完整的取图/出图/投递，
 * 而不必去 mock `fetch` 与文件系统。与 `transcription/types.ts` 的 `QueueOperations` 同形。
 */
export interface QueueOperations {
  runTask?: (
    job: Readonly<InternalJob>,
    signal: AbortSignal,
    setStatus: (status: ImageGenStatus, extra?: Partial<InternalJob>) => void,
    config: EffectiveConfig,
    workDir: string
  ) => Promise<ImageArtifact>;
  deliver?: (job: Readonly<InternalJob>, artifact: ImageArtifact, config: EffectiveConfig) => Promise<void>;
}

/** 队列构造参数。 */
export interface QueueDeps {
  sender: ImageGenSender;
  getConfig: () => AppConfig;
  log?: (...args: unknown[]) => void;
  operations?: QueueOperations;
  /** 见 `ImageResultSink`。**成功与失败都走它**；缺省时 assisted 任务退回"队列自己往群里贴一句"（否则群友什么都等不到），并记一条日志。 */
  deliverImageResult?: ImageResultSink | null;
}
