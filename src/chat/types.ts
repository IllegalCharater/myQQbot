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
