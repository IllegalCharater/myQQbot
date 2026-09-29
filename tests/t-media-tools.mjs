// 模型自主调用的两个能力工具：get_hot_search（只取榜单）与 transcribe_video（转写）。
//
// 这里验的是**工具层的接线与闸门**，不重复验各自的领域逻辑：
//   · 热搜的接口契约、去重分页、幂等互斥在 t-hot-search.mjs
//   · 转写的 SSRF、单并发状态机、凭证脱敏在 t-transcription.mjs
// 闸门本体（滑动窗口）在两个功能间的共用性由 t-image-source.mjs 与这里的配额用例共同钉住。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, readUI, stripComments } from './lib/src.mjs';

// dataDir 必须先于 load('core/config.js')：config 在加载时就把 DATA_DIR 定死，
// 晚一步这个套件就会往真 data/ 里写配置（真 key、真白名单）。
const DATA = dataDir('qqagent-media-tools-');
const { ok, done } = checker();

const { buildToolDefs, executeTool } = await load('agent/tools/index.js');
const { DEFAULT_CONFIG, updateConfig } = await load('core/config.js');
const { resolveTranscriptionConfig, TranscriptionError } = await load('media/video-transcription.js');
const { HotSearchStateStore } = await load('media/hot-search/state-store.js');
const { HotSearchScheduler } = await load('media/hot-search/scheduler.js');

const defs = buildToolDefs();

// ── 共用夹具 ─────────────────────────────────────────────────────
// 假 sender 记录每次 sendTextBatch 的实参：热搜工具必须一次都不发；转写工具恰好发一条
// 固定回执（结果本身不贴群，改成进模型上下文 —— 见 t-transcription.mjs 的 assisted 段）。
// `session` 与 `emit` 在 ToolContext 上是必填：漏了会在运行期抛 TypeError，
// 而套件里一个未捕获异常会**静默吃掉它后面的全部断言**（终端上只显示"这个套件失败了"）。
const sent = [];
const sessions = [];
const emits = [];
const ctxOf = ({ hotSearch, transcription, store, triggerEntries = [], chatKey = 'group:10001' } = {}) => {
  const session = { id: `s-${sessions.length + 1}`, sent: [] };
  sessions.push(session);
  return {
    chatKey,
    sender: {
      sendTextBatch: async (...args) => {
        sent.push(args);
        return { sent: [{ text: String(args[1]), at: 1 }], failed: [] };
      }
    },
    triggerEntries,
    store: store || { findByMid: () => null },
    session,
    emit: (type, payload) => { emits.push([type, payload]); },
    hotSearch,
    transcription
  };
};
const lastSession = () => sessions[sessions.length - 1];

// ── get_hot_search ──────────────────────────────────────────────
const limitsSeen = [];
const hotCtx = () => ctxOf({
  hotSearch: {
    readTopics: async (limit) => {
      limitsSeen.push(limit);
      return { generatedAt: '2026-09-28T08:30:00+08:00', itemCount: 2, pages: ['第一页', '第二页'], authMode: 'anonymous' };
    }
  }
});

const listed = await executeTool(defs, hotCtx(), 'get_hot_search', {});
ok('取榜单把分页文本拼成一条工具结果', listed.isError !== true && listed.content === '第一页\n\n第二页',
  `content=${JSON.stringify(listed.content)}`);
ok('取榜单工具自己不发送任何消息（要不要发由模型决定）', sent.length === 0);

await executeTool(defs, hotCtx(), 'get_hot_search', { limit: 5 });
ok('limit 原样传给取榜接口', limitsSeen.at(-1) === 5, `seen=${limitsSeen.at(-1)}`);
await executeTool(defs, hotCtx(), 'get_hot_search', { limit: 'abc' });
ok('非法 limit 退化成"用配置里的条数"（传 undefined 而不是 NaN）', limitsSeen.at(-1) === undefined,
  `seen=${limitsSeen.at(-1)}`);

const busy = await executeTool(defs, ctxOf({
  hotSearch: { readTopics: async () => { throw new Error('热搜任务正在运行，请稍后再试'); } }
}), 'get_hot_search', {});
ok('热搜正忙时把真实原因转述给模型', busy.isError === true && busy.content.includes('正在运行'), busy.content);

const noDep = await executeTool(defs, ctxOf({}), 'get_hot_search', {});
ok('缺 hotSearch 依赖时返回友好错误而不是抛', noDep.isError === true && noDep.content.includes('未启用'));

// ── transcribe_video ────────────────────────────────────────────
const jobs = [];
const queue = {
  enqueue: ({ chatKey, url, replyToMessageId, mode }) => {
    jobs.push({ chatKey, url, replyToMessageId, mode });
    return { id: 'abcdef1234567890' };
  }
};

