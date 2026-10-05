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
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-websearch-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

const { webSearch, sanitizeQuery, yandexSearch, bookmarkList, resolveBookmarkSite, parseSiteSearch } = await load('media/web-search.js');
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

console.log('\n═══ 8. bookmarkMode=web：名单保留，但不传 site 时完全不理会它 ═══');
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

await new Promise((r) => srv.close(r));
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
