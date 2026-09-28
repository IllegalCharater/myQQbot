export const HOT_SEARCH_PLATFORMS = ['weibo', 'zhihu', 'bilibili', 'tieba'] as const;

export type HotSearchPlatform = typeof HOT_SEARCH_PLATFORMS[number];
export type HotSearchTrigger = 'scheduled' | 'manual' | 'preview';
export type HotSearchRunStatus = 'idle' | 'success' | 'failed' | 'running' | 'skipped';

export interface HotSearchRawItem {
  rank?: unknown;
  title?: unknown;
  hot?: unknown;
  url?: unknown;
  mobile_url?: unknown;
  [key: string]: unknown;
}

export interface HotSearchItem {
  title: string;
  platformId: string;
  platformName: string;
  rank?: number;
  hot?: string | number;
  url?: string;
  sourceIndex: number;
}

export interface HotSearchTopic {
  title: string;
  sources: string[];
  sourceIds: string[];
  rank?: number;
  hot?: string | number;
  url?: string;
  sourceIndex: number;
}

export interface HotSearchFeed {
  generatedAt?: string;
  items: HotSearchItem[];
  requestedPlatforms: string[];
  failedPlatforms: string[];
}

export interface HotSearchState {
  lastSuccessDate?: string;
  deliveryDate?: string;
  deliveredGroupIds: string[];
  status: HotSearchRunStatus;
  trigger?: HotSearchTrigger;
  updatedAt?: string;
  itemCount: number;
  targetCount: number;
  error?: string;
  authMode?: 'api-key' | 'anonymous';
}

export interface HotSearchPreview {
  generatedAt?: string;
  itemCount: number;
  pages: string[];
  authMode: 'api-key' | 'anonymous';
}

export interface HotSearchStatusView extends HotSearchState {
  enabled: boolean;
  cron: string;
  timezone: string;
  configuredTargetCount: number;
  eligibleTargetCount: number;
  hasApiKey: boolean;
  scheduled: boolean;
  nextRunAt: string | null;
  running: boolean;
}
