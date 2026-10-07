// 智谱 Web Search API（结构化结果：标题/链接/摘要/网站名/日期）。
import { getConfig } from '../../../core/config.js';
import { asRecord, recordArray } from '../record-utils.js';
import { maxResults } from '../shared.js';
import type { SearchResponse } from '../types.js';

export async function zhipuSearch(query: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch?.zhipu ?? {};
  const apiKey = String(cfg.apiKey || process.env.ZHIPU_API_KEY || '').trim();
  if (!apiKey) throw new Error('智谱搜索需要 API Key（设置里填，或环境变量 ZHIPU_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/web_search').replace(/\/+$/, '');
  const engine = String(cfg.engine || 'search_std');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ search_engine: engine, search_query: query, count }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`智谱搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const raw: unknown = await res.json().catch(() => { throw new Error('智谱搜索返回了无法解析的 JSON'); });
  const arr = recordArray(asRecord(raw).search_result);
  const results = arr
    .filter((r) => r?.link || r?.url)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.link ?? r.url ?? ''),
      snippet: String(r.content ?? r.summary ?? '').trim()
    }))
    .slice(0, maxResults());
  if (!results.length) throw new Error('智谱搜索没有返回有效结果（检查 API Key 或搜索引擎编码）');
  return { query, results };
}
