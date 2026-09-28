import type { HotSearchFeed, HotSearchItem, HotSearchRawItem } from './types.js';

const PLATFORM_NAMES: Record<string, string> = {
  weibo: '微博热搜',
  zhihu: '知乎热榜',
  bilibili: 'B站日榜',
  tieba: '百度贴吧热议'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanUrl(value: unknown): string | undefined {
  const raw = cleanText(value, 1_200);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch { return undefined; }
}

function cleanRank(value: unknown): number | undefined {
  const rank = Number(value);
  return Number.isInteger(rank) && rank > 0 && rank <= 10_000 ? rank : undefined;
}

function cleanHot(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const text = cleanText(value, 80);
  return text || undefined;
}

/**
 * 接口按平台分别返回榜单，并没有定义跨平台的“总热度”。这里按各平台榜内位置轮询：
 * 每个平台第 1 名 → 每个平台第 2 名……，既保留平台返回顺序，也不比较不可比的 hot 字段。
 */
export function normalizeHotSearchResponse(payload: unknown): HotSearchFeed {
  if (!isRecord(payload) || String(payload.code ?? '') !== '200' || !isRecord(payload.data)) {
    throw new Error('热搜响应缺少有效的 code/data');
  }
  const data = payload.data;
  if (!isRecord(data.platforms)) throw new Error('热搜响应缺少 platforms');

  const platformLists: Array<{ id: string; name: string; items: HotSearchRawItem[] }> = [];
  for (const [id, rawPlatform] of Object.entries(data.platforms)) {
    if (!isRecord(rawPlatform) || !Array.isArray(rawPlatform.items)) continue;
    const name = cleanText(rawPlatform.name, 40) || PLATFORM_NAMES[id] || id;
    platformLists.push({ id, name, items: rawPlatform.items.filter(isRecord) as HotSearchRawItem[] });
  }

  const items: HotSearchItem[] = [];
  const maxLength = Math.max(0, ...platformLists.map((platform) => platform.items.length));
  let sourceIndex = 0;
  for (let itemIndex = 0; itemIndex < maxLength; itemIndex++) {
    for (const platform of platformLists) {
      const raw = platform.items[itemIndex];
      if (!raw) continue;
      const title = cleanText(raw.title, 300);
      if (!title) continue;
      items.push({
        title,
        platformId: platform.id,
        platformName: platform.name,
        rank: cleanRank(raw.rank),
        hot: cleanHot(raw.hot),
        url: cleanUrl(raw.url) ?? cleanUrl(raw.mobile_url),
        sourceIndex: sourceIndex++
      });
    }
  }

  const requestedPlatforms = Array.isArray(data.requested_platforms)
    ? data.requested_platforms.map((value) => cleanText(value, 40)).filter(Boolean)
    : platformLists.map((platform) => platform.id);
  const failed = data.failed_platforms;
  const failedPlatforms = Array.isArray(failed)
    ? failed.map((value) => cleanText(value, 80)).filter(Boolean)
    : isRecord(failed) ? Object.keys(failed) : [];
  const generatedAt = cleanText(data.generated_at, 80) || undefined;
  return { generatedAt, items, requestedPlatforms, failedPlatforms };
}
