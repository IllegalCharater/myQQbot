export type ImageSourceKind = 'anime' | 'illustration';

export interface ImageSourceResult {
  provider: 'trace.moe' | 'SauceNAO';
  kind: ImageSourceKind;
  similarity: number;
  title: string;
  author?: string;
  source?: string;
  episode?: string;
  time?: number;
  url?: string;
  previewUrl?: string;
  indexName?: string;
  characters?: string;
}

export interface ProviderResponse {
  results: ImageSourceResult[];
  statusCode: number;
  quota?: { shortRemaining?: number; longRemaining?: number };
}

export type SearchIntent = 'anime' | 'illustration' | 'unknown';

export interface ImageSourceConfig {
  enabled: boolean;
  traceMoe: { enabled: boolean; timeoutMs: number; minSimilarity: number; maxResults: number };
  sauceNao: { enabled: boolean; apiKey: string; timeoutMs: number; minSimilarity: number; maxResults: number };
  maxImageBytes: number;
  maxQueueLength: number;
  totalTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTtlMs: number;
  maxCallsPerChatPerHour: number;
  maxCallsPerDay: number;
}
