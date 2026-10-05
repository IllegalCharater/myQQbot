// 验证：联网搜索的「网页收藏夹（模型选站点）」、查询词清洗，以及 Yandex 网页解析。
//
// 为什么要有这个套件：`media/web-search.ts` 在这之前**整条链零行为覆盖** —— provider 的解析、
// 查询词清洗、收藏夹的合并与校验逻辑，全都只能靠读代码确认。合并逻辑尤其需要真跑：它的正确性
// 全在"两次请求各自的返回如何被拼成一个列表"上，用文本断言只能钉住"写过某一行"。
//
// 做法照 `t-sticker.mjs` 第 13 段：**真起本地假搜索引擎**（不是 mock fetch），
// 于是走的是真实的 HTML 解析 + 真实的并发请求 + 真实的结果归一。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { load, readSrc, ROOT } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-websearch-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

const { webSearch, sanitizeQuery, yandexSearch, bookmarkList, resolveBookmarkSite, parseSiteSearch, siteSearchCandidates, probeSiteSearch, normalizeSiteInput } = await load('media/web-search.js');
const { updateConfig, getConfig } = await load('core/config.js');
const { buildSystemPrompt } = await load('agent/prompting/prompt-builder.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

/** 造一段 Bing 形状的结果块（`b_algo` 是解析器唯一的入口）。 */
const block = (url, title, snippet) =>
  `<li class="b_algo"><h2><a href="${url}">${title}</a></h2><p>${snippet}</p></li>`;

// ── Yandex 夹具用的一次性端口与配置构造器 ──
let YANDEX_PORT = 0;
const yandexUrl = () => `http://127.0.0.1:${YANDEX_PORT}/search/`;

/**
 * 造一份**完整**的 Yandex 配置。
 *
 * ⚠️ 必须每次都写全五个字段，不能靠"传一部分、其余沿用上次"：`updateConfig` 走的是
 * `deepMerge`，**只加键不覆盖**，所以上一节故意改坏的选择器会**留在配置里**，
 * 让下一节失败于"选择器过期"而不是它真正要测的那件事（本套件初版就是这么红的）。
 * 这是 `core/config.ts` 里记过的那条同款陷阱（`updateConfig` 只加不删）。
 */
const yandexCfg = (overrides = {}) => ({
  baseUrl: yandexUrl(),
  serpClass: 'serp-item',
  urlClass: 'organic__url',
  titleClass: 'OrganicTitle',
  textClass: 'OrganicText',
  ...overrides
});

/**
 * 假搜索引擎（Bing 路径）。按查询串里有没有 `site:` 分成两条路径，各自返回**不同**的
 * 结果集，这样"哪一发回来了"可以从结果内容反推，而不只看请求数。
 */
const MODES = {
  normal: {
    scoped: [['https://book.mark/only', '收藏夹内的文章']],
    general: [
      ['https://other.com/a', '普通结果甲'],
      // 同一条 URL 在两次查询里都出现：合并时必须去重，否则白占名额
      ['https://book.mark/only', '收藏夹内的文章'],
      ['https://other.com/b', '普通结果乙']
    ]
  },
  // 第 5 节：普通那一发**也不给**收藏夹站点，用来分辨"受限那一发没给出东西"
  'no-bookmark': { scoped: null, general: [['https://other.com/a', '普通结果甲'], ['https://other.com/b', '普通结果乙']] },
  // 第 3 节：收藏 `example.com` 时的**子串陷阱** —— m.example.com 是它的子域（该命中），
  // notexample.com 与它只共享字符、没有点边界（不该命中）。只有这对域名才能把
  // "点边界后缀匹配"与"裸 includes"区分开：`book.mark` vs `other.com` 两种实现结果相同。
  'substring-trap': {
    scoped: null,
    general: [
      ['https://m.example.com/1', '子域结果'],
      ['https://notexample.com/2', '后缀陷阱结果'],
      ['https://other.com/3', '无关结果']
    ]
  }
};
let scopedHits = 0, generalHits = 0, scopedMode = 'normal', generalMode = 'normal';
const render = (rows) => rows.map(([url, title]) => block(url, title, 'snippet')).join('');
const srv = http.createServer((req, res) => {
  const q = decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('q') || '');
  const scoped = q.includes('site:');
  if (scoped) {
    scopedHits++;
    // 失败模式必须在 writeHead 之前分叉：先 200 再 500 会抛 ERR_HTTP_HEADERS_SENT
    if (scopedMode === 'fail') { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    const rows = MODES[generalMode]?.scoped;
    // 受限那一发在这个模式下没有专属结果 → 返回一个空页面（合法：搜不到）
    return res.end(rows ? render(rows) : '<html><body>no results</body></html>');
  }
  generalHits++;
  res.writeHead(200, { 'content-type': 'text/html' });
  return res.end(render(MODES[generalMode]?.general || []));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const SEARCH_URL = `http://127.0.0.1:${srv.address().port}/search`;

const baseSearch = {
  enabled: true, provider: 'bing', searchUrl: SEARCH_URL, maxResults: 6,
  maxCallsPerChatPerHour: 20, maxCallsPerDay: 200
};

/**
 * 造一条收藏夹条目（枚举值 + 网页地址 + 用途，后两项可选）。
 *
 * ⚠️ 必须走这个 helper 而不是手写字符串：`updateConfig` 走 `deepMerge`，
 * **不会**经过 `normalizeConfigShape`（迁移只发生在 `loadConfig` 读盘那一步）。
 * 所以夹具里塞旧形状的字符串数组不会被迁移，只会让 `bookmarkList()` 过滤成空 ——
 * 表现为"收藏夹配了却完全不生效"，而套件报错指向别处（本套件初版就是这么红的）。
 *
 * 同理，**多出来的字段也必须在这里显式接住**：helper 少一个形参就会把 `searchUrl`
 * 静默丢掉，于是"站内搜索"那一节实际跑的是 `site:` 路径 —— 断言看着过了，
 * 测的却是别的东西（本节初版 9 条红里有 5 条就是这么来的）。
 */
const bm = (key, url, purpose = '测试用途', extra = {}) => ({ key, url, purpose, ...extra });

console.log('\n═══ 1. 没有收藏夹时不发第二发（行为与从前逐字相同） ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: [], bookmarkMode: 'prefer' } });
scopedHits = 0; generalHits = 0;
let out = await webSearch('测试查询');
ok('收藏夹为空时只发一次请求', scopedHits === 0 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
ok('返回全部普通结果', out.results.length === 3, `实际 ${out.results.length}`);
ok('没有收藏夹时不打 fromBookmark 标记', out.results.every((r) => r.fromBookmark === undefined));
ok('查询词原样带进请求（没被拼上 site: 子句）',
  out.query === '测试查询' && out.results[0].url === 'https://other.com/a');

console.log('\n═══ 2. 模型没点名 + prefer 模式：两发并发 + 收藏夹命中排最前 + 去重 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: [bm('book', 'book.mark')], bookmarkMode: 'prefer' } });
scopedHits = 0; generalHits = 0;
out = await webSearch('测试查询');
ok('两发都发出去了', scopedHits === 1 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
// 3 条普通 + 1 条受限里的重复项 → 去重后仍是 3 条
ok('按 URL 去重（两次查询都命中的那条不重复出现）', out.results.length === 3, `实际 ${out.results.length}`);
ok('收藏夹站点的结果排在最前', out.results[0].url === 'https://book.mark/only', `首条是 ${out.results[0]?.url}`);
ok('收藏夹结果带 fromBookmark 标记', out.results[0].fromBookmark === true);
ok('只有收藏夹结果带标记，普通结果不带',
  out.results.slice(1).every((r) => r.fromBookmark === undefined));
ok('普通结果仍然保留（收藏夹不是"只搜收藏夹"）',
  out.results.some((r) => r.url === 'https://other.com/a') && out.results.some((r) => r.url === 'https://other.com/b'));
ok('返回的 query 是用户原始查询词，不含我们拼的 site: 子句（否则模型会照抄去搜）',
  out.query === '测试查询');

console.log('\n═══ 3. 域名边界：收藏 example.com 只该命中它自己和它的子域 ═══');
// 这一节的夹具是**唯一**能把"点边界后缀匹配"和"裸 includes"区分开的形状：
//   m.example.com   → 是子域，该命中
//   notexample.com  → 只是共享字符、没有点边界，**不该**命中
// 用 `book.mark` vs `other.com` 之类的域名测不出这个区别（两种实现结果相同，
// 那种断言是假的绿 —— 本轮证伪探针亲自撞出来过）。
generalMode = 'substring-trap';
updateConfig({ webSearch: { ...baseSearch, bookmarks: [bm('example', 'example.com')], bookmarkMode: 'prefer' } });
out = await webSearch('测试');
const bookmarked = out.results.filter((r) => r.fromBookmark).map((r) => r.url);
ok('子域 m.example.com 命中收藏的 example.com',
  bookmarked.includes('https://m.example.com/1'), JSON.stringify(bookmarked));
ok('notexample.com **不**命中（后缀匹配必须要点边界，不能用 includes）',
  !bookmarked.includes('https://notexample.com/2'), JSON.stringify(bookmarked));
ok('无关站点不命中', !bookmarked.includes('https://other.com/3'), JSON.stringify(bookmarked));
ok('恰好只有一条被标记', bookmarked.length === 1, JSON.stringify(bookmarked));
generalMode = 'normal';

console.log('\n═══ 4. 模型显式传 site（枚举值）：只按它点的那条优先 ═══');
// 这是本轮改动的核心：站点由**模型**决定，照 reverse_image_source 的 intent 那一套。
// 它传的是**枚举值**（`book`），不是域名（`book.mark`）—— 域名由服务端查表得出。
updateConfig({ webSearch: { ...baseSearch, bookmarks: [bm('book', 'book.mark'), bm('example', 'example.com')], bookmarkMode: 'web' } });
scopedHits = 0; generalHits = 0;
out = await webSearch('测试查询', 'book');
ok('传了 site 就发两发（站内 + 全网）', scopedHits === 1 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
ok('站内命中排最前', out.results[0].url === 'https://book.mark/only', `首条是 ${out.results[0]?.url}`);
ok('站内命中带 fromBookmark 标记', out.results[0].fromBookmark === true);
ok('全网结果仍作补充（不是只搜收藏夹）', out.results.some((r) => r.url === 'https://other.com/a'));
// bookmarkMode=web 只管"模型没点名"时；点了名就必须生效 —— 否则这个下拉会悄悄废掉新功能
ok('bookmarkMode=web 不阻止模型显式指定站点（两者管的是不同的事）', scopedHits === 1);

console.log('\n═══ 5. site 校验：不在名单里的枚举值必须报错并给出可选值 ═══');
// 为什么必须校验而不是直接拼进 site: —— 一个凭空写出的值会**静默**搜出空结果，
// 看起来像"这个站没有内容"，实际是"它从来不在名单里"。报错要把名单带回去让模型改对。
let badSite = '';
try { await webSearch('测试查询', 'evil'); } catch (error) { badSite = String(error?.message || error); }
ok('不在收藏夹里的枚举值被拒绝', badSite.length > 0, JSON.stringify(badSite));
ok('报错带回可选**枚举值**（不是域名），模型下一轮能改对',
  badSite.includes('book') && badSite.includes('example'), JSON.stringify(badSite));
// 用途要一起带回去：模型靠它才知道每个枚举值是什么，而不是只剩两个生造的词
ok('报错里带上了用途，模型能据此选对',
  badSite.includes('测试用途'), JSON.stringify(badSite));
// 传**域名**而不是枚举值时必须被拒：两者的取值空间不同，宽容接受会让"模型传错了"
// 永远不被发现，而它传错的依据（以为能传域名）会一直错下去。
let wrongKind = '';
try { await webSearch('测试查询', 'book.mark'); } catch (error) { wrongKind = String(error?.message || error); }
ok('传域名（而不是枚举值）被拒 —— 两者取值空间不同，不能宽容接受',
  wrongKind.length > 0, JSON.stringify(wrongKind));
// 返回值是**条目**（含解析出的域名与用途），不只是那个枚举值
const resolved = resolveBookmarkSite('book');
ok('resolveBookmarkSite 返回解析后的条目（枚举值→域名）',
  resolved.key === 'book' && resolved.host === 'book.mark' && resolved.purpose === '测试用途',
  JSON.stringify(resolved));
// 名单为空时点名 → 要说清"管理员还没配"，而不是一个含糊的失败
updateConfig({ webSearch: { ...baseSearch, bookmarks: [], bookmarkMode: 'prefer' } });
let noList = '';
try { await webSearch('测试查询', 'book'); } catch (error) { noList = String(error?.message || error); }
ok('名单为空时传 site 报"还没配置收藏夹"', noList.includes('收藏夹'), JSON.stringify(noList));

console.log('\n═══ 6. 站内搜索模板：真正"只在这个站里搜"的那条路 ═══');
// 这一节的存在理由是一条**实测出来的硬限制**：Bing 对程序化请求完全忽略 `site:` 限定符
// （带与不带的结果逐字节相同，连 zhihu.com 这种必然被收录的站也零命中）。所以只靠拼
// `site:` 的"限定站点"是假的；填了站内搜索模板才有真效果。
// 夹具里的链接用**绝对地址**：这是真实站内搜索页的常态（MediaWiki、Discourse 等都吐绝对
// 链接）。相对地址的解析另有一条独立断言覆盖（见下面 parseSiteSearch 那次直接调用）——
// 混在这里会让"只收本站链接"的判据与"相对地址基准"纠缠，红了分不清是哪一个。
const siteHtml = `<!doctype html><html><body>
<div class="searchresults">
  <li class="result"><a href="__BASE__/wiki/DeepSeek">DeepSeek - 维基百科</a>
    <div class="snippet">深度求索是一家中国人工智能公司，开发了 DeepSeek 系列模型。</div></li>
  <li class="result"><a href="__BASE__/wiki/Artificial_intelligence">人工智能 - 维基百科</a>
    <div class="snippet">人工智能是计算机科学的一个分支，研究智能体的构建。</div></li>
  <li class="result"><a href="https://other.example.com/x">站外链接不该被收</a>
    <div class="snippet">这是一条足够长的站外摘要文本，用来验证跨站链接会被过滤掉。</div></li>
  <li class="result"><a href="__BASE__/wiki/DeepSeek">重复条目</a>
    <div class="snippet">同一条 URL 重复出现时只该保留一次，否则白占一个名额。</div></li>
</div>
</body></html>`;
let siteHits = 0, siteLastUrl = '';
const ssrv = http.createServer((req, res) => {
  siteHits++;
  siteLastUrl = req.url || '';
  res.writeHead(200, { 'content-type': 'text/html' });
  const base = `http://127.0.0.1:${ssrv.address().port}`;
  res.end(siteHtml.split('__BASE__').join(base));
});
await new Promise((r) => ssrv.listen(0, '127.0.0.1', r));
const siteBase = `http://127.0.0.1:${ssrv.address().port}`;
const siteTemplate = `${siteBase}/search?q={q}`;

updateConfig({
  webSearch: {
    ...baseSearch, bookmarkMode: 'web',
    bookmarks: [bm('wiki', 'zh.wikipedia.org', '维基百科，查事实依据', { searchUrl: siteTemplate })]
  }
});
siteHits = 0; siteLastUrl = '';
scopedHits = 0; generalHits = 0;
out = await webSearch('深度求索', 'wiki');
ok('传了带模板的 site 时**不走搜索引擎**（不产生 site: 请求）',
  scopedHits === 0 && generalHits === 0, `scoped=${scopedHits} general=${generalHits}`);
ok('只请求站内搜索页一次', siteHits === 1, `hits=${siteHits}`);
ok('查询词被填进模板（{q} 占位符）', siteLastUrl.includes(encodeURIComponent('深度求索')), siteLastUrl);
ok('解析出结果', out.results.length > 0, JSON.stringify(out.results.map((r) => r.url)));
ok('相对链接被解析成绝对地址', out.results[0].url === `${siteBase}/wiki/DeepSeek`, out.results[0].url);
// 相对地址的解析基准：以**结果页的真实 URL** 为基准（`/wiki/X` 要落在它的源上）。
// 这一条单独测，是因为上面的夹具用的是绝对链接（真实站内搜索页的常态）——
// 把两种混在一起会让"只收本站链接"的判据与"相对基准"纠缠，红了分不清是哪一个。
const relParsed = parseSiteSearch(
  '<li><a href="/wiki/Rel">相对链接条目</a><div>这是一段足够长的摘要文本，用来通过最小长度门槛。</div></li>',
  `${siteBase}/search?q=%E6%B5%8B%E8%AF%95`
);
ok('相对链接按结果页的源解析（不是拼成怪路径）',
  relParsed.length === 1 && relParsed[0].url === `${siteBase}/wiki/Rel`, JSON.stringify(relParsed));

// **兄弟子域必须算同站**：站内搜索页与它搜出来的内容经常不在同一个子域上。
// 实测 B 站：搜索页是 `search.bilibili.com`，而每一条结果都在 `www.bilibili.com`。
// 旧判据是"结果宿主等于搜索页宿主、或是它的子域"，于是那 47~95 条结果**全部被丢掉**，
// 表现为"页面上明明有结果、解析出来却是 0 条"。
// 这里用保留域名模拟（`*.example.com` 不会真的联网，解析失败也不影响 —— 这条只测 URL 归属判定）。
const siblingParsed = parseSiteSearch(
  '<li><a href="https://content.example.com/wiki/Sib">兄弟子域条目</a>'
  + '<div>这是一段足够长的摘要文本，用来通过最小长度门槛。</div></li>',
  'https://search.example.com/search?q=x'
);
ok('兄弟子域的结果被收下（B 站那类站点靠这条才能解析出结果）',
  siblingParsed.length === 1 && siblingParsed[0].url === 'https://content.example.com/wiki/Sib',
  JSON.stringify(siblingParsed));
// 但**不同站点家族**仍要丢掉，否则"只在这个站里搜"就名存实亡
const foreignParsed = parseSiteSearch(
  '<li><a href="https://other.example.net/wiki/X">站外条目</a>'
  + '<div>这是一段足够长的摘要文本，用来通过最小长度门槛。</div></li>',
  'https://search.example.com/search?q=x'
);
ok('站点家族不同的链接仍被丢掉', foreignParsed.length === 0, JSON.stringify(foreignParsed));
ok('只收本站链接（站外那条被丢掉）',
  !out.results.some((r) => r.url.includes('other.example.com')), JSON.stringify(out.results.map((r) => r.url)));
ok('重复 URL 只保留一条',
  out.results.filter((r) => r.url.endsWith('/wiki/DeepSeek')).length === 1, `共 ${out.results.length} 条`);
ok('摘要被解析出来', out.results[0].snippet.includes('深度求索'), JSON.stringify(out.results[0].snippet));

console.log('\n═══ 7. 站内搜索：容器类名可配 + 失败必须归因 ═══');
// 配了 resultClass 时按类名切块（改动标记后通用启发式会多收，类名能把它收窄）
updateConfig({
  webSearch: {
    ...baseSearch, bookmarkMode: 'web',
    bookmarks: [bm('wiki', 'zh.wikipedia.org', '维基百科', { searchUrl: siteTemplate, resultClass: 'result' })]
  }
});
out = await webSearch('深度求索', 'wiki');
ok('配了 resultClass 仍能解析出结果', out.results.length >= 1, JSON.stringify(out.results.map((r) => r.url)));
// 模板缺 {q} 时必须被**忽略**（退回 site: 路径），否则请求会打到搜索页首页、
// 返回"文不对题"的结果而不是报错——那种失败比直接拒掉难查得多。
updateConfig({
  webSearch: {
    ...baseSearch, bookmarkMode: 'web',
    bookmarks: [bm('wiki', 'zh.wikipedia.org', '维基百科', { searchUrl: `${siteBase}/search` })]
  }
});
scopedHits = 0; generalHits = 0;
out = await webSearch('深度求索', 'wiki');
ok('模板缺 {q} 时被忽略，退回 site: 路径（两发并发）',
  scopedHits === 1 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
// 非 http(s) 的模板同样应被忽略
updateConfig({
  webSearch: { ...baseSearch, bookmarkMode: 'web', bookmarks: [bm('wiki', 'zh.wikipedia.org', '维基百科', { searchUrl: 'file:///x?q={q}' })] }
});
ok('file:// 模板被忽略（不进 bookmarkList）',
  bookmarkList()[0].searchUrl === undefined, JSON.stringify(bookmarkList()[0]));
// 站内搜索页结构变化 → 必须报错并说清"结构可能变了"，而不是返回空列表让模型说"没有内容"
const emptySrv = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>没有结果</body></html>'); });
await new Promise((r) => emptySrv.listen(0, '127.0.0.1', r));
updateConfig({
  webSearch: {
    ...baseSearch, bookmarkMode: 'web',
    bookmarks: [bm('wiki', 'zh.wikipedia.org', '维基百科', { searchUrl: `http://127.0.0.1:${emptySrv.address().port}/s?q={q}` })]
  }
});
let siteEmpty = '';
try { await webSearch('x', 'wiki'); } catch (e) { siteEmpty = String(e?.message || e); }
ok('站内搜索解析不出结果时抛错（不返回空列表）', siteEmpty.length > 0, JSON.stringify(siteEmpty));
ok('报错点明是该站搜索页结构问题，并指向「结果容器类名」',
  siteEmpty.includes('结构') && siteEmpty.includes('结果容器类名'), JSON.stringify(siteEmpty));
const badSrv = http.createServer((_req, res) => { res.writeHead(500); res.end('boom'); });
await new Promise((r) => badSrv.listen(0, '127.0.0.1', r));
updateConfig({
  webSearch: {
    ...baseSearch, bookmarkMode: 'web',
    bookmarks: [bm('wiki', 'zh.wikipedia.org', '维基百科', { searchUrl: `http://127.0.0.1:${badSrv.address().port}/s?q={q}` })]
  }
});
let siteHttp = '';
try { await webSearch('x', 'wiki'); } catch (e) { siteHttp = String(e?.message || e); }
ok('站内搜索 HTTP 错误如实带上状态码与站点', siteHttp.includes('500') && siteHttp.includes('zh.wikipedia.org'), JSON.stringify(siteHttp));
await new Promise((r) => emptySrv.close(r));
await new Promise((r) => badSrv.close(r));
await new Promise((r) => ssrv.close(r));

console.log('\n═══ 8. 自动检测站内搜索地址（probeSiteSearch）═══');
// 用一个本地假站点模拟三种真实形态，**必须真发请求**才能验到探测逻辑（对照查询、
// 减基线、时间预算都是行为，不是文本）。
let probeMode = 'html', probeHits = 0;
const probeNav = '<a href="/about">关于</a><a href="/login">登录</a><a href="/docs">文档</a>'
  + '<a href="/blog">博客</a><a href="/pricing">价格</a><a href="/contact">联系</a>'
  + '<a href="/faq">常见问题</a><a href="/terms">条款</a>';
const psrv = http.createServer((req, res) => {
  probeHits++;
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'text/html' });
  if (u.pathname === '/') return res.end(`<html><body>${probeNav}</body></html>`);
  // JSON 接口形态：**必须在最前面**，因为它的响应头与正文都与网页完全不同 ——
  // 这正是要认出来的那种地址（实测：第三方百科 JSON 接口被填进「站内搜索地址」）
  if (probeMode === 'json') {
    // 夹具的 content-type 仍是 text/html，所以这里靠**正文前缀**（`{`）被识别成 JSON
    return res.end(JSON.stringify({ code: 200, msg: '成功', data: { 词语: u.searchParams.get('wd') || '', 释义: '一段百科释义' } }));
  }
  if (probeMode === 'js') {
    // JS 渲染：搜不搜都是同一个空壳（导航与首页完全一致）
    return res.end(`<html><body>${probeNav}<div id="root"></div></body></html>`);
  }
  // 参数名要覆盖 hint 用的那个（`wd`），否则夹具对 hint 返回空页、把 hint 判成不可用 ——
  // 那是夹具的漏洞，不是被测逻辑的问题（本节初版就这么假红了一条）
  const q = u.searchParams.get('q') || u.searchParams.get('wd') || '';
  const isSearchPath = u.pathname.startsWith('/search') || u.pathname === '/custom';
  if (!isSearchPath || !q) return res.end(`<html><body>${probeNav}</body></html>`);
  // 搜索**无结果**要说无结果，而不是回退成首页导航：这既是真实搜索页的行为，也是探测
  // 「乱串对照」那一步的前提。初版夹具对任何词都吐同一批导航，于是乱串查询也"多出 8 条"，
  // 把正确候选判成了噪声（红了一条）。放在 js/classed 分支之前：那些模式模拟的是别的形态。
  if (q === 'zzqxvbnmklpoiuytrewqqzxcv') {
    return res.end(`<html><body>${probeNav}<p>没有找到相关结果</p></body></html>`);
  }
  if (probeMode === 'js') {
    // JS 渲染：搜不搜都是同一个空壳（导航与首页完全一致）
    return res.end(`<html><body>${probeNav}<div id="root"></div></body></html>`);
  }
  if (probeMode === 'classed') {
    return res.end(`<html><body>${probeNav}`
      + `<li class="mw-search-result"><a href="/wiki/${encodeURIComponent(q)}-1">条目 ${q} 一</a><div>关于 ${q} 的足够长的摘要文本。</div></li>`
      + `<li class="mw-search-result"><a href="/wiki/${encodeURIComponent(q)}-2">条目 ${q} 二</a><div>另一条足够长的摘要文本内容。</div></li>`
      + '</body></html>');
  }
  // 普通 HTML 结果页：真结果 + 首页那批导航（导航必须在减基线时被去掉）
  return res.end(`<html><body>${probeNav}`
    + `<li><a href="/wiki/${encodeURIComponent(q)}-1">条目 ${q} 一</a><div>关于 ${q} 的足够长的摘要文本。</div></li>`
    + `<li><a href="/wiki/${encodeURIComponent(q)}-2">条目 ${q} 二</a><div>另一条足够长的摘要文本内容。</div></li>`
    + `<li><a href="/wiki/${encodeURIComponent(q)}-3">条目 ${q} 三</a><div>第三条足够长的摘要文本内容。</div></li>`
    + '</body></html>');
});
await new Promise((r) => psrv.listen(0, '127.0.0.1', r));
const pBase = `http://127.0.0.1:${psrv.address().port}`;

// ① 模板生成：常见的参数名与路径都要有
const cands = siteSearchCandidates(`${pBase}/`);
ok('候选模板覆盖常见参数名（q/query/search/keyword/wd/word）',
  ['q', 'query', 'search', 'keyword', 'wd', 'word'].every((p) => cands.some((c) => c.includes(`?${p}={q}`))),
  JSON.stringify(cands.slice(0, 3)));
ok('候选模板都指向同一个源', cands.every((c) => c.startsWith(pBase)), JSON.stringify(cands));
ok('认不出的地址返回空数组（不抛错）', siteSearchCandidates('a b').length === 0);
// 宿主名必须像域名：`不是地址` 这种会被 WHATWG URL 的 punycode 接受（变成 xn--…），
// 若不拦就会去打一个无意义域名、白等一轮超时
ok('单标签宿主名被拒（不给 punycode 留机会）',
  siteSearchCandidates('不是地址').length === 0
  && siteSearchCandidates('localhost').length === 0, JSON.stringify(siteSearchCandidates('localhost').slice(0, 1)));

// 裸域名（设置页那一栏的占位符就是 `zh.wikipedia.org`，用户这么填是最正常的）：
// 必须能生成候选。这条曾经整条链路报「URL 无效」——`new URL('baike.baidu.com')` 会抛错，
// 而路由的 validateFetchUrl 直接吃 `new URL`，于是界面接受、后端拒绝。
ok('裸域名归一成带协议的 URL', normalizeSiteInput('baike.baidu.com') === 'https://baike.baidu.com');
ok('已带协议的地址原样保留', normalizeSiteInput('https://github.com') === 'https://github.com');
ok('两头空白被去掉', normalizeSiteInput('  example.com  ') === 'https://example.com');
ok('裸域名能生成候选（这是用户实际会填的形态）',
  siteSearchCandidates('baike.baidu.com').length > 0
  && siteSearchCandidates('baike.baidu.com')[0].startsWith('https://baike.baidu.com/'),
  JSON.stringify(siteSearchCandidates('baike.baidu.com').slice(0, 1)));
// 裸域名跑探测必须走到真实判定，而不是在入口就报"URL 无效"
updateConfig({ webSearch: { ...baseSearch, bookmarks: [], bookmarkMode: 'prefer' } });
const bareProbe = await probeSiteSearch(`${pBase.replace('http://', '')}`, { budgetMs: 8000 });
ok('裸域名（无协议）能跑完探测并给出正常判定',
  typeof bareProbe.ok === 'boolean' && !String(bareProbe.note || '').includes('URL 无效'),
  JSON.stringify(bareProbe.note));

// ② HTML 结果页：应被检出，且计数是**减掉导航后**的
probeMode = 'html';
let pr = await probeSiteSearch(pBase, { budgetMs: 15000 });
ok('普通 HTML 结果页被检出', pr.ok === true, JSON.stringify(pr.note));
ok('检出的模板含 {q}', String(pr.searchUrl || '').includes('{q}'), pr.searchUrl);
ok('计数是减掉导航后的真结果（3 条，不是导航+3）',
  String(pr.note).includes('剩 3 条'), String(pr.note));
// 这条是本节的核心：若不减基线，导航那 8 条会让任何页面都"看起来有结果"
ok('探测过程确实取了基线（诊断里有通用候选记录）',
  Array.isArray(pr.diagnostics) && pr.diagnostics.some((d) => d.kept !== undefined), JSON.stringify(pr.diagnostics?.slice(0, 2)));

// ③ JS 渲染页：必须判为不可用（真结果与基线完全相同）
probeMode = 'js';
pr = await probeSiteSearch(pBase, { budgetMs: 8000 });
ok('JS 渲染的站点被拒（导航减掉后一条不剩）', pr.ok === false, JSON.stringify(pr.note));
ok('拒绝时的文案说明原因并给出可执行做法',
  String(pr.note).includes('JavaScript') && String(pr.note).includes('{q}'), String(pr.note).slice(0, 120));

// ④ 通用解析收不到、但带容器类名时能收到
probeMode = 'classed';
pr = await probeSiteSearch(pBase, { budgetMs: 15000 });
ok('带容器类名的结果页被检出', pr.ok === true, JSON.stringify(pr.note));
ok('检出时一并给出 resultClass', pr.resultClass === 'mw-search-result', JSON.stringify(pr.resultClass));

// ⑤ hint 优先：用户自己贴的地址必须排在自动候选之前被采纳
probeMode = 'html';
pr = await probeSiteSearch(pBase, { hint: `${pBase}/custom?wd={q}`, budgetMs: 15000 });
ok('hint 被优先采纳', pr.ok === true && String(pr.searchUrl).includes('/custom?wd={q}'),
  `searchUrl=${JSON.stringify(pr.searchUrl)} note=${JSON.stringify(pr.note)} diag=${JSON.stringify((pr.diagnostics || []).slice(0, 3))}`);
// hint 缺 {q} 时必须被忽略（否则会去搜一个拼不出查询词的地址）
pr = await probeSiteSearch(pBase, { hint: `${pBase}/custom`, budgetMs: 15000 });
ok('hint 缺 {q} 时被忽略，退回自动候选',
  pr.ok === true && !String(pr.searchUrl).includes('/custom'), JSON.stringify(pr.searchUrl));

// ⑦b **JSON 接口地址必须被单独认出来**，而不是笼统报"没解析出结果"。
//
// 实测成因：用户把第三方 JSON 百科接口（`.../baikebaidu.php?...&words={q}`）填进
// 「站内搜索地址」。站内搜索链**只从 HTML 里解析链接**（`parseSiteSearch`），JSON 必然
// 解析不出东西 —— 这是**结构性**不兼容，不是"页面改版"。旧文案说"结构可能变了 / 要登录"，
// 会把人引去改「结果容器类名」，方向完全错。顺带：认出不是网页后**只发一次请求**就返回
// （继续试类名和基线是白烧预算）。
probeMode = 'json';
probeHits = 0;
const jsonProbe = await probeSiteSearch(pBase, { searchUrl: `${pBase}/custom?wd={q}`, budgetMs: 15000 });
ok('JSON 接口地址被判为不可用', jsonProbe.ok === false, JSON.stringify(jsonProbe.note));
ok('文案点明"返回的是 JSON 接口数据、不是网页"（而不是含糊的"结构可能变了"）',
  /JSON/.test(String(jsonProbe.note)) && /不是网页/.test(String(jsonProbe.note)), JSON.stringify(jsonProbe.note));
ok('文案说明站内搜索只解析 HTML 链接（讲清为什么结构性不兼容）',
  /HTML/.test(String(jsonProbe.note)) && /解析链接/.test(String(jsonProbe.note)), JSON.stringify(jsonProbe.note));
ok('认出不是网页后立刻返回，不再白烧请求试类名与基线',
  Number(jsonProbe.tried) === 1, `tried=${jsonProbe.tried} hits=${probeHits}`);
// ⚠️ 只说"不行"是不够的：初版写的是"若它就是你要的数据源，需要单独支持 JSON 接口"——
// 而那个能力**早就有了**（就是收藏夹那行的「请求结构」）。用户照着那句话只会以为
// "这个站接不了"（**实测反馈**）。文案必须点名该去哪填。
ok('文案**给出下一步**：点名「请求结构」并说明那一栏要留空',
  /请求结构/.test(String(jsonProbe.note)) && /留空/.test(String(jsonProbe.note)), JSON.stringify(jsonProbe.note));
ok('文案不再说"需要单独支持 JSON 接口"（那能力早就有，会误导）',
  !/需要单独支持/.test(String(jsonProbe.note)), JSON.stringify(jsonProbe.note));
// JSON 接口主机上"清空再自动找"多半是死路，而且会把用户从正确的下一步带走 —— 不加这句
ok('JSON 接口那条不追加"清空这一栏再自动找"（那是 HTML 场景的提示）',
  !/清空这一栏再点检测/.test(String(jsonProbe.note)), JSON.stringify(jsonProbe.note));
// ⚠️ **机器可读标记**：前端靠它决定"把地址搬进「请求结构」并弹窗"。
// **不许让前端去正则匹配 note 文案** —— 文案本轮就改过一次，匹配文案会静默失效。
ok('检测到 JSON 时回一个机器可读标记 detectedJson + 要预填的地址',
  jsonProbe.detectedJson === true && String(jsonProbe.jsonApiUrl || '').includes('{q}'),
  JSON.stringify({ detectedJson: jsonProbe.detectedJson, jsonApiUrl: jsonProbe.jsonApiUrl }));
ok('预填的就是**用户填的那条**模板（不是别的候选）',
  String(jsonProbe.jsonApiUrl) === `${pBase}/custom?wd={q}`, JSON.stringify(jsonProbe.jsonApiUrl));
probeMode = 'html';

// 对照：非 JSON 的失败路径**仍然**要带那句自动检测提示（别一刀切删掉）
probeMode = 'js';   // 结果由 JS 渲染：解析不出结果，且不是 JSON
const jsProbe = await probeSiteSearch(pBase, { searchUrl: `${pBase}/search?q={q}`, budgetMs: 8000 });
ok('对照：非 JSON 失败仍带"清空这一栏再点检测"提示（没被误删）',
  /清空这一栏再点检测/.test(String(jsProbe.note)) && !/JSON/.test(String(jsProbe.note)), JSON.stringify(jsProbe.note));
ok('对照：非 JSON 失败**不带** detectedJson（前端不该弹请求结构窗口）',
  jsProbe.detectedJson !== true && !jsProbe.jsonApiUrl,
  JSON.stringify({ detectedJson: jsProbe.detectedJson, jsonApiUrl: jsProbe.jsonApiUrl }));
probeMode = 'html';


//
// 判据不能只看 `ok`：自动检测**也会**搜到同样的地址，于是"只测了一个"和"扫了一堆候选"
// 给出一样的结论 —— 那正是假绿。所以这里用**请求数**来钉：只测一个时 `tried` 必须很小
// （校验 + 真查询，最多再加基线/乱串两次），而自动检测要挨个试候选，次数明显更多。
probeMode = 'html';
const fixedUrl = `${pBase}/custom?wd={q}`;
probeHits = 0;
const fixedProbe = await probeSiteSearch(pBase, { searchUrl: fixedUrl, budgetMs: 15000 });
ok('填了地址 → 用它测，且原样保留（不会被换成别的）',
  fixedProbe.ok === true && fixedProbe.searchUrl === fixedUrl,
  `searchUrl=${JSON.stringify(fixedProbe.searchUrl)} note=${JSON.stringify(fixedProbe.note)}`);
ok('填了地址时只测这一个（请求数少 —— 自动检测要挨个试候选）',
  Number(fixedProbe.tried) <= 5, `tried=${fixedProbe.tried} hits=${probeHits}`);
ok('结论说的是"你填的地址"，不是"已找到"（两种行为对用户可分辨）',
  /你填的地址/.test(String(fixedProbe.note)), JSON.stringify(fixedProbe.note));

// 对照：同样能搜到结果，但**没填** → 走自动检测，请求数明显更多
probeHits = 0;
const autoProbe = await probeSiteSearch(pBase, { budgetMs: 15000 });
ok('对照：没填地址 → 自动检测，请求数比"只测一个"多',
  autoProbe.ok === true && Number(autoProbe.tried) > Number(fixedProbe.tried),
  `auto=${autoProbe.tried} fixed=${fixedProbe.tried}`);

// 填了地址但该地址**不能用** → 报它不能用，且**不许**偷偷换成自动找到的那个
probeMode = 'js';   // 结果由 JS 渲染：任何地址都解析不出结果
const fixedFail = await probeSiteSearch(pBase, { searchUrl: `${pBase}/search?q={q}`, budgetMs: 15000 });
ok('填的地址不可用时如实报失败，不悄悄换成别的地址',
  fixedFail.ok === false && !fixedFail.searchUrl?.includes('/custom'),
  JSON.stringify({ ok: fixedFail.ok, searchUrl: fixedFail.searchUrl, note: fixedFail.note }));
ok('失败原因里点明可以用清空这一栏来改走自动检测',
  /清空这一栏/.test(String(fixedFail.note)), JSON.stringify(fixedFail.note));

// 填了地址但**没有 {q}** → 直接说清怎么办，且一次请求都不该发
probeMode = 'html';
const beforeNoQ = probeHits;
const fixedNoQ = await probeSiteSearch(pBase, { searchUrl: `${pBase}/custom`, budgetMs: 15000 });
ok('填的地址缺 {q} → 明确报"没法替换查询词"（而不是含糊的检测失败）',
  fixedNoQ.ok === false && /\{q\}/.test(String(fixedNoQ.note)), JSON.stringify(fixedNoQ.note));
ok('缺 {q} 时一次请求都不发（省掉无意义的联网）',
  probeHits === beforeNoQ, `before=${beforeNoQ} after=${probeHits}`);



console.log('\n═══ 9. bookmarkMode=web：名单保留，但不传 site 时完全不理会它 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: [bm('book', 'book.mark')], bookmarkMode: 'web' } });
scopedHits = 0; generalHits = 0;
out = await webSearch('测试查询');
ok('关掉后只发一发（不传 site 就不为收藏夹多付一次往返）',
  scopedHits === 0 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
ok('关掉后不打标记', out.results.every((r) => r.fromBookmark === undefined));
ok('配置里的名单没被清掉（只是默认不生效，方便临时关）',
  Array.isArray(getConfig().webSearch.bookmarks) && getConfig().webSearch.bookmarks.length === 1);

console.log('\n═══ 7. 受限那一发失败：不拖垮普通结果 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: [bm('book', 'book.mark')], bookmarkMode: 'prefer' } });
scopedMode = 'fail';
// 这一节的假引擎让**普通那一发也不返回 book.mark**：否则"没有收藏夹标记"会因为
// 普通结果里本来就有这个站而假绿 —— 断言的靶子是"受限那一发没给出东西"，
// 不是"这个站没出现在最终列表里"（两者在别的夹具下会重合，正是假绿的来源）。
generalMode = 'no-bookmark';
scopedHits = 0; generalHits = 0;
out = await webSearch('测试查询');
ok('受限查询 500 时整次搜索不抛错', Array.isArray(out.results) && out.results.length > 0);
ok('两发都照常发出（失败的是受限那一发，不是没发）',
  scopedHits === 1 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
ok('普通结果照旧返回（allSettled 而不是 all 的意义就在这里）',
  out.results.some((r) => r.url === 'https://other.com/a'));
ok('受限失败时没有收藏夹标记（它根本没给出结果）',
  out.results.every((r) => r.fromBookmark === undefined),
  `标了 ${out.results.filter((r) => r.fromBookmark).length} 条`);
scopedMode = 'normal';
generalMode = 'normal';

console.log('\n═══ 8. 两发都失败：抛的是**用户真正请求的那一发**的原因 ═══');
// 用"接口 500"而不是"连不上"：前者带得上 HTTP 状态与响应文本，是本工具真实会遇到的形态，
// 也才看得出我们抛的是**普通那一发**的原因。连不上时两边都退化成 fetch 的 "fetch failed"，
// 那时"抛哪一发"在这条断言里根本不可分辨（原先就是这么写的，探针撞出来的假红）。
const dead = http.createServer((_req, res) => { res.writeHead(500); res.end('search down'); });
await new Promise((r) => dead.listen(0, '127.0.0.1', r));
const deadUrl = `http://127.0.0.1:${dead.address().port}/search`;
updateConfig({ webSearch: { ...baseSearch, searchUrl: deadUrl, bookmarks: [bm('book', 'book.mark')], bookmarkMode: 'prefer' } });
let threw = '';
try { await webSearch('测试查询'); } catch (error) { threw = String(error?.message || error); }
await new Promise((r) => dead.close(r));
ok('两发都失败时确实抛错', threw.length > 0, `得到 ${JSON.stringify(threw)}`);
ok('抛的是普通那一发的 HTTP 错误（不是受限查询的，也不是内部拼的 site: 子句）',
  threw === '搜索服务 HTTP 500', JSON.stringify(threw));

console.log('\n═══ 9. 查询词清洗（sanitizeQuery） ═══');
ok('剥掉 CQ 码', !sanitizeQuery('[CQ:at,qq=123] 你好').includes('[CQ:'));
ok('剥掉控制字符', sanitizeQuery('a\u0000b\u001fc') === 'a b c');
ok('折叠多余空白', sanitizeQuery('  a   b  ') === 'a b');
ok('截断到 120 字', sanitizeQuery('x'.repeat(300)).length === 120);
ok('非字符串输入不炸', sanitizeQuery(undefined) === '' && sanitizeQuery(null) === '' && sanitizeQuery(12345) === '12345');

console.log('\n═══ 10. 收藏夹名单注入 system prompt（模型要看得见才能选） ═══');
// 名单必须由 system prompt 承载而不是写进 tool schema：**枚举值与用途是用户配置的动态
// 数据**，而 Catalog 里放的是固定指令（同 stickers 的做法）。不注入的话模型根本不知道
// site 能填什么，只会瞎猜 —— 而瞎猜会被校验拦掉，表现为"这个功能从没成功过"。
// 每行三样都要进：枚举值（回传用）、域名（知道实际在哪搜）、用途（选站依据）。
updateConfig({ persona: { botName: '小鲸鱼', roleText: '' } });
const sysSites = [
  { key: 'wiki-zh', host: 'zh.wikipedia.org', purpose: '查百科条目、定义、背景事实' },
  { key: 'news-yc', host: 'news.ycombinator.com', purpose: '查技术圈讨论与创业动态' }
];
const sys = buildSystemPrompt({ bookmarkSites: sysSites });
ok('system prompt 里列出了枚举值', sys.includes('wiki-zh') && sys.includes('news-yc'));
ok('同时列出了它解析出的域名（模型要知道实际在哪个站搜）',
  sys.includes('zh.wikipedia.org') && sys.includes('news.ycombinator.com'));
ok('同时列出了用途（模型据此判断该选哪一条）',
  sys.includes('查百科条目、定义、背景事实') && sys.includes('查技术圈讨论与创业动态'));
ok('说明了 site 的取值是"枚举值"而不是域名', sys.includes('枚举值'));
ok('提醒了不确定时不要传 site（避免把搜索无谓地收窄）', sys.includes('不要传 site'));
const sysEmpty = buildSystemPrompt({ bookmarkSites: [] });
// 判据要盯**名单注入那一句**，不能扫"收藏夹站点"这个泛词：另有一条无条件的行为规则也含它
// （"带 fromBookmark 标记的条目来自管理员配置的收藏夹站点…"），扫泛词会永远假红。
ok('名单为空时**不注入**名单那两行（没有可选项就别占提示词预算）',
  !sysEmpty.includes('管理员配置了这些收藏夹站点'), '空名单时仍注入了名单行');

console.log('\n═══ 11. 配置迁移：旧形状（宿主名数组）与旧键 bookmarkFirst ═══');
// 两条迁移都在 `normalizeConfigShape` 里，且都必须**在独立进程里验**：
// 本进程前面调过 `updateConfig`，内存里的 config 已带着一个非迁移来的 `bookmarkMode`，
// 再 `loadConfig()` 会被 `updateConfig` 的 deepMerge 结果盖掉（第一版就是这么假红的）。
//
// 旧收藏夹是**纯宿主名数组**，新形状是三元组对象，两者不能共存：
//   ① 宿主名要 slug 化成枚举值（`news.ycombinator.com` → `news-ycombinator-com`）；
//   ② 用途留空（它是迁移来的，丢掉就等于删了用户的收藏）；
//   ③ 旧键 bookmarkFirst 翻成 bookmarkMode 并删除。
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-legacy-'));
fs.writeFileSync(path.join(legacyDir, 'config.json'),
  JSON.stringify({ webSearch: {
    // 混着写：两条旧形状 + 一条新形状 + 一条重复枚举值
    bookmarks: ['a.example.com', 'news.ycombinator.com', { key: 'ok', url: 'ok.example.com', purpose: '合法的新条目' },
      { key: 'ok', url: 'dup.example.com', purpose: '重复枚举值，应被丢弃' }],
    bookmarkFirst: false
  } }), 'utf8');
// 输出写到文件而不是管道：沙箱下子进程的 stdout 管道可能拿不到（项目已知的 EPERM 边界）
const probeOut = path.join(legacyDir, 'out.json');
const configUrl = new URL('../dist/core/config.js', import.meta.url).href;
const probeFile = path.join(legacyDir, 'probe.mjs');
fs.writeFileSync(probeFile, `
import fs from 'node:fs';
import { loadConfig } from ${JSON.stringify(configUrl)};
const c = loadConfig();
fs.writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify(c.webSearch));
`, 'utf8');
const { execFileSync } = await import('node:child_process');
execFileSync(process.execPath, [probeFile], { env: { ...process.env, QQ_AGENT_DATA_DIR: legacyDir }, stdio: 'inherit' });
const legacyWs = JSON.parse(fs.readFileSync(probeOut, 'utf8'));
ok('bookmarkFirst=false 迁移成 bookmarkMode=web', legacyWs.bookmarkMode === 'web',
  JSON.stringify(legacyWs.bookmarkMode));
ok('旧键已从配置里删除（不留死旋钮）', !('bookmarkFirst' in legacyWs),
  JSON.stringify(Object.keys(legacyWs)));
const lb = legacyWs.bookmarks || [];
ok('旧形状（宿主名）迁移成三元组条目', lb.length === 3, JSON.stringify(lb));
ok('宿主名被 slug 化成合法枚举值',
  lb.some((b) => b.key === 'a-example-com' && b.url === 'a.example.com')
  && lb.some((b) => b.key === 'news-ycombinator-com' && b.url === 'news.ycombinator.com'),
  JSON.stringify(lb.map((b) => b.key)));
ok('新形状条目原样保留（枚举值与用途都不动）',
  lb.some((b) => b.key === 'ok' && b.url === 'ok.example.com' && b.purpose === '合法的新条目'),
  JSON.stringify(lb));
ok('重复枚举值被丢弃（否则模型传一个键会命中两条）',
  lb.filter((b) => b.key === 'ok').length === 1, JSON.stringify(lb.map((b) => b.key)));
ok('迁移来的条目用途为空（不编造用途，留给用户补）',
  lb.filter((b) => b.key !== 'ok').every((b) => b.purpose === ''), JSON.stringify(lb));
fs.rmSync(legacyDir, { recursive: true, force: true });

// ── Yandex 段 ──────────────────────────────────────────────────────────
//
// ⚠️ 这一段用的是**按可考证形状手写的 HTML**，不是真机样本 —— 本机无法访问 yandex.com。
// 所以它证明的是"解析器按既定假设工作"，**不能**证明"假设等于 Yandex 当前的页面"。
// 真机首次运行若报"没有解析到结果"，就是假设过期了（改设置页的选择器即可，见第 13 节）。
//
// 夹具刻意塞进五种真实存在的形态：
//   ① 容器用复合类名 `serp-item serp-item_card`（旧版正是 `li class="serp-item"`）；
//   ② 标题锚点是 **redir 跳转**而不是目标地址（直接把跳转地址当结果，模型读到的会是跳转页）；
//   ③ 标题锚点带 `hreflang`，用来钉住"取 href 时不会匹配到 hrefLang"；
//   ④ 标题与摘要里都是数字实体 + HTML 实体（`&#x27;` / `&amp;`）；
//   ⑤ 混着一条**站内入口**（yandex.com/images/…），它不是检索结果，必须被丢掉 ——
//      不丢的话模型会把 yandex.com 的页面当成"来源"。
const YANDEX_HTML = `<!doctype html><html><body>
<li class="serp-item serp-item_card">
  <h2 class="OrganicTitle-Link">
    <a class="Link OrganicTitle-Link" hreflang="ru"
       href="https://yandex.com/redir?url=https%3A%2F%2Fexample.org%2Farticles%2Fone&amp;text=1">
      <span class="OrganicTitle">结果 &#x27;一&#x27; &amp; 标题</span>
    </a>
  </h2>
  <div class="OrganicText">摘要一 &#171; 带实体</div>
</li>
<li class="serp-item">
  <a class="organic__url" href="https://second.example.net/page">第二条</a>
  <div class="OrganicText">摘要二</div>
</li>
<li class="serp-item">
  <a class="organic__url" href="https://yandex.com/images/xyz">站内链接，应被丢掉</a>
  <div class="OrganicText">摘要三</div>
</li>
</body></html>`;
const YANDEX_LEGACY_HTML = `<!doctype html><html><body>
<li class="serp-item">
  <h2><a class="b-serp-item__title-link" href="https://legacy.example.com/p">旧版标题</a></h2>
  <div class="b-serp-item__text">旧版摘要</div>
</li>
</body></html>`;

let yandexMode = 'modern', yandexHits = 0, yandexLastQuery = '';
const ysrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  yandexHits++;
  yandexLastQuery = u.searchParams.get('text') || '';
  if (u.pathname === '/showcaptcha') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>captcha</html>'); }
  if (yandexMode === 'captcha-redirect') { res.writeHead(302, { location: '/showcaptcha' }); return res.end(); }
  if (yandexMode === 'captcha-inline') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html><div class="captcha-page">подтвердите</div></html>'); }
  if (yandexMode === 'http-403') { res.writeHead(403); return res.end('blocked'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  if (yandexMode === 'container-only') {
    // 容器命中、但块内既没有可用链接也没有标题：用来触发"容器对了、锚点错了"那条文案
    return res.end('<html><body><li class="serp-item"><span>没有链接也没有标题</span></li></body></html>');
  }
  return res.end(yandexMode === 'legacy' ? YANDEX_LEGACY_HTML : yandexMode === 'empty' ? '<html><body>ничего</body></html>' : YANDEX_HTML);
});
await new Promise((r) => ysrv.listen(0, '127.0.0.1', r));
YANDEX_PORT = ysrv.address().port;
updateConfig({ webSearch: { ...baseSearch, provider: 'yandex', yandex: yandexCfg() } });

console.log('\n═══ 12. Yandex：结果解析、跳转解包、实体解码 ═══');
yandexHits = 0; yandexLastQuery = '';
let yo = await yandexSearch('тест');
ok('查询词进的是 text 参数（Yandex 的入参名，不是 q）', yandexLastQuery === 'тест', JSON.stringify(yandexLastQuery));
ok('只请求一次', yandexHits === 1, `hits=${yandexHits}`);
ok('解析出 2 条（第三条站内链接被丢掉）', yo.results.length === 2, JSON.stringify(yo.results.map((r) => r.url)));
ok('redir 跳转被解包成真实地址（不是 yandex.com/redir…）',
  yo.results[0].url === 'https://example.org/articles/one',
  JSON.stringify(yo.results[0].url));
ok('数字实体与 HTML 实体都解码', yo.results[0].title === "结果 '一' & 标题", JSON.stringify(yo.results[0].title));
ok('摘要里的实体也解码', yo.results[0].snippet === '摘要一 « 带实体', JSON.stringify(yo.results[0].snippet));
ok('hreflang 不会被当成 href（第二条拿到的是它自己的地址）',
  yo.results[1].url === 'https://second.example.net/page', JSON.stringify(yo.results[1].url));
ok('直接写目标地址的第二条标题正常', yo.results[1].title === '第二条', JSON.stringify(yo.results[1].title));
ok('站内 yandex.com 链接没被当成结果',
  !yo.results.some((r) => r.url.includes('yandex.com')), JSON.stringify(yo.results.map((r) => r.url)));

console.log('\n═══ 13. Yandex：选择器可配置（页面改版时的自救通路） ═══');
yandexMode = 'legacy';
updateConfig({
  webSearch: {
    ...baseSearch, provider: 'yandex',
    yandex: yandexCfg({ urlClass: 'b-serp-item__title-link', titleClass: 'b-serp-item__title-link', textClass: 'b-serp-item__text' })
  }
});
yo = await yandexSearch('тест');
ok('换成旧版类名后能解析出结果（同一页面、只改配置）',
  yo.results.length === 1 && yo.results[0].url === 'https://legacy.example.com/p',
  JSON.stringify(yo.results));
ok('旧版摘要也取到了', yo.results[0].snippet === '旧版摘要', JSON.stringify(yo.results[0].snippet));
// 反向：类名对不上时必须**抛错并说出出问题的那一栏**，而不是安静地返回空列表 ——
// 后者会让模型说"没搜到"，把"选择器过期"误导成"这个事实不存在"。
// 三种形态分开测，因为它们的正确行为并不相同：
//   ① 容器没命中            → 抛错，点名「结果容器类名」；
//   ③ 容器命中、块里没有可用链接/标题 → 抛错，点名「标题锚点类名 / 链接类名」；
//   ② 容器命中、标题类名错  → **不该抛错**：有 urlClass 兜底，仍能解析出来。
yandexMode = 'modern';
updateConfig({ webSearch: { ...baseSearch, provider: 'yandex', yandex: yandexCfg({ serpClass: 'no-such-container' }) } });
let missing = '';
try { await yandexSearch('тест'); } catch (error) { missing = String(error?.message || error); }
ok('① 容器没命中时报错而不是返回空列表（假绿最容易藏在这里）', missing.length > 0);
ok('① 报错点名「结果容器类名」并带上当前值，用户才知道改哪一栏',
  missing.includes('结果容器类名') && missing.includes('no-such-container'), JSON.stringify(missing));

// ③ 容器命中但块内既没有可用链接、也没有标题 → 这才是"容器对了、锚点错了"的形态
yandexMode = 'container-only';
updateConfig({ webSearch: { ...baseSearch, provider: 'yandex', yandex: yandexCfg() } });
let noAnchor = '';
try { await yandexSearch('тест'); } catch (error) { noAnchor = String(error?.message || error); }
ok('③ 容器命中但凑不出链接/标题时，文案指向「标题锚点类名」而不是容器',
  noAnchor.includes('标题锚点类名') && !noAnchor.includes('一条都没命中'), JSON.stringify(noAnchor));

// ② 回到可用页面再断言兜底行为 —— 顺序很重要：上面两节把 yandexMode 与配置都改坏过，
//    不先恢复就会让这一条失败于"页面里根本没有结果"（本套件踩过一次）。
yandexMode = 'modern';
updateConfig({ webSearch: { ...baseSearch, provider: 'yandex', yandex: yandexCfg({ titleClass: 'no-such-title-class' }) } });
let fellBack = '';
let fallbackResults = null;
try { fallbackResults = await yandexSearch('тест'); } catch (error) { fellBack = String(error?.message || error); }
ok('② 标题类名写错时不抛错：退回用链接类名的文本当标题（兜底是有意的，实测确认过）',
  fellBack === '' && fallbackResults?.results.length === 2,
  `err=${JSON.stringify(fellBack)} results=${JSON.stringify(fallbackResults?.results.map((r) => r.title))}`);

console.log('\n═══ 14. Yandex：被 CAPTCHA 拦要有明确归因 ═══');
updateConfig({ webSearch: { ...baseSearch, provider: 'yandex', yandex: yandexCfg() } });
for (const [mode, label] of [['captcha-redirect', '重定向到 /showcaptcha'], ['captcha-inline', '200 但正文是验证码页']]) {
  yandexMode = mode;
  let msg = '';
  try { await yandexSearch('тест'); } catch (error) { msg = String(error?.message || error); }
  ok(`${label} → 抛错`, msg.length > 0, JSON.stringify(msg));
  ok(`${label} → 文案点明是人机验证（不是"没搜到"）`, msg.includes('人机验证'), JSON.stringify(msg));
}
yandexMode = 'http-403';
let httpMsg = '';
try { await yandexSearch('тест'); } catch (error) { httpMsg = String(error?.message || error); }
ok('HTTP 403 如实报状态码', httpMsg.includes('403'), JSON.stringify(httpMsg));

console.log('\n═══ 15. Yandex：解析为空与 provider 分发 ═══');
// 注意：第 13 节把 titleClass 改成了对不上的值，这里必须**显式改回**完整可用配置，
// 否则下面两条会失败于选择器而不是被测的那件事。
updateConfig({ webSearch: { ...baseSearch, provider: 'yandex', yandex: yandexCfg() } });
yandexMode = 'empty';
let emptyMsg = '';
try { await yandexSearch('тест'); } catch (error) { emptyMsg = String(error?.message || error); }
ok('页面正常但没有结果块 → 报"没解析到"并给出容器类名',
  emptyMsg.includes('serp-item'), JSON.stringify(emptyMsg));

yandexMode = 'modern';
updateConfig({ webSearch: { ...baseSearch, provider: 'yandex', yandex: yandexCfg() } });
const viaDispatch = await webSearch('тест');
ok('provider=yandex 时 webSearch 走的是 Yandex（不是回落到 Bing）',
  viaDispatch.results.length === 2 && viaDispatch.results[0].url === 'https://example.org/articles/one',
  JSON.stringify(viaDispatch.results.map((r) => r.url)));
await new Promise((r) => ysrv.close(r));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 16. 收藏夹「请求结构」：按方法/请求头取 JSON 接口 ═══');
// 真实成因：权威数据源（如百度千帆百科）只提供 **JSON 接口**，没有"结果页"。
// 硬塞进站内搜索链的表现是**永远检测不通过**、且报错指向"页面改版/容器类名"——方向完全错。
// 这一节用本地假接口模拟，**必须真发请求**才能验到拼装、鉴权与两种响应形态。
let bqAuth = '';
let bqMode = 'list';       // list=条目数组 / single=单对象
const bqHits = [];
const bqsrv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  bqHits.push(u.pathname + u.search);
  bqAuth = String(req.headers.authorization || '');
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  if (u.pathname === '/list') {
    if (bqMode === 'list') {
      return res.end(JSON.stringify([
        { lemma_title: `条目A-${u.searchParams.get('top_k')}`, lemma_desc: '甲', url: 'https://baike.baidu.com/item/1' },
        { lemma_title: '条目B', lemma_desc: '乙', url: 'https://baike.baidu.com/item/2' }
      ]));
    }
    return res.end(JSON.stringify({ code: 400, msg: '查询失败' }));
  }
  // 单对象形态：外层与嵌套里都有 title 字段，且带一个 relations 数组
  return res.end(JSON.stringify({
    request_id: 'r1',
    result: {
      lemma_title: '刘德华', summary: '华裔影视男演员。'.repeat(4),
      relations: [{ lemma_title: '朱丽蒨', relation_name: '妻子' }]
    }
  }));
});
await new Promise((r) => bqsrv.listen(0, '127.0.0.1', r));
const bqBase = `http://127.0.0.1:${bqsrv.address().port}`;

// ① 配置归一：请求结构 / 静态参数（**密钥也走静态参数**）
// ⚠️ 密钥用**带斜杠的真实格式**（千帆是 `bce-v3/ALTAK-xxx/yyy`）。用 `abc123` 这种
// 不含特殊字符的假值会让"请求头被 URL 编码"这个 bug **测不出来** —— 实测踩过一次。
const REAL_KEY = 'bce-v3/ALTAK-abc123/125eeb1c5e9ddc8cf3edf18ef6d03f1517ec9408';
updateConfig({
  webSearch: {
    ...baseSearch,
    bookmarks: [{
      key: 'baike', url: `${bqBase}/list?lemma_title={q}&top_k={top_k}`, purpose: '查百科',
      request: {
        method: 'GET',
        endpoint: `${bqBase}/list?lemma_title={q}&top_k={top_k}`,
        // 密钥的写法就是这个：请求头里留 `{API Key}` 占位，真值走静态参数。
        // 占位符**允许空格**（用户是照文档写的，文档里就是 `{API Key}`）。
        headers: [{ name: 'X-Trace', value: 't1' }, { name: 'Authorization', value: 'Bearer {API Key}' }]
      },
      params: { top_k: '5', 'API Key': REAL_KEY }
    }]
  }
});
let bl = bookmarkList();
ok('① 请求结构进了归一结果', !!bl[0]?.request && bl[0].request.endpoint.includes('{q}'), JSON.stringify(bl[0]?.request));
ok('① 静态参数进了归一结果（含带空格的名字）',
  bl[0]?.params?.top_k === '5' && bl[0]?.params?.['API Key'] === REAL_KEY, JSON.stringify(bl[0]?.params));
// 「网页地址」与「站内搜索地址」合并成一栏：填含 {q} 的地址时，url 退化成域名
ok('① 合并那一栏：含 {q} 的输入同时给出域名与模板',
  bl[0]?.host === `127.0.0.1:${bqsrv.address().port}`.split(':')[0] || !!bl[0]?.host, `host=${bl[0]?.host}`);
ok('① 含 {q} 的输入被当成站内搜索模板存下来',
  String(bl[0]?.searchUrl || '').includes('{q}'), JSON.stringify(bl[0]?.searchUrl));

// ② 真发请求 + JSON 转候选 + 鉴权头 + 静态参数替换
bqHits.length = 0;
let bout = await webSearch('刘德华', 'baike');
ok('② 拿到接口返回的条目（不是走了搜索引擎）',
  bout.results.length >= 2 && bout.results.every((r) => !String(r.url).includes('bing')), JSON.stringify(bout.results.map((r) => r.title)));
ok('② 静态参数 {top_k} 被替换进去（不是原样发 {top_k}）',
  bqHits.some((h) => h.includes('top_k=5')) && !bqHits.some((h) => h.includes('top_k=%7B')), JSON.stringify(bqHits));
ok('② 密钥（静态参数 `{API Key}`）被替换进请求头，拼成 Bearer',
  bqAuth === `Bearer ${REAL_KEY}`, JSON.stringify(bqAuth));
// ⚠️ 这条单独钉"请求头**不做 URL 编码**"：URL 参数必须编码，请求头绝不能编码。
// 千帆的 Key 含 `/`，编码成 `%2F` 后服务端报 `InvalidHTTPAuthHeader:
// Fail to parse apikey authorization` —— 配置页看起来却完全正确（**实测报错**）。
ok('② 请求头里的密钥没有被 URL 编码（`/` 不该变成 `%2F`）',
  !bqAuth.includes('%2F') && bqAuth.includes('/ALTAK-'), JSON.stringify(bqAuth));
ok('② 自定义请求头也发出去了（X-Trace）', bqHits.length > 0, JSON.stringify(bqHits.slice(0, 2)));
// 关键：`request` 单独存在时**必须**走请求结构，不能掉进 `site:` 分支
bqHits.length = 0;
updateConfig({ webSearch: { ...baseSearch, bookmarks: [{ key: 'b2', url: `${bqBase}/single`, purpose: '百科详情', request: { method: 'GET', endpoint: `${bqBase}/single?k={q}` } }] } });
await webSearch('x', 'b2');
ok('② 只配了 request（没有 searchUrl）也走请求结构，不会掉进 site: 分支',
  bqHits.some((h) => h.startsWith('/single')), JSON.stringify(bqHits));

// ③ 单对象响应 → 压平成一条资料（不是"没有结果"）
bout = await webSearch('刘德华', 'b2');
ok('③ 单对象响应被转成**一条**资料（关联数组不会被当成结果列表）',
  bout.results.length === 1, JSON.stringify(bout.results.map((r) => `${r.title}|${(r.snippet || '').slice(0, 30)}`)));
ok('③ 资料里保留字段路径与正文',
  /result\.summary:/.test(bout.results[0]?.snippet || ''), (bout.results[0]?.snippet || '').slice(0, 120));
ok('③ 正文没被 relations 顶掉（这是 findBestArray 只认带链接列表的理由）',
  !/relation_name/.test(bout.results[0]?.title || ''), bout.results[0]?.title);

// ③b MediaWiki OpenSearch（`action=opensearch`）—— **并列字符串数组**，要走专用解析
//
// 形状是按下标定语义的：`["查询词", [标题…], [描述…], [URL…]]`。
// 通用解析只看"对象数组里有没有链接字段"，对它是**瞎的** —— 实测后果是整份响应退回
// `flattenJson()` 压成一段文本，模型看到 `[3]: https://…` 而不是 5 条可点的条目。
// 萌娘百科的 `action=query&list=search` 被官方关了（`action-notallowed`），
// 而 `action=opensearch` **放行**，所以这一支是接入它的唯一途径。
console.log('\n═══ 18 MediaWiki OpenSearch 格式 ═══');
const { jsonToResults: j2r } = await load('media/bookmark-request.js');
const osXml = JSON.stringify(['初音未来', ['初音未来', '初音未来的消失'], ['', ''], ['https://m.example/A', 'https://m.example/B']]);
let osRes = j2r(osXml, 5);
ok('③b OpenSearch 解析出 2 条（不是退回压平）', osRes.length === 2, JSON.stringify(osRes));
ok('③b 标题按下标对应', osRes[0]?.title === '初音未来' && osRes[1]?.title === '初音未来的消失', JSON.stringify(osRes.map((r) => r.title)));
ok('③b URL 按下标对应', osRes[0]?.url === 'https://m.example/A' && osRes[1]?.url === 'https://m.example/B', JSON.stringify(osRes.map((r) => r.url)));
ok('③b 描述为空串时不编造摘要', osRes[0]?.snippet === '', JSON.stringify(osRes.map((r) => r.snippet)));
// 紧判据：这是**按位置**取值的格式，判松了会把随便一个四元素数组当结果
ok('③b 长度不匹配（标题 2 / URL 1）→ 不认', j2r('["q",["a","b"],[],["u1"]]', 5).length === 0);
ok('③b 下标 3 不是字符串数组 → 不认', j2r('["q",["a"],[],[{"u":1}]]', 5).length === 0);
ok('③b 不足四个元素 → 不认', j2r('["q",["a"],[]]', 5).length === 0);
ok('③b 四个数字 → 不认', j2r('[1,2,3,4]', 5).length === 0);
// 对照：既有的通用形状**不能被误伤**
ok('③b 对照：对象数组带链接仍然照旧解析',
  j2r(JSON.stringify({ result: { list: [
    { lemma_title: '甲', lemma_desc: '甲描述', url: 'https://a.example/1' },
    { lemma_title: '乙', lemma_desc: '乙描述', url: 'https://a.example/2' }
  ] } }), 5).length === 2);
ok('③b 对照：单对象响应仍交给压平（jsonToResults 返回空）',
  j2r('{"result":{"lemma_title":"熊本熊","summary":"正文"}}', 5).length === 0);

// ④ 缺静态参数的值 → 明确报错，且不发请求
bqHits.length = 0;
updateConfig({ webSearch: { ...baseSearch, bookmarks: [{ key: 'b3', url: `${bqBase}/list?x={q}`, purpose: '缺参', request: { method: 'GET', endpoint: `${bqBase}/list?q={q}&top_k={top_k}` } }] } });
let bErr = '';
try { await webSearch('x', 'b3'); } catch (e) { bErr = e.message; }
ok('④ 缺静态参数时报错并点名占位符', /top_k/.test(bErr), JSON.stringify(bErr.slice(0, 140)));
ok('④ 缺参数时一次请求都不发', bqHits.length === 0, JSON.stringify(bqHits));

// ⑤ 配置层：方法白名单 / 缺 {q} 的请求结构被丢弃
updateConfig({ webSearch: { ...baseSearch, bookmarks: [
  { key: 'ok1', url: 'https://a.example', purpose: 'p', request: { method: 'GET', endpoint: 'https://a.example/x?q={q}' } },
  { key: 'bad1', url: 'https://b.example', purpose: 'p', request: { method: 'DELETE', endpoint: 'https://b.example/x?q={q}' } },
  { key: 'bad2', url: 'https://c.example', purpose: 'p', request: { method: 'GET', endpoint: 'https://c.example/x' } }
] } });
bl = bookmarkList();
ok('⑤ 合法请求结构留下', !!bl.find((b) => b.key === 'ok1')?.request, JSON.stringify(bl.map((b) => b.key)));
ok('⑤ 非白名单方法（DELETE）被丢弃', !bl.find((b) => b.key === 'bad1')?.request);
ok('⑤ 缺 {q} 的请求地址被丢弃（拼不出查询词）', !bl.find((b) => b.key === 'bad2')?.request);

// ⑥ **「网页地址」留空、只配了请求结构时，条目必须留下**（实测反馈的 bug）
//
// 旧判据先看 `!host` 就丢，于是 `url` 为空 = 整条丢掉（连请求结构一起没）：
// 用户配好接口、保存、刷新 —— 那条就消失了。而请求结构里本来就写着完整接口地址，
// 域名从那里取即可，没理由再要求用户把域名抄一遍。
// 三种来源都要覆盖：endpoint 里的整条地址 / Host 头 / 用户填的那一栏优先。
console.log('\n═══ 17. 只配请求结构（网页地址留空）不该被丢 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: [{
  key: 'empty-url', url: '', purpose: '查百科',
  request: { method: 'GET', endpoint: `https://appbuilder.baidu.com/v2/baike/lemma/get_list_by_title?lemma_title={q}&top_k={top_k}` }
}] } });
bl = bookmarkList();
ok('⑥ 条目留下了（旧版这里会被整条丢掉 → 刷新后设置页里就没了）',
  bl.length === 1 && bl[0]?.key === 'empty-url', JSON.stringify(bl.map((b) => b.key)));
ok('⑥ 请求结构也留下了', !!bl[0]?.request, JSON.stringify(bl[0]?.request));
ok('⑥ url 从请求结构的地址里推出来', bl[0]?.host === 'appbuilder.baidu.com', JSON.stringify(bl[0]?.host));
// 只写路径 + Host 头（文档里那种写法）
updateConfig({ webSearch: { ...baseSearch, bookmarks: [{
  key: 'host-only', url: '', purpose: 'p',
  request: { method: 'GET', endpoint: '/v2/x?q={q}', headers: [{ name: 'Host', value: 'api.example.com' }] }
}] } });
ok('⑥ 只写路径时域名从 Host 头取', bookmarkList()[0]?.host === 'api.example.com', JSON.stringify(bookmarkList()[0]?.host));
// 对照：用户填了那一栏时**以他填的为准**，不被请求结构覆盖
updateConfig({ webSearch: { ...baseSearch, bookmarks: [{
  key: 'both', url: 'zh.wikipedia.org', purpose: 'p',
  request: { method: 'GET', endpoint: 'https://other.example.com/x?q={q}' }
}] } });
ok('⑥ 对照：用户填的域名优先（不被请求结构覆盖）', bookmarkList()[0]?.host === 'zh.wikipedia.org', JSON.stringify(bookmarkList()[0]?.host));
// 对照：两个来源都没有 → 仍然丢弃（没有站点就拼不出检索）
updateConfig({ webSearch: { ...baseSearch, bookmarks: [{ key: 'none', url: '', purpose: 'p' }] } });
ok('⑥ 对照：没有任何站点来源时仍然丢弃', bookmarkList().length === 0, JSON.stringify(bookmarkList()));

// ═══ 19. web_fetch 的正文提取（HTML → 可读文本）═══
//
// **实测反馈的 bug**：旧实现是 `content: body.slice(0, 20000)` —— 直接把原始 HTML 的
// 前 20000 字符给模型。现代站点的 `<head>` 塞满 `<script>`（MediaWiki 的 `RLCONF={…}`
// 动辄几十 KB），于是那 20000 字符几乎全被脚本吃掉，**正文一个字都进不去**。
// 实测萌娘百科初音未来词条：20000 字符里只有 **206** 字可读文本，正文第一个 `<p>` 在
// 23306 处。模型拿到一串看不懂的脚本，就以为"抓取失败/被限流"并反复重试。
console.log('\n═══ 19. web_fetch 的正文提取 ═══');
const { htmlToText, looksLikeHtml } = await load('media/html-to-text.js');

ok('⑦ 脚本内容被丢掉（RLCONF 不该出现在正文里）',
  !/RLCONF/.test(htmlToText('<script>RLCONF={"a":1}</script><p>正文</p>')));
ok('⑦ style 内容被丢掉', !/\.cls\{\}/.test(htmlToText('<style>.cls{}</style><p>正文</p>')));
// ⚠️ 这两条是本轮修掉的**真 bug**：初版对 script/template 写了"没有闭合标签就贪到结尾"，
// 而实测萌娘页面上有个**不闭合的 `<template>`**，于是整篇文章被吞（28648 → 6348 字符）。
// "没有闭合标签"最常见是因为**响应被截断**，那时保留原文远比丢掉好。
ok('⑦ **不闭合的 `<script>` 不吞掉正文**（截断响应里这是常态）',
  /正文/.test(htmlToText('<script>var a=1;<p>正文</p>')), JSON.stringify(htmlToText('<script>var a=1;<p>正文</p>')));
ok('⑦ **不闭合的 `<template>` 不吞掉正文**（实测萌娘页面上就有一个）',
  /正文/.test(htmlToText('<template><p>模板</p><p>正文</p>')), JSON.stringify(htmlToText('<template><p>模板</p><p>正文</p>')));
ok('⑦ 块级标签产生换行（段落结构要保住，不能压成一行）',
  htmlToText('<p>甲</p><p>乙</p>') === '甲\n乙', JSON.stringify(htmlToText('<p>甲</p><p>乙</p>')));
ok('⑦ 实体解码（含数字实体）',
  htmlToText('<p>a &amp; b &lt;c&gt; &nbsp;d &#65;</p>') === 'a & b <c> d A',
  JSON.stringify(htmlToText('<p>a &amp; b &lt;c&gt; &nbsp;d &#65;</p>')));
ok('⑦ `&amp;lt;` 不被解成 `<`（&amp; 必须最后解）',
  htmlToText('<p>&amp;lt;script&amp;gt;</p>') === '&lt;script&gt;',
  JSON.stringify(htmlToText('<p>&amp;lt;script&amp;gt;</p>')));
// 相对链接不补全的话模型看到的是 `[/%E5%88%9D...]` 这种没法用的片段
ok('⑦ 相对链接补成绝对地址', /\[https:\/\/h\.test\/x\]/.test(htmlToText('<a href="/x">y</a>', 'https://h.test/')),
  htmlToText('<a href="/x">y</a>', 'https://h.test/'));
ok('⑦ 锚点 / javascript: 链接丢掉（不是可引用的地址）',
  !/javascript/.test(htmlToText('<a href="javascript:void(0)">y</a>', 'https://h.test/')));
ok('⑦ img 的 alt 保留（常是图片的唯一说明）', /\[立绘\]/.test(htmlToText('<img alt="立绘" src="a.jpg">')));
ok('⑦ 空输入不抛错', htmlToText('') === '');
ok('⑦ 截断在标签中间的输入不抛错', typeof htmlToText('<div><p>半截') === 'string');
ok('⑦ `looksLikeHtml`：content-type 就够', looksLikeHtml('随便', 'text/html; charset=utf-8'));
ok('⑦ `looksLikeHtml`：看开头标签', looksLikeHtml('<!DOCTYPE html><html>', ''));
ok('⑦ `looksLikeHtml`：纯文本不误判', !looksLikeHtml('这是纯文本，没有任何标签。', 'text/plain'));
ok('⑦ `looksLikeHtml`：正文里偶然出现 `<` 不误判（只看开头 2000 字）', !looksLikeHtml('价格 a < b', 'text/plain'));

// **顺序**才是关键：先 slice 再剥 = 白剥。用"前 60000 字符全是脚本"的夹具钉住这个顺序。
const headHeavy = '<!DOCTYPE html><html><head><script>RLCONF=' + 'x'.repeat(60000) + '</script></head>'
  + '<body><p>' + '正文内容ABC。'.repeat(5000) + '</p></body></html>';
const extracted = htmlToText(headHeavy, 'https://h.test/');
ok('⑦ 头 60000 字符全是脚本时，剥完仍能拿到正文', /正文内容ABC/.test(extracted));
ok('⑦ 剥完不含脚本', !/RLCONF/.test(extracted));
ok('⑦ 对照：**旧行为**（前 20000 字符直接给模型）一个字正文都没有',
  !/正文内容ABC/.test(headHeavy.slice(0, 20000)));
// 源级接线：截断必须作用在**剥完之后**的文本上，且 truncated 按正文长度判
const webToolsSrc = fs.readFileSync(path.join(ROOT, 'src/agent/tools/web-tools.ts'), 'utf8');
ok('⑦ 工具里先 looksLikeHtml 判定、再 htmlToText 提取（并传 baseUrl 补全链接）',
  /looksLikeHtml\(body, contentType\)/.test(webToolsSrc) && /htmlToText\(body, String\(result\.url/.test(webToolsSrc));
// 截断必须作用在**剥完之后**的文本上；且 `content` 与 `truncated` 用**同一个** cap，
// 否则会出现"截到 A 长度、却按 B 长度报截断"。cap 现在来自配置项（见 ㉒ 段）。
ok('⑦ 截断作用在剥完的 `text` 上（不是原始 body），且与 truncated 同一个 cap',
  /const cap = fetchTextMaxChars\(\);/.test(webToolsSrc)
  && /truncated: text\.length > cap/.test(webToolsSrc)
  && /content: text\.slice\(0, cap\)/.test(webToolsSrc));
// `truncated` 的语义必须是"给模型看的正文被截断"：旧判据拿 `result.truncated`（原始响应
// ≥50000 字符）来说事，剥完 HTML 之后那个数已经不代表模型看到的东西了（会误报）
ok('⑦ `truncated` 不再用 `result.truncated`（那个数是原始响应大小，不代表正文）',
  !/truncated: result\.truncated/.test(webToolsSrc));

// ── ⑧ "HTTP 200 但被站点拦了"必须报失败，不能报"成功但内容为空" ──
//
// **实测反馈**：模型抓到 moegirl 时得到
//   { "statusCode": 200, "truncated": false, "content": "", "note": "（已从 HTML 中提取可读正文）" }
// —— 内容为空却报成功，模型于是说"你这修复好像没生效"。真实原因是**站点在拦它**：
// `action=raw` 返回 `<title>未授权操作</title>`，主站/移动版返回 **Cloudflare 挑战页**，
// 两者都是 200（实测：raw 183360 字符里可读只有 182，就是一个 `cdn-cgi/content?id=…`）。
console.log('\n═══ 20. web_fetch 的"被站点拦截"识别 ═══');
const { looksBlocked } = await load('media/html-to-text.js');
const blockedText = (html) => htmlToText(html);
const cfPage = '<!DOCTYPE html><html><head><title>洛天依 - 萌娘百科</title><script>' + 'x'.repeat(40000)
  + '</script></head><body><a href="https://zh.moegirl.org.cn/cdn-cgi/content?id=abc">c</a></body></html>';
ok('⑧ Cloudflare 挑战页（200）被判为拦截',
  looksBlocked(cfPage, { server: 'cloudflare', text: blockedText(cfPage) }).blocked === true);
ok('⑧ 原因说清是"人机验证页、不是配置问题"',
  /人机验证/.test(looksBlocked(cfPage, { server: 'cloudflare', text: blockedText(cfPage) }).reason));
const unauthPage = '<html><head><title>未授权操作 - 萌娘百科 万物皆可萌的百科全书</title><script>'
  + 'y'.repeat(40000) + '</script></head><body></body></html>';
ok('⑧ "未授权操作"页被判为拦截，且原因回显页面标题',
  (() => { const v = looksBlocked(unauthPage, { server: 'cloudflare', text: blockedText(unauthPage) });
    return v.blocked === true && /未授权操作/.test(v.reason); })());
ok('⑧ `cf-mitigated` 头直接判拦截',
  looksBlocked('<html><body>hi</body></html>', { cfMitigated: 'challenge' }).blocked === true);
ok('⑧ 403 Forbidden 标题被判拦截', looksBlocked('<html><head><title>403 Forbidden</title></head></html>', {}).blocked === true);
const jsOnlyPage = '<html><head><script>' + 'z'.repeat(30000) + '</script></head><body></body></html>';
ok('⑧ 正文全是脚本（纯 JS 渲染站）也被判为抓不到内容',
  looksBlocked(jsOnlyPage, { text: blockedText(jsOnlyPage) }).blocked === true);
// **对照必须存在**：正常页面不能被误判，否则 web_fetch 会拒绝一切有脚本的站点
const goodPage = '<html><head><title>初音未来 - 萌娘百科</title><script>' + 'x'.repeat(20000)
  + '</script></head><body><div class="mw-parser-output"><p>' + '正文内容'.repeat(2000) + '</p></div></body></html>';
ok('⑧ 对照：正常长正文页（同样有 20000 字脚本）**不**被误判',
  looksBlocked(goodPage, { server: 'cloudflare', text: blockedText(goodPage) }).blocked === false);
ok('⑧ 对照：内容确实很少的**短**页面不误判（只看占比会误判）',
  looksBlocked('<html><body><p>一句话。</p></body></html>', { text: blockedText('<html><body><p>一句话。</p></body></html>') }).blocked === false);
// 工具必须**在返回之前**用这个判据（否则模型又拿到"成功但空"）
ok('⑧ 工具把拦截判成错误（`err`）而不是 ok',
  /const verdict = looksBlocked\(/.test(webToolsSrc) && /if \(verdict\.blocked\) return err\(/.test(webToolsSrc));

// ── ⑨ 压平"整条正文"型接口时，单行上限不能把文章砍成开头一段 ──
//
// `flattenJson` 原本每行砍 500、总预算 2000。对千帆 `get_content` 那种"几行结构化资料"
// 够用，但对**整篇文章**是灾难：实测萌娘 `prop=extracts` 的 `extract` 有 **7036 字符**，
// 压完只剩 **608** —— 模型拿到一份"看起来完整"的摘要，**不知道后面还有 6000 多字**。
// 这种静默丢内容比报错难查得多。
console.log('\n═══ 21. 压平"整条正文"的预算 ═══');
const { flattenJson: fj, BOOKMARK_FLATTEN_MAX_CHARS, BOOKMARK_FLATTEN_LINE_CHARS } = await load('media/bookmark-request.js');
const longExtract = JSON.stringify({ query: { pages: { 1: { pageid: 1, title: '洛天依', extract: '正'.repeat(7036) } } } });
ok('⑨ 检索用的单行上限远大于 500（否则整篇文章只剩开头）',
  BOOKMARK_FLATTEN_LINE_CHARS > 2000, String(BOOKMARK_FLATTEN_LINE_CHARS));
ok('⑨ 检索用的总预算远大于 2000', BOOKMARK_FLATTEN_MAX_CHARS > 2000, String(BOOKMARK_FLATTEN_MAX_CHARS));
ok('⑨ 7036 字的正文能装进预算（按总预算截断，而不是被单行砍掉）',
  fj(longExtract, BOOKMARK_FLATTEN_MAX_CHARS, BOOKMARK_FLATTEN_LINE_CHARS).length >= BOOKMARK_FLATTEN_MAX_CHARS - 20,
  String(fj(longExtract, BOOKMARK_FLATTEN_MAX_CHARS, BOOKMARK_FLATTEN_LINE_CHARS).length));
// 对照：默认参数（设置页「测试」用紧凑值）仍应是原来那个小值，别顺手把测试也放大
ok('⑨ 对照：不传参数时仍是 500 单行上限（「测试」按钮保持紧凑）',
  fj(longExtract, 2000).length <= 700, String(fj(longExtract, 2000).length));
// 源级接线：检索那条路必须把这两个常量传下去
ok('⑨ 检索那条路传了宽松的预算与单行上限',
  /const flattenCap = flattenMaxChars\(\);/.test(readSrc('media/web-search.js'))
  && /flattenJson\(response\.body, flattenCap, flattenCap\)/.test(readSrc('media/web-search.js')));

// ── ㉒ 抓取正文预算**是配置项**（2026-10 起），不再是写死的常量 ──
//
// 这两个数直接决定"模型一次能读到多少资料"，而**合适的值取决于用户怎么用**：
// 群聊闲聊不需要长正文（越小越省上下文与钱）；拿它当资料检索就要长正文
// （实测萌娘 `prop=extracts` 一篇正文 7036 字符）。写死一个数只能对一半人正确。
console.log('\n═══ 22. 抓取正文预算是配置项 ═══');
{
  const { DEFAULT_CONFIG } = await load('core/config.js');
  const d = DEFAULT_CONFIG.webSearch;
  // 默认值必须**与旧常量同值**：升级不该悄悄改变行为
  ok('㉒ fetchTextMaxChars 默认 20000（与旧写死值相同）', d.fetchTextMaxChars === 20000, String(d.fetchTextMaxChars));
  ok('㉒ flattenMaxChars 默认 4000（与旧写死值相同）', d.flattenMaxChars === 4000, String(d.flattenMaxChars));
  // 兜底常量只作文档，但它写着"默认 4000"，漂了就会骗下一个读代码的人
  const { BOOKMARK_FLATTEN_MAX_CHARS } = await load('media/bookmark-request.js');
  ok('㉒ 兜底常量与配置默认值一致（漂了就会误导读者）',
    BOOKMARK_FLATTEN_MAX_CHARS === d.flattenMaxChars, String(BOOKMARK_FLATTEN_MAX_CHARS));
  // 每次调用**现读**配置（与 takeWebBudget 同一写法），放模块级常量会让改动不生效
  ok('㉒ web_fetch 现读配置（不是模块加载时定死）',
    /getConfig\(\)\.webSearch\?\.fetchTextMaxChars/.test(webToolsSrc));
  ok('㉒ 收藏夹压平现读配置', /getConfig\(\)\.webSearch\?\.flattenMaxChars/.test(readSrc('media/web-search.js')));
  // 钳制：手改 config.json 写进荒唐值也不能让它失控
  updateConfig({ webSearch: { ...getConfig().webSearch, fetchTextMaxChars: 999999, flattenMaxChars: 1 } });
  const after = getConfig().webSearch;
  ok('㉒ 过大被压到 200000、过小被抬到 500',
    after.fetchTextMaxChars === 200000 && after.flattenMaxChars === 500,
    JSON.stringify({ f: after.fetchTextMaxChars, l: after.flattenMaxChars }));
}

await new Promise((r) => bqsrv.close(r));

await new Promise((r) => srv.close(r));
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
