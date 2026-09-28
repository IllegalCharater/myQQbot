import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load } from './lib/src.mjs';

const DATA = dataDir('qqagent-hot-search-');
const { ok, done } = checker();

const { DEFAULT_CONFIG, updateConfig } = await load('core/config.js');
const { fetchHotSearch } = await load('web/runtime/hot-search/api-client.js');
const { normalizeHotSearchResponse } = await load('web/runtime/hot-search/normalize.js');
const { dedupeHotSearchItems } = await load('web/runtime/hot-search/dedupe.js');
const { formatHotSearchPages } = await load('web/runtime/hot-search/formatter.js');
const { HotSearchStateStore } = await load('web/runtime/hot-search/state-store.js');
const { HotSearchScheduler } = await load('web/runtime/hot-search/scheduler.js');

const payload = (itemsByPlatform = {
  weibo: [{ rank: 1, title: '同一热点', hot: 123, url: 'https://example.com/a' }],
  zhihu: [{ rank: 1, title: '【热】 同一热点', hot: '10 万热度', url: 'https://example.com/b' }, { rank: 2, title: '第二条' }]
}) => ({
  code: '200', desc: 'success', data: {
    generated_at: '2026-09-28T08:30:00+08:00', requested_platforms: Object.keys(itemsByPlatform),
    total_items: Object.values(itemsByPlatform).flat().length, failed_platforms: [],
    platforms: Object.fromEntries(Object.entries(itemsByPlatform).map(([id, items]) => [id, {
      name: id === 'weibo' ? '微博热搜' : '知乎热榜', status: 'success', count: items.length, items
    }]))
  }, tips: '极数本源'
});

// 匿名请求与 Bearer 请求：Key 只能进请求头，不能出现在 URL。
const seen = [];
const successFetch = async (url, init) => {
  seen.push({ url: String(url), init });
  return new Response(JSON.stringify(payload()), { status: 200 });
};
await fetchHotSearch({ limit: 5, platformFilter: [] }, { fetchImpl: successFetch, log: () => {} });
await fetchHotSearch({ apiKey: 'test-key', limit: 5, platformFilter: ['weibo', 'zhihu'] }, { fetchImpl: successFetch, log: () => {} });
ok('未配置 Key 时匿名请求不带 Authorization', !seen[0].init.headers, JSON.stringify(seen[0].init.headers));
ok('已配置 Key 时只用 Bearer 请求头，URL 不含 Key',
  seen[1].init.headers?.authorization === 'Bearer test-key' && !seen[1].url.includes('test-key')
  && seen[1].url.includes('platform=weibo%2Czhihu'), seen[1].url);
ok('客户端严格使用文档的 POST、limit 与 8 秒 timeout 查询参数',
  seen.every((entry) => entry.init.method === 'POST' && entry.url.includes('limit=5') && entry.url.includes('timeout=8')));

// 429 / 5xx / 网络超时均最多重试两次，退避为 500ms、1000ms（测试不真等待）。
for (const status of [429, 503]) {
  let calls = 0;
  const waits = [];
  const flaky = async () => {
    calls++;
    return calls < 3 ? new Response('', { status }) : new Response(JSON.stringify(payload()), { status: 200 });
  };
  await fetchHotSearch({ limit: 3 }, { fetchImpl: flaky, wait: async (ms) => waits.push(ms), log: () => {} });
  ok(`${status} 会指数退避且最多重试两次`, calls === 3 && waits.join(',') === '500,1000', `calls=${calls} waits=${waits}`);
}
let timeoutCalls = 0;
const timeoutFetch = async (_url, init) => {
  timeoutCalls++;
  return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new TypeError('aborted')), { once: true }));
};
let timeoutMessage = '';
try {
  await fetchHotSearch({ limit: 3 }, { fetchImpl: timeoutFetch, wait: async () => {}, timeoutMs: 5, log: () => {} });
} catch (error) { timeoutMessage = error.message; }
ok('网络超时会重试两次并给出脱敏摘要', timeoutCalls === 3 && timeoutMessage.includes('请求超时'), `calls=${timeoutCalls} error=${timeoutMessage}`);

