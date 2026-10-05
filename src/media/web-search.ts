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

/**
 * 数字实体解码（`&#39;` / `&#x27;`）—— 只给 Yandex 的 HTML 用。
 *
 * 为什么不并进 `decodeHtml`：那个是 Bing 路径在用的，改它等于改一条**已有行为**的解析
 * （Bing 的摘要里出现字面量 `&#x27;` 的概率不为零），而这次没有要修 Bing 的需求。
 * Yandex 的 HTML 里数字实体很常见（标题与摘要都过一遍转义），不解会把 `&#x27;`
 * 原样喂给模型。保持两条路径各自独立，先不动既有的那条。
 */
function decodeNumericEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _m;
    });
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
  const set = new Set<string>();
  for (const item of bookmarkList()) set.add(item.host);
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

// ── Yandex 网页解析 ──────────────────────────────────────────────────────
//
// ⚠️ **这条路是"抓公开 HTML 页"，与官方付费 API 无关**，而抓取天生易碎：
//   · Yandex 的类名是压缩混淆过的，且会变。SearXNG 的 yandex 引擎就是这么烂掉的
//     ——它 2021 年被整个**删除**（删除前已在 settings.yml 里 `disabled: True`），
//     留下的选择器是更早一代的 `b-serp-item__*` 标记。所以**不要**把选择器当成
//     可信常量：它们做成配置项（`webSearch.yandex.serpClass/urlClass/titleClass/
//     textClass`），改版时用户能自己在设置页救回来，而不必等一次发版。
//   · 被拦是常态而非异常。`/showcaptcha` 是**可机检**的信号（SearXNG 同样是靠
//     `resp.url.path.startswith('/showcaptcha')` 判的），命中时我们抛一句能读懂的话，
//     而不是返回空列表 —— 后者会让模型说"没搜到"，把"被拦了"误导成"这个事实不存在"。
//
// 默认值取自可考证的两代标记，取**交集**里最稳的那部分：
//   容器 `serp-item` —— 2016 一代与 2021 一代都用它，是唯一贯穿两代的锚点；
//   标题 `OrganicTitle` —— 新版的标题锚点，配 `organic__url` 的兜底；
//   正文 `OrganicText` / `organic__text` —— 新版摘要，配旧版 `text-container`。
// **这些默认值没有在真机上验证过**（本机无法访问 yandex.com），夹具用的是按上述
// 形状手写的 HTML。首次真机运行若报"没有解析到结果"，就是选择器对不上当前页面。

const YANDEX_DEFAULTS = {
  baseUrl: 'https://yandex.com/search/',
  serpClass: 'serp-item',
  urlClass: 'organic__url',
  titleClass: 'OrganicTitle',
  textClass: 'OrganicText'
} as const;

/** 读 Yandex 配置；缺项回落默认值，空白串也当缺项。 */
function yandexConfig(): Record<string, string> {
  const raw = (getConfig().webSearch as Record<string, unknown> | undefined)?.yandex;
  const cfg = isRecord(raw) ? raw : {};
  const pick = (key: keyof typeof YANDEX_DEFAULTS): string =>
    String(cfg[key] ?? '').trim() || YANDEX_DEFAULTS[key];
  return {
    baseUrl: pick('baseUrl'),
    serpClass: pick('serpClass'),
    urlClass: pick('urlClass'),
    titleClass: pick('titleClass'),
    textClass: pick('textClass')
  };
}

/** 把 HTML 里的属性值/元素内容解出可读文本（实体 → 文本、标签剥掉、空白折叠）。 */
function htmlToText(input: string): string {
  return decodeHtml(decodeNumericEntities(input));
}

/**
 * 从 Yandex 的跳转包装里取真实 URL。
 *
 * Yandex 的标题链接通常不是目标地址本身，而是 `…/redir?url=<编码后的地址>` 或
 * `yabs.yandex.ru/count/…` 这类计费跳转。**不解析它就没有可用的链接**（模型会拿到
 * 一个 yandex.ru 的跳转地址，`web_fetch` 抓到的是跳转页而不是正文）。
 * 解不出来时**宁可丢掉这条**也不把跳转地址当结果 —— 那会让模型读到错的内容。
 */