const beforeUrl = sent.length;
const byUrl = await executeTool(defs, ctxOf({ transcription: queue }), 'transcribe_video', { url: ' https://example.com/v.mp4 ' });
ok('url 路径去掉首尾空白后交给队列并回任务号',
  jobs.at(-1).url === 'https://example.com/v.mp4' && byUrl.content.includes('abcdef12'), byUrl.content);
ok('结果不贴群：工具只代发一条固定回执「我先看看」',
  sent.length === beforeUrl + 1 && String(sent.at(-1)[1]) === '我先看看', JSON.stringify(sent.slice(beforeUrl)));
ok('回执记进会话并广播 session-update（面板要立刻看到这次发言）',
  lastSession().sent.length === 1 && lastSession().sent[0].text === '我先看看'
  && emits.at(-1)?.[0] === 'session-update' && emits.at(-1)?.[1]?.sessionId === lastSession().id,
  JSON.stringify(emits.at(-1)));
ok('模型自主路径以 assisted 入队（结果进上下文，由模型决定说什么）', jobs.at(-1).mode === 'assisted', String(jobs.at(-1).mode));
ok('url 路径没有可回复的消息时不带 replyToMessageId', jobs.at(-1).replyToMessageId === null);
ok('工具结果交代清楚"结果还没到、届时由你决定说什么"',
  byUrl.content.includes('【转写结果】') && byUrl.content.includes('不要'), byUrl.content);

// 本轮消息（窗口内）
const inBatch = [{ mid: '-2040798711', media: [{ kind: 'video', url: 'https://b23.tv/abc' }] }];
const beforeId = sent.length;
await executeTool(defs, ctxOf({ transcription: queue, triggerEntries: inBatch }), 'transcribe_video', { messageId: '-2040798711' });
ok('messageId 命中本轮消息时取到视频地址，并把它作为回复目标',
  jobs.at(-1).url === 'https://b23.tv/abc' && jobs.at(-1).replyToMessageId === '-2040798711');
ok('回执也引用同一条消息（群里看得出在回谁）',
  sent.length === beforeId + 1 && sent.at(-1)[2]?.replyToMessageId === '-2040798711', JSON.stringify(sent.at(-1)));

// 批外旧消息 —— 与 reverse_image_source 同源的缺陷面：工具愿意去查存档，
// 夹具必须证明"查存档这条路真的通"，不能只覆盖窗口内那一种。
const store = {
  findByMid: (_chatKey, mid) => (String(mid) === '-1'
    ? { mid: '-1', media: [{ kind: 'card', url: 'https://b23.tv/x' }, { kind: 'video', url: 'https://example.com/old.mp4' }] }
    : null)
};
await executeTool(defs, ctxOf({ transcription: queue, store }), 'transcribe_video', { messageId: '-1' });
ok('窗口外的旧消息经存档回退也能取到视频', jobs.at(-1).url === 'https://example.com/old.mp4', jobs.at(-1).url);

const beforeRejects = jobs.length;
const sentBeforeRejects = sent.length;
const noVideo = await executeTool(defs, ctxOf({
  transcription: queue,
  triggerEntries: [{ mid: '7', media: [{ kind: 'image', url: 'https://example.com/a.png' }] }]
}), 'transcribe_video', { messageId: '7' });
ok('消息里只有图片时明确告知没有视频，且不建任务',
  noVideo.isError === true && jobs.length === beforeRejects, noVideo.content);
// 这条错句必须列出**实际看到的附件种类**：卡片链接没被解析出来时（B 站小程序卡曾如此），
// 「只看到：card、image」是唯一能区分「消息里真没视频」与「卡片在、链接没解析出来」的证据。
ok('没有视频时把实际看到的附件种类一并说出来（卡片解析失灵时的唯一线索）',
  noVideo.content.includes('只看到：image') && noVideo.content.includes('视频 URL'), noVideo.content);

// 「id 打错/消息已不在存档」与「消息里确实没有视频」是两种失败，混成一句会让排查的人
// 以为是后者（真实的「卡片抓不到链接」报告就会被这句话盖住）。
const missing = await executeTool(defs, ctxOf({ transcription: queue }), 'transcribe_video', { messageId: '-999' });
ok('消息不存在时说的是"没找到消息"，不是"没有视频链接"',
  missing.isError === true && missing.content.includes('没找到消息 -999')
  && !missing.content.includes('没有视频链接') && jobs.length === beforeRejects, missing.content);

