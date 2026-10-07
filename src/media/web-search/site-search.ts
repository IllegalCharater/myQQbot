// 站内搜索：抓收藏夹里那个站**自己的**搜索页，从 HTML 里解析结果。
//
// **它解决的是一条实测出来的硬限制**：`cn.bing.com` 与 `www.bing.com` 对程序化请求
// **完全忽略 `site:` 限定符** —— 带与不带的结果逐字节相同，连换一个必然被收录的站点
// （zhihu.com）也零命中。所以"只在这个站里搜"若只靠拼 `site:`，等于没限定。
// 填了站内搜索模板就直接请求那个站自己的搜索页，绕开搜索引擎。
//
// ⚠️ 抓取解析天生易碎（同 Yandex 那条）：容器类名做成配置项（`resultClass`），
// 那是页面改版时的自救通路。没配置时走通用启发式 —— 判据是"本站链接 + 有实义的文本"。
import { getConfig } from '../../core/config.js';
import { fetchBookmarkRequest, flattenJson, jsonToResults, type BookmarkSite } from './bookmark-request.js';
import { decodeNumericEntities, htmlToText as toText, siteFamily, urlKey } from './text-utils.js';
import type { SearchResponse, SearchResult } from './types.js';

/** 通用启发式下，一条结果的摘要至少要这么长，否则只当它没有摘要。 */
const SITE_RESULT_MIN_TEXT = 20;

/**
 * 把查询词填进模板。
 *
 * 用 split/join 而不是 `String.replace`：`{q}` 若在模板里出现两次也该全替换，
 * 而 `replace` 的替换串会把查询词里的 `$&`、`$1` 当特殊序列解释（查询词是模型给的，
 * 出现 `$` 完全可能，那会把查询词悄悄改掉）。
 */
export function fillSiteTemplate(template: string, query: string): string {
  return template.split('{q}').join(encodeURIComponent(query));
}

/** `htmlToText` 的别名式调用点，保持与 yandex 那段一致的可读性。 */
function textOf(input: string): string {
  return toText(input);
}

/**
 * 从站内搜索页解析结果。
 *
 * `resultClass` 有值时按它切块（更准，也是改版时的自救通路）；否则逐锚点通用启发式。
 * 通用启发式会带上一些非结果链接（导航、页脚），所以**它只是兜底**：
 * 用它时后面的条目质量会差，配 `resultClass` 才准。
 */
export function parseSiteSearch(html: string, pageUrl: string, resultClass?: string): SearchResult[] {
  const baseHost = (() => { try { return new URL(pageUrl).hostname; } catch { return ''; } })();
  const baseFamily = siteFamily(baseHost);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  /** 收一条结果；不是本站链接、认不出 URL、重复的都会被丢掉。 */
  const take = (href: string, title: string, snippet: string) => {
    const raw = decodeNumericEntities(href).replace(/&amp;/g, '&').trim();
    // **先把相对地址按结果页的 URL 解成绝对地址，再判本站**。少了这一步，
    // 站内搜索页里所有相对链接（`/wiki/X` 很常见）都会在下面 `new URL` 抛错而被丢掉 ——
    // 而这条链本身能跑通只是因为夹具/真实页面大多吐绝对链接，属于侥幸。
    let target: URL;
    try {
      target = new URL(raw, pageUrl);
    } catch {
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
    // **只收本站（同一站点家族）的链接**：站内搜索页里跨站的通常是"相关站点/广告"之类的噪声，
    // 而收藏夹的意义正是要这个站自己的内容。判据用**站点家族**而不是"宿主或它的子域" ——
    // 后者会丢掉 `search.bilibili.com` 搜出来的 `www.bilibili.com` 结果（实测：47 条全丢）。
    if (baseFamily && siteFamily(target.hostname) !== baseFamily) return;
    const url = target.toString();
    const key = urlKey(url);
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    if (!title) return;
    results.push({ title, url, snippet });
  };

  const blocks = resultClass ? splitByClass(html, resultClass) : [html];
  for (const block of blocks) {
    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(block)) !== null) {
      const href = m[1].match(/\bhref="([^"]*)"/i);
      if (!href) continue;
      const title = textOf(m[2]);
      if (!title || title.length > 200) continue;
      // 摘要：取锚点之后到下一个块级闭合标签之间的文本
      const after = block.slice(m.index + m[0].length);
      const cut = after.search(/<\/(?:li|p|div|td|h[1-6]|dd)>/i);
      const snippet = textOf(cut >= 0 ? after.slice(0, cut) : '');
      take(href[1], title, snippet.length >= SITE_RESULT_MIN_TEXT ? snippet : '');
      // 配了容器类名时，一个块只取第一条锚点当结果（块内其余锚点多半是附件/编辑链接）
      if (resultClass) break;
    }
  }
  return results;
}

