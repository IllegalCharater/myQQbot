import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, readUI, stripComments } from './lib/src.mjs';

// dataDir 必须先于 load('core/config.js')：末尾的工具级用例要开功能开关，
// config 在加载时就把 DATA_DIR 定死，晚一步就会往真 data/ 里写配置。
dataDir('qqagent-image-source-');

const { ok, done } = checker();
const { AsyncSingleQueue } = await load('media/image-source/queue.js');
const { LruTtlCache } = await load('media/image-source/cache.js');

// ── Node 侧唯一的通用 provider：只转发，没有引擎分支 ───────────────
// 假客户端是**普通对象字面量**：`PicImageSearchPort` 是纯结构接口（无 instanceof、无 Symbol
// 品牌、无运行期校验，与 `agent/runtime/control-port.ts` 同形），所以这整段既不联网、也不
// spawn Python —— 客户端的懒启动在没有任何 search/ping 时不会触发。
//
// 这一段**取代的是旧的按引擎 provider 测试**（当时给每个类注入假 `fetch` 来验各自的映射表）。
// 那些映射表现在只有一份，在 `pic-image-search-client.ts` 的 `toImageSourceResult()` 里；
// 这里验的是 provider 这一层：**不加工、不吞错误、不解释引擎名**。
const { PicImageSearchProvider } = await load('media/image-source/pic-image-search-provider.js');

/** 假的 `PicImageSearchPort`。`seen` 记下每次调用的**全部位次参数**，供逐位断言。 */
function fakePort(over = {}) {
  const seen = [];
  return {
    seen,
    async search(...args) { seen.push(args); return over.search ? over.search(...args) : { results: [], statusCode: 200 }; },
    async ping(...args) { seen.push(args); if (over.ping) return over.ping(...args); return true; }
  };
}

const imgBytes = Buffer.from([1]);
const port = fakePort();
const generic = new PicImageSearchProvider(port);
const genericRes = await generic.search('trace.moe', imgBytes, 'image/png', 1000, 2);
ok('通用 provider 按位次原样转发（引擎名由 Node 给，Node 不解释它）',
  port.seen[0][0] === 'trace.moe' && port.seen[0][1] === imgBytes && port.seen[0][2] === 'image/png'
  && port.seen[0][3] === 1000 && port.seen[0][4] === 2,
  JSON.stringify(port.seen[0].slice(0, 5).map((x) => (Buffer.isBuffer(x) ? `<buffer ${x.length}>` : String(x)))));
ok('通用 provider 原样返回客户端的结果（不二次映射、不改字段）',
  genericRes.statusCode === 200 && genericRes.results.length === 0);

const abortSignal = new AbortController().signal;
const portSig = fakePort();
await new PicImageSearchProvider(portSig).search('saucenao', imgBytes, 'image/png', 1, 1, abortSignal, { apiKey: 'k' });
ok('AbortSignal 与 engineOptions 都按位次传到底（SauceNAO 的 key 只走这里 —— 进 stdin，绝不进 argv）',
  portSig.seen[0][5] === abortSignal && portSig.seen[0][6]?.apiKey === 'k',
  JSON.stringify(portSig.seen[0].map((x) => (Buffer.isBuffer(x) ? '<buffer>' : String(x)))));

// 错误码原样透传：服务层的 failures 记的就是 `error.message`，把码换成别的话等于换掉排查线索。
for (const code of ['RATE_LIMIT', 'QUOTA_EXHAUSTED', 'TIMEOUT']) {
  await new PicImageSearchProvider(fakePort({ search: () => { throw new Error(code); } }))
    .search('saucenao', imgBytes, 'image/png', 1, 1)
    .then(() => ok(`provider 原样透传 ${code}`, false), (e) => ok(`provider 原样透传 ${code}`, e.message === code));
}

const portPing = fakePort();
const pingOk = await new PicImageSearchProvider(portPing).test('saucenao', 1234, { apiKey: 'k' });
ok('test() 走 ping() 而不是 search()：引擎名、超时与引擎参数都递下去',
  pingOk === true && portPing.seen[0][0] === 'saucenao' && portPing.seen[0][1] === 1234
  && portPing.seen[0][3]?.apiKey === 'k',
  JSON.stringify(portPing.seen[0].map((x) => (Buffer.isBuffer(x) ? '<buffer>' : String(x)))));
ok('ping 返回 false 时 test() 就是 false（不把它当可用）',
  (await new PicImageSearchProvider(fakePort({ ping: () => false })).test('trace.moe', 1)) === false);
