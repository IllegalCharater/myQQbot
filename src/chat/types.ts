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
  /** 识别出的原文总字符数；条目正文被截断时它大于正文长度。 */
  chars: number;
  /** 条目正文是否只是原文开头（原文超过单条上限）。 */
  truncated: boolean;
}

/**
 * 图像生成结果条目（kind:'image-result'）的结构化事实。
 *
 * 与 TranscriptRecord 同一个取向：只记**发生了什么**。这里有两件事实值得留：
 * `prompt` 是模型给的那段画面描述（不含后端叠加的风格层），`count` 是这次实际发出的张数。
 * 记 `prompt` 的理由不是"留个副本"，而是这类条目的正文里就得点明画的是什么 ——
 * 回流触发的那一次运行拿不到原始工具调用，模型只能靠这条文本回想自己画了啥。
 *
 * **不回填投递结果**（"发出去没有"）：图片由队列在写这条之前就发出去了，把投递状态
 * 也塞进来只会让投递顺序变成提示词的一部分（同 TranscriptRecord 的取舍）。
 */
export interface ImageResultRecord extends Record<string, unknown> {
  /** 模型给的画面描述（未叠加管理员风格层）。 */
  prompt: string;
  /** 本次实际发送出去的图片张数。 */
  count: number;
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
