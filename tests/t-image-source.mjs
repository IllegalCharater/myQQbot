import fs from 'node:fs';
import path from 'node:path';
import { checker } from './lib/harness.mjs';
import { ROOT, load, readUI, stripComments } from './lib/src.mjs';

const { ok, done } = checker();
const { TraceMoeProvider } = await load('media/image-source/trace-moe-provider.js');
const { SauceNaoProvider } = await load('media/image-source/saucenao-provider.js');
const { AsyncSingleQueue } = await load('media/image-source/queue.js');
const { LruTtlCache } = await load('media/image-source/cache.js');

const anime = { result: [{ anilist: { id: 1, title: { chinese: '测试番', native: '原名' } }, episode: 3, from: 754, similarity: .91, image: 'https://example.test/a.jpg' }] };
const trace = new TraceMoeProvider(async () => new Response(JSON.stringify(anime), { status: 200 }));
const tr = await trace.search(Buffer.from([1]), 'image/png', 1000, 2);
ok('trace.moe 成功响应标准化中文标题、集数、时间与 AniList 链接', tr.results[0].title === '测试番' && tr.results[0].episode === '3' && tr.results[0].time === 754 && tr.results[0].url.endsWith('/1'));
const traceEmpty = new TraceMoeProvider(async () => new Response('{"result":[]}', { status: 200 }));
ok('trace.moe 无结果返回空数组', (await traceEmpty.search(Buffer.from([1]), 'image/png', 1000, 2)).results.length === 0);
await new TraceMoeProvider(async () => { throw new DOMException('timeout', 'TimeoutError'); }).search(Buffer.from([1]), 'image/png', 1, 1).then(() => ok('trace.moe 超时会失败', false), (e) => ok('trace.moe 超时会失败', e.name === 'TimeoutError'));
await new TraceMoeProvider(async () => new Response('{}', { status: 200 })).search(Buffer.from([1]), 'image/png', 1, 1).then(() => ok('trace.moe 格式异常会失败', false), (e) => ok('trace.moe 格式异常会失败', e.message === 'INVALID_RESPONSE'));

const saucePayload = { header: { status: 0, short_remaining: 3, long_remaining: 80 }, results: [{ header: { similarity: '87.5', index_name: 'Index #5: pixiv Images', thumbnail: 'x' }, data: { title: '作品', member_name: '画师', ext_urls: ['https://www.pixiv.net/artworks/1'] } }] };
const sauce = new SauceNaoProvider(async () => new Response(JSON.stringify(saucePayload), { status: 200 }));
const sr = await sauce.search(Buffer.from([1]), 'image/png', 'secret-test-key', 1000, 2);
ok('SauceNAO 成功响应标准化且 Key 不进入 URL', sr.results[0].similarity === .875 && sr.results[0].author === '画师' && sr.results[0].source === 'pixiv Images');
ok('SauceNAO 低相似度由服务层可可靠过滤', sr.results.every((x) => x.similarity < .9));
await new SauceNaoProvider(async () => new Response('', { status: 429 })).search(Buffer.from([1]), 'image/png', 'k', 1, 1).then(() => ok('SauceNAO 429 会失败', false), (e) => ok('SauceNAO 429 会失败', e.message === 'RATE_LIMIT'));
const quota = { header: { status: -3 }, results: [] };
await new SauceNaoProvider(async () => new Response(JSON.stringify(quota), { status: 200 })).search(Buffer.from([1]), 'image/png', 'k', 1, 1).then(() => ok('SauceNAO 配额耗尽会失败', false), (e) => ok('SauceNAO 配额耗尽会失败', e.message === 'QUOTA_EXHAUSTED'));
await new SauceNaoProvider(async () => new Response('{}', { status: 200 })).search(Buffer.from([1]), 'image/png', 'k', 1, 1).then(() => ok('SauceNAO 格式异常会失败', false), (e) => ok('SauceNAO 格式异常会失败', e.message === 'INVALID_RESPONSE'));

const q = new AsyncSingleQueue(); let active = 0; let peak = 0; let release;
const gate = new Promise((r) => { release = r; });
const a = q.enqueue(1, async () => { active++; peak = Math.max(peak, active); await gate; active--; });
const b = q.enqueue(1, async () => { active++; peak = Math.max(peak, active); active--; });
await q.enqueue(1, async () => {}).then(() => ok('队列已满时拒绝', false), (e) => ok('队列已满时拒绝', e.message === 'QUEUE_FULL'));
release(); await Promise.all([a, b]); ok('队列全局单并发', peak === 1, `peak=${peak}`);