await new PicImageSearchProvider(fakePort({ ping: () => { throw new Error('库没装'); } })).test('trace.moe', 1)
  .then((v) => ok('test() 吞掉异常返回 false，从不抛（设置页按钮路径）', v === false),
    () => ok('test() 吞掉异常返回 false，从不抛（设置页按钮路径）', false));

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

// ── 展示层：模型看到的那几行字由这里唯一决定 ─────────────────────
// `formatImageSourceResult` 是"上层不感知 Python 细节"的落点 —— 引擎无论由谁答、字段无论
// 由哪层归一化，到这里都只剩几行文本。它同时是 `title` 改可选（数据层不再编造名字，
// 见 `types.ts`）之后**唯一**的兜底处：兜错了就在群里印出字面量 `undefined`。
// 这个函数此前一条断言都没有，下面逐条钉住输出形状。
const { formatImageSourceResult } = await load('media/image-source/result-formatter.js');
const animeCase = (over = {}) => ({ provider: 'trace.moe', kind: 'anime', similarity: 0.95, ...over });
const illCase = (over = {}) => ({ provider: 'saucenao', kind: 'illustration', similarity: 0.8, ...over });

ok('动画结果：集数与时间点都在时合成一行',
  formatImageSourceResult(animeCase({ title: '某番', episode: '12', time: 65 }))
  === '可能是《某番》\n第 12 集，01:05\n匹配度：95%',
  JSON.stringify(formatImageSourceResult(animeCase({ title: '某番', episode: '12', time: 65 }))));
ok('动画结果：只有集数时**不**凭空印出 00:00（旧版无条件插值 time||0，等于替接口编了个时间点）',
  formatImageSourceResult(animeCase({ title: '某番', episode: '12' }))
  === '可能是《某番》\n第 12 集\n匹配度：95%');
ok('动画结果：只有时间点时不印"第 集"',
  formatImageSourceResult(animeCase({ title: '某番', time: 65 }))
  === '可能是《某番》\n01:05\n匹配度：95%');
ok('time === 0 是合法值（正好片头），不是"没给"：照样印 00:00',
  formatImageSourceResult(animeCase({ time: 0 })).includes('\n00:00\n'),
  JSON.stringify(formatImageSourceResult(animeCase({ time: 0 }))));
ok('集数与时间点都没有时整行让位，不留空行、不漏字面量 undefined',
  formatImageSourceResult(animeCase({})) === '可能是《未知作品》\n匹配度：95%',
  JSON.stringify(formatImageSourceResult(animeCase({}))));
ok('插画结果走另一套标签，缺失的 title 兜成"未知来源"',
  formatImageSourceResult(illCase({ author: '画师A', source: 'Pixiv', url: 'https://x/1' }))
  === '可能来源：未知来源\n画师：画师A\n来源：Pixiv\n相似度：80%\n链接：https://x/1');
ok('没有结果时那句固定说明（工具与模型看到的就是它）',
  formatImageSourceResult(null).startsWith('没找到可靠图源'));

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
ok('工具在查询前先消耗调用额度', toolSrc.includes('budget.take(ctx.chatKey)'));
// 与 transcribe_video 同一契约：工具不代模型开口。代发会写进 session.sent，把这一轮撑成
// done —— 模型本该给群友一句"没找到/接口出错"，却会停在错误结果上结束，群里只剩那句占位。
ok('工具自己不发消息：不碰 sender、不写 session.sent、不发事件',
  !toolSrc.includes('sendTextBatch') && !toolSrc.includes('session.sent')
  && !toolSrc.includes('ctx.emit') && !toolSrc.includes('EVENTS'));

const sectionsSrc = readUI('js/views/settings/sections.js');
const saveSrc = readUI('js/views/settings/save.js');
ok('设置页渲染了每群每小时与全局每日两个输入框', sectionsSrc.includes('id="cfg-image-source-chat-hourly"') && sectionsSrc.includes('id="cfg-image-source-daily"'));
ok('保存时钳制并持久化两个调用上限', saveSrc.includes("clampInt(val('#cfg-image-source-chat-hourly'") && saveSrc.includes("clampInt(val('#cfg-image-source-daily'"));

