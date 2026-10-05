// HTML → 可读文本。`web_fetch` 给模型看的内容要过这一层。
//
// ── 为什么必须有这一层（**实测反馈**）──
//
// 旧实现是 `body.slice(0, 20000)`，直接把原始 HTML 切前 20000 字符给模型。对现代站点
// 那是**灾难性**的：`<head>` 里塞满了 `<script>`（MediaWiki 的 `RLCONF={…}`、
// `wgCategories` 这类配置 JSON 动辄几十 KB），于是那 20000 字符几乎全被脚本吃掉，
// **正文一个字都进不去**。实测萌娘百科：
//
//   · 洛天依（整页 183K）：20000 字符里可读文本只有 **633** 字，第一个 `<p>` 在 46288 处
//   · 初音未来（整页 486K）：20000 字符里可读文本只有 **206** 字，第一个 `<p>` 在 23306 处
//
// 模型拿到的是"一串看不出是什么的脚本片段"，于是它会以为抓取失败/被限流，反复重试 ——
// 而真实原因只是**我们把预算花在了页面的元数据上**。
//
// ── 设计取舍 ──
//
// 1. **纯函数、无依赖**。仓库里没有 HTML 解析库（`package.json` 只有 js-yaml / node-cron /
//    undici / ws），为了这件事引入 cheerio/jsdom 不划算；这里只需要"把脚本文本丢掉、
//    让块级标签断行、解开实体"，正则足够，且**可单测**。
// 2. **不追求完美的正文识别**。去掉导航/页脚要靠 Readability 那类启发式，误删正文的风险
//    比留下噪声更大。这里只做**无损**的部分：丢脚本样式、断行、解实体。
// 3. **块级标签换成 `\n`**，`</p>`/`</li>`/`<br>` 等 —— 全都压成空格的话整篇文章会变成一行，
//    模型没法定位段落（这与会话日志那条"pre-wrap 加横向滚动"是同一类判据：结构要保住）。
// 4. **`alt` 与链接 URL 要保留**：图片的 `alt` 常是唯一说明，链接地址是模型要引用的东西。

/** 块级标签：用换行分隔，保住段落结构。 */
const BLOCK_TAGS = 'p|div|br|li|ul|ol|tr|td|th|h[1-6]|section|article|header|footer|blockquote|pre|hr|dd|dt|figure|figcaption|table|thead|tbody';

/**
 * 把一段 HTML 变成可读文本。
 *
 * 输入不完整（被上游按字节截断在标签中间）时也必须**能跑** —— `safeFetch` 的 50000 字节
 * 上限经常正好切在 `<script>` 中间，那种情况下"闭合标签找不到"是常态，不能抛错。
 */
