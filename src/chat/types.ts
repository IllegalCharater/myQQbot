export interface MediaEntry extends Record<string, unknown> {
  kind: string;
  url?: string;
}

export interface DigestRecord extends Record<string, unknown> {
  from: number;
  to: number;
  count: number;
  summary?: string;
}

/**
 * 转写结果条目（kind:'transcript'）的结构化事实。
 *
 * 和 DigestRecord 同一个取向：数据只记**发生了什么**（`chars` 是**原文全长**、
 * `truncated` 是"条目正文只是开头"），"原文共 N 字，此处为开头部分"这句话怎么写
 * 由渲染方（prompt-builder 的 formatEntry）决定。不回填"完整文件发出去没有"之类的
 * 投递结果——那会让投递顺序变成提示词的一部分。
 */
export interface TranscriptRecord extends Record<string, unknown> {
  /** 识别出的原文总字符数；条目正文被截断时它大于正文长度。失败条目为 0。 */
  chars: number;
  /** 条目正文是否只是原文开头（原文超过单条上限）。失败条目恒为 `false`。 */
  truncated: boolean;
  /** 结局。**只有两态**（见下 `TranscriptStatus`）。字段缺席 = 本改动之前的存档，按 `sent` 处理。 */
  status?: TranscriptStatus;
  /** `failed` 时给模型看的原因（一句话）；`sent` 时为空串。 */
  reason?: string;
}

/**
 * 转写的结局：**只有 `sent` / `failed` 两态，没有 `unsent`**。
 *
 * 判据是**交付物是不是文件**：出图与漫画的交付物是队列自己发出去的文件，所以"做好了但没能
 * 发出去"（`unsent`）是一件真实、且与"没做成"完全不同的事 —— 那份东西**可能已经在群里了**。
 * 转写的交付物是**文本**：它要么交到回流端口（= 条目存在 = 模型会看到），要么无人接单 ——
 * 而"无人接单"时队列自己把文本贴进群，**压根不产生条目**，那个中间态无处可记。
 * 与 `media/transcription/types.ts` 的 `TranscriptStatus` 逐字同值（`chat` 与 `media` 同属 T1，
 * 不能互相 import）。**不许为了对齐形状凭空补一个 `unsent`**。
 */
export type TranscriptStatus = 'sent' | 'failed';

/**
 * 异步任务结果的**三态结局**（`sent` 成功 / `unsent` 做成了但没能确认送达 / `failed` 没做成）。
 *
 * 出图与漫画**各写一份取值逐字相同的联合类型**（`media/image-gen/types.ts` 的
 * `ImageResultStatus`、`media/jmcomic.ts` 的 `JmcomicStatus`）：`chat` 与 `media` 同属 T1，
 * 不能互相 import。**三态不能合成一个"失败"** —— `unsent` 那一支的东西**可能已经在群里了**，
 * 对模型（该说什么）和对群友（要不要再要一次）都完全是另一件事。
 */
export type AsyncResultStatus = 'sent' | 'unsent' | 'failed';

/** 出图结果的三态（见上；`chat` 内部用它自己的名字，与 media 那份逐字同值）。 */
export type ImageResultStatus = AsyncResultStatus;

/** 漫画下载结果的三态（见上）。 */
export type JmcomicStatus = AsyncResultStatus;

/**
 * 图像生成结果条目（kind:'image-result'）的结构化事实。
 *
 * 与 TranscriptRecord 同一个取向：只记**发生了什么**。这里有三件事实值得留：
 * `prompt` 是模型给的那段画面描述（不含后端叠加的风格层）、`count` 是这次实际发出的张数、
 * `status` 是上面那三态。记 `prompt` 的理由不是"留个副本"，而是这类条目的正文里就得点明
 * 画的是什么 —— 回流触发的那一次运行拿不到原始工具调用，模型只能靠这条文本回想自己画了啥。
 *
 * **不回填投递结果之外的东西**（"发出去没有"由 `status` 与正文表达）：把投递状态拆成
 * 一堆字段塞进来，只会让投递顺序变成提示词的一部分（同 TranscriptRecord 的取舍）。
 */
