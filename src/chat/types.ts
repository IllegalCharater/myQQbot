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
  reply?: unknown;
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
