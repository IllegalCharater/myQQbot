// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
//
// 入口有两个层次，改这条链之前先分清：
//   · `webSearch()` —— 对工具的唯一入口。负责**网页收藏夹（域名优先检索）**：名单非空时
//     并行发两发（收藏夹限定 + 普通），合并后把收藏夹命中整体上提并打 `fromBookmark` 标记。
//     名单为空时只发一发，行为与没有这个功能时逐字相同。
//   · `searchOnce()` —— 按 `webSearch.provider` 分发到具体 provider，只认一个查询词。
//     **它不认识收藏夹**，所以新增 provider 只需要接进这张分发表，不必重复实现优先逻辑。
import { getConfig } from '../core/config.js';
import { safeFetch } from './safe-fetch.js';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /**
   * 这条结果来自网页收藏夹里的站点（由 `annotateBookmarks` 在服务层标记）。
   *
   * 为什么要把"为什么它排在前面"告诉模型，而不是悄悄重排：收藏夹是我们替他做的排序，
   * 模型看不到排序依据时，会把"排第一"读成"最权威"，从而照着一条其实只是"用户常去"
   * 的站点回答。带上这个字段，它才能在需要时自己权衡。
   * 由**字段的缺席**表示"不是收藏夹结果"，与 ImageSourceResult.similarity 同一条规矩
   * （不写 false：那会让每条普通结果都多一个无信息量的键）。
   */
  fromBookmark?: true;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query: unknown): string {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing 搜索（解析 b_algo 结果块）。searchUrl 可在配置中替换（测试/换引擎）。 */
export async function bingSearch(query: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
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
    if (results.length >= maxResults) break;
  }
  return { query, results };
}

/**
 * 一次 `site:` 子句里最多放几个站点。
 *
 * 与配置层的站点上限（`MAX_BOOKMARK_SITES` = 20）是**两个数、管两件事**：那个管"名单能有多长"，
 * 这个管"单次查询串里塞几个"。不合并成一个是因为二者的正确值由不同约束决定：名单长度由
 * 用户想收藏多少决定，而查询串长度只影响这一次搜索的质量。超出部分不丢——它们仍参与
 * 结果优先级的判定（`annotateBookmarks` 用的是整份名单）。
 */
const MAX_SITES_PER_QUERY = 5;

/** 收藏夹站点命中判定用的纯宿主名集合。 */
function bookmarkSiteSet(): Set<string> {
  const list = getConfig().webSearch?.bookmarks;
  const set = new Set<string>();
  if (!Array.isArray(list)) return set;
  for (const item of list) {
    const host = String(item ?? '').toLowerCase().trim().replace(/\.$/, '');
    if (host) set.add(host);
  }
  return set;
}

/**
 * 这条结果是否落在某个收藏夹站点下。
 *
 * 用**后缀匹配 + 点边界**，不是 `includes`：否则收藏了 `a.com` 会连带把 `nota.com`
 * 也算命中（真机实测里最容易发生的一类串台：域名是别名的后缀）。
 */
function hostMatchesSet(host: string, sites: Set<string>): boolean {
  if (!host) return false;
  for (const site of sites) {
    if (host === site || host.endsWith(`.${site}`)) return true;
  }
  return false;
}

/**
 * 给结果打上「来自收藏夹站点」的标记，并把它们**整体上提到最前面**。
 *
 * 两个动作合成一件事：排序是我们做的，标记是让模型知道排序依据。只做前者会让模型把
 * "用户常去"误读成"最权威"；只做后者则收藏夹不起任何作用（这正是本轮之前的状态）。
 *
 * 顺带按规范化 URL 去重：受限查询与普通查询的**重叠部分通常是绝大多数**（收藏的站点
 * 本来就可能排在前面），不去重会让同一篇文章在结果里出现两次、白占一个名额。
 */
function annotateBookmarks(results: SearchResult[], sites: Set<string>): SearchResult[] {
  const scored = results.map((item) => ({ item, bookmark: hostMatchesSet(hostOf(item.url), sites) }));
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const pass of [true, false]) {
    for (const { item, bookmark } of scored) {
      if (bookmark !== pass) continue;
      const key = urlKey(item.url);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      out.push(bookmark ? { ...item, fromBookmark: true } : item);
    }
  }
  return out;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}