// 缺字段与空列表安全降级；去重合并来源且不伪造跨平台热度排序。
const normalized = normalizeHotSearchResponse(payload());
const topics = dedupeHotSearchItems(normalized.items);
ok('按各平台榜内排名稳定交错，并对装饰词归一化后去重',
  normalized.items.map((item) => item.platformId).join(',') === 'weibo,zhihu,zhihu'
  && topics.length === 2 && topics[0].sources.length === 2 && topics[1].title === '第二条');
const missing = normalizeHotSearchResponse(payload({ weibo: [{ rank: null, title: '可用标题', hot: null }, { url: 'https://example.com/no-title' }] }));
ok('字段缺失时隐藏无效条目/字段，不产生 undefined 或 NaN',
  missing.items.length === 1 && missing.items[0].rank === undefined && missing.items[0].hot === undefined);
const empty = normalizeHotSearchResponse(payload({ weibo: [] }));
ok('空列表能被识别，格式化器不生成空榜单', empty.items.length === 0 && formatHotSearchPages([], {}).length === 0);

const manyTopics = Array.from({ length: 8 }, (_, index) => ({
  title: `第 ${index + 1} 条${'很长的标题'.repeat(14)}`, sources: ['微博热搜'], sourceIds: ['weibo'], rank: index + 1,
  hot: 1000 + index, url: `https://example.com/${index}`, sourceIndex: index
}));
const pages = formatHotSearchPages(manyTopics, { includeLinks: true, maxChars: 500, now: new Date('2026-09-28T01:00:00Z') });
ok('长榜单按完整条目分页且可选附链接', pages.length > 1 && pages.every((page) => page.length <= 560) && pages.join('\n').includes('链接：https://example.com/0'));

const uiText = ['sections.js', 'save.js', 'index.js']
  .map((file) => fs.readFileSync(path.join(ROOT, 'ui/js/views/settings', file), 'utf8')).join('\n');
ok('管理页接入启用、Key、时间/时区、群多选、条数、平台、链接、预览、二次确认与状态',
  ['cfg-hotsearch-enabled', 'cfg-hotsearch-key', 'cfg-hotsearch-time', 'Asia/Shanghai',
    'cfg-hotsearch-groups', 'cfg-hotsearch-limit', 'data-hotsearch-platform', 'cfg-hotsearch-links',
    '/api/hot-search/preview', '/api/hot-search/broadcast', '/api/hot-search/status', 'confirm(']
    .every((needle) => uiText.includes(needle)));

function config(overrides = {}) {
  return Object.assign(structuredClone(DEFAULT_CONFIG), {
    hotSearchEnabled: true,
    hotSearchTargetGroupIds: ['10001'],
    hotSearchItemLimit: 10,
    allow: { groups: ['10001'], private: [] },
    send: { ...DEFAULT_CONFIG.send, minGapMs: 0, maxGapMs: 0, byLengthMs: 0 },
    ...overrides
  });
}

function schedulerFixture({ cfg = config(), file, fetchFeed, sender, now } = {}) {
  let current = cfg;
  const stateStore = new HotSearchStateStore(file || path.join(DATA, `state-${Math.random()}.json`));
  const instance = new HotSearchScheduler({
    getConfig: () => current,
    updateConfig: (patch) => (current = Object.assign(current, patch)),
    sender: sender || { sendTextBatch: async () => ({ sent: [{}], failed: [] }) },
    fetchFeed: fetchFeed || (async () => payload()),
    stateStore,
    now: now || (() => new Date('2026-09-28T01:05:00Z')),
    log: () => {}
  });
  return { instance, stateStore, getConfig: () => current };
}

let sends = 0;
const noTarget = schedulerFixture({
  cfg: config({ hotSearchTargetGroupIds: [] }),
  sender: { sendTextBatch: async () => { sends++; return { sent: [{}], failed: [] }; } }
});
let noTargetError = '';
try { await noTarget.instance.broadcast(); } catch (error) { noTargetError = error.message; }
ok('目标群为空时拒绝播报且不调用发送器', sends === 0 && noTargetError.includes('目标群'));

