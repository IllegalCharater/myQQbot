// 站内搜索地址的**自动探测**（设置页那个「自动检测」按钮的后端）。
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
import { decodeNumericEntities, urlKey } from './text-utils.js';
import { parseSiteSearch } from './site-search.js';

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
  return urlKey(url);
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
 * 把用户填的站点地址归一成可解析的 URL 形态。
 *
 * **为什么需要它**：设置页那一栏的标签是「网页地址」、占位符是 `zh.wikipedia.org`（裸域名），
 * 所以用户填裸域名是**最正常**的填法。而 `validateFetchUrl` 直接吃 `new URL(...)`，
 * 裸域名会抛"URL 无效" —— 于是检测按钮报"站点地址不可用：URL 无效"，
 * 用户完全不知道自己哪里填错了（实测就报了这个）。
 *
 * 只做"补协议"与去空白，**不做别的解释**：`siteSearchCandidates` 复用同一份归一逻辑，
 * 两边口径必须一致，否则界面接受而路由拒绝（或反过来）。
 */
export function normalizeSiteInput(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
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
    const url = new URL(normalizeSiteInput(input));
    origin = url.origin;
    hostname = url.hostname;
  } catch {
    return [];
  }
  // **宿主名必须是个像域名的东西**（带点，或 IP 字面量）。少了这条，"不是地址"这种输入会被
  // WHATWG URL 的 punycode 接受（变成 `https://xn--ihqq6tnb086g`），于是探测会去打一个
  // 毫无意义的域名、白等一轮超时，用户却看不出是自己输错了。
  if (!hostname.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return [];
  // 候选清单：**刻意不做全笛卡尔积**。每个候选至少要发一个请求，而这条探测是串行的，
  // 所以候选数量直接决定耗时与"能不能在预算内跑完"。
  //
  // 实测教训：初版按「4 路径 × 6 参数 = 24 个候选」全跑，预算在**筛选阶段**就耗尽，
  // 而真正可用的那个（Gentoo Wiki 的 `?search=`）排在后面、还没被确认就整体放弃了 ——
  // 症状是"本来能检测出来的站点变成找不到"。
  //
  // 现在的配比按"实际出现频率"给：
  //   · `/search` 是最常见的入口，配全部参数名；
  //   · `/w/index.php` 与 `/index.php` 是 MediaWiki 的标准入口（实测 Gentoo 用它返回
  //     41KB 的 `mw-search-result` 结果页，而 `/search?q=` 它根本不认），只配 `search`
  //     这一个参数名 —— MediaWiki 的参数名恒为 `search`，配全套纯属浪费；
  //   · 站点根的参数名只在提示词场景下有用，用 hint 覆盖即可，不主动试。
  // 站点根也要配几个参数名，不能只有一个 `?q=`：**有些站的搜索就在根路径上，而且用的是
  // 别的参数名**。实测 B 站：`https://search.bilibili.com/?keyword=test` 返回 95 条真结果，
  // 而 `/search?q=` 是 **404** —— 只配 `/?q=` 的话自动检测必然漏掉它（只能靠用户自己填 hint）。
  // 这里只挑最可能的三个，控制请求量。
  const out: string[] = [];
  for (const p of ['q', 'query', 'search', 'keyword', 'wd', 'word']) {
    out.push(`${origin}/search?${p}={q}`);
  }
  out.push(`${origin}/w/index.php?search={q}`);
  out.push(`${origin}/index.php?search={q}`);
  for (const p of ['q', 'keyword', 'search']) {
    out.push(`${origin}/?${p}={q}`);
  }
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
  /**
   * 判定结果：**用户填的那个地址是个 JSON 接口**（不是 HTML 搜索页）。
   *
   * 单独给一个**机器可读**的标记，而不是让前端去正则匹配 `note` 文案 —— 前端要靠它
   * 决定「把这条地址搬进『请求结构』并弹窗」。文案随时会改，匹配文案的做法会在改文案时
   * 静默失效。
   *
   * 同时给出 `jsonApiUrl`：预填时要用**用户填的那个模板**（含 `{q}`），不是别的候选。
   */
  detectedJson?: boolean;
  jsonApiUrl?: string;
  /** 逐候选的实测计数，让用户能自己判断推荐值可不可信（而不是只给一个结论）。 */
  diagnostics?: Array<{ template: string; resultClass?: string; kept?: number; raw?: number; error?: string }>;
}

