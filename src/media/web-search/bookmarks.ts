// 网页收藏夹：名单归一、枚举值校验、收藏夹命中标记与排序。
//
// 这一层只认**名单与路由**，取内容的动作在 `site-search.ts`。（`image-source/` 那张图里
// 对应的是"引擎清单 + ORDER"，取值的那一半是服务层。）
import { getConfig } from '../../core/config.js';
import type { BookmarkSite, BookmarkRequest, BookmarkHeader } from './bookmark-request.js';
import { isRecord } from './record-utils.js';
import { urlKey } from './text-utils.js';
import type { BookmarkMode, SearchResult } from './types.js';

// 类型定义在 `bookmark-request.ts` —— 请求结构那条链（拼请求、发请求、把 JSON 转成候选）
// 与这里共用同一个形状，**两边各写一份必然漂移**。这里重新导出，让
// `web-search/index.js` 仍是收藏夹检索的对外入口。
export type { BookmarkSite, BookmarkRequest, BookmarkHeader } from './bookmark-request.js';

/**
 * 一次 `site:` 子句里最多放几个站点。
 *
 * 与配置层的站点上限（`MAX_BOOKMARK_SITES` = 20）是**两个数、管两件事**：那个管"名单能有多长"，
 * 这个管"单次查询串里塞几个"。不合并成一个是因为二者的正确值由不同约束决定：名单长度由
 * 用户想收藏多少决定，而查询串长度只影响这一次搜索的质量。超出部分不丢——它们仍参与
 * 结果优先级的判定（`annotateBookmarks` 用的是整份名单）。
 */
const MAX_SITES_PER_QUERY = 5;

/** 读收藏夹优先模式。`bookmarkFirst === false` 视为 'web'，缺省视为 'prefer'（兼容迁移）。 */
export function bookmarkPreference(): BookmarkMode {
  const cfg = getConfig().webSearch as Record<string, unknown> | undefined;
  if (cfg?.bookmarkMode === 'web') return 'web';
  return cfg?.bookmarkFirst === false ? 'web' : 'prefer';
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
    // 请求结构：形状检查同样在这里再做一次（同上面两条的理由）。
    // `endpoint` 必须含 `{q}`，否则拼不出查询词 —— 与 `searchUrl` 完全一样的要求。
    const req = isRecord(raw.request) ? raw.request : null;
    if (req) {
      const method = String(req.method ?? 'GET').toUpperCase();
      const endpoint = String(req.endpoint ?? req.url ?? '').trim();
      if ((method === 'GET' || method === 'POST') && endpoint.includes('{q}')) {
        const headers: BookmarkHeader[] = Array.isArray(req.headers)
          ? (req.headers as unknown[])
            .filter(isRecord)
            .map((h) => ({ name: String(h.name ?? '').trim(), value: String(h.value ?? '') }))
            .filter((h) => h.name)
          : [];
        entry.request = headers.length ? { method, endpoint, headers } : { method, endpoint };
      }
    }
    const params = isRecord(raw.params) ? raw.params : null;
    if (params) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(params)) {
        const name = String(k).trim();
        if (!name) continue;
        clean[name] = String(v ?? '');
      }
      if (Object.keys(clean).length) entry.params = clean;
    }
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

/** 收藏夹站点命中判定用的纯宿主名集合。 */
export function bookmarkSiteSet(): Set<string> {
  const set = new Set<string>();
  for (const item of bookmarkList()) set.add(item.host);
  return set;
}

/** 取 URL 的纯宿主名（小写、去尾点）。认不出返回空串。 */
function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
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
 * "用户常去"误读成"最权威"；只做后者则收藏夹不起任何作用。
 *
 * 顺带按规范化 URL 去重：受限查询与普通查询的**重叠部分通常是绝大多数**（收藏的站点
 * 本来就可能排在前面），不去重会让同一篇文章在结果里出现两次、白占一个名额。
 */
export function annotateBookmarks(results: SearchResult[], sites: Set<string>): SearchResult[] {
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

/** 把若干站点拼成一条 `(site:a OR site:b)` 子句；没有可用站点时返回空串。 */
export function siteClause(sites: string[]): string {
  const picks = sites.slice(0, MAX_SITES_PER_QUERY).map((site) => `site:${site}`);
  return picks.length ? `(${picks.join(' OR ')})` : '';
}
