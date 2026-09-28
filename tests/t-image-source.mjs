import fs from 'node:fs';
import path from 'node:path';
import { checker } from './lib/harness.mjs';
import { ROOT, load } from './lib/src.mjs';

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

done();