const noArgs = await executeTool(defs, ctxOf({ transcription: queue }), 'transcribe_video', {});
ok('url 与 messageId 都缺时明确告知，且不建任务',
  noArgs.isError === true && noArgs.content.includes('url') && jobs.length === beforeRejects, noArgs.content);

const noQueue = await executeTool(defs, ctxOf({}), 'transcribe_video', { url: 'https://example.com/v.mp4' });
ok('缺 transcription 依赖时返回友好错误而不是抛', noQueue.isError === true && noQueue.content.includes('未启用'));
ok('以上四种"任务根本没建起来"的情形一律不发回执（说了要先看看就一定真的在转）',
  sent.length === sentBeforeRejects, `多发了 ${sent.length - sentBeforeRejects} 条`);

// 队列给的中文原因要原样转述（它与 `/转写` 命令路径同源，不能在这里被换成一句泛泛的失败）。
// 用一个没记过账的 chatKey：额度是**在 enqueue 之前**消耗的，本群前面三条用例已经用完默认的 3 次。
const sentBeforeRejected = sent.length;
const rejected = await executeTool(defs, ctxOf({
  chatKey: 'group:77002',
  transcription: { enqueue: () => { throw new TranscriptionError('validation', 'DISABLED', '转写服务未启用'); } }
}), 'transcribe_video', { url: 'https://example.com/v.mp4' });
ok('转写被队列拒绝时转述队列给的原因',
  rejected.isError === true && rejected.content === '错误：转写服务未启用', rejected.content);
// 回执排在 enqueue **之后**（enqueue 同步做完 URL 安全校验/凭证/FFmpeg/去重，抛错发生在建任务之前）
// —— 把回执挪到前面，这条就会红。
ok('入队抛错时不发回执（证明回执排在 enqueue 之后）',
  sent.length === sentBeforeRejected, `多发了 ${sent.length - sentBeforeRejected} 条`);

// ── 成本闸门：超限不建任务 ───────────────────────────────────────
// 用一个**全新的 chatKey**：模块级闸门是单例，前面几条用例已经在本群记过账，
// 复用同一个 key 会让这里的第一次调用就被前面记的时间戳拦下（假红）。
// 全局每日上限放到很宽，让本用例只考察"每群每小时"这一条。
updateConfig({ transcription: { maxCallsPerChatPerHour: 1, maxCallsPerDay: 1000 } });
const gateJobs = [];
const gateQueue = { enqueue: ({ url }) => { gateJobs.push(url); return { id: 'gate00000000' }; } };
const gateCtx = () => ctxOf({ transcription: gateQueue, chatKey: 'group:77001' });

const gateFirst = await executeTool(defs, gateCtx(), 'transcribe_video', { url: 'https://example.com/1.mp4' });
const sentAfterGateFirst = sent.length;
const gateSecond = await executeTool(defs, gateCtx(), 'transcribe_video', { url: 'https://example.com/2.mp4' });
ok('未超限的第一次正常建任务', gateFirst.isError !== true, gateFirst.content);
ok('超过每群每小时上限时拒绝，且被拒的那一次不建任务',
  gateSecond.isError === true && gateSecond.content.includes('太频繁') && gateJobs.length === 1,
  `jobs=${gateJobs.length} content=${gateSecond.content}`);
ok('被限频拒绝时同样不发回执（回执不是"我收到了"的空头支票）',
  sent.length === sentAfterGateFirst, `多发了 ${sent.length - sentAfterGateFirst} 条`);

// ── 配置默认值与钳制 ────────────────────────────────────────────
ok('转写新增两个配额字段有默认值',
  DEFAULT_CONFIG.transcription.maxCallsPerChatPerHour === 3 && DEFAULT_CONFIG.transcription.maxCallsPerDay === 10);
const clamped = resolveTranscriptionConfig(Object.assign(structuredClone(DEFAULT_CONFIG), {
  transcription: { ...DEFAULT_CONFIG.transcription, maxCallsPerChatPerHour: 999, maxCallsPerDay: 0 }
}));
ok('超出范围的配额被钳制回合法区间',
  clamped.maxCallsPerChatPerHour === 60 && clamped.maxCallsPerDay === 1,
  `${clamped.maxCallsPerChatPerHour}/${clamped.maxCallsPerDay}`);

