// 文本与实体处理。**没有依赖**（不读配置、不发请求），所以谁都能安全引用。
//
// ⚠️ 这里有两个"看着重复"的解码器，**故意不合并**（原因见 `decodeNumericEntities` 的注释）：
// 改 `decodeHtml` 等于改 Bing 那条**已有行为**的解析路径。

/** 剥标签 + 解码常见命名实体 + 折叠空白。Bing 路径在用它。 */
export function decodeHtml(s: unknown): string {
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
export function decodeNumericEntities(s: string): string {
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

/** 把 HTML 里的属性值/元素内容解出可读文本（实体 → 文本、标签剥掉、空白折叠）。 */
export function htmlToText(input: string): string {
  return decodeHtml(decodeNumericEntities(input));
}

/**
 * 取一个宿主名的"站点家族"（可注册域，近似 eTLD+1）：`a.b.c` → `b.c`。
 *
 * **为什么需要它**：站内搜索页与它搜出来的内容**经常不在同一个子域上**。实测 B 站：
 * 搜索页是 `search.bilibili.com`，而**每一条结果都在 `www.bilibili.com`**。
 * 原先那条"结果宿主必须等于搜索页宿主、或是它的子域"的过滤会把这些全部丢掉 ——
 * 表现为"这个站的 HTML 里明明有 47 个结果，解析出来却是 0 条"。
 *
 * 对 `com.cn`/`co.jp` 这类二级后缀会略微放宽（`foo.com.cn` 与 `bar.com.cn` 会被当同一家族）。
 * 这是**有意的取舍**：收藏夹的语义本来就是"限定在这个站点家族里"，而真正的把关在
 * 探测那一步的基线差 + 乱串对照。
 */
export function siteFamily(hostname: string): string {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(-2).join('.');
}

/**
 * URL 的规范化去重键：**去掉 fragment 与末尾斜杠**，保留查询串与路径 ——
 * `a.com/x` 与 `a.com/x#sec2` 是同一篇，而 `a.com/x` 与 `a.com/y` 不是。
 * 认不出 URL 时返回空串，调用方按"不参与去重"处理（宁可重复也不误删）。
 */
export function urlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}