export function htmlToText(html: string, baseUrl = ''): string {
  let text = String(html ?? '');

  // ① 整块丢掉：脚本、样式、注释。
  //
  // ⚠️ **只在找到闭合标签时才连内容一起丢**。初版对每种标签都写了 `|$` 兜底
  // （"没有闭合标签就贪到结尾"），那是**危险**的：实测萌娘百科页面上有一个**不闭合的
  // `<template>`**，于是那条规则把整篇文章吞掉了（28647 → 6348 字符，最后只剩一段
  // Cloudflare 的 URL）。"没有闭合标签"最常见的成因是**响应被上游截断**，那种时候
  // 保留原文远比丢掉好 —— 宁可留一段脚本，也不能让正文消失。
  //
  // 注释是唯一安全的例外：`<!--` 之后没有 `-->` 时，剩下的确实都在注释里。
  text = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');

  // ② `head` 整段没有可见内容（`title` 由调用方另取），整块丢掉能省最多预算。
  //    同样**只在闭合时**丢：截断的响应里 `</head>` 可能根本不在。
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ');

  // ③ 上面没配成对的脚本/样式**开标签**也要去掉（内容留着，见 ① 的理由），
  //    否则它们会以标签文本的形式混进正文。
  text = text.replace(/<\/?(?:script|style|template|noscript)\b[^>]*>/gi, ' ');

  // ④ 保留语义信息：图片 alt、链接地址。
  //
  // ⚠️ 链接地址里的**相对路径要补成绝对地址**，否则模型看到的是 `[/%E5%88%9D...]`
  // 这种片段 —— 它没法用（不知道主机名），也没法引给群友。实测萌娘百科的链接全是
  // `href="/初音未来"` 这种形态，补全之前正文里全是看不懂的百分号串。
  text = text
    .replace(/<img\b[^>]*?\balt\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi,
      (_all, _q, d, s, b) => ` [${d || s || b || ''}] `)
    .replace(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi,
      (_all, _q, d, s, b) => {
        const raw = String(d || s || b || '').trim();
        if (!raw) return ' ';
        // `#`/`javascript:` 这类锚点不是"可引用的地址"，丢掉（留着只会让正文更乱）
        if (/^(#|javascript:|mailto:)/i.test(raw)) return ' ';
        return ` [${absolute(raw, baseUrl)}] `;
      });

  // ⑤ 块级标签 → 换行；其余标签 → 空格
  text = text
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]*>/g, ' ');

  // ⑥ 解实体。`&amp;` 必须**最后**解，否则 `&amp;lt;` 会被解成 `<`（少数派但真实存在）。
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_all, d: string) => codePoint(Number(d)))
    .replace(/&#[xX]([0-9a-f]+);/g, (_all, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');

  // ⑦ 规范化空白：行内多空格压成一个、连续空行压成一个（保住段落边界）
  return text
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 码点安全的实体解码：非法码点给空串，绝不抛错（输入来自任意网页）。 */
function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/**
 * 把链接补成绝对地址。补不成（没有 baseUrl / baseUrl 自己也不合法）就原样返回 ——
 * 相对路径总比丢掉链接强，模型至少能看到那是条路径。
 */
function absolute(href: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  if (!baseUrl) return href;
  try { return new URL(href, baseUrl).toString(); } catch { return href; }
}

/**
 * 内容是否"像 HTML"。
 *
 * 判据故意宽松（只看有没有像标签的东西），因为**误判两个方向的代价不对称**：
 *   · 把 HTML 当纯文本 → 模型拿到一堆脚本，就是本文件开头那个 bug；
 *   · 把纯文本当 HTML → 过一遍 `htmlToText` 基本无变化（纯文本里没有标签）。
 * 所以宁可多过一层。
 */
export function looksLikeHtml(body: string, contentType = ''): boolean {
  if (/html/i.test(contentType)) return true;
  const head = String(body ?? '').slice(0, 2000);
  return /<\s*(!doctype|html|head|body|div|p|span|a|script|meta|table|ul|li)\b/i.test(head);
}

/** `looksBlocked` 的结论。 */
export interface BlockedVerdict {
  blocked: boolean;
  /** 给模型/用户看的原因（`blocked` 为假时为空串）。 */
  reason: string;
}

/**
 * 判断"这次抓取其实被站点拦了"，即使 HTTP 是 200。
 *
 * ── 为什么需要（**实测反馈**）──
 *
 * 模型调用 `web_fetch` 抓萌娘百科，拿到的是：
 *
 * ```
 * { "statusCode": 200, "truncated": false, "content": "",
 *   "note": "（已从 HTML 中提取可读正文）" }
 * ```
 *
 * **内容为空却报成功** —— 模型于是说"你这修复好像没生效"，而真实原因是**站点在拦它**：
 * `action=raw` 返回 `<title>未授权操作</title>`，移动版与主站返回的是 **Cloudflare 挑战页**
 * （`<title>` 是正常条目名，但正文全是脚本，剥完只剩一段 `cdn-cgi/content?id=…` 的 URL）。
 * 这两种都是 **200**，所以"看状态码"判不出来。
 *
 * ── 判据 ──
 *
 * 1. **明确的 Cloudflare 标记**：`cf-mitigated` 头、`server: cloudflare` 配合正文里的
 *    `cdn-cgi/content` / `challenge-platform`；或正文里出现 `/cdn-cgi/` 字样。
 * 2. **显式的拒绝标题**：`<title>` 里是"未授权操作 / 403 Forbidden / Access denied"这类。
 * 3. **兜底：正文被剥成几乎没有**。原始响应不小（> 5000 字符）而剥完不到 200
 *    字符且不到原始的 1% —— 那说明响应主体是脚本/样式而不是给人看的内容。
 *    这条同时兜住"还没见过的挑战页形态"和"纯 JS 渲染的站点"。
 *
 * ⚠️ 第 3 条**故意同时要求"绝对量小"和"占比小"**：只看占比会把"内容确实很少的正常页"
 * 误判（如一个 500 字符的短页面剥完 50 字符 = 10%，占比不小但绝对量小，不该报错）；
 * 只看绝对量则会把"200KB 里只有 250 字符正文"的正常窄页误判。
 */
export function looksBlocked(body: string, opts: { server?: string; cfMitigated?: string; text?: string } = {}): BlockedVerdict {
  const raw = String(body ?? '');
  const text = String(opts.text ?? '');
  const server = String(opts.server || '').toLowerCase();
  const cfMitigated = String(opts.cfMitigated || '').trim();

  if (cfMitigated) {
    return { blocked: true, reason: `站点返回了拦截标记（cf-mitigated: ${cfMitigated}）` };
  }
  // 挑战页的特征串。`/cdn-cgi/` 之外还看 `challenge-platform`（Cloudflare 的 JS 挑战脚本）。
  const cfHit = /\/cdn-cgi\/|challenge-platform|cf-challenge|__cf_chl/i.test(raw);
  if (cfHit && (/cloudflare/i.test(server) || /cdn-cgi\/content/i.test(raw))) {
    return {
      blocked: true,
      reason: '站点返回的是 Cloudflare 的**人机验证页**（HTTP 200，但正文是脚本、没有内容）。'
        + '这不是配置问题，是站点在拦自动抓取 —— 换个镜像站/接口，或过一会儿再试。'
    };
  }
  const title = (/<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(raw) || [, ''])[1].replace(/\s+/g, ' ').trim();
  if (/未授权|无权限|禁止访问|拒绝访问|forbidden|access denied|unauthorized|just a moment|attention required|请稍候/i.test(title)) {
    return { blocked: true, reason: `站点拒绝了这次抓取（页面标题是「${title}」）` };
  }
  // 兜底：剥完几乎没东西，而原始响应并不小
  if (raw.length > 5000 && text.length < 200 && text.length < raw.length * 0.01) {
    return {
      blocked: true,
      reason: `抓回来的 ${raw.length} 字符几乎全是脚本/样式，剥完只剩 ${text.length} 字符可读内容`
        + '（站点可能在拦截自动抓取，或这个页面完全靠 JavaScript 渲染）。'
    };
  }
  return { blocked: false, reason: '' };
}
