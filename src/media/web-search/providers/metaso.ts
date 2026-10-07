// 秘塔 AI 搜索（metaso.cn，每天 100 次免费）。
//
// ⚠️ 它是唯一**没有 API Key 也照发**的 provider（`endpoint` 有 key 就带、没有就不带），
// 与其余五个"没 key 就抛错"的形状不同。这不是漏写校验：秘塔的免费额度本来就允许匿名调用，
// 加一条本地校验只会把能用的功能挡掉。
import { getConfig } from '../../../core/config.js';
import { asRecord, recordArray } from '../record-utils.js';
import { maxResults } from '../shared.js';
import type { SearchResponse } from '../types.js';

export async function metasoSearch(query: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch?.metaso ?? {};
  const apiKey = String(cfg.apiKey || process.env.METASO_API_KEY || '').trim();
  const endpoint = String(cfg.baseUrl || 'https://metaso.cn/api/open/v1/search').replace(/\/+$/, '');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ query, top_k: Math.min(10, Math.max(1, Number(cfg.count) || 6)) }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`秘塔搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const raw: unknown = await res.json().catch(() => { throw new Error('秘塔搜索返回了无法解析的 JSON'); });
  const data = asRecord(raw);
  const arr = Array.isArray(data.results) ? recordArray(data.results)
    : Array.isArray(data.data) ? recordArray(data.data)
    : Array.isArray(data.sources) ? recordArray(data.sources)
    : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, maxResults());
  if (!results.length) throw new Error('秘塔搜索没有返回有效结果（可能已用完免费额度或接口地址需要更新）');
  return { query, results };
}
