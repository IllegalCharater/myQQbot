// SSE 帧投影：dist/web/http/event-projector.js 的纯函数单测。
//
// 这段逻辑以前藏在 src/web/app.ts 的 emit 闭包里，只能靠 t-smoke 端到端间接守 ——
// 写错了症状是"面板不更新"，看不到是哪一帧不对。抽成纯函数后这里逐字节比对。
//
// 本套件是 S1 的验收件：S1 的契约是"纯重构、帧逐字节不变"，所以下面的期望值
// 全部是**手写死的字符串**，不从被测代码里算——照抄实现就等于没断言。
import { checker, dataDir } from './lib/harness.mjs';
import { load, readSrc } from './lib/src.mjs';

dataDir('qqagent-sse-project-');
const { projectSse, projectSessionUpdate, writeSse } = await load('web/http/event-projector.js');

const { ok, done } = checker();

// ── 通用帧：非 session-update、以及 session-update 的退化分支 ──
// 今天线上真正跑的就是这条：12 个生产者发的都是裸字符串 id，而富投影要求对象载荷。
ok('裸字符串载荷：session-update 走通用帧，与线上逐字节一致',
  projectSse('session-update', 'abc') === 'event: session-update\ndata: "abc"\n\n',
  JSON.stringify(projectSse('session-update', 'abc')));

ok('裸字符串载荷：即使传了 peek 也不进富投影（入口条件是对象）',
  projectSse('session-update', 'abc', { sessions: { peek: () => ({ id: 'x' }) } }) ===
    'event: session-update\ndata: "abc"\n\n');

ok('未知事件名：原样 JSON 序列化',
  projectSse('snowluma-status', { running: true }) ===
    'event: snowluma-status\ndata: {"running":true}\n\n');

ok('undefined 载荷发成 {}（undefined 不是合法 JSON）',
  projectSse('session-end', undefined) === 'event: session-end\ndata: {}\n\n');

ok('null 载荷同样发成 {}',
  projectSse('session-end', null) === 'event: session-end\ndata: {}\n\n');

ok('数组载荷不被当成对象（isRecord 挡住）',
  projectSse('session-end', [1, 2]) === 'event: session-end\ndata: [1,2]\n\n');

ok('对象载荷但 sessionId 为空串：退回原样 payload',
  projectSse('session-update', { sessionId: '' }) ===
    'event: session-update\ndata: {"sessionId":""}\n\n');

ok('对象载荷有 sessionId 但 peek 找不到会话：退回原样 payload',
  projectSse('session-update', { sessionId: 'gone' }, { sessions: { peek: () => null } }) ===
    'event: session-update\ndata: {"sessionId":"gone"}\n\n');

ok('没传 deps.sessions 时不炸，退回原样 payload',
  projectSse('session-update', { sessionId: 's1' }) ===
    'event: session-update\ndata: {"sessionId":"s1"}\n\n');

// ── 富帧：字段与顺序手写死 ──
// 顺序是本模块的对外表现（UI 按名字取，顺序变了对 UI 无害，但顺手改顺序说明
// 有人在"重排"这段代码，而它的契约是逐字节不动）。
const RICH_FIELDS = [
  'sessionId', 'chatKey', 'startedAt', 'status', 'waitUntil', 'activity',
  'webSearchCount', 'rounds', 'usage', 'trigger', 'triggerSummary', 'messages',
  'sent', 'finishReason', 'error', 'endedAt'
];

const full = {
  id: 'sess-1', chatKey: 'g:123', startedAt: '2026-09-28T00:00:00.000Z', status: 'running',
  waitUntil: 1234, activity: 'thinking', webSearchCount: 2, rounds: 3,
  usage: { total_tokens: 15 }, triggerSummary: '有人问好',
  messages: [{ role: 'assistant', content: 'hi' }],
  sent: [{ tool: 'send_message', ok: true }],
  finishReason: 'stop', error: null, endedAt: null
};
const rich = JSON.parse(projectSessionUpdate('sess-1', { peek: () => full }));
ok('富帧：字段名与顺序逐项一致',
  JSON.stringify(Object.keys(rich)) === JSON.stringify(RICH_FIELDS),
  JSON.stringify(Object.keys(rich)));
ok('富帧：值原样透传', rich.sessionId === 'sess-1' && rich.chatKey === 'g:123' &&
  rich.status === 'running' && rich.rounds === 3 && rich.sent.length === 1 &&
  rich.messages.length === 1 && rich.triggerSummary === '有人问好');
// trigger 与 triggerSummary 同名同值：UI 老代码读的是 trigger，新代码读 triggerSummary，两个都得在。
ok('富帧：trigger 与 triggerSummary 同值（兼容两种读法）', rich.trigger === rich.triggerSummary);

// sent / finishReason / error / endedAt 随帧推下去，否则会话结束后的最终发言只能靠手动刷新。
const bare = JSON.parse(projectSessionUpdate('sess-2', { peek: () => ({ id: 'sess-2' }) }));
ok('富帧：缺字段补默认值，不出现 undefined',
  bare.waitUntil === null && bare.activity === '' && bare.webSearchCount === 0 &&
  bare.rounds === 0 && bare.usage === null && bare.trigger === '' &&
  JSON.stringify(bare.messages) === '[]' && JSON.stringify(bare.sent) === '[]' &&
  bare.finishReason === null && bare.error === null && bare.endedAt === null,
  JSON.stringify(bare));
ok('富帧：顶层无 undefined（JSON.stringify 会吃掉它，等于缺字段）',
  !JSON.stringify(bare).includes('undefined'));

ok('富帧：peek 抛错时退回 null（调用方据此退回原样 payload）',
  projectSessionUpdate('sess-3', { peek: () => { throw new Error('boom'); } }) === null);
ok('富帧：peek 返回 undefined 时也退回 null',
  projectSessionUpdate('sess-4', { peek: () => undefined }) === null);
// JSON.stringify 遇到环形引用会抛 —— 这条也走 catch，不能让整个 emit 打挂。
// 环必须挂在会被整体引用的字段上（usage/messages/sent 是原样搬进输出对象的），
// 挂在别的标量字段上根本进不了输出，测不到 catch。
const cycUsage = {};
cycUsage.self = cycUsage;
ok('富帧：会话里带环形引用时退回 null，不把 emit 打挂',
  projectSessionUpdate('cyc', { peek: () => ({ id: 'cyc', usage: cycUsage }) }) === null);

// ── writeSse ──
const mkRes = () => ({ lines: [], write(l) { this.lines.push(l); }, fail: false });
const a = mkRes(), b = mkRes();
b.write = () => { throw new Error('客户端已断开'); };
const c = mkRes();
writeSse([a, b, c], 'frame\n');
ok('writeSse：一个客户端写失败不影响其余客户端',
  a.lines.length === 1 && c.lines.length === 1 && a.lines[0] === 'frame\n');
ok('writeSse：空集合不炸', (() => { writeSse([], 'x'); return true; })());

// ── 结构守卫：app.ts 只许委托，不许在自己身上重新长出拼帧逻辑 ──
const appSrc = readSrc('web/app.js');
ok('app.ts：emit 闭包委托给 projectSse', /const emit = \(type, payload\)[^]*?projectSse\(/.test(appSrc));
ok('app.ts：emit 闭包里不再自己拼 SSE 帧',
  !/const emit = \(type, payload\)[^]*?`event: \$\{type\}/.test(appSrc));

process.exit(done() ? 0 : 1);