export interface ImageResultRecord extends Record<string, unknown> {
  /** 模型给的画面描述（未叠加管理员风格层）。 */
  prompt: string;
  /** 本次实际发送出去的图片张数（失败时为 0）。 */
  count: number;
  status: ImageResultStatus;
  /** `failed` / `unsent` 时给模型看的原因（一句话）；`sent` 时为空串。 */
  reason: string;
}

/**
 * 漫画下载结果条目（kind:'jmcomic-result'）的结构化事实。与上面那条同形（含三态）。
 *
 * `cached` 记的是"这一份用的是本地缓存"——它会进正文（"（使用本地缓存）"），
 * 因为那解释了"为什么这次这么快"。
 */
export interface JmcomicResultRecord extends Record<string, unknown> {
  comicId: string;
  cached: boolean;
  status: JmcomicStatus;
  /** `failed` / `unsent` 时给模型看的原因（一句话）；`sent` 时为空串。 */
  reason: string;
}

/**
 * 这条消息引用/回复的对象。**`mid` 是它存在的理由，不是附加信息**。
 *
 * 三者分工：`mid` = 被引用消息的 QQ id（可寻址），`sender`/`text` = 预览（人看着像话）。
 * 少了 `mid`，模型就只能看见一句 `[引用 清三：[图片]]` —— 而 `[图片]` 是所有图片共用的
 * 占位符，"清三的哪一张图"在文本上完全无从分辨，`get_message_images` 又只认消息 id，
 * 于是它只能从提示词里可见的 id 里挑一个（实测踩到：挑中了同一发送者的另一条图片消息）。
 * 细节与修法见 `docs/ts-migration-plan.md` 的「引用」一节。
 */
export interface ChatReply extends Record<string, unknown> {
  /** 被引用消息的 id。空串 = 引用段没带 id（理论上有，按"没有引用"处理）。 */
  mid: string;
  sender: string;
  text: string;
}

export interface ChatMessage extends Record<string, unknown> {
  id: number;
  ts: number;
  text: string;
  senderId: string;
  senderName: string;
  self: boolean;
  read: boolean;
  /** false = 已由确定性处理器接管，只进存档/历史，不进入动态唤醒窗口。 */
  wakeEligible?: boolean;
  mid?: string | number | null;
  kind?: string;
  media?: MediaEntry[];
  digest?: DigestRecord;
  transcript?: TranscriptRecord;
  imageResult?: ImageResultRecord;
  jmcomic?: JmcomicResultRecord;
  /**
   * 引用对象。**预览只存在这里，不再拍进 `text`**（见 `Ingest` 的注释）：
   * 拍进去的话 id 就没了，而渲染层拿得到结构化数据才能把它印成 `[引用 #id 谁：什么]`。
   * 老存档（本改动之前）的 `reply` 是 `null`，预览在 `text` 里 —— 两边渲染出来一样，
   * 所以不需要迁移。
   */
  reply?: ChatReply | null;
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  calls: number;
}

export interface SessionRecord extends Record<string, unknown> {
  id: string;
  chatKey: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
  waitUntil?: number | null;
  activity?: string;
  webSearchCount?: number;
  outcome?: unknown;
  usage: SessionUsage;
  model?: string;
  trigger?: unknown;
  triggerSummary?: string;
  triggerText?: string;
  promptChars?: number;
  pastStateCount?: number;
  /** 当前消息窗口在本次运行中实际注入的消息数。 */
  currentWindowCount?: number;
  /** 当前窗口溢出、未能进入本次提示词的消息数。 */
  foldedAway?: number;
  /** 历史读取边界：只读取该本地消息 id 之前的记录。 */
  historyBeforeId?: number | null;
  /** 当前窗口的独立响应决策。 */
  responseTier?: number;
  responseReason?: string;
  responseShouldRespond?: boolean;
  /** 独立历史策略请求读取的最大消息数。 */
  historyLimit?: number;
  rounds?: number;
  messages: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
  feedbacks: Array<Record<string, unknown>>;
  finishReason?: unknown;
  error?: unknown;
  systemPrompt?: string;
  userPrompt?: string;
  llmRequests?: Array<Record<string, unknown>>;
}
export interface MemoryMember extends Record<string, unknown> { id?: string; name?: string }
