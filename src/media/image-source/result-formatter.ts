import type { ImageSourceResult } from './types.js';

const pct = (v: number) => `${Math.round(v * 100)}%`;
export function formatImageSourceResult(result: ImageSourceResult | null): string {
  if (!result) return '没找到可靠图源，可能是裁剪图、二次编辑图，或者不在当前索引库里。';
  if (result.kind === 'anime') {
    const seconds = Math.max(0, Math.floor(result.time || 0));
    const at = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    return [`可能是《${result.title}》`, result.episode ? `第 ${result.episode} 集，${at}` : at, `匹配度：${pct(result.similarity)}`, result.url ? `链接：${result.url}` : ''].filter(Boolean).join('\n');
  }
  return [`可能来源：${result.title}`, result.author ? `画师：${result.author}` : '', result.source ? `来源：${result.source}` : '', `相似度：${pct(result.similarity)}`, result.url ? `链接：${result.url}` : ''].filter(Boolean).join('\n');
}