/**
 * 去重键。**规范化掉末尾斜杠与 fragment**，但保留查询串与路径——
 * `a.com/x` 与 `a.com/x#sec2` 是同一篇，而 `a.com/x` 与 `a.com/y` 不是。
 * 认不出 URL 时返回空串，调用方按"不参与去重"处理（宁可重复也不误删）。
 */
function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** 把若干站点拼成一条 `(site:a OR site:b)` 子句；没有可用站点时返回空串。 */
function siteClause(sites: string[]): string {
  const picks = sites.slice(0, MAX_SITES_PER_QUERY).map((site) => `site:${site}`);
  return picks.length ? `(${picks.join(' OR ')})` : '';
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */
export async function webSearch(query: unknown): Promise<SearchResponse> {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const cfg = getConfig().webSearch ?? {};
  const sites = cfg.bookmarkFirst === false ? new Set<string>() : bookmarkSiteSet();
  if (!sites.size) return searchOnce(clean);

  // ── 收藏夹优先检索（"域名优先"而不是"只搜收藏夹"）──
  //
  // 结构与 reverse-image-source 的 ORDER 那条链是同一种判据：**专属来源先答，答不上再
  // 问一般向兜底**。区别在于这里不能"命中即停"——收藏夹里没有对应内容时，只搜收藏夹会
  // 让整次搜索彻底落空，而模型无从知道"是站内没有"还是"搜索引擎坏了"。
  //
  // 两发**并行**：串行会让每次带收藏夹的搜索都多付一个完整往返；而"命中即停"在这里
  // 本来就不成立（我们必须拿到普通结果才能知道收藏夹有没有答上）。
  // `allSettled` 而不是 `all`：受限那一发失败（provider 不认 site: 语法等）不该把
  // 已经拿到手的普通结果一起丢掉。
  const [scoped, general] = await Promise.allSettled([
    searchOnce(`${clean} ${siteClause([...sites])}`),
    searchOnce(clean)
  ]);

  const merged: SearchResult[] = [];
  if (scoped.status === 'fulfilled') merged.push(...scoped.value.results);
  if (general.status === 'fulfilled') merged.push(...general.value.results);
  // 两发都失败时，把**普通那一发**的真实原因抛出去：受限查询是我们额外加的，
  // 用户/模型看到的原因该对应他们真正请求的那件事。
  if (!merged.length && scoped.status === 'rejected' && general.status === 'rejected') {
    throw general.reason;
  }
  return { query: clean, results: annotateBookmarks(merged, sites) };
}

/** 按配置分发到具体 provider。收藏夹逻辑在外层，这里只认"一个查询词"。 */
async function searchOnce(clean: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'bing').toLowerCase();
  if (provider === 'deepseek') return deepSeekSearch(clean);
  if (provider === 'zhipu') return zhipuSearch(clean);
  if (provider === 'bocha') return bochaSearch(clean);
  if (provider === 'baidu') return baiduSearch(clean);
  if (provider === 'metaso') return metasoSearch(clean);
  // 自定义：'custom'（旧单槽位）或 'custom:<id>'（设置页添加的多个之一）
  if (provider === 'custom' || provider.startsWith('custom:')) {
    return customSearch(clean, provider);
  }
  return bingSearch(clean);
}

/**
 * DeepSeek 服务端原生搜索（Responses API，web_search 工具）。
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/responses_api
 * 说明：搜索在 DeepSeek 服务端完成并注入上下文，客户端能拿到的是模型基于
 * 搜索结果生成的最终回答；URL/标题/摘要为黑盒，拿不到结构化来源。适合
 * “只要能搜到并总结”的场景；需要引用列表时请用 Bing / 其他搜索 API。
 */
export async function deepSeekSearch(query: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch?.deepseek ?? {};
  const apiKey = String(cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DeepSeek 搜索需要 API Key（设置里填，或环境变量 DEEPSEEK_API_KEY）');
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com/responses').replace(/\/+$/, '');
  const model = String(cfg.model || 'deepseek-v4-flash');

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: `请联网搜索并回答（用中文，简洁、只给结论和关键信息）：${query}`,
      tools: [{ type: 'web_search' }],
      stream: false
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 60000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek 搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const raw: unknown = await res.json().catch(() => { throw new Error('DeepSeek 搜索返回了无法解析的 JSON'); });
  const data = asRecord(raw);
  const outputText = String(data.output_text ?? '').trim();
  if (!outputText) {
    // 兼容不同字段位置
    const message = recordArray(data.output).find((item) => item.type === 'message' && recordArray(item.content).length);
    const alt = message ? recordArray(message.content).map((content) => String(content.text ?? '')).join('') : '';
    if (!alt) throw new Error('DeepSeek 搜索没有返回文本（可能是模型不支持 web_search 工具）');
    return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: alt }] };
  }
  return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: outputText }] };
}