// ── 工具层：失败原因不许被吞掉 ───────────────────────────────────
// 这是全项目问题最多的一条链路（先撞语义闸门，再撞兜底文案），而它此前**一条工具级断言都没有**。
// 下面用必然解析失败的地址驱动：查询会立刻以 "URL 无效" / "禁止访问内网/本机地址" 结束，
// 不联网、不依赖真实图床，但足以证明"查询确实跑过"以及"原因确实被带了出来"。
const { buildToolDefs, executeTool } = await load('agent/tools/index.js');
const { updateConfig } = await load('core/config.js');
const { imageSourceFailureText } = await load('agent/tools/image-source.js');
const defs = buildToolDefs();
updateConfig({ imageSource: { enabled: true } });

const warns = [];
const realWarn = console.warn;
console.warn = (...args) => { warns.push(args.map(String).join(' ')); };
try {
  // 每个用例一个**全新的 chatKey**：额度闸门是模块级单例，复用键会被前面的用例记账拦下（假红）。
  const emits = [];
  const ctxOf = (chatKey, url) => ({
    chatKey,
    sender: { sendTextBatch: async () => { throw new Error('发送频率超限（每分钟最多 80 条），请等一会再发'); } },
    session: { id: 's1', sent: [] },
    emit: (type) => { emits.push(type); },
    store: { findByMid: () => null },
    triggerEntries: [{ mid: 'm1', media: [{ kind: 'image', url }] }]
  });

  // ① 把 sender 换成**必抛**的：工具压根不碰它，查询必须照常跑完并把真实原因带回模型。
  // （旧版在这里代发「在找图源，稍等」，这条用例当时验的是"占位发不出去也不能拖累查询"。）
  const failedSend = await executeTool(defs, ctxOf('group:88001', 'not-a-url'), 'reverse_image_source', { messageId: 'm1' });
  ok('工具不代发消息：sender 必抛也照样跑完查询，并把真实原因带回模型',
    failedSend.isError === true && failedSend.content.includes('URL 无效'), failedSend.content);
  ok('失败原因不再被报成"这次图源识别没成功"（旧兜底文案）',
    !failedSend.content.includes('没成功'), failedSend.content);

  // ② 原因必须落进日志：会话记录里只能看到工具结果这句话，console 是唯一的排查面。
  ok('查询失败写了 console.warn',
    warns.some((w) => w.includes('查询失败：URL 无效')), warns.join(' | '));
  ok('不再有"占位提示发送失败"那条日志（占位提示已删除）',
    !warns.some((w) => w.includes('占位提示')), warns.join(' | '));

  // ③ 工具零外部动作 —— 这一轮"发过话"的账只能由模型自己的 send_message 记。
  const sentCalls = [];
  const okCtx = {
    ...ctxOf('group:88002', 'not-a-url'),
    session: { id: 's2', sent: [] },
    sender: { sendTextBatch: async (...args) => { sentCalls.push(args); return { sent: [{ text: 'x', at: '12:00' }], failed: [] }; } }
  };
  await executeTool(defs, okCtx, 'reverse_image_source', { messageId: 'm1' });
  ok('工具零发送：不调 sender、不写 session.sent、不发 session-update（否则失败的一轮会被撑成 done）',
    sentCalls.length === 0 && okCtx.session.sent.length === 0 && emits.length === 0,
    `calls=${sentCalls.length} sent=${okCtx.session.sent.length} emits=${emits.join(',')}`);

  // ④ 安全层挡下的地址也要如实说明，不能退化成一句泛泛的失败。
  const blocked = await executeTool(defs, ctxOf('group:88003', 'http://127.0.0.1/x.png'), 'reverse_image_source', { messageId: 'm1' });
  ok('被 SSRF 挡下时如实带出原因', blocked.content.includes('禁止访问内网'), blocked.content);
} finally {
  console.warn = realWarn;
}

// ⑤ 映射表是纯函数，可以离线逐条钉住；未知原因**必须**带回原始码。
ok('已知失败原因各有专属文案',
  ['TOTAL_TIMEOUT', 'IMAGE_FORMAT', 'IMAGE_EMPTY', 'IMAGE_TOO_LARGE', 'QUEUE_FULL', 'DISABLED']
    .every((code) => imageSourceFailureText(code) !== imageSourceFailureText('SOMETHING_ELSE'))
  && imageSourceFailureText('TOTAL_TIMEOUT').includes('超时') && imageSourceFailureText('IMAGE_FORMAT').includes('格式'));
ok('未知失败原因带回原始码或说明未知，不压成泛泛的一句',
  imageSourceFailureText('HTTP 403').includes('HTTP 403') && imageSourceFailureText('').includes('未知原因'));