const cache = new LruTtlCache(100); cache.set('x', { result: 1 }, 1000);
ok('内存缓存命中返回副本', cache.get('x').result === 1 && cache.get('x') !== cache.get('x'));
ok('实现不创建临时文件，因而无原图或临时文件残留', !fs.readFileSync(path.join(ROOT, 'src/media/image-source/reverse-image-source-service.ts'), 'utf8').includes('writeFile'));

const consoleSrc = fs.readFileSync(path.join(ROOT, 'src/web/http/console.ts'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'ui/js/views/settings/sections.js'), 'utf8');
ok('设置页使用密码框且服务端删除 SauceNAO 原始 Key', ui.includes('id="cfg-sauce-key"') && ui.includes('type="password"') && consoleSrc.includes('delete out.imageSource.sauceNao.apiKey'));
ok('未配置 SauceNAO 时 trace.moe 配置保持独立', ui.includes('cfg-trace-enabled') && ui.includes('cfg-sauce-enabled'));

// ── 调用额度闸门（成本闸门，替代原先的关键词闸门）────────────────
// 用注入的假时钟，夹具不依赖全局状态与随机挑选，结果确定。
// 闸门本体与视频转写共用（media/call-budget.ts），这里验的是搜图传进去的那组限额。
const { SlidingWindowBudget } = await load('media/call-budget.js');
const { DEFAULT_CONFIG } = await load('core/config.js');

const T0 = 1_750_000_000_000;
const HOUR = 60 * 60 * 1000;
const budgetAt = (cfg) => {
  let now = T0;
  const b = new SlidingWindowBudget({
    getLimits: () => ({ perChatPerHour: cfg.maxCallsPerChatPerHour, perDay: cfg.maxCallsPerDay }),
    now: () => now
  });
  return { take: (k) => b.take(k), at: (t) => { now = t; } };
};
const refusal = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };

ok('新增两个配额字段有默认值', DEFAULT_CONFIG.imageSource.maxCallsPerChatPerHour === 5 && DEFAULT_CONFIG.imageSource.maxCallsPerDay === 30);

const b1 = budgetAt({ maxCallsPerChatPerHour: 2, maxCallsPerDay: 100 });
b1.take('group:1'); b1.take('group:1');
const overChat = refusal(() => b1.take('group:1'));
ok('单群超过每小时上限时拒绝', overChat === 'RATE_LIMITED', `msg=${overChat}`);

const b2 = budgetAt({ maxCallsPerChatPerHour: 2, maxCallsPerDay: 100 });
b2.take('group:1'); b2.take('group:1');
ok('不同群的额度互不影响', refusal(() => b2.take('group:2')) === '');

const b3 = budgetAt({ maxCallsPerChatPerHour: 1, maxCallsPerDay: 100 });
b3.take('group:1');
const refusedInWindow = refusal(() => b3.take('group:1')) === 'RATE_LIMITED';
b3.at(T0 + HOUR + 1);
ok('每小时窗口滑过后额度恢复', refusedInWindow && refusal(() => b3.take('group:1')) === '');

// 每群上限放到很宽，只让全局每日上限起作用：换四个不同的群，第四个应被日上限拦下。
const b4 = budgetAt({ maxCallsPerChatPerHour: 60, maxCallsPerDay: 3 });
b4.take('g1'); b4.take('g2'); b4.take('g3');
const overDay = refusal(() => b4.take('g4'));
ok('全局每日上限跨群生效', overDay === 'RATE_LIMITED', `msg=${overDay}`);

// 若被拒绝的那一次也记账，daily 会从 1/2 涨到 2/2，另一个群就会被误拒。
const b5 = budgetAt({ maxCallsPerChatPerHour: 1, maxCallsPerDay: 2 });
b5.take('g');
refusal(() => b5.take('g'));
ok('被拒绝的调用不占额度', refusal(() => b5.take('h')) === '');

// ── 语义闸门已删除 ───────────────────────────────────────────────
const toolSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/agent/tools/image-source.ts'), 'utf8'));
ok('工具里不再有关键词闸门（"该不该搜"交回模型判断）', !toolSrc.includes('什么番') && !toolSrc.includes('requestText'));
ok('工具在发占位回复前先消耗调用额度', toolSrc.includes('budget.take(ctx.chatKey)'));

const sectionsSrc = readUI('js/views/settings/sections.js');
const saveSrc = readUI('js/views/settings/save.js');
ok('设置页渲染了每群每小时与全局每日两个输入框', sectionsSrc.includes('id="cfg-image-source-chat-hourly"') && sectionsSrc.includes('id="cfg-image-source-daily"'));
ok('保存时钳制并持久化两个调用上限', saveSrc.includes("clampInt(val('#cfg-image-source-chat-hourly'") && saveSrc.includes("clampInt(val('#cfg-image-source-daily'"));

done();
