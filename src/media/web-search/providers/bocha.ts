// 博查 Web Search API（国内中文优化，网页结果在 data.webPages.value）。
import { getConfig } from '../../../core/config.js';
import { asRecord, recordArray } from '../record-utils.js';
import { maxResults } from '../shared.js';
import type { SearchResponse } from '../types.js';

export async function bochaSearch(query: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch?.bocha ?? {};
  const apiKey = String(cfg.apiKey || process.env.BOCHA_API_KEY || '').trim();
  if (!apiKey) throw new Error('博查搜索需要 API Key（设置里填，或环境变量 BOCHA_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://api.bochaai.com/v1/web-search').replace(/\/+$/, '');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query, count, freshness: 'noLimit', summary: false }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`博查搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const raw: unknown = await res.json().catch(() => { throw new Error('博查搜索返回了无法解析的 JSON'); });
  const data = asRecord(raw);
  if (data.code && Number(data.code) !== 200) {
    throw new Error(`博查搜索 API 错误（code ${data.code}）：${data.message || data.msg || '未知'}`);
  }
  const arr = recordArray(asRecord(asRecord(data.data).webPages).value);
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.name ?? r.title ?? '').trim() || '（无标题）',
      url: String(r.url ?? ''),
      snippet: String(r.snippet ?? r.summary ?? r.content ?? '').trim()
    }))
    .slice(0, maxResults());
  if (!results.length) throw new Error('博查搜索没有返回网页结果');
  return { query, results };
}
