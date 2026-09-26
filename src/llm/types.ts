export type JsonObject = Record<string, unknown>;

export interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatRequestMessage extends JsonObject {
  role: string;
  content?: unknown;
  tool_calls?: ToolCall[];
}

export interface ChatResponseMessage extends ChatRequestMessage {}

export interface TokenUsage extends JsonObject {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  calls: number;
}

export interface ProviderConfig extends JsonObject {
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models: string[];
}

export interface ModelPrice extends JsonObject {
  in: number;
  out: number;
  cached: number | null;
  peak?: { in: number; out: number; cached: number | null };
  image?: ImagePrice;
  note?: string;
  src?: string;
}

export interface ImagePrice extends JsonObject {
  mode?: 'capped' | 'pixel' | string;
  maxTokensPerImage?: number;
  divisor?: number;
  base?: number;
  maxPixels?: number;
  note?: string;
}

export interface PriceRow extends ModelPrice {
  id: string;
  matched?: string;
  remote?: boolean;
}

export interface UsagePriceRow {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  at?: number | Date;
}

export type PriceTable = Record<string, ModelPrice>;

export interface OpenAiResponse extends JsonObject {
  choices?: Array<{ message?: ChatResponseMessage; finish_reason?: string | null }>;
  usage?: TokenUsage;
  model?: string;
  data?: Array<{ id?: string; model?: string }>;
  error?: { message?: string; detail?: string };
}

export interface ChatCompletionResult {
  message: ChatResponseMessage;
  finishReason: string | null;
  usage: TokenUsage | null;
  model: string;
  raw: OpenAiResponse;
}
