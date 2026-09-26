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
  rounds?: number;
  messages: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
  feedbacks: Array<Record<string, unknown>>;
  finishReason?: unknown;
  error?: unknown;
  systemPrompt?: string;
  userPrompt?: string;
}
export interface MemoryMember extends Record<string, unknown> { id?: string; name?: string }
