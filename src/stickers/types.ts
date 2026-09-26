export type StickerSource = 'qq' | 'ai' | 'manual';

export interface StickerEntry extends Record<string, unknown> {
  id: string;
  resId: string;
  url: string;
  md5: string;
  desc: string;
  localNote: string;
  tags: string[];
  usage: string;
  source: StickerSource;
  useCount: number;
  lastUsedAt: number;
  lastContext: string;
  createdAt: string;
  updatedAt: string;
  cacheFile: string;
  cachedAt: string;
}

export interface StickerPatch {
  note?: unknown;
  tags?: unknown;
  usage?: unknown;
  source?: StickerSource;
}

export interface StickerCacheResult {
  name: string;
  file: string;
  mime: string;
  bytes: number;
}