/**
 * 探测某个站点的站内搜索地址。
 *
 * 两种模式，由**用户填没填**「站内搜索地址」决定（`options.searchUrl`）：
 *   · **没填**（默认）：自动检测 —— 按 `siteSearchCandidates` 生成的候选逐个试，找到可用的就返回。
 *     这是用户点「检测」想要的东西：他不知道地址长什么样，让程序去找。
 *   · **填了**：只测他填的那一个，**不去猜别的**。填了地址就说明他知道这一栏怎么用，
 *     "测试"该回答的是"我填的这个能不能用"；拿他的输入当线索去自动找别的，会把框里的值
 *     悄悄换成另一个地址 —— 观感就是"检测自己把我的配置改了"。
 *
 * `hint` 是旧的"候选线索"入口，保留兼容：它只影响**自动检测**模式的候选顺序，
 * 不再是"用户已填地址"的表达方式（那个语义现在由 `searchUrl` 承担）。
 *
 * 需要联网，所以调用方（HTTP 路由）负责先做 URL 校验与网络例外判断。
 */
export async function probeSiteSearch(
  siteInput: string,
  options: { hint?: string; searchUrl?: string; timeoutMs?: number; budgetMs?: number } = {}
): Promise<SiteSearchProbe> {
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || 6000));
  // 总预算：**必须有**。候选是 10 个通用 + 10×4 个类名组合，每个都可能在慢站上耗到超时，
  // 实测 MDN 在没预算的一版里跑满 64 秒（用户对着按钮干等）。超预算就停止探测并如实说明。
  const budgetMs = Math.max(4000, Number(options.budgetMs) || 12000);
  const deadline = Date.now() + budgetMs;

  const hintTemplate = String(options.hint ?? '').trim();
  // 用户**明确填了**「站内搜索地址」时走"只测这一个"模式（见函数头注释）。
  // 留空/只有空白 = 没填 = 自动检测。
  const fixedTemplate = String(options.searchUrl ?? '').trim();
  const generated = siteSearchCandidates(siteInput);
  if (!generated.length && !hintTemplate && !fixedTemplate) {
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

  /**
   * 取一页 HTML。失败返回 null；超预算返回 'budget'。
   *
   * **带一次重试**：这是一串几十个请求的连续探测，任何一次网络抖动都会让该候选被判成
   * "取页失败"、悄悄丢掉一个本来可用的地址。实测踩到过：GitHub 在十几秒内**每个** URL
   * 都 `fetch failed`（含纯首页），而同一时刻别的站点一切正常 —— 这种抖动是常态，
   * 不该让一次探测给出错误的"找不到"。重试只在**还来得及**时做（离死线太近就直接放弃），
   * 且只重试一次，避免把预算耗在真的不可达的站点上。
   */
  /**
   * 一页抓下来的东西：正文 + **它自己的** `content-type`。
   *
   * 必须随身带，不能记在共享变量里：`fetchHtml` 还被基线（站点根）与乱串对照用，
   * 记在共享变量上会被**后一次**抓取覆盖，于是"判定这一页是不是网页"读到的是**别人**的
   * content-type。实测踩到：JSON 夹具被判成 HTML（基线那一次把类型刷成了 text/html），
   * 于是新加的 JSON 识别完全不生效、断言全假绿。
   */
  type SitePage = { body: string; contentType: string };

  const fetchHtml = async (url: string): Promise<SitePage | null | 'budget'> => {
    const netTimeout = () => Math.min(timeoutMs, Math.max(1000, deadline - Date.now()));
    const attempt = async (): Promise<SitePage | null> => {
      tried++;
      try {
        const res = await fetch(url, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'accept-language': 'zh-CN,zh;q=0.9'
          },
          signal: AbortSignal.timeout(netTimeout()),
          redirect: 'follow'
        });
        if (!res.ok) return null;
        return { body: await res.text(), contentType: String(res.headers.get('content-type') || '') };
      } catch {
        return null;
      }
    };
    if (Date.now() > deadline) { budgetExceeded = true; return 'budget'; }
    const first = await attempt();
    if (first !== null) return first;
    // 重试需要「够一次最小超时」的剩余预算，否则只会把死线耗光却没有结果
    if (Date.now() + 1000 > deadline) { budgetExceeded = true; return 'budget'; }
    return await attempt();
  };

  // 站点自身的基线链接集合：拿站点根当对照，用来把导航、页脚、侧栏减掉。
  // **这是整套探测的判据所在**：不与基线比，任何真实搜索页都会"解析出十几条结果"，
  // 而那十几条在乱串查询下一样存在（实测 Bing 16 vs 16、MDN 15 vs 15）。
  //
  // 三个细节都是有意的：
  //   · **惰性取**：只有真有模板"命中一批链接"时才去取基线 —— JS 渲染的站点每一发都零命中，
  //     不该为它们白发一次基线请求；
  //   · 走 `normalizeSiteInput`：调用方可能给裸域名（设置页就是这么提示的），
  //     而 `new URL('baike.baidu.com')` 会抛错 → 基线退化成空集 → 整条判据失效；
  //   · 基线取**站点根**（`origin + '/'`），不是某个带查询串的页面。
  let baselineCache: Set<string> | null = null;
  const baseline = async (): Promise<Set<string>> => {
    if (baselineCache) return baselineCache;
    const normalized = normalizeSiteInput(siteInput);
    const root = (() => { try { return `${new URL(normalized).origin}/`; } catch { return normalized; } })();
    const html = await fetchHtml(root);
    baselineCache = html && html !== 'budget' ? linkKeysIn(html.body, root) : new Set<string>();
    return baselineCache;
  };

  /** 取一页 HTML（真查询），供"类名试解析"与"通用解析"共用。 */
  const fetchRealHtml = async (template: string): Promise<{ html: string; url: string; contentType: string } | null | 'budget'> => {
    const url = fillProbe(template, PROBE_QUERY);
    const page = await fetchHtml(url);
    if (page === 'budget') return 'budget';
    if (page === null) return null;
    return { html: page.body, url, contentType: page.contentType };
  };

  /**
   * 判定**一个**模板可不可用（类名 → 基线差 → 乱串对照）。
   *
   * 抽出来是因为有两条调用路径，而它们必须用**同一套判据**：
   *   · 自动检测：对每个生成的候选跑一遍，挑最好的；
   *   · 用户已填地址时的"测试"：只跑他填的那一个。
   * 判据分两份写必然漂移 —— 那正是"检测说可以、真用起来不对"的来源。
   *
   * `baseline()` / `fetchHtml` 都带缓存或预算检查，所以重复调用是安全的。
   */
  const judgeTemplate = async (
    template: string
  ): Promise<{ template: string; accepted: boolean; classHit?: { cls: string; n: number }; kept?: number; junkKept?: number; note?: string; jsonApi?: boolean }> => {
    const real = await fetchRealHtml(template);
    if (real === 'budget') return { template, accepted: false, note: '预算用尽' };
    if (real === null) return { template, accepted: false, note: '取页失败' };

    // ⓞ **先认"这不是网页"**。站内搜索链只解析 HTML 链接，JSON/纯文本接口必然解析不出东西，
    //    而且继续往下试类名与基线只是白烧请求。实测就是这个形状：用户填了第三方 JSON 百科接口，
    //    旧文案说"结构可能变了"，把人引去改「结果容器类名」——方向完全错。
    //
    //    ⚠️ 顺序很关键：**JSON 判据必须排在 HTML 判据之前**。
    //    `content-type: text/html` 里天然含 "html" 子串，而接口站经常把 content-type 写错
    //    （实测夹具就是这样）；先看 content-type 的话一个 JSON 接口会被当成网页放过去，
    //    这段识别等于白写（实测踩到一次：断言全红）。**正文形态**才是权威。
    const bodyHead = real.html.slice(0, 200);
    const shortType = real.contentType.split(';')[0];
    const isJson = /json/i.test(real.contentType) || /^\s*[{[]/.test(bodyHead);
    if (isJson) {
      return {
        template, accepted: false, jsonApi: true,
        // ⚠️ 文案必须**给出下一步**，不能只说"不行"。
        // 初版写的是"若它就是你要的数据源，需要单独支持 JSON 接口" —— 而那个能力**早就有了**，
        // 就是收藏夹那一行的「请求结构」按钮。用户照着这句话只会以为"这个站接不了"，
        // 或者去改「结果容器类名」（方向完全错，实测就是这样）。所以这里直接点名该去哪填。
        note: `这个地址返回的是 JSON 接口数据（content-type: ${shortType || '未知'}），不是网页 —— `
          + '「网页地址」这一栏只会从 HTML 页面里解析链接，所以 JSON 接口填这里检测永远通不过。'
          + `但这不代表它接不了：请点同一条收藏夹右侧的「请求结构」，把这条地址原样填进去`
          + '（JSON 接口是它的用途），然后「网页地址」留空即可。'
      };
    }
    const looksHtml = /html/i.test(real.contentType) || /^\s*</.test(bodyHead);
    if (real.contentType && !looksHtml) {
      return {
        template, accepted: false,
        note: `这个地址返回的不是网页（content-type: ${shortType || '未知'}），站内搜索只能解析 HTML。`
      };
    }

    // ① 结果容器类名：命中 ≥2 条即可接受（`mw-search-result`/`b_algo` 都不是导航会用到的类名）
    for (const cls of PROBE_CLASS_CANDIDATES) {
      const n = parseSiteSearch(real.html, real.url, cls).length;
      if (n >= 2) return { template, accepted: true, classHit: { cls, n } };
    }

    // ② 通用解析：真查询 → 基线差 → 乱串对照，三者都过才算数
    const genericReal = parseSiteSearch(real.html, real.url).length;
    if (genericReal < 3) return { template, accepted: false, note: `通用解析只拿到 ${genericReal} 条` };

    const base = await baseline();
    if (budgetExceeded) return { template, accepted: false, note: '预算用尽' };
    const kept = parseSiteSearch(real.html, real.url).filter((r) => !base.has(linkKey(r.url))).length;
    diagnostics.push({ template, kept, raw: genericReal });
    if (kept < 3) return { template, accepted: false, kept, note: `减掉导航后只剩 ${kept} 条` };

    // 乱串对照：确认这些"多出来的链接"确实是因为查询词才出现的
    const junkHtml = await fetchHtml(fillProbe(template, PROBE_JUNK_QUERY));
    if (junkHtml === 'budget') return { template, accepted: false, kept, note: '预算用尽' };
    if (junkHtml === null) return { template, accepted: false, kept, note: '乱串对照取页失败' };
    const junkKept = parseSiteSearch(junkHtml.body, fillProbe(template, PROBE_JUNK_QUERY))
      .filter((r) => !base.has(linkKey(r.url))).length;
    if (kept < junkKept + 3) {
      return { template, accepted: false, kept, junkKept, note: `乱串查询也拿到 ${junkKept} 条，区分不开` };
    }
    return { template, accepted: true, kept, junkKept };
  };

  // ── 用户**已经填了**站内搜索地址 → 只测他填的那一个 ──
  //
  // 这条分支是刻意的：填了地址就说明他知道这一栏是干什么的，"测试"该回答的是
  // **"我填的这个能不能用"**，而不是拿他的输入当线索去猜别的地址。
  // 旧行为把填写值当 `hint`（优先试、试不通再自动找别的），结果是点「检测」之后
  // 那个框里的值被**悄悄换成另一个地址** —— 看起来像"检测自己把我的配置改了"。
  if (fixedTemplate) {
    if (!fixedTemplate.includes('{q}')) {
      return {
        ok: false, tried, searchUrl: fixedTemplate,
        note: '你填的这个地址里没有 {q} 占位符，没法把查询词替换进去。'
          + '做法：在站内搜一次，把地址栏里的 URL 贴进来，并把查询词所在的位置改成 {q}'
          + '（例：https://example.com/search?q={q}）。'
          + '想让我自己找，请先清空这一栏再点检测。'
      };
    }
    const verdict = await judgeTemplate(fixedTemplate);
    if (verdict.accepted) {
      return {
        ok: true, tried, searchUrl: fixedTemplate, resultClass: verdict.classHit?.cls, diagnostics,
        note: verdict.classHit
          ? `你填的地址可用：按容器类名「${verdict.classHit.cls}」命中 ${verdict.classHit.n} 条`
          : `你填的地址可用：减掉导航后剩 ${verdict.kept} 条（乱串对照 ${verdict.junkKept} 条）`
      };
    }
    return {
      ok: false, tried, searchUrl: fixedTemplate, diagnostics,
      // 机器可读的"这是 JSON 接口"标记 + 要预填的那条模板（见 `SiteSearchProbe` 注释）
      ...(verdict.jsonApi ? { detectedJson: true, jsonApiUrl: fixedTemplate } : {}),
      // 不给 `verdict.note` 补句号：那几条文案自己带标点，补了会出现"。。"（实测看到过）
      //
      // ⚠️ "清空这一栏再点检测"那句**只在真可能找得到时才加**。判定说"这是个 JSON 接口"
      // 时，自动检测那一支去试的是**HTML 搜索页**，而这个地址本身多半就是接口主机
      // （实测萌娘百科 `api.php` 就是这样）—— 让它去自动找等于指一条大概率死路，
      // 而且会把用户从"该去填请求结构"这个正确的下一步上带走。
      note: `你填的地址没通过检测：${verdict.note || '判定不通过'}`
        + (verdict.jsonApi ? '' : '（清空这一栏再点检测，我可以自动去这个站里找。）')
    };
  }

  // ── 没填地址 → 自动检测：逐个候选试，找到就返回 ──
  //
  // 三条教训写在结构里：
  //   · **一次请求，本地试多个类名**。初版对每个类名各发一次请求（4 倍请求量），
  //     在慢站上几个候选就把预算烧光，把本来能检出的站点（Gentoo Wiki）变成"找不到"。
  //   · **类名检查排在通用解析之前**，不能挂在"通用解析命中数"的门槛后面 —— 那个门槛比的是
  //     **原始**条数（含导航，动辄十几），而类名命中的是**结果块**（可能只有 2~3 条）。
  //     初版写成 `if (genericReal < 3)`，于是"通用解析出 10 条、类名命中 2 条"的页面
  //     （典型：结果少但结构清晰的 wiki）两边都不落地，被直接放弃。
  //   · **不要写成"先全部筛选、再统一确认"两趟**：预算会在第一趟耗尽，排在后面的可用候选
  //     永远等不到确认（Gentoo 的 `?search=` 是第 3 个候选，就这么被跳过了）。
  let best: { url: string; kept: number; junkKept: number } | null = null;
  for (const template of candidates) {
    const verdict = await judgeTemplate(template);
    if (verdict.note === '预算用尽') break;
    if (verdict.accepted) {
      if (verdict.classHit) {
        return {
          ok: true, searchUrl: template, resultClass: verdict.classHit.cls, tried, diagnostics,
          note: `按容器类名「${verdict.classHit.cls}」命中 ${verdict.classHit.n} 条`
        };
      }
      if (!best || (verdict.kept ?? 0) - (verdict.junkKept ?? 0) > best.kept - best.junkKept) {
        best = { url: template, kept: verdict.kept ?? 0, junkKept: verdict.junkKept ?? 0 };
      }
      // 已经拿到一个可信候选：信噪比足够好就直接用，不再花预算试剩下的
      if ((verdict.kept ?? 0) - (verdict.junkKept ?? 0) >= 10) break;
    }
  }
  if (best) {
    return {
      ok: true, searchUrl: best.url, tried, diagnostics,
      note: `通用解析：减掉导航后剩 ${best.kept} 条（乱串对照 ${best.junkKept} 条）`
    };
  }

  const tail = budgetExceeded ? `（已发 ${tried} 次请求后到时间上限，探测未跑完）` : '';
  return {
    ok: false,
    tried,
    diagnostics,
    note: '没找到可用的站内搜索地址。常见原因：① 该站结果由 JavaScript 动态渲染（抓到的 HTML 里没有结果）；' +
      '② 查询参数名不在已试的这几个里（q/query/search/keyword/wd/word），或结果在别的主机上；' +
      '③ 该站需要登录或被反爬拦截（反爬时连结果标记都会被去掉）。' +
      '最可靠的做法：自己在站内搜一次，把地址栏里的 URL 贴到「站内搜索地址」栏，再把查询词换成 {q}。' + tail
  };
}
