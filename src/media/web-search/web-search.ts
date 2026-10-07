// 联网搜索的统一入口。
//
// 入口有两个层次，改这条链之前先分清：
//   · `webSearch()` —— 对工具的唯一入口。负责**网页收藏夹（域名优先检索）**：名单非空时
//     并行发两发（收藏夹限定 + 普通），合并后把收藏夹命中整体上提并打 `fromBookmark` 标记。
//     名单为空时只发一发，行为与没有这个功能时逐字相同。
//   · `searchOnce()` —— 按 `webSearch.provider` 分发到具体 provider，只认一个查询词。
//     **它不认识收藏夹**，所以新增 provider 只需要接进这张分发表，不必重复实现优先逻辑。
import { getConfig } from '../../core/config.js';
import { safeFetch } from '../safe-fetch.js';
import { annotateBookmarks, bookmarkList, bookmarkPreference, resolveBookmarkSite, siteClause } from './bookmarks.js';
import { sanitizeQuery } from './query.js';
import { maxResults } from './shared.js';
import { siteSearch } from './site-search.js';
import { baiduSearch } from './providers/baidu.js';
import { bingSearch } from './providers/bing.js';
import { bochaSearch } from './providers/bocha.js';
import { customSearch } from './providers/custom.js';
import { deepSeekSearch } from './providers/deepseek.js';
import { metasoSearch } from './providers/metaso.js';
import { yandexSearch } from './providers/yandex.js';
import { zhipuSearch } from './providers/zhipu.js';
import type { SearchResponse, SearchResult } from './types.js';

/**
 * 给工具用的统一入口。
 *
 * `site` 由**模型**给出，值是收藏夹里的**枚举值**（不是域名）。照 reverse-image-source 的
 * `intent` 那一套：模型判断该用哪条路，代码只负责查表、校验与路由，不替模型做默认决定。
 * 三种形态：
 *   · `site` 有值   → 查表得到站点，在该站点内检索；
 *   · `site` 无值   → 走全网；若管理员仍是"收藏夹优先"模式，则按关键字先问收藏夹再补全网
 *                     （旧行为，`bookmarkMode: 'web'` 可关掉）；
 *   · 名单为空      → 一次额外请求都不发，行为与没有这个功能时逐字相同。
 */
export async function webSearch(query: unknown, site?: unknown): Promise<SearchResponse> {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const all = bookmarkList();
  const sites = new Set(all.map((item) => item.host));
  const limit = maxResults();

  // ── 模型点了名 ──
  if (site !== undefined && site !== null && String(site).trim() !== '') {
    const picked = resolveBookmarkSite(site);
    // 填了**站内搜索模板**或**请求结构**，就直接去那个站取内容：这是唯一能真正
    // "只在这个站里搜"的办法（实测搜索引擎对程序化请求会忽略 `site:`）。
    // ⚠️ `request` 必须算在这里 —— 只配了请求结构（典型的 JSON 接口书签，如千帆百科）
    // 而没填搜索地址时，漏判会让它**掉进下面的 `site:` 分支**：于是请求结构根本不被执行，
    // 用户看到的是真实搜索引擎的结果，而配置页看起来配好了（**实测踩到**）。
    if (picked.searchUrl || picked.request) return siteSearch(picked, clean, limit);
    return mergeScoped(clean, [picked.host], sites);
  }

  // ── 模型没点名 ──
  if (!sites.size || bookmarkPreference() === 'web') return searchOnce(clean);
  return mergeScoped(clean, all.map((item) => item.host), sites);
}

/**
 * 「受限那一发 + 全网那一发」的并集，收藏夹命中排最前。
 *
 * 结构与 reverse-image-source 的 ORDER 那条链是同一种判据（专属来源先答、一般向兜底），
 * 但**不能命中即停**：站内没有对应内容时，只搜站内会让整次搜索彻底落空，而模型无从分辨
 * "站内没有"与"搜索引擎坏了"。两发**并行**：串行会让每次多付一个完整往返，而"命中即停"
 * 在这里本来就不成立（必须拿到两边才知道站内有没有答上）。
 * `allSettled` 而不是 `all`：受限那发失败（provider 不认 site: 语法等）不该把已经拿到手的
 * 普通结果一起丢掉；两发都失败时抛**普通那一发**的原因 —— 受限查询是我们额外加的，
 * 报错该对应调用方真正请求的那件事。
 */
async function mergeScoped(clean: string, scopedSites: string[], allSites: Set<string>): Promise<SearchResponse> {
  const [scoped, general] = await Promise.allSettled([
    searchOnce(`${clean} ${siteClause(scopedSites)}`),
    searchOnce(clean)
  ]);
  const merged: SearchResult[] = [];
  if (scoped.status === 'fulfilled') merged.push(...scoped.value.results);
  if (general.status === 'fulfilled') merged.push(...general.value.results);
  if (!merged.length && scoped.status === 'rejected' && general.status === 'rejected') {
    throw general.reason;
  }
  // 标注用**整份**名单：模型点了 A 站、结果里出现 B 站（收藏夹里的另一个）时也该标出来。
  return { query: clean, results: annotateBookmarks(merged, allSites) };
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
  if (provider === 'yandex') return yandexSearch(clean);
  // 自定义：'custom'（旧单槽位）或 'custom:<id>'（设置页添加的多个之一）
  if (provider === 'custom' || provider.startsWith('custom:')) {
    return customSearch(clean, provider);
  }
  return bingSearch(clean);
}

/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。 */
export async function webFetch(url: unknown) {
  const result = await safeFetch(url);
  return result;
}