// ⑥ 服务层的 failures 是"接口报错"的唯一痕迹：全空结果配上非空 failures 必须走报错分支。
// 这条是对**工具侧**分支的文本断言（它得便宜、得在工具被改动时立刻红）。服务层能不能真的
// 产出 failures 曾经是守护空白（当时套件里没有可注入 loader 的口子），现在由下面 ⑦ 起一个
// 环回图床喂真图来覆盖 —— 两件事互补，别把任一条当成另一条的替身。
ok('服务层报过错的全空结果不会被当成"没找到图源"',
  toolSrc.includes('output.failures.length') && toolSrc.includes('图源接口这次没返回结果'));

// ── ⑦ 服务层的分发与过滤 ─────────────────────────────────────────
// 这一段是本次重构少有的**净收益**：分发（按 intent 决定先问谁）与过滤（各自的门槛、
// 启用开关、空 key）此前**一条断言都没有**，只靠"读一遍代码"确认。
//
// 要驱动服务层就必须真的下载成功一张图（`#perform` 第一行是 `loadSafeImage`），而套件里
// 没有可注入 loader 的口子 —— 所以起一个**环回** HTTP 图床喂一张 16 字节的合法 PNG 头
// （`detectMime` 只认魔数），并临时打开 `security.allowPrivateImageHosts` 让 SSRF 层放行
// 127.0.0.1。**必须在上面"被 SSRF 挡下"那条用例之后才开** —— 它验的正是"默认不放行内网"。
const { ReverseImageSourceService } = await load('media/image-source/reverse-image-source-service.js');
// 16 字节的合法 PNG 头：`detectMime` 只看魔数（前 4 字节），不需要真的能解码。
const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const imgServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG_HEAD); });
await new Promise((resolve) => imgServer.listen(0, '127.0.0.1', resolve));
const localImg = `http://127.0.0.1:${imgServer.address().port}/a.png`;
updateConfig({ security: { allowPrivateImageHosts: true } });

/** 一段完整的 imageSource 配置。走 `deps.getConfig()` 注入，不碰全局配置单例。 */
const cfgOf = (over = {}) => ({
  enabled: true,
  traceMoe: { enabled: true, timeoutMs: 1000, minSimilarity: 0.87, maxResults: 3 },
  sauceNao: { enabled: true, apiKey: 'secret-test-key', timeoutMs: 1000, minSimilarity: 0.80, maxResults: 3 },
  maxImageBytes: 8 * 1024 * 1024,
  maxQueueLength: 5,
  totalTimeoutMs: 35000,
  // 关缓存：每个用例喂的是同一份字节，开着的话第二个用例会直接命中缓存、一次 provider 都不调。
  cacheEnabled: false,
  cacheTtlMs: 60000,
  ...over
});

/** 用假 provider 跑一次**真实下载 + 完整分发**，返回调用记录与输出。 */
async function dispatch(over, responders, intent) {
  const calls = [];
  const provider = {
    async search(engine, buffer, mime, timeoutMs, maxResults, signal, options) {
      calls.push({ engine, mime, timeoutMs, maxResults, signal, options });
      const reply = responders[engine];
      return typeof reply === 'function' ? reply() : { results: [], statusCode: 200 };
    },
    async ping() { return true; }
  };
  const service = new ReverseImageSourceService({ getConfig: () => cfgOf(over), provider });
  return { out: await service.search(localImg, intent), calls };
}

const animeHit = await dispatch({}, { 'trace.moe': () => ({ results: [{ similarity: 0.95 }], statusCode: 200 }) }, 'anime');
ok('intent=anime 先问 trace.moe，命中就不问第二个',
  animeHit.calls.map((c) => c.engine).join(',') === 'trace.moe' && animeHit.out.result?.similarity === 0.95,
  animeHit.calls.map((c) => c.engine).join(','));
ok('每个引擎用自己那段配置，且 mime 来自真实下载（超时与条数不串台）',
  animeHit.calls[0].timeoutMs === 1000 && animeHit.calls[0].maxResults === 3 && animeHit.calls[0].mime === 'image/png',
  JSON.stringify(animeHit.calls[0]));
ok('AbortSignal 传到了 provider（取消链路的这一端）', animeHit.calls[0].signal instanceof AbortSignal);
ok('trace.moe 没有私有参数，engineOptions 保持 undefined（别凭空造一个空对象）',
  animeHit.calls[0].options === undefined, JSON.stringify(animeHit.calls[0].options));