/** 按类名把页面切成若干块（`<li>/<div>/...` 里 `class` 含该名字的元素的开始标签）。 */
function splitByClass(html: string, className: string): string[] {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<[a-z0-9]+\\b[^>]*\\bclass="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, 'gi');
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, i + 1 < starts.length ? starts[i + 1] : html.length));
}

/**
 * 按收藏夹取一页结果。三种形态，由配置里填了什么决定：
 *
 *   1. **请求结构**（`site.request`）—— 按方法/地址/请求头发一次请求。响应用 JSON 或
 *      HTML 两路解析。这是权威数据源（如千帆百科接口）唯一能走通的路。
 *   2. **站内搜索地址**（`site.searchUrl`）—— 去搜索页抓 HTML，从链接里解析候选。
 *   3. 两者都没有 —— 由调用方走搜索引擎的 `site:`（不进这个函数）。
 */
export async function siteSearch(site: BookmarkSite, clean: string, maxResults: number): Promise<SearchResponse> {
  // ── 形态 1：请求结构 ──
  if (site.request) {
    // 密钥不在这里单独取：它走**静态参数**（请求头里写 `Bearer {API Key}`，
    // 参数里给 `API Key` 填值），与 `{top_k}` 是同一条替换链。
    const sent = await fetchBookmarkRequest(site.request, { q: clean, params: site.params });
    if (!sent.ok) throw new Error(`请求结构调用失败（${site.key}）：${sent.error}`);
    const { response } = sent;
    if (response.kind === 'json') {
      const list = jsonToResults(response.body, maxResults, response.url);
      if (list.length) return { query: clean, results: list };
      // 没有条目列表 → 接口给的是**单个对象的资料**（如 `get_content` 的整条词条）。
      // 这时"一段压平后的资料"本身就是答案，**不是失败**：把它包成一条结果返回，
      // 否则模型会得到"这个站没有内容"的错误归因。
      //
      // 预算**每次现读配置**（`webSearch.flattenMaxChars`），改完设置即时生效。
      // 单行上限就用同一个数：意思是"整段正文都装进来、只在总预算处截断"——
      // 单行砍短会让"整篇文章"型接口只剩开头一段，而模型**不知道后面还有内容**。
      const flattenCap = flattenMaxChars();
      const flat = flattenJson(response.body, flattenCap, flattenCap);
      if (flat.trim()) {
        return { query: clean, results: [{ title: `${site.purpose || site.key}（接口返回）`, url: response.url, snippet: flat }] };
      }
      throw new Error(`请求结构返回的 JSON 里没有可用内容（${site.key}）：检查接口是否要求鉴权、或参数是否对。`);
    }
    if (response.kind === 'html') {
      const list = parseSiteSearch(response.body, response.url, site.resultClass).slice(0, maxResults);
      if (list.length) return { query: clean, results: list };
      throw new Error(`请求结构返回的是网页，但没解析出结果（${site.key}）：可在设置页填「结果容器类名」。`);
    }
    throw new Error(`请求结构返回的内容既不是 JSON 也不是网页（${site.key}，content-type: ${response.contentType || '未知'}）。`);
  }

  // ── 形态 2：站内搜索地址 ──
  const target = fillSiteTemplate(site.searchUrl as string, clean);
  const res = await fetch(target, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`站内搜索 HTTP ${res.status}（${site.host}）`);
  const results = parseSiteSearch(await res.text(), target, site.resultClass).slice(0, maxResults);
  if (!results.length) {
    // 与 Yandex 那条同一条规矩：**不返回空列表**。空列表会让模型说"这个站没有内容"，
    // 而真实原因往往是"搜索页结构变了"或"这个站要登录"——归因错了就没人去改配置。
    throw new Error(
      `站内搜索没有解析出结果（${site.host}）：该站搜索页的结构可能变了，或它要求登录。` +
      '可在设置页给这条收藏夹填「结果容器类名」，或先用 web_fetch 打开它的搜索页确认。'
    );
  }
  return { query: clean, results };
}

/**
 * 收藏夹压平"单个对象"（整条资料）时的字符预算，**可配置**（`webSearch.flattenMaxChars`）。
 *
 * 兜底 4000 只在配置缺失/非法时用（配置层已钳制过范围）。
 * 为什么不直接用 `flattenJson` 的默认参数：那个默认值（500）是按"几行结构化资料"定的，
 * 对"整篇文章"型接口会把正文砍成开头一段 —— 见 `bookmark-request.ts` 里那段注释。
 */
function flattenMaxChars(): number {
  const n = Math.round(Number(getConfig().webSearch?.flattenMaxChars));
  return Number.isFinite(n) && n >= 500 ? n : 4000;
}
