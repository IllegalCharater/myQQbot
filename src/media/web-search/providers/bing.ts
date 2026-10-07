// Bing 网页解析（默认 provider，无需 API key）。
//
// ⚠️ `bingSearch` 与 `bingSearchWithUrl` **共用同一段 b_algo 解析**是刻意的：前者读
// `webSearch.searchUrl`，后者用自定义 provider 自己的地址。两份解析必然漂移，而症状是
// "默认 Bing 能搜到、自定义 bing 类型搜不到"（或反过来）—— 那种不一致没人会去核对。
import { getConfig } from '../../../core/config.js';
import { decodeHtml } from '../text-utils.js';
import { maxResults } from '../shared.js';
import type { SearchResponse, SearchResult } from '../types.js';

/** 浏览器 UA + 中文偏好：Bing 对没有 UA 的请求会直接给一页空结果。 */
const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'zh-CN,zh;q=0.9'
};

/** 用指定地址跑一次 Bing 结果页的 HTML 解析。 */
async function searchBingHtml(query: string, searchUrl: string): Promise<SearchResult[]> {
  const target = new URL(searchUrl);
  target.searchParams.set('q', query);
  const res = await fetch(target, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  const limit = maxResults();
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= limit) break;
  }
  return results;
}

/** Bing 搜索（解析 b_algo 结果块）。searchUrl 可在配置中替换（测试/换引擎）。 */
export async function bingSearch(query: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  return { query, results: await searchBingHtml(query, searchUrl) };
}

/**
 * 用指定 URL 跑一次 Bing 结果的 HTML 解析（供自定义 bing 类型复用）。
 *
 * 与 `bingSearch` 的唯一区别：**地址从参数来**，且"一条都没解析到"要**报错**而不是返回
 * 空列表。默认 Bing 那条路保持着历史上的宽松行为（返回空列表），改它等于改已有行为。
 */
export async function bingSearchWithUrl(query: string, searchUrl: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch ?? {};
  const url = String(searchUrl || cfg.searchUrl || 'https://cn.bing.com/search');
  const results = await searchBingHtml(query, url);
  if (!results.length) throw new Error('自定义搜索（bing 类型）没有解析到结果，请确认该引擎返回 b_algo 结构');
  return { query, results };
}
