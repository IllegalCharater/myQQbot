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

const { webSearch, sanitizeQuery, yandexSearch, bookmarkList, resolveBookmarkSite } = await load('media/web-search.js');
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
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['book.mark'], bookmarkMode: 'prefer' } });
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
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['example.com'], bookmarkMode: 'prefer' } });
out = await webSearch('测试');
const bookmarked = out.results.filter((r) => r.fromBookmark).map((r) => r.url);
ok('子域 m.example.com 命中收藏的 example.com',
  bookmarked.includes('https://m.example.com/1'), JSON.stringify(bookmarked));
ok('notexample.com **不**命中（后缀匹配必须要点边界，不能用 includes）',
  !bookmarked.includes('https://notexample.com/2'), JSON.stringify(bookmarked));
ok('无关站点不命中', !bookmarked.includes('https://other.com/3'), JSON.stringify(bookmarked));
ok('恰好只有一条被标记', bookmarked.length === 1, JSON.stringify(bookmarked));
generalMode = 'normal';

console.log('\n═══ 4. 模型显式传 site：只按它点的那个站点优先 ═══');
// 这是本轮改动的核心：站点由**模型**决定，照 reverse_image_source 的 intent 那一套。
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['book.mark', 'example.com'], bookmarkMode: 'web' } });
scopedHits = 0; generalHits = 0;
out = await webSearch('测试查询', 'book.mark');
ok('传了 site 就发两发（站内 + 全网）', scopedHits === 1 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
ok('站内命中排最前', out.results[0].url === 'https://book.mark/only', `首条是 ${out.results[0]?.url}`);
ok('站内命中带 fromBookmark 标记', out.results[0].fromBookmark === true);
ok('全网结果仍作补充（不是只搜收藏夹）', out.results.some((r) => r.url === 'https://other.com/a'));
// bookmarkMode=web 只管"模型没点名"时；点了名就必须生效 —— 否则这个下拉会悄悄废掉新功能
ok('bookmarkMode=web 不阻止模型显式指定站点（两者管的是不同的事）', scopedHits === 1);

console.log('\n═══ 5. site 校验：不在名单里的站点必须报错并给出可选值 ═══');
// 为什么必须校验而不是直接拼进 site: —— 一个凭空写出的域名会**静默**搜出空结果，
// 看起来像"这个站没有内容"，实际是"它从来不在名单里"。报错要把名单带回去让模型改对。
let badSite = '';
try { await webSearch('测试查询', 'evil.example.net'); } catch (error) { badSite = String(error?.message || error); }
ok('不在收藏夹里的 site 被拒绝', badSite.length > 0, JSON.stringify(badSite));
ok('报错带回可选名单，模型下一轮能改对',
  badSite.includes('book.mark') && badSite.includes('example.com'), JSON.stringify(badSite));
// 收藏了 example.com 时，模型把子域写全也该认（它在那个站点范围内）
ok('子域写法被接受（收藏 example.com，模型写 m.example.com）',
  resolveBookmarkSite('m.example.com') === 'm.example.com');
ok('带 scheme 的写法被归一后接受', resolveBookmarkSite('https://book.mark/x') === 'book.mark');
// 名单为空时点名 → 要说清"管理员还没配"，而不是一个含糊的失败
updateConfig({ webSearch: { ...baseSearch, bookmarks: [], bookmarkMode: 'prefer' } });
let noList = '';
try { await webSearch('测试查询', 'book.mark'); } catch (error) { noList = String(error?.message || error); }
ok('名单为空时传 site 报"还没配置收藏夹"', noList.includes('收藏夹'), JSON.stringify(noList));

console.log('\n═══ 6. bookmarkMode=web：名单保留，但不传 site 时完全不理会它 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['book.mark'], bookmarkMode: 'web' } });
scopedHits = 0; generalHits = 0;
out = await webSearch('测试查询');
ok('关掉后只发一发（不传 site 就不为收藏夹多付一次往返）',
  scopedHits === 0 && generalHits === 1, `scoped=${scopedHits} general=${generalHits}`);
ok('关掉后不打标记', out.results.every((r) => r.fromBookmark === undefined));
ok('配置里的名单没被清掉（只是默认不生效，方便临时关）',
  Array.isArray(getConfig().webSearch.bookmarks) && getConfig().webSearch.bookmarks.length === 1);

console.log('\n═══ 7. 受限那一发失败：不拖垮普通结果 ═══');
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['book.mark'], bookmarkMode: 'prefer' } });
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
updateConfig({ webSearch: { ...baseSearch, searchUrl: deadUrl, bookmarks: ['book.mark'], bookmarkMode: 'prefer' } });
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
// 名单必须由 system prompt 承载而不是写进 tool schema：域名是用户配置的**动态数据**，
// 而 Catalog 里放的是固定指令（同 stickers 的做法）。不注入的话模型根本不知道 site 能填什么，
// 只会瞎猜域名 —— 而瞎猜会被校验拦掉，表现为"这个功能从没成功过"。
updateConfig({ webSearch: { ...baseSearch, bookmarks: ['zh.wikipedia.org', 'news.ycombinator.com'], bookmarkMode: 'prefer' } });
updateConfig({ persona: { botName: '小鲸鱼', roleText: '' } });
let sys = buildSystemPrompt({ bookmarkSites: ['zh.wikipedia.org', 'news.ycombinator.com'] });
ok('system prompt 里列出了收藏夹站点', sys.includes('zh.wikipedia.org') && sys.includes('news.ycombinator.com'));
ok('说明了 site 的取值必须来自名单', sys.includes('site') && sys.includes('之一'));
ok('提醒了不确定时不要传 site（避免把搜索无谓地收窄）', sys.includes('不要传 site'));
const sysEmpty = buildSystemPrompt({ bookmarkSites: [] });
// 判据要盯**名单注入那一句**，不能扫"收藏夹站点"这个泛词：另有一条无条件的行为规则也含它
// （"带 fromBookmark 标记的条目来自管理员配置的收藏夹站点…"），扫泛词会永远假红。
ok('名单为空时**不注入**名单那两行（没有可选项就别占提示词预算）',
  !sysEmpty.includes('管理员配置了这些收藏夹站点'), '空名单时仍注入了名单行');

console.log('\n═══ 11. 配置兼容：旧键 bookmarkFirst 迁移成 bookmarkMode ═══');
// 旧键有两个值、新键有两个档，映射必须是 false→web / true→prefer，且**旧键要删掉**：
// `updateConfig` 只加键不删键，不显式 delete 就会让一个没人读的旋钮永远留在 config.json 里。
//
// ⚠️ 必须在**独立进程**里做：本进程前面调过 `updateConfig`，内存里的 config 已经带着
// 一个非迁移来的 `bookmarkMode`，再 `loadConfig()` 会被 `updateConfig` 的 deepMerge 结果
// 盖掉 —— 第一版就是这么假红的（迁移明明生效，断言读到的却是上一节的 'prefer'）。
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-legacy-'));
fs.writeFileSync(path.join(legacyDir, 'config.json'),
  JSON.stringify({ webSearch: { bookmarks: ['a.example.com'], bookmarkFirst: false } }), 'utf8');
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
ok('bookmarkFirst=false 迁移成 bookmarkMode=web（独立进程里跑，避免内存态干扰）',
  legacyWs.bookmarkMode === 'web', JSON.stringify(legacyWs.bookmarkMode));
ok('旧键已从配置里删除（不留死旋钮）', !('bookmarkFirst' in legacyWs),
  JSON.stringify(Object.keys(legacyWs)));
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