const illHit = await dispatch({}, { saucenao: () => ({ results: [{ similarity: 0.9 }], statusCode: 200 }) }, 'illustration');
ok('intent=illustration 先问 saucenao', illHit.calls[0]?.engine === 'saucenao', illHit.calls.map((c) => c.engine).join(','));
ok('SauceNAO 的 apiKey 从配置经 engineOptions 递到 provider（不进 URL、不进 argv，只进 stdin）',
  illHit.calls[0].options?.apiKey === 'secret-test-key');

const fallthrough = await dispatch({}, {
  'trace.moe': () => ({ results: [{ similarity: 0.5 }], statusCode: 200 }),
  saucenao: () => ({ results: [{ similarity: 0.92 }], statusCode: 200 })
}, 'anime');
ok('前一个引擎的结果低于它自己的门槛时继续问下一个，取达到门槛的那条',
  fallthrough.calls.map((c) => c.engine).join(',') === 'trace.moe,saucenao' && fallthrough.out.result?.similarity === 0.92,
  `calls=${fallthrough.calls.map((c) => c.engine).join(',')} sim=${fallthrough.out.result?.similarity}`);

const below = await dispatch({}, { 'trace.moe': () => ({ results: [{ similarity: 0.86 }], statusCode: 200 }) }, 'anime');
ok('低于门槛的结果不被当成命中（0.86 < trace.moe 的 0.87）', below.out.result === null);

const traceOff = await dispatch(
  { traceMoe: { enabled: false, timeoutMs: 1000, minSimilarity: 0.87, maxResults: 3 } },
  { saucenao: () => ({ results: [{ similarity: 0.95 }], statusCode: 200 }) }, 'anime');
ok('关掉的引擎被跳过（intent=anime 本该先问 trace.moe，这里直接问 saucenao）',
  traceOff.calls.map((c) => c.engine).join(',') === 'saucenao' && traceOff.out.result?.similarity === 0.95);

const noKey = await dispatch(
  { sauceNao: { enabled: true, apiKey: '', timeoutMs: 1000, minSimilarity: 0.80, maxResults: 3 } },
  { 'trace.moe': () => ({ results: [], statusCode: 200 }) }, 'illustration');
ok('enabled 但空 apiKey 的 SauceNAO 视同没开：一次调用都不发、也不记 failure（不把"没配"伪装成"接口出错"）',
  noKey.calls.map((c) => c.engine).join(',') === 'trace.moe' && noKey.out.failures.length === 0,
  `calls=${noKey.calls.map((c) => c.engine).join(',')} failures=${noKey.out.failures.join('|')}`);

const failTrace = await dispatch({}, {
  'trace.moe': () => { throw new Error('TIMEOUT'); },
  saucenao: () => ({ results: [], statusCode: 200 })
}, 'anime');
ok('引擎抛错时 failures 用 trace:/sauce: 标签 —— 它经工具原样进模型可见文本，不能为了好看改成引擎名',
  failTrace.out.failures.length === 1 && failTrace.out.failures[0] === 'trace:TIMEOUT' && failTrace.out.result === null,
  failTrace.out.failures.join('|'));
ok('一个引擎报错不拦下另一个（顺序走完，错误只记账）',
  failTrace.calls.map((c) => c.engine).join(',') === 'trace.moe,saucenao');

const failSauce = await dispatch(
  { traceMoe: { enabled: false, timeoutMs: 1000, minSimilarity: 0.87, maxResults: 3 } },
  { saucenao: () => { throw new Error('RATE_LIMIT'); } }, 'illustration');
ok('SauceNAO 侧同样是 sauce: 标签', failSauce.out.failures[0] === 'sauce:RATE_LIMIT', failSauce.out.failures.join('|'));

