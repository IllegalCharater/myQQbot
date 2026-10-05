// 验证：联网搜索的「网页收藏夹（域名优先检索）」与调用阀门。
//
// 为什么要有这个套件：`media/web-search.ts` 在这之前**整条链零行为覆盖** —— 六路 provider 的
// 解析、查询词清洗、以及本轮新增的"受限查询 + 普通查询取并集"合并逻辑，全都只能靠读代码确认。
// 合并逻辑尤其需要真跑：它的正确性全在"两次请求各自的返回如何被拼成一个列表"上，
// 而这类东西用文本断言只能钉住"写过某一行"，钉不住"拼出来是什么"。
//
// 做法照 `t-sticker.mjs` 第 13 段：**真起一个本地假搜索引擎**（不是 mock fetch），
// 于是走的是真实的 `bingSearch` 解析 + 真实的两次并发请求 + 真实的结果归一。
// 只有真的发出去、真的解析回来，"收藏夹命中排在最前"才算被证明过。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-websearch-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

const { webSearch, sanitizeQuery } = await load('media/web-search.js');
const { updateConfig, getConfig } = await load('core/config.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`); }
};

/** 造一段 Bing 形状的结果块（`b_algo` 是解析器唯一的入口）。 */
const block = (url, title, snippet) =>
  `<li class="b_algo"><h2><a href="${url}">${title}</a></h2><p>${snippet}</p></li>`;

/**
 * 假搜索引擎。按查询串里有没有 `site:` 分成两条路径，各自返回**不同**的结果集，
 * 这样"哪一发回来了"可以从结果内容反推，而不只看请求数。
 *
 * 每个模式给一串 `[url, title]`；模式可以运行时切换（第 5/8 节就是靠这个换夹具）。
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
  // 第 8 节：收藏 `example.com` 时的**子串陷阱** —— m.example.com 是它的子域（该命中），
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

console.log('\n═══ 1. 没有收藏夹时不发第二发（行为与从前逐字相同） ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: [], bookmarkFirst: true } });
scopedHits = 0; generalHits = 0;
let out = await webSearch('测试查询');
ok('收藏夹为空时只发一次请求', scopedHits === 0 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
ok('返回全部普通结果', out.results.length === 3, `实际 ${out.results.length}`);
ok('没有收藏夹时不打 fromBookmark 标记', out.results.every((r) => r.fromBookmark === undefined));
ok('查询词原样带进请求（没被拼上 site: 子句）',
  out.query === '测试查询' && out.results[0].url === 'https://other.com/a');

console.log('\n═══ 2. 有收藏夹：两发并发 + 收藏夹命中排最前 + 去重 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['book.mark'], bookmarkFirst: true } });
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
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['example.com'], bookmarkFirst: true } });
out = await webSearch('测试');
const bookmarked = out.results.filter((r) => r.fromBookmark).map((r) => r.url);
ok('子域 m.example.com 命中收藏的 example.com',
  bookmarked.includes('https://m.example.com/1'), JSON.stringify(bookmarked));
ok('notexample.com **不**命中（后缀匹配必须要点边界，不能用 includes）',
  !bookmarked.includes('https://notexample.com/2'), JSON.stringify(bookmarked));
ok('无关站点不命中', !bookmarked.includes('https://other.com/3'), JSON.stringify(bookmarked));
ok('恰好只有一条被标记', bookmarked.length === 1, JSON.stringify(bookmarked));
generalMode = 'normal';

console.log('\n═══ 4. bookmarkFirst=false：名单保留但检索不再理会它 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['book.mark'], bookmarkFirst: false } });
scopedHits = 0; generalHits = 0;
out = await webSearch('测试查询');
ok('关掉后只发一发（不为收藏夹多付一次往返）', scopedHits === 0 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
ok('关掉后不打标记', out.results.every((r) => r.fromBookmark === undefined));
const cfg = getConfig();
ok('配置里的名单没被清掉（只是不生效，方便临时关）',
  Array.isArray(cfg.webSearch.bookmarks) && cfg.webSearch.bookmarks.length === 1);

console.log('\n═══ 5. 受限那一发失败：不拖垮普通结果 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['book.mark'], bookmarkFirst: true } });
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

console.log('\n═══ 6. 两发都失败：抛的是**用户真正请求的那一发**的原因 ═══');
// 用"接口 500"而不是"连不上"：前者带得上 HTTP 状态与响应文本，是本工具真实会遇到的形态，
// 也才看得出我们抛的是**普通那一发**的原因。连不上时两边都退化成 fetch 的 "fetch failed"，
// 那时"抛哪一发"在这条断言里根本不可分辨（原先就是这么写的，探针撞出来的假红）。
const dead = http.createServer((_req, res) => { res.writeHead(500); res.end('search down'); });
await new Promise((r) => dead.listen(0, '127.0.0.1', r));
const deadUrl = `http://127.0.0.1:${dead.address().port}/search`;
await new Promise((r) => srv.close(r));
updateConfig({ webSearch: { ...baseSearch, searchUrl: deadUrl, bookmarks: ['book.mark'], bookmarkFirst: true } });
let threw = '';
try { await webSearch('测试查询'); } catch (error) { threw = String(error?.message || error); }
await new Promise((r) => dead.close(r));
ok('两发都失败时确实抛错', threw.length > 0, `得到 ${JSON.stringify(threw)}`);
ok('抛的是普通那一发的 HTTP 错误（不是受限查询的，也不是内部拼的 site: 子句）',
  threw === '搜索服务 HTTP 500', JSON.stringify(threw));

console.log('\n═══ 7. 查询词清洗（sanitizeQuery） ═══');
ok('剥掉 CQ 码', sanitizeQuery('[CQ:at,qq=123] 你好') === '你好' || !sanitizeQuery('[CQ:at,qq=123] 你好').includes('[CQ:'));
ok('剥掉控制字符', sanitizeQuery('a\u0000b\u001fc') === 'a b c');
ok('折叠多余空白', sanitizeQuery('  a   b  ') === 'a b');
ok('截断到 120 字', sanitizeQuery('x'.repeat(300)).length === 120);
ok('非字符串输入不炸', sanitizeQuery(undefined) === '' && sanitizeQuery(null) === '' && sanitizeQuery(12345) === '12345');

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
