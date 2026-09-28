import type { HotSearchItem, HotSearchTopic } from './types.js';

export function normalizeHotSearchTitle(title: string): string {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/^(?:[#＃]\s*)?(?:【|\[|\(|（)\s*(?:热搜|热点|热议|热|爆|沸|新|荐)\s*(?:】|\]|\)|）)\s*/u, '')
    .replace(/\s*(?:【|\[|\(|（)\s*(?:热|爆|沸|新|荐)\s*(?:】|\]|\)|）)\s*$/u, '')
    .replace(/^#+|#+$/g, '')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

/** 精确标题去重；首个位置不动，只为首条补齐缺失字段并合并来源。 */
export function dedupeHotSearchItems(items: HotSearchItem[]): HotSearchTopic[] {
  const byTitle = new Map<string, HotSearchTopic>();
  for (const item of items) {
    const key = normalizeHotSearchTitle(item.title);
    if (!key) continue;
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, {
        title: item.title,
        sources: [item.platformName],
        sourceIds: [item.platformId],
        rank: item.rank,
        hot: item.hot,
        url: item.url,
        sourceIndex: item.sourceIndex
      });
      continue;
    }
    if (!existing.sourceIds.includes(item.platformId)) {
      existing.sourceIds.push(item.platformId);
      existing.sources.push(item.platformName);
    }
    if (existing.rank === undefined && item.rank !== undefined) existing.rank = item.rank;
    if (existing.hot === undefined && item.hot !== undefined) existing.hot = item.hot;
    if (!existing.url && item.url) existing.url = item.url;
  }
  return [...byTitle.values()].sort((a, b) => a.sourceIndex - b.sourceIndex);
}