// ── ⑦b 缓存：按引擎分开、失败不缓存 ──────────────────────────────
// 上一版的键**只有图片 hash**，缓存的值是**整轮结论**（已挑好、已过滤的 `SearchOutput`）。
// 两个后果都在下面被钉住：
//  ① 换 intent 后"先问哪个引擎"变了，却会命中另一个引擎的结论 —— 用户看到的是"换了个问法，
//     答案一模一样"，而第二个引擎**根本没被问过**；
//  ② 失败也被写进缓存：一次"全引擎超时"会让这张图在 cacheTtlMs（默认 24 小时）内**永远**
//     返回失败，而远端可能早就好了。
// 现在缓存的是**单个引擎的响应**，键 = 引擎 + 图片 hash + maxResults + 引擎参数指纹。
// 这些用例必须共用一个 service 实例才有缓存可言 → 与上面的 `dispatch`（一次一实例）分开。
function cachedService(over, responders) {
  const calls = [];
  const provider = {
    async search(engine, buffer, mime, timeoutMs, maxResults, signal, options) {
      calls.push({ engine, maxResults, options });
      const reply = responders[engine];
      return typeof reply === 'function' ? reply() : { results: [], statusCode: 200 };
    },
    async ping() { return true; }
  };
  // 配置对象固定一份并返回出去：缓存键里的 maxResults / apiKey 由它决定，用例要改就得改它。
  const cfg = cfgOf({ cacheEnabled: true, ...over });
  const service = new ReverseImageSourceService({ getConfig: () => cfg, provider });
  return { calls, cfg, run: (intent) => service.search(localImg, intent) };
}

const hit = cachedService({}, { 'trace.moe': () => ({ results: [{ similarity: 0.95 }], statusCode: 200 }) });
const hitFirst = await hit.run('anime'); const hitSecond = await hit.run('anime');
ok('同引擎 + 同图 + 同条数：第二次不再发远端调用，并标记 cached',
  hit.calls.length === 1 && hitFirst.cached === false && hitSecond.cached === true && hitSecond.result?.similarity === 0.95,
  `calls=${hit.calls.length} cached=${hitFirst.cached}/${hitSecond.cached}`);

const sepReply = { 'trace.moe': () => ({ results: [{ similarity: 0.95 }], statusCode: 200 }) };
const sep = cachedService({}, sepReply);
await sep.run('anime');
sepReply.saucenao = () => { throw new Error('RATE_LIMIT'); };
const sepSecond = await sep.run('illustration');
ok('换 intent 不会被另一个引擎的缓存顶替：sauce 侧没有缓存槽，必须真去问（并如实报错）',
  sep.calls.map((c) => c.engine).join(',') === 'trace.moe,saucenao'
  && sepSecond.failures.includes('sauce:RATE_LIMIT') && sepSecond.cached === false,
  `calls=${sep.calls.map((c) => c.engine).join(',')} failures=${sepSecond.failures.join('|')} cached=${sepSecond.cached}`);
ok('部分命中不算 cached（这个标记只回答"这次有没有花钱"，半缓存半真查的答案是有花钱）',
  sepSecond.result?.similarity === 0.95, String(sepSecond.result?.similarity));

const failRuns = cachedService(
  { sauceNao: { enabled: false, apiKey: '', timeoutMs: 1000, minSimilarity: 0.8, maxResults: 3 } },
  { 'trace.moe': () => { throw new Error('TIMEOUT'); } });
await failRuns.run('anime'); await failRuns.run('anime');
ok('失败不进缓存：同一张图连问两次都真的去问了（旧版会把一次超时冻结 cacheTtlMs）',
  failRuns.calls.length === 2, `calls=${failRuns.calls.length}`);

const mr = cachedService({}, { 'trace.moe': () => ({ results: [{ similarity: 0.95 }], statusCode: 200 }) });
await mr.run('anime');
mr.cfg.traceMoe = { ...mr.cfg.traceMoe, maxResults: 5 };   // 改条数就是在问不同的问题
await mr.run('anime');
ok('maxResults 也进键：改了条数必须重新问（否则用户调了条数却拿回上一次的条数）',
  mr.calls.length === 2 && mr.calls[1].maxResults === 5,
  `calls=${mr.calls.length} last=${mr.calls.at(-1)?.maxResults}`);

const keyRuns = cachedService({}, { saucenao: () => ({ results: [{ similarity: 0.9 }], statusCode: 200 }) });
await keyRuns.run('illustration');
keyRuns.cfg.sauceNao = { ...keyRuns.cfg.sauceNao, apiKey: 'another-key' };
await keyRuns.run('illustration');
ok('引擎参数指纹也进键：换了 SauceNAO 的 key 不命中上一次的缓存',
  keyRuns.calls.length === 2 && keyRuns.calls[1].options?.apiKey === 'another-key',
  `calls=${keyRuns.calls.length} key=${keyRuns.calls.at(-1)?.options?.apiKey}`);

await new Promise((resolve) => imgServer.close(resolve));
updateConfig({ security: { allowPrivateImageHosts: false } });   // 还原，别把内网放行漏给后续用例

