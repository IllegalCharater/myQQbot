// Yandex 网页解析。
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
import { getConfig } from '../../../core/config.js';
import { decodeNumericEntities, htmlToText } from '../text-utils.js';
import { isRecord } from '../record-utils.js';
import { maxResults } from '../shared.js';
import type { SearchResponse, SearchResult } from '../types.js';

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
  const limit = maxResults();
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
    if (results.length >= limit) break;
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
