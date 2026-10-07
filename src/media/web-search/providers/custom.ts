// 用户自定义的搜索服务（provider = 'custom' 或 'custom:<id>'）。
//
// 两种类型：
//   - 'openai'：POST 一个 JSON 搜索接口。为兼容各家实现，会尝试多种常见请求体字段
//     （query / q / messages）与响应结构（results / data / sources / references / webPages）。
//     适合 SearXNG、Tavily、自建聚合搜索等。
//   - 'bing'：GET 一个搜索页并用 b_algo 块解析（兼容 Bing 结果格式的引擎，如部分 SearXNG 实例）。
import { asRecord, recordArray } from '../record-utils.js';
import { maxResults, resolveCustomConfig } from '../shared.js';
import { bingSearchWithUrl } from './bing.js';
import type { SearchResponse } from '../types.js';

export async function customSearch(query: string, providerId: string | null = null): Promise<SearchResponse> {
  const cfg = resolveCustomConfig(providerId);
  const type = String(cfg.type || 'openai').toLowerCase();

  if (type === 'bing') {
    return bingSearchWithUrl(query, String(cfg.baseUrl || ''));
  }

  const endpoint = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('自定义搜索未配置接口地址（设置 → 模型 API → 搜索提供方 → 自定义）');
  const apiKey = String(cfg.apiKey || '').trim();
  const model = String(cfg.model || '').trim();
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  // 兼容多种请求体：优先 query / q，带 model 时额外附上 messages（Responses API 风格）
  const body: Record<string, unknown> = { query, q: query, top_k: topK, count: topK };
  if (model) {
    body.model = model;
    body.messages = [{ role: 'user', content: query }];
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`自定义搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const raw: unknown = await res.json().catch(() => { throw new Error('自定义搜索返回了无法解析的 JSON'); });
  const data = asRecord(raw);

  // 兜住各家字段名
  const arr = Array.isArray(data.results) ? recordArray(data.results)
    : Array.isArray(data.data) ? recordArray(data.data)
    : Array.isArray(data.sources) ? recordArray(data.sources)
    : Array.isArray(data.references) ? recordArray(data.references)
    : Array.isArray(asRecord(data.webPages).value) ? recordArray(asRecord(data.webPages).value)
    : Array.isArray(raw) ? recordArray(raw)
    : [];

  const results = arr
    .filter((r) => r && (r.url || r.link))
    .map((r) => ({
      title: String(r.title ?? r.name ?? r.headline ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? r.body ?? '').trim()
    }))
    .slice(0, maxResults());
  if (!results.length) {
    throw new Error('自定义搜索没有返回可识别的结果（请检查接口返回是否包含 results/data/sources 等数组，或改用 bing 类型抓页面）');
  }
  return { query, results };
}