// ── ⑧ 原生 fetch 已删 ─────────────────────────────────────────────
// 两个按引擎的 provider 文件整体消失，搜图目录里也不再出现任何引擎端点或 fetch 注入口。
// 这是"引擎知识只在 Python 一份"的机检边界：谁把 URL 或 `fetchImpl` 写回来，这条就红。
const imageDir = path.join(ROOT, 'src/media/image-source');
const leaked = fs.readdirSync(imageDir).filter((f) => f.endsWith('.ts')).filter((f) => {
  const src = stripComments(fs.readFileSync(path.join(imageDir, f), 'utf8'));
  return /saucenao\.com|api\.trace\.moe|TraceMoeProvider|SauceNaoProvider|fetchImpl/.test(src);
});
ok('搜图目录里没有任何原生端点或按引擎的 provider（引擎知识只在 Python 一份）', leaked.length === 0, leaked.join(','));
ok('两个按引擎的 provider 文件已删除',
  !fs.existsSync(path.join(imageDir, 'saucenao-provider.ts')) && !fs.existsSync(path.join(imageDir, 'trace-moe-provider.ts')));

// 引擎表是**逐行声明**的：加一个引擎 = 加一行 + 在 ORDER 里给它定位置（顺序是语义，不该由
// 一条"按 kind 排序"的现成规则替加引擎的人做决定）。这两条是形态断言，行为断言在上面 ⑦。
const svcSrc = stripComments(fs.readFileSync(path.join(imageDir, 'reverse-image-source-service.ts'), 'utf8'));
ok('引擎表与顺序表都是显式声明的（`Record<EngineWhich, EngineRow>` / `Record<SearchIntent, …>`）',
  svcSrc.includes('ENGINE_ROWS: Record<EngineWhich, EngineRow>')
  && svcSrc.includes('ORDER: Record<SearchIntent, readonly EngineWhich[]>'));

// ⚠️ AnimeTrace **不在**表里，这是决定而不是遗漏：worker 的 `ENGINE_CLASS_CANDIDATES` 里
// `anime_trace` 的候选是 `("TraceMoe","AnimeTrace")` —— 它是 trace.moe 的**中文叫法**，
// 同一个远端服务。加成一个独立引擎、两个都打开，就会对同一个接口打两次、白烧一份配额。
// 谁要真加它，先想清楚这一点，再把这行断言改掉。
// （这条扫的是剥注释后的源码：文件里那段说明 AnimeTrace 为什么不在表里的注释不算数。）
ok('AnimeTrace 没有被加成第三个引擎（它是 trace.moe 的别名，不是独立服务）',
  !svcSrc.includes('anime_trace'));