function resolveYandexUrl(href: string): string {
  const raw = decodeNumericEntities(href).replace(/&amp;/g, '&').trim();
  if (!raw) return '';
  const candidates: string[] = [];
  // 1) 包在查询参数里的目标地址（redir / count / clck 都用 url= 或 text=）
  for (const key of ['url', 'text', 'target']) {
    const m = raw.match(new RegExp(`[?&]${key}=([^&]+)`, 'i'));
    if (m) candidates.push(m[1]);
  }
  // 2) 本身就是绝对地址
  if (/^https?:\/\//i.test(raw)) candidates.push(raw);
  for (const candidate of candidates) {
    let decoded = candidate;
    try { decoded = decodeURIComponent(candidate); } catch { /* 保持原样 */ }
    if (/^https?:\/\//i.test(decoded)) return decoded;
  }
  return '';
}

/**
 * 从一段 HTML 里按类名取第一个元素的**属性值**或**文本**。
 *
 * 这是一个刻意写窄的提取器（不是通用 HTML 解析器）：只支持"按 class 找元素、
 * 取某个属性或取innerHtml"，够用即可，不引入依赖。**已知边界**：不处理同名类出现在
 * 属性串中间（如 `class="x serp-item y"` 能认，`data-serp-item=` 不认，因为要求
 * `class` 字样紧邻），也不做嵌套配对 —— 所以调用方都只取第一个匹配。
 */
function findClassBlock(html: string, className: string): string | null {
  if (!className) return null;
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // class 属性里含这个名字（允许前后有别的类名），且停在标签结束
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bclass="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, 'i');
  const m = re.exec(html);
  return m ? m[0] : null;
}

/** 取某个类名元素的某个属性值。 */
function attrOfClass(html: string, className: string, attr: string): string {
  const tag = findClassBlock(html, className);
  if (!tag) return '';
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = tag.match(new RegExp(`\\b${escaped}="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

/**
 * 扫描 HTML，按类名收集"一组同构块"（每个元素从它的开始标签起、到同标签名的下一个
 * 元素或文本上限为止）。用于把整页切成一条条结果。
 */
function splitBlocks(html: string, className: string): string[] {
  if (!className) return [];
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<li\\b[^>]*\\bclass="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, 'gi');
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, i + 1 < starts.length ? starts[i + 1] : html.length));
}

/**
 * 这条解析出来的地址是不是 Yandex 自家站点。
 *
 * 搜索结果里混着大量站内入口（图片/视频/地图/服务导航），它们**不是检索结果**：
 * 交给模型只会让它拿一个 yandex.com 的页面当"来源"。判据用 `yandex.<tld>` 与
 * `*.yandex.<tld>`，外加 yandex 自有的跳转域名。刻意只认 `yandex.` 前缀而不是
 * 整个 `*.ru`，避免顺手误杀正常的俄语站点。
 */
function isYandexHost(host: string): boolean {
  const h = host.toLowerCase();
  return /(^|\.)yandex\.[a-z]{2,}$/.test(h) || /(^|\.)yastatic\.net$/.test(h) || /(^|\.)yandex\.net$/.test(h);
}

/**
 * 取某个类名元素**标签内**的文本（元素自己的文字，不含子元素）。
 *
 * ⚠️ 两条边界，都是实测踩出来的（写成 `block.indexOf(tag)` 时 tag 为空串会退化成
 * `indexOf('') === 0`，于是从块首开始找第一个闭合标签、切出一个空串 —— 表现为
 * "某条结果静默消失"而不是报错）：
 *   ① `tag` 为空（类名没找到）时**直接返回空串**，让调用方走兜底；
 *   ② 找不到闭合标签时返回空串，不要把整块剩余内容当成标题。
 */
function textOfTag(block: string, tag: string | null): string {
  if (!tag) return '';
  const at = block.indexOf(tag);
  if (at < 0) return '';
  const after = block.slice(at + tag.length);
  const close = after.search(/<\/[a-z0-9]+>/i);
  return close >= 0 ? htmlToText(after.slice(0, close)) : '';
}

/** 抓取并解析 Yandex 结果页（`baseUrl` 可换 yandex.ru 等镜像）。 */
export async function yandexSearch(query: string): Promise<SearchResponse> {
  const cfg = yandexConfig();
  const maxResults = Math.max(1, Math.min(10, Number(getConfig().webSearch?.maxResults) || 6));
  const url = new URL(cfg.baseUrl);
  url.searchParams.set('text', query);

  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(15000),
    // Yandex 会按重定向把人送去 /showcaptcha，必须能看到最终落点才判得了"被拦"
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`Yandex 搜索 HTTP ${res.status}`);

  const finalPath = (() => { try { return new URL(res.url).pathname; } catch { return ''; } })();
  const html = await res.text();
  // 被拦的两种形态都要认：重定向到 /showcaptcha，或 200 但正文就是验证码页
  if (finalPath.startsWith('/showcaptcha') || /class="[^"]*\bcaptcha\b/i.test(html)) {
    throw new Error('Yandex 要求人机验证（CAPTCHA），这次抓取被拦截。换个搜索提供方，或稍后重试。');
  }

  const results: SearchResult[] = [];
  for (const block of splitBlocks(html, cfg.serpClass)) {
    // 标题锚点的 href：优先 organic__url，退回块内第一个外链锚点
    let href = attrOfClass(block, cfg.urlClass, 'href');
    if (!href) {
      const anyLink = block.match(/<a\b[^>]*\bhref="([^"]+)"/i);
      href = anyLink ? anyLink[1] : '';
    }
    const target = resolveYandexUrl(href);
    if (!target) continue;
    // 站内入口不是检索结果：过滤掉，只留外部站点
    try { if (isYandexHost(new URL(target).hostname)) continue; } catch { continue; }

    // 标题文本：先按标题类名取，取不到时退回链接类名元素的文本，再退回块内第一个
    // 锚点的文本。**逐级兜底而不是取了就算**：标题类名对不上时，若直接放弃这一条，
    // 表现就是"结果静默变少"——比报错更难发现（实测：三条只剩一条）。
    const titleTag = findClassBlock(block, cfg.titleClass) || findClassBlock(block, cfg.urlClass);
    let title = textOfTag(block, titleTag);
    if (!title) {
      const anchor = block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
      if (anchor) title = htmlToText(anchor[1]);
    }
    if (!title) continue;

    // 摘要：新版 OrganicText，旧版回退 organic__text；都没有就留空（摘要不是必需的）
    const snippet = textOfTag(block, findClassBlock(block, cfg.textClass) || findClassBlock(block, 'organic__text'));

    results.push({ title, url: target, snippet });
    if (results.length >= maxResults) break;
  }

  if (!results.length) {
    // 两条"没解析到"的成因不同，文案必须分开，否则用户不知道该改哪一栏：
    //   · 容器一个都没命中 → 页面结构整个变了（或搜索页地址填错）；
    //   · 容器命中了但一条都没凑齐链接/标题 → 是**标题锚点类名**对不上。
    // 合并成一句"没解析到"会把后一种说成前一种，用户就会去改容器类名（改也没用）。
    const containerFound = splitBlocks(html, cfg.serpClass).length > 0;
    if (containerFound) {
      throw new Error(
        `Yandex 找到了结果容器「${cfg.serpClass}」，但没有一条能解析出链接与标题。` +
        `多半是「标题锚点类名」（当前「${cfg.titleClass}」）或「链接类名」（当前「${cfg.urlClass}」）对不上，可在设置页调整。`
      );
    }
    throw new Error(
      `Yandex 没有解析到结果（容器类名「${cfg.serpClass}」一条都没命中）。` +
      '多半是 Yandex 改了页面结构，可在设置页调整「结果容器类名」等选择器。'
    );
  }
  return { query, results };
}

/** 收藏夹优先模式（只影响"模型没说搜哪个站点"时的默认行为）。 */
export type BookmarkMode = 'prefer' | 'web';

/** 读收藏夹优先模式。`bookmarkFirst === false` 视为 'web'，缺省视为 'prefer'（兼容迁移）。 */
function bookmarkPreference(): BookmarkMode {
  const cfg = getConfig().webSearch as Record<string, unknown> | undefined;
  if (cfg?.bookmarkMode === 'web') return 'web';
  return cfg?.bookmarkFirst === false ? 'web' : 'prefer';
}

/** 收藏夹站点（已归一）。前四项都在：枚举值、宿主名、用途；后两项可选。 */
export interface BookmarkSite {
  /** 枚举值，**模型在 `web_search.site` 里传的就是它**。 */
  key: string;
  /** 从 URL 归一出来的宿主名。没有站内搜索模板时用它拼 `site:`。 */
  host: string;
  /** 用途，给模型判断"该选哪一条"用。 */
  purpose: string;
  /** 站内搜索地址模板（含 `{q}`）。填了就**直接去站内搜**，绕开搜索引擎的 `site:`。 */
  searchUrl?: string;
  /** 站内搜索页里"每条结果容器"的类名；留空走通用启发式。 */
  resultClass?: string;
}

/**
 * 读收藏夹名单（顺序稳定）。
 *
 * 归一只在配置层做（`core/config.ts` 的 `normalizeConfigShape`），这里**不再清洗**——
 * 两边各写一份规则必然漂移，而漂移的表现是"设置页看到的"与"实际参与检索的"不是同一份。
 * 这里只做一次防御性的形状过滤（配置可能来自夹具或未过 `loadConfig` 的路径）。
 */
export function bookmarkList(): BookmarkSite[] {
  const list = getConfig().webSearch?.bookmarks;
  if (!Array.isArray(list)) return [];
  const out: BookmarkSite[] = [];
  // 循环变量显式标成 unknown：配置的静态类型已经保证这里是对象数组，直接用 `isRecord`
  // 会被 TS 收窄成 `never`（"已确定是对象，再判一次必然是假"）。而这道守卫仍有价值——
  // 配置可能来自测试夹具或任何未过 `loadConfig` 的路径。
  for (const raw of list as unknown[]) {
    if (!isRecord(raw)) continue;
    const key = String(raw.key ?? '').trim();
    const host = String(raw.url ?? '').trim().toLowerCase();
    if (!key || !host) continue;
    const entry: BookmarkSite = { key, host, purpose: String(raw.purpose ?? '').trim() };
    const searchUrl = String(raw.searchUrl ?? '').trim();
    // 形状检查在这里再做一次（配置层已经做过）：调用方可能来自夹具或未过 `loadConfig`
    // 的路径，而一个缺 `{q}` 的模板会让请求打到搜索页首页、返回"文不对题"的结果
    // 而不是报错 —— 那种失败比直接拒掉难查得多。
    if (searchUrl && /^https?:\/\//i.test(searchUrl) && searchUrl.includes('{q}')) entry.searchUrl = searchUrl;
    const resultClass = String(raw.resultClass ?? '').trim();
    if (resultClass) entry.resultClass = resultClass;
    out.push(entry);
  }
  return out;
}

/**
 * 模型给的枚举值 → 收藏夹条目；不在名单里就抛一句可执行的话。
 *
 * **为什么必须校验而不是直接把值拼进查询串**：`site:` 的值会进搜索引擎，一个模型凭空
 * 写出的值会静默地搜出一个空结果 —— 看起来像"这个站没有内容"，实际是"它从来不在名单里"。
 * 报错把**可选枚举值连同用途**一起带回去，模型下一轮就能改对（本仓库那条"把真实原因
 * 返回给模型，而不是替它编一个结果"）。
 */
export function resolveBookmarkSite(raw: unknown): BookmarkSite {
  const asked = String(raw ?? '').trim();
  if (!asked) throw new Error('site 为空');
  const list = bookmarkList();
  if (!list.length) {
    throw new Error('管理员还没有配置任何网页收藏夹站点，无法指定 site；请不带 site 直接做全网搜索');
  }
  // 精确匹配枚举值。**不做大小写归一**：枚举值是配置里逐字写明的标识符，
  // 宽容匹配会让"模型传了 wiki、配置里是 Wiki"这类不一致被掩盖过去。
  const hit = list.find((item) => item.key === asked);
  if (hit) return hit;
  const options = list.map((item) => (item.purpose ? `${item.key}（${item.purpose}）` : item.key)).join('、');
  throw new Error(`收藏夹里没有枚举值「${asked}」。可选的只有：${options}。请改用其中之一，或不要传 site 直接做全网搜索`);
}

// ── 站内搜索（收藏夹填了 searchUrl 时走这条路）────────────────────────────
//
// **它解决的是一条实测出来的硬限制**：`cn.bing.com` 与 `www.bing.com` 对程序化请求
// **完全忽略 `site:` 限定符** —— 带与不带的结果逐字节相同，连换一个必然被收录的站点
// （zhihu.com）也零命中。所以"只在这个站里搜"若只靠拼 `site:`，等于没限定。
// 填了站内搜索模板就直接请求那个站自己的搜索页，绕开搜索引擎。
//
// ⚠️ 抓取解析天生易碎（同 Yandex 那条）：容器类名做成配置项（`resultClass`），
// 那是页面改版时的自救通路。没配置时走通用启发式 —— 判据是"本站链接 + 有实义的文本"。

/** 通用启发式下，一条结果的摘要至少要这么长，否则只当它没有摘要。 */
const SITE_RESULT_MIN_TEXT = 20;

/**
 * 把查询词填进站内搜索模板。
 *
 * 用 split/join 而不是 `String.replace`：`{q}` 若在模板里出现两次也该全替换，
 * 而 `replace` 的替换串会把查询词里的 `$&`、`$1` 当特殊序列解释（查询词是模型给的，
 * 出现 `$` 完全可能，那会把查询词悄悄改掉）。
 */
function fillSiteTemplate(template: string, query: string): string {
  return template.split('{q}').join(encodeURIComponent(query));
}

/** `htmlToText` 的别名式调用点，保持与 yandex 那段一致的可读性。 */
function textOf(input: string): string {
  return htmlToText(input);
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
    // **只收本站链接**：站内搜索页里跨站的通常是"相关站点/广告"之类的噪声，
    // 而收藏夹的意义正是要这个站自己的内容。
    if (baseHost && !(target.hostname === baseHost || target.hostname.endsWith(`.${baseHost}`))) return;
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

/** 按站内搜索模板取结果（模板的合法性已由 `bookmarkList()` 过滤保证）。 */
async function siteSearch(site: BookmarkSite, clean: string, maxResults: number): Promise<SearchResponse> {
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
 * 给工具用的统一入口。
 *
 * `site` 由**模型**给出，值是收藏夹里的**枚举值**（不是域名）。照 reverse-image-source 的
 * `intent` 那一套：模型判断该用哪条路，代码只负责查表、校验与路由，不替模型做默认决定。
 * 三种形态：
 *   · `site` 有值   → 查表得到站点，在该站点内检索，外部结果只作补充、该站命中排最前；
 *   · `site` 无值   → 走全网；若管理员仍是"收藏夹优先"模式，则按关键字先问收藏夹再补全网
 *                     （旧行为，`bookmarkMode: 'web'` 可关掉）；
 *   · 名单为空      → 一次额外请求都不发，行为与没有这个功能时逐字相同。
 */
export async function webSearch(query: unknown, site?: unknown): Promise<SearchResponse> {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const all = bookmarkList();
  const sites = new Set(all.map((item) => item.host));
  const maxResults = Math.max(1, Math.min(10, Number(getConfig().webSearch?.maxResults) || 6));

  // ── 模型点了名 ──
  if (site !== undefined && site !== null && String(site).trim() !== '') {
    const picked = resolveBookmarkSite(site);
    // 填了站内搜索模板就**直接去那个站搜**：这是唯一能真正"只在这个站里搜"的办法
    // （实测搜索引擎对程序化请求会忽略 `site:`）。没填才退回旧的 `site:` 路径。
    if (picked.searchUrl) return siteSearch(picked, clean, maxResults);
    return mergeScoped(clean, [picked.host], sites);
  }

  // ── 模型没点名 ──
  if (!sites.size || bookmarkPreference() === 'web') return searchOnce(clean);
  return mergeScoped(clean, all.map((item) => item.host), sites);
}

// ── 站内搜索地址的自动探测（设置页那个「自动检测」按钮的后端）────────────
//
// **它必须用对照查询，不能只看"有没有解析出结果"**：真实搜索页里满是导航/页脚链接，
// 通用启发式会把它们当结果。实测：GitHub 的结果页用真查询解析出 124 条、用乱串解析出
// 66 条（全是导航），**只看真查询就会把一个只有噪声的模板判成可用**。所以判据是
// "真查询的条数要明显多于乱串查询"——JS 渲染的站点两边一样多（MDN 实测 15 vs 15），
// 于是被正确拒掉。
//
// 已知边界（写在这里免得下次误以为是 bug）：**带结果容器类名的候选只做真查询**，
// 不跑对照。因为稀有类名本身就是强证据（实测 GitHub 的 `search-title` 真查询命中 10 条、
// 乱串命中 0 条），而"每个候选都跑两次"会把 12 次请求变成 24 次。

/** 探测用的"必然搜不到"的乱串：真查询的条数要明显多于它，才算这个模板真的在出结果。 */
const PROBE_JUNK_QUERY = 'zzqxvbnmklpoiuytrewqqzxcv';

/** 探测用的真查询。选一个**几乎任何站点都该有结果**的通用词，避免"该站确实没这个内容"。 */
const PROBE_QUERY = 'test';

/**
 * 候选结果容器类名。都来自真机观察，不是猜的：
 *   · `mw-search-result` —— MediaWiki 的 Special:Search；
 *   · `b_algo`           —— Bing 的结果块（注意：反爬时 Bing 会把结果标记整个去掉，
 *                           实测同一个模板有时 9 条、有时 0 条 —— 所以它只是候选，不是保证）；
 *   · `search-title`     —— GitHub 搜索；
 *   · `fps-result`       —— Discourse 论坛。
 */
const PROBE_CLASS_CANDIDATES = ['mw-search-result', 'b_algo', 'search-title', 'fps-result'];

/** 把模板里的 `{q}` 换成查询词。 */
function fillProbe(template: string, query: string): string {
  return template.split('{q}').join(encodeURIComponent(query));
}

/** 一条 URL 的规范化键（去 fragment 与尾斜杠），用于"这条链接在首页上也有吗"的判断。 */
function linkKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/**
 * 一页 HTML 里所有链接的规范化键集合。
 *
 * 用途是**减去"这个站本来就有的链接"**：真实搜索页里满是导航/页脚，通用解析会把它们当
 * 结果。实测 Bing 的结果页对真查询与乱串查询都解析出 **16 条**（全是导航），
 * GitHub 是 130 vs 66 —— 所以"有没有解析出结果"完全不能作为判据。
 * 与首页取差集之后，只剩"因为这次搜索才出现"的链接，那才是真结果。
 */
function linkKeysIn(html: string, pageUrl: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].match(/\bhref="([^"]*)"/i);
    if (!href) continue;
    try {
      const u = new URL(decodeNumericEntities(href[1]).replace(/&amp;/g, '&').trim(), pageUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const k = linkKey(u.toString());
      if (k) out.add(k);
    } catch { /* 认不出就跳过 */ }
  }
  return out;
}

/**
 * 由一个站点首页/任意页面推出候选搜索地址模板。
 *
 * 只按**已经观察到的**参数名与路径组合，不穷举：五个通用查询参数 × 两个路径形态。
 * 顺序即优先级 —— `?q=` 是最常见的，`/search?q=` 次之。
 */
export function siteSearchCandidates(input: string): string[] {
  let origin = '';
  let hostname = '';
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    origin = url.origin;
    hostname = url.hostname;
  } catch {
    return [];
  }
  // **宿主名必须是个像域名的东西**（带点，或 IP 字面量）。少了这条，"不是地址"这种输入会被
  // WHATWG URL 的 punycode 接受（变成 `https://xn--ihqq6tnb086g`），于是探测会去打一个
  // 毫无意义的域名、白等一轮超时，用户却看不出是自己输错了。
  if (!hostname.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return [];
  // 参数名清单来自实测，不是穷举：`word` 是百度系站点的叫法（实测百度百科用 `?word=`），
  // 其余几个是国际站常见的。**每多一个参数就多两个请求**（通用解析要跑真/乱两次），
  // 所以只加有实测依据的，不要"顺手把能想到的都列上"。
  const params = ['q', 'query', 'search', 'keyword', 'wd', 'word'];
  const paths = ['/search', '/'];
  const out: string[] = [];
  for (const path of paths) for (const p of params) out.push(`${origin}${path}?${p}={q}`);
  return out;
}

export interface SiteSearchProbe {
  ok: boolean;
  /** 可用的模板（`ok` 为真时才有）。 */
  searchUrl?: string;
  /** 建议的结果容器类名（用了类名才有；空表示通用解析即可）。 */
  resultClass?: string;
  /** `ok` 为假时说明为什么。 */
  note?: string;
  /** 实际发出的请求数，便于用户判断"是不是试都没试"。 */
  tried?: number;
  /** 逐候选的实测计数，让用户能自己判断推荐值可不可信（而不是只给一个结论）。 */
  diagnostics?: Array<{ template: string; resultClass?: string; kept?: number; raw?: number; error?: string }>;
}

/**
 * 探测某个站点的站内搜索地址。
 *
 * `hint` 是用户**自己填的候选模板**（他在站内搜过一次、从地址栏抄下来的），优先级最高 ——
 * 它是唯一能覆盖"参数名不在这几个里"或"结果在另一个主机上"（如 Bing 的
 * `cn.bing.com` 出结果的是 `www.bing.com`）的办法。自动生成的候选只是兜底。
 *
 * 需要联网，所以调用方（HTTP 路由）负责先做 URL 校验与网络例外判断。
 */
export async function probeSiteSearch(
  siteInput: string,
  options: { hint?: string; timeoutMs?: number; budgetMs?: number } = {}
): Promise<SiteSearchProbe> {
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || 6000));
  // 总预算：**必须有**。候选是 10 个通用 + 10×4 个类名组合，每个都可能在慢站上耗到超时，
  // 实测 MDN 在没预算的一版里跑满 64 秒（用户对着按钮干等）。超预算就停止探测并如实说明。
  const budgetMs = Math.max(4000, Number(options.budgetMs) || 12000);
  const deadline = Date.now() + budgetMs;

  const hintTemplate = String(options.hint ?? '').trim();
  const generated = siteSearchCandidates(siteInput);
  if (!generated.length && !hintTemplate) {
    return { ok: false, note: '站点地址无法解析成 URL（形如 `https://example.com` 或 `example.com`）' };
  }
  // 用户给的候选排在第一位；它若不含 `{q}` 则整条丢弃（理由同配置层那条校验）
  const candidates = [
    ...(hintTemplate && hintTemplate.includes('{q}') ? [hintTemplate] : []),
    ...generated.filter((c) => c !== hintTemplate)
  ];

  let tried = 0;
  let budgetExceeded = false;
  const diagnostics: NonNullable<SiteSearchProbe['diagnostics']> = [];

  /** 取一页 HTML。失败返回 null；超预算返回 'budget'。 */
  const fetchHtml = async (url: string): Promise<string | null | 'budget'> => {
    if (Date.now() > deadline) { budgetExceeded = true; return 'budget'; }
    tried++;
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'accept-language': 'zh-CN,zh;q=0.9'
        },
        signal: AbortSignal.timeout(Math.min(timeoutMs, Math.max(1000, deadline - Date.now()))),
        redirect: 'follow'
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  };

  // 站点自身的基线链接集合：拿"首页/普通页"当对照，用来把导航、页脚、侧栏减掉。
  // **这是整套探测的判据所在**：不与基线比，任何真实搜索页都会"解析出十几条结果"，
  // 而那十几条在乱串查询下一样存在（实测 Bing 16 vs 16、MDN 15 vs 15）。
  const baseRaw = await fetchHtml(siteSearchCandidates(siteInput)[0]?.replace(/\/search\?q=\{q\}$/, '/') || siteInput);
  const baseUrl = (() => { try { return new URL(siteInput).toString(); } catch { return siteInput; } })();
  const baseline = baseRaw && baseRaw !== 'budget' ? linkKeysIn(baseRaw, baseUrl) : new Set<string>();

  /** 一个模板是否真的在出结果：把"基线里已有的链接"减掉，看还剩几条。 */
  const scoreTemplate = async (template: string, cls?: string): Promise<{ kept: number; raw: number } | null | 'budget'> => {
    const html = await fetchHtml(fillProbe(template, PROBE_QUERY));
    if (html === 'budget') return 'budget';
    if (html === null) return null;
    const raw = parseSiteSearch(html, fillProbe(template, PROBE_QUERY), cls).length;
    // 按类名命中时不再减基线：类名本身已经把范围收到结果块上（Bing 的 b_algo、
    // MediaWiki 的 mw-search-result 都不是导航用的类名）。
    if (cls) return { kept: raw, raw };
    const kept = parseSiteSearch(html, fillProbe(template, PROBE_QUERY), cls)
      .filter((r) => !baseline.has(linkKey(r.url))).length;
    return { kept, raw };
  };

  // ① 通用解析：只认"减掉基线后还剩 ≥3 条"的模板
  let best: { url: string; kept: number; raw: number } | null = null;
  for (const template of candidates) {
    const s = await scoreTemplate(template);
    if (s === 'budget') break;
    if (!s) { diagnostics.push({ template, error: '取页失败' }); continue; }
    diagnostics.push({ template, kept: s.kept, raw: s.raw });
    if (s.kept < 3) continue;
    if (!best || s.kept > best.kept) best = { url: template, kept: s.kept, raw: s.raw };
  }
  if (best) {
    return {
      ok: true, searchUrl: best.url, tried, diagnostics,
      note: `通用解析：减掉导航后剩 ${best.kept} 条（原始 ${best.raw} 条）`
    };
  }

  // ② 结果容器类名：类名把范围收窄到结果块，所以只看命中数（≥2 条）
  for (const template of candidates) {
    for (const cls of PROBE_CLASS_CANDIDATES) {
      const s = await scoreTemplate(template, cls);
      if (s === 'budget') break;
      if (!s) { diagnostics.push({ template, resultClass: cls, error: '取页失败' }); continue; }
      diagnostics.push({ template, resultClass: cls, kept: s.kept, raw: s.raw });
      if (s.kept < 2) continue;
      return { ok: true, searchUrl: template, resultClass: cls, tried, diagnostics, note: `按容器类名「${cls}」命中 ${s.kept} 条` };
    }
    if (budgetExceeded) break;
  }

  const tail = budgetExceeded ? `（已发 ${tried} 次请求后到时间上限，探测未跑完）` : '';
  return {
    ok: false,
    tried,
    diagnostics,
    note: '没找到可用的站内搜索地址。常见原因：① 该站结果由 JavaScript 动态渲染（抓到的 HTML 里没有结果）；' +
      '② 查询参数名不在这几个里（q/query/search/keyword/wd），或结果在别的主机上；' +
      '③ 该站需要登录或被反爬拦截（反爬时连结果标记都会被去掉）。' +
      '最可靠的做法：自己在站内搜一次，把地址栏里的 URL 贴到「站内搜索地址」栏，再把查询词换成 {q}。' + tail
  };
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
