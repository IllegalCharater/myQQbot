export interface StickerEntry extends Record<string, unknown> {
  id: string;
  url: string;
  source: string;
  resId?: string;
  md5?: string;
  desc?: string;
  note?: string;
  labels?: string[];
  scenes?: string[];
  cacheFile?: string;
  cachedAt?: string;
  createdAt?: string;
  usedAt?: string;
  useCount?: number;
}

export type StickerPatch = Partial<Pick<StickerEntry, 'note' | 'labels' | 'scenes'>>;
export interface StickerCacheResult { cached: boolean; file?: string; error?: string }