let emptySends = 0;
const emptyFeed = schedulerFixture({
  fetchFeed: async () => payload({ weibo: [] }),
  sender: { sendTextBatch: async () => { emptySends++; return { sent: [{}], failed: [] }; } }
});
let emptyError = '';
try { await emptyFeed.instance.broadcast(); } catch (error) { emptyError = error.message; }
ok('接口返回空列表时记录可读失败且绝不发送空榜单',
  emptySends === 0 && emptyError.includes('没有返回可用') && emptyFeed.stateStore.read().status === 'failed');

// 成功后状态落盘；新实例读取同一状态文件，同一天不再发送。
const persistentFile = path.join(DATA, 'restart-state.json');
const sentGroups = [];
const first = schedulerFixture({
  file: persistentFile,
  sender: { sendTextBatch: async (chatKey) => { sentGroups.push(chatKey); return { sent: [{}], failed: [] }; } }
});
await first.instance.broadcast();
const second = schedulerFixture({
  file: persistentFile,
  sender: { sendTextBatch: async (chatKey) => { sentGroups.push(chatKey); return { sent: [{}], failed: [] }; } }
});
let duplicateError = '';
try { await second.instance.broadcast(); } catch (error) { duplicateError = error.message; }
const persisted = fs.readFileSync(persistentFile, 'utf8');
ok('服务重启后同一天不会重复播报', sentGroups.length === 1 && duplicateError.includes('已经成功播报过'));
ok('状态文件只保存元数据，不保存完整标题、链接或 Key',
  !persisted.includes('同一热点') && !persisted.includes('example.com') && !persisted.includes('sk_'));

// 手动与定时调用共享同一个互斥锁。
let releaseFetch;
const blockedFetch = new Promise((resolve) => { releaseFetch = resolve; });
const concurrent = schedulerFixture({ fetchFeed: async () => await blockedFetch });
const manual = concurrent.instance.broadcast('manual');
await new Promise((resolve) => setImmediate(resolve));
let busyError = '';
try { await concurrent.instance.broadcast('scheduled'); } catch (error) { busyError = error.message; }
releaseFetch(payload());
await manual;
ok('手动播报与定时播报不能并发', busyError.includes('正在运行'));

const lifecycle = schedulerFixture();
await lifecycle.instance.start();
const scheduledBeforeStop = lifecycle.instance.status().scheduled;
const missedReason = lifecycle.stateStore.read().error || '';
await lifecycle.instance.stop();
ok('计划任务可显式启动并在 stop 时销毁句柄', scheduledBeforeStop === true && lifecycle.instance.status().scheduled === false);
ok('服务在计划时刻后启动时不补发，并记录可读的漏发原因', missedReason.includes('不补发'));

// GET 与 POST 配置响应都只能返回存在性标记，不能把配置值或环境变量值带给浏览器。
const previousEnvKey = process.env.HOT_SEARCH_API_KEY;
process.env.HOT_SEARCH_API_KEY = 'env-test-key';
updateConfig({
  server: { port: 39420 }, hotSearchEnabled: false,
  hotSearchApiKey: 'config-test-key'
});
const { createApp } = await load('web/app.js');
const app = createApp({ log: () => {} });
const port = await app.start();
try {
  const getBody = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  const postBody = await (await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hotSearchItemLimit: 11 })
  })).json();
  const serialized = JSON.stringify([getBody, postBody]);
  ok('GET/POST 配置响应都不返回热搜 Key，只返回 hasHotSearchApiKey',
    getBody.hasHotSearchApiKey === true && postBody.config?.hasHotSearchApiKey === true
    && !('hotSearchApiKey' in getBody) && !('hotSearchApiKey' in (postBody.config || {}))
    && !serialized.includes('config-test-key') && !serialized.includes('env-test-key'));
} finally {
  await app.stop();
  if (previousEnvKey === undefined) delete process.env.HOT_SEARCH_API_KEY;
  else process.env.HOT_SEARCH_API_KEY = previousEnvKey;
}

process.exit(done() ? 0 : 1);
