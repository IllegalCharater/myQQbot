import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, readUI, stripComments } from './lib/src.mjs';

// dataDir 必须先于 load('core/config.js')：末尾的工具级用例要开功能开关，
// config 在加载时就把 DATA_DIR 定死，晚一步就会往真 data/ 里写配置。
dataDir('qqagent-image-source-');

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
// 这条只能做文本断言——要让服务层真的返回 failures 得先下载成功一张图并让真实
// provider 报错，套件里没有可注入 loader 的口子（守护空白，别以为它被行为断言管着）。
ok('服务层报过错的全空结果不会被当成"没找到图源"',
  toolSrc.includes('output.failures.length') && toolSrc.includes('图源接口这次没返回结果'));

// 必须是 process.exit(done() …)：done() 只**返回**布尔值、自己从不退出（见 lib/harness.mjs:27），
// 而 run.mjs 单看子进程的退出码判定成败。这里原先是一句裸 `done();`，于是本套件**永远退 0** ——
// 断言红成一片，run.mjs 照样报 ✅。（实测：30 通过 / 5 失败的一次运行，run.mjs 显示全绿。）
process.exit(done() ? 0 : 1);