/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。 */
export async function webFetch(url: unknown) {
  const result = await safeFetch(url);
  return result;
}

/** 智谱 Web Search API（结构化结果：标题/链接/摘要/网站名/日期）。 */
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
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('智谱搜索没有返回有效结果（检查 API Key 或搜索引擎编码）');
  return { query, results };
}

/** 博查 Web Search API（国内中文优化，网页结果在 data.webPages.value）。 */
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
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('博查搜索没有返回网页结果');
  return { query, results };
}

/** 百度千帆 AI Search（web_search，返回 references）。 */
export async function baiduSearch(query: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch?.baidu ?? {};
  const apiKey = String(cfg.apiKey || process.env.BAIDU_SEARCH_API_KEY || '').trim();
  if (!apiKey) throw new Error('百度搜索需要 API Key（设置里填，或环境变量 BAIDU_SEARCH_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://qianfan.baidubce.com/v2/ai_search/web_search').replace(/\/+$/, '');
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: query }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: topK }]
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`百度搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const raw: unknown = await res.json().catch(() => { throw new Error('百度搜索返回了无法解析的 JSON'); });
  const data = asRecord(raw);
  if (data.error_code && Number(data.error_code) !== 0) {
    throw new Error(`百度搜索 API 错误（code ${data.error_code}）：${data.error_msg || data.message || '未知'}`);
  }
  const arr = recordArray(data.references);
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('百度搜索没有返回有效结果');
  return { query, results };
}

/** 秘塔 AI 搜索（metaso.cn，每天 100 次免费）。 */
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
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('秘塔搜索没有返回有效结果（可能已用完免费额度或接口地址需要更新）');
  return { query, results };
}

/**
 * 解析自定义搜索配置。
 * providerId 形如 'custom:abc123' 时从 webSearch.providers 数组里取对应项；
 * 否则退回旧的单槽位 webSearch.custom（兼容早期配置）。
 */
function resolveCustomConfig(providerId: string | null = null): Record<string, unknown> {
  const ws = getConfig().webSearch ?? {};
  if (providerId && String(providerId).startsWith('custom:')) {
    const id = String(providerId).slice('custom:'.length);
    const found = recordArray(ws.providers).find((provider) => String(provider.id) === id);
    if (found) return found;
    // 列表里找不到 → 回退单槽位，避免配置丢失后完全搜不了
  }
  return asRecord(ws.custom);
}

/**
 * 用户自定义的搜索服务（provider = 'custom' 或 'custom:<id>'）。
 *
 * 两种类型：
 *   - 'openai'：POST 一个 JSON 搜索接口。为兼容各家实现，会尝试多种常见请求体字段
 *     （query / q / messages）与响应结构（results / data / sources / references / webPages）。
 *     适合 SearXNG、Tavily、自建聚合搜索等。
 *   - 'bing'：GET 一个搜索页并用 b_algo 块解析（兼容 Bing 结果格式的引擎，如部分 SearXNG 实例）。
 */
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
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) {
    throw new Error('自定义搜索没有返回可识别的结果（请检查接口返回是否包含 results/data/sources 等数组，或改用 bing 类型抓页面）');
  }
  return { query, results };
}

/** 用指定 URL 跑一次 Bing 结果的 HTML 解析（供自定义 bing 类型复用）。 */
async function bingSearchWithUrl(query: string, searchUrl: string): Promise<SearchResponse> {
  const cfg = getConfig().webSearch ?? {};
  const url = String(searchUrl || cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const target = new URL(url);
  target.searchParams.set('q', query);
  const res = await fetch(target, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`自定义搜索（bing 类型）HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error('自定义搜索（bing 类型）没有解析到结果，请确认该引擎返回 b_algo 结构');
  return { query, results };
}