// ── ⑨ 引擎名是跨进程的手工镜像 ───────────────────────────────────
// `types.ts` 的 `PicImageSearchEngine` ↔ 客户端的 `PIC_IMAGE_SEARCH_ENGINES` 有编译期覆盖
// 断言，但 **Python 那一侧谁都没管**：worker 的 `ENGINE_CLASS_CANDIDATES` 少一个键、多一个
// 键，Node 这边不会有任何动静（`.py` 不进 `tsc`，也没有任何套件读它）。
//
// 本段有两条断言，**它们的能力边界不一样，别把后一条当前一条用**：
//   ① 键集合比对（下面第一条）—— 引擎少一个/多一个会红。但它**只比键**：把 `baidu` 的候选从
//      `("BaiDu","Baidu")` 改回 `("Baidu",)`，键集合照样对得上，实测全绿。
//   ② `MEASURED_FIRST_CANDIDATE`（下面第二条）—— 钉住**实测到的类名**。实测踩到过：`baidu`
//      曾写成 `("Baidu",)`，而库里导出的名字是 `BaiDu`（大写的 D），于是那个引擎**永远解析
//      不到**：既不出现在 ready 事件的 engines 里，真去请求也报 PROVIDER_UNAVAILABLE。而静态
//      清单里 `baidu` 一直都在，谁也不觉得缺 —— 类名的拼写只能靠**带库的机器**实测
//      （`--self-check`）看出来，本地推不出来。所以 ② 钉的是**实测结论**，不是可推导的规则：
//      它挡不住"库改名"，只挡得住"有人把已经实测对的名字又改回去"。库里真改名了 → 重跑一次
//      `--self-check`，同时改 worker 的表与这一行。
const { PIC_IMAGE_SEARCH_ENGINES } = await load('media/image-source/pic-image-search-client.js');
const workerPath = path.join(ROOT, 'python-tools', 'pic_image_search_worker.py');
const workerSrc = fs.readFileSync(workerPath, 'utf8');
/** 取 Python 里某个 dict 字面量的表体，并**按行丢掉注释**（`#` 开头的行不参与匹配）。 */
const pyTable = (name) => {
  const body = (workerSrc.match(new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`)) || [])[1] || '';
  const lines = body.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n');
  return {
    body,
    lines,
    keys: [...lines.matchAll(/^\s*"([\w.]+)"\s*:/gm)].map((m) => m[1]),
    values: [...lines.matchAll(/^\s*"[\w.]+"\s*:\s*"([\w.]+)"/gm)].map((m) => m[1]),
    /** 键 → 候选元组（`"k": ("A", "B"),` 括号里那一串）。 */
    candidates: new Map([...lines.matchAll(/^\s*"([\w.]+)"\s*:\s*\(([^)]*)\)/gm)]
      .map((m) => [m[1], [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1])]))
  };
};
const classTable = pyTable('ENGINE_CLASS_CANDIDATES');
const nodeEngines = [...PIC_IMAGE_SEARCH_ENGINES].sort();
ok('worker 的引擎键与 Node 的引擎名逐字相同（跨进程镜像，没有编译器管它）',
  classTable.keys.length > 0
  && JSON.stringify([...classTable.keys].sort()) === JSON.stringify(nodeEngines),
  `worker=[${[...classTable.keys].sort().join(',')}] node=[${nodeEngines.join(',')}]`);

// 2026-09-29 在目标解释器上跑 `--self-check` 实测到的**库导出的类名**（PicImageSearch 3.12.11，
// 结论与理由写在 worker 头部 ⚑ c 条）。断言的是"实测名在候选链里、**够得着**"，不是"必须排第一"
// —— 顺序另有语义（`google_lens` 的 `Google` 近亲、`tineye` 的老版本名都刻意排在后面）。
const MEASURED_CLASS_NAMES = {
  'saucenao': 'SauceNAO', 'trace.moe': 'TraceMoe', 'baidu': 'BaiDu', 'bing': 'Bing',
  'google_lens': 'GoogleLens', 'yandex': 'Yandex', 'tineye': 'Tineye'
};
const unreachable = Object.entries(MEASURED_CLASS_NAMES)
  .filter(([key, cls]) => !(classTable.candidates.get(key) ?? []).includes(cls))
  .map(([key, cls]) => `${key} 候选中没有 ${cls}（现在是 [${(classTable.candidates.get(key) ?? []).join(',')}]）`);
ok('各引擎的候选链都还够得着实测到的类名（`Baidu`/`BaiDu` 那种拼写错误骗得过上面那条）',
  unreachable.length === 0,
  `${unreachable.join('；')} —— 实测名是从 worker 头部 ⚑ c 条抄来的，改表时别把它改掉；`
  + '库里真改名了要重跑 `--self-check` 并同时改这两处');

// 归一化器是**按家族**挑的（`ENGINE_FAMILY.get(engine, "web")`），而家族名与引擎名是两套字面量：
// 家族键拼错 → 静默退回通用 "web" 提取表（字段全丢但不报错）；家族的**值**拼错 → 更糟，
// `_NORMALIZERS[...]` 直接 KeyError。两种都在这里挡住。
const familyTable = pyTable('ENGINE_FAMILY');
const normalizers = pyTable('_NORMALIZERS');
ok('worker 的引擎家族表指向真实存在的引擎与归一化器（拼错会静默退回通用提取表）',
  familyTable.keys.length > 0 && normalizers.keys.length > 0
  && familyTable.keys.every((k) => classTable.keys.includes(k))
  && familyTable.values.every((v) => normalizers.keys.includes(v)),
  `family=[${familyTable.keys.join(',')}] → [${familyTable.values.join(',')}] normalizers=[${normalizers.keys.join(',')}]`);

// 必须是 process.exit(done() …)：done() 只**返回**布尔值、自己从不退出（见 lib/harness.mjs:27），
// 而 run.mjs 单看子进程的退出码判定成败。这里原先是一句裸 `done();`，于是本套件**永远退 0** ——
// 断言红成一片，run.mjs 照样报 ✅。（实测：30 通过 / 5 失败的一次运行，run.mjs 显示全绿。）
process.exit(done() ? 0 : 1);