// ── readTopics 必须无副作用 ─────────────────────────────────────
// preview() 会把面板的"上次任务"刷成 trigger=preview；模型每查一次就写一次，
// 面板上就再也看不到真实播报状态了。这条是 readTopics 存在的唯一理由。
const stateStore = new HotSearchStateStore(path.join(DATA, 'readonly-state.json'));
const listCfg = Object.assign(structuredClone(DEFAULT_CONFIG), { hotSearchEnabled: true, hotSearchApiKey: '' });
const readOnlyScheduler = new HotSearchScheduler({
  getConfig: () => listCfg,
  updateConfig: (patch) => Object.assign(listCfg, patch),
  sender: { sendTextBatch: async () => ({ sent: [{}], failed: [] }) },
  fetchFeed: async () => ({
    code: '200', desc: 'success', data: {
      generated_at: '2026-09-28T08:30:00+08:00', requested_platforms: ['weibo'], total_items: 2, failed_platforms: [],
      platforms: { weibo: { name: '微博热搜', status: 'success', count: 2, items: [
        { rank: 1, title: '第一条', hot: 123 }, { rank: 2, title: '第二条', hot: 99 }
      ] } }
    }, tips: '极数本源'
  }),
  stateStore,
  now: () => new Date('2026-09-28T01:05:00Z'),
  log: () => {}
});
const stateBefore = JSON.stringify(stateStore.read());
const topics = await readOnlyScheduler.readTopics();
ok('readTopics 返回榜单分页', topics.itemCount === 2 && topics.pages.length >= 1, `itemCount=${topics.itemCount}`);
ok('readTopics 不写热搜状态（模型查询不该盖掉面板的上次任务）',
  JSON.stringify(stateStore.read()) === stateBefore, `${stateBefore} → ${JSON.stringify(stateStore.read())}`);

// ── 接线与边界（文本断言，先剥注释）──────────────────────────────
// 两个工具的定义文件与负责过滤的 agent-runner 都不方便在套件里跑完整一轮，
// 所以"用什么挡、不做什么"这类只有源码能表达的事实按项目惯例扫源码文本。
const hotToolSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/agent/tools/hot-search.ts'), 'utf8'));
// 扫的是整个词而不是 `broadcast(`：实测"只匹配带括号的调用"会被一个裸引用
// （`scheduler.broadcast`、或把它当回调传出去）整整齐齐地绕过去。
// 剥注释后这个文件里不该再有 `broadcast` 出现（头注释提过它，stripComments 会去掉）。
ok('热搜工具只读榜单：不碰 broadcast（播报带当天幂等与目标群白名单，不能绕开）',
  hotToolSrc.includes('readTopics(') && !hotToolSrc.includes('broadcast'));

const trToolSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/agent/tools/transcription.ts'), 'utf8'));
ok('转写工具里没有关键词闸门（"该不该转"交回模型判断）',
  !trToolSrc.includes('什么视频') && !trToolSrc.includes('requestText'));
ok('转写工具在建任务前先消耗调用额度', trToolSrc.includes('budget.take(ctx.chatKey)'));
ok('模型自主路径以 assisted 入队', trToolSrc.includes("mode: 'assisted'"));
ok('回执排在 enqueue 之后（说了「我先看看」就一定是真的入了队）',
  trToolSrc.indexOf('queue.enqueue') < trToolSrc.indexOf('我先看看'));
// 从回执那句切到"已加入转写队列"的返回：中间必须有一个 catch。
// 去掉内层 try/catch 后，这段里就只剩注释与 return —— 而实际后果是"客套话没发出去"
// 会被外层捕获报成"转写失败"（转写其实已经入队了）。
ok('回执与真正的转写分开捕获（客套话没发出去不能被报成转写失败）',
  /\}\s*catch/.test(trToolSrc.slice(trToolSrc.indexOf('我先看看'), trToolSrc.indexOf('已加入转写队列'))));

const runnerSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/agent/runtime/agent-runner.ts'), 'utf8'));
ok('未启用的能力不进模型工具集（按配置过滤，与既有视觉/搜索过滤同款）',
  runnerSrc.includes("!transcriptionEnabled && d.name === 'transcribe_video'")
  && runnerSrc.includes("cfg.hotSearchEnabled !== true && d.name === 'get_hot_search'"));
ok('转写的启用判定复用 resolveTranscriptionConfig（认环境变量注入，不另写一份）',
  runnerSrc.includes('resolveTranscriptionConfig(cfg).enabled'));

const sectionsSrc = readUI('js/views/settings/sections.js');
const saveSrc = readUI('js/views/settings/save.js');
ok('设置页渲染了转写两个配额输入框',
  sectionsSrc.includes('id="cfg-transcription-chat-hourly"') && sectionsSrc.includes('id="cfg-transcription-daily"'));
ok('保存时钳制并持久化两个配额',
  saveSrc.includes("clampInt(val('#cfg-transcription-chat-hourly'") && saveSrc.includes("clampInt(val('#cfg-transcription-daily'"));

if (!done()) process.exit(1);
