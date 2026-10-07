// 各 provider 共用的读取逻辑。
//
// 为什么单开一个文件而不是塞进某个 provider：`maxResults` / `resolveCustomConfig` 都被
// **多个** provider 与分发层用。挂在 `providers/bing.ts` 上会让"改 Bing"与"改搜索条数上限"
// 变成同一件事，而它们毫无关系（分发层 import 一个具体 provider 也是错的形状）。
import { getConfig } from '../../core/config.js';
import { asRecord, recordArray } from './record-utils.js';

/** 读 `webSearch.maxResults`（1–10，默认 6）。各处口径只有这一处，避免 6 这个数散开写。 */
export function maxResults(): number {
  return Math.max(1, Math.min(10, Number(getConfig().webSearch?.maxResults) || 6));
}

/**
 * 解析自定义搜索配置。
 * providerId 形如 'custom:abc123' 时从 webSearch.providers 数组里取对应项；
 * 否则退回旧的单槽位 webSearch.custom（兼容早期配置）。
 */
export function resolveCustomConfig(providerId: string | null = null): Record<string, unknown> {
  const ws = getConfig().webSearch ?? {};
  if (providerId && String(providerId).startsWith('custom:')) {
    const id = String(providerId).slice('custom:'.length);
    const found = recordArray(ws.providers).find((provider) => String(provider.id) === id);
    if (found) return found;
    // 列表里找不到 → 回退单槽位，避免配置丢失后完全搜不了
  }
  return asRecord(ws.custom);
}
