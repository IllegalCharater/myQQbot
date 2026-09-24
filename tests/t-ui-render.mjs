// 前端渲染真实执行测试：把 ui/app.js 整份丢进 vm，配一层最小 DOM 假壳，
// 然后用真数据调 loadStickerView / loadMemoryDetail / chatMsgRowHtml，
// 检查它们吐出来的 HTML。
//
// 为什么还要这一层（已经有静态 lint 了）：静态检查只能证明"id 拼写一致"，
// 证明不了"这段代码跑起来不炸"。模板串里少一个反引号、引用了不存在的 helper、
// state 字段名打错，在文本层面全都看不出来，但会在用户点开那一页时白屏。
// 仓库没有 jsdom，所以这里手搓一层壳：只实现 app.js 真正用到的那几个方法，
// 遇到没实现的就让它抛错——那正是"用了壳里没有的能力"的信号，不该被静默吞掉。
import vm from 'node:vm';
import { readUI } from './lib/src.mjs';
import { createDomSandbox } from './lib/harness.mjs';

const code = readUI('app.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
};

// ── 最小 DOM 假壳：壳本身搬到了 lib/harness.mjs（S7 把 ui/app.js 拆成 ES 模块时，
//    这套"整份丢进 vm"的办法要一起换掉，届时只有 harness 那一份要动） ──
const { sandbox, ctx, doc, el: $el } = createDomSandbox();

console.log('\n═══ 整份 app.js 能在无 DOM 环境下加载完（启动路径不炸） ═══');
try {
  // 追加一行把模块级 const 暴露出来（const/let 不会挂到 globalThis 上）
  vm.runInContext(code + '\n;globalThis.__state = state;globalThis.__labels = STICKER_SOURCE_LABEL;\n', ctx, { filename: 'ui/app.js' });
  ok('加载 + 执行顶层代码没抛异常', true);
} catch (e) {
  ok('加载 + 执行顶层代码没抛异常', false, `${e.name}: ${e.message}`);
  console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
  process.exit(1);
}
const state = sandbox.__state;
for (const fn of ['chatMsgRowHtml', 'renderStickerItems', 'renderStickerDetail', 'loadStickerView', 'loadMemoryDetail', 'fmtTime', 'esc']) {
  ok(`可以调到 ${fn}()`, typeof sandbox[fn] === 'function', `实际是 ${typeof sandbox[fn]}`);
}
ok('拿到了模块级 state', !!state && typeof state === 'object');

// ── 路由式 fetch：按 URL 回 fixture ──
function routeFetch(routes) {
  const hits = [];
  sandbox.fetch = async (url, opts = {}) => {
    hits.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    for (const [re, reply] of routes) {
      const m = String(url).match(re);
      if (m) {
        const data = typeof reply === 'function' ? reply(m, opts) : reply;
        return { ok: !data.__status || data.__status < 400, status: data.__status || 200, json: async () => data };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'no route' }) };
  };
  return hits;
}

// ═══════════ A. 存档行渲染 ═══════════
console.log('\n═══ 存档行：普通消息 / 摘要 / 人工备注 ═══');
const plain = sandbox.chatMsgRowHtml({ id: 7, ts: Date.parse('2026-09-24T10:05:00'), senderId: '10001', senderName: '小明', text: '早上好', self: false, read: true, kind: null, media: [] });
ok('普通消息：有发送者名字', plain.includes('小明'));
ok('普通消息：有 改 和 删 两个按钮', plain.includes('data-op="edit"') && plain.includes('data-op="del"'));
ok('普通消息：行上带 data-midrow 供事件委托定位', plain.includes('data-midrow="7"'));

const digest = sandbox.chatMsgRowHtml({ id: 8, ts: Date.parse('2026-09-24T10:06:00'), senderId: '', senderName: '', text: '【摘要】聊了会儿天气', self: false, read: true, kind: 'digest', media: [] });
ok('摘要：走 digest-row 弱化样式', digest.includes('digest-row'));
ok('摘要：不给「改」按钮（后端也会 400，给了就是个点了报错的按钮）', !digest.includes('data-op="edit"'));
ok('摘要：仍然可以删（后端 DELETE 不拦摘要，它的 400 文案自己写着"可以删除"）', digest.includes('data-op="del"'));
ok('摘要：标出「摘要」而不是留一个没名字的人', digest.includes('摘要'));
ok('摘要：不冒充任何群友', !digest.includes('>我<'));

const note = sandbox.chatMsgRowHtml({ id: 9, ts: Date.parse('2026-09-24T10:07:00'), senderId: '', senderName: '', text: '这条是人工备注：那个时间点其实在开会', self: false, read: true, kind: 'note', media: [] });
ok('备注：走 note-row 独立样式', note.includes('note-row'));
ok('备注：标出「备注」', note.includes('备注'));
ok('备注：可以改也可以删', note.includes('data-op="edit"') && note.includes('data-op="del"'));
ok('备注：不冒充任何群友（没有 senderName 或"我"）', !/小明|>我</.test(note));

console.log('\n  ── 未读 / XSS ──');
const unread = sandbox.chatMsgRowHtml({ id: 10, ts: Date.now(), senderId: '1', senderName: '小红', text: '在吗', self: false, read: false, kind: null, media: [] });
ok('未读行带 unread 类', unread.includes('unread'));
const evil = sandbox.chatMsgRowHtml({ id: 11, ts: Date.now(), senderId: '1', senderName: '<img src=x onerror=alert(1)>', text: '"><script>alert(1)</script>', self: false, read: true, kind: null, media: [] });
ok('发送者名里的 HTML 被转义', !evil.includes('<img src=x') && evil.includes('&lt;img'));
ok('正文里的 script 被转义', !evil.includes('<script>') && evil.includes('&lt;script&gt;'));

console.log('\n  ── 选项参数：预览裁剪 / 注入徽标 ──');
const longMsg = { id: 20, ts: Date.now(), senderId: '1', senderName: '小明', text: '这是一条很长很长的消息'.repeat(30), self: false, read: true, kind: null, media: [] };
const preview = sandbox.chatMsgRowHtml(longMsg, { previewChars: 8, badge: '<span class="digest-badge is-in">已注入</span>' });
ok('previewChars 只裁正文、并留省略号', preview.includes('…'));
ok('裁剪不影响其它单元格（发言人还在）', preview.includes('小明'));
ok('badge 原样拼在正文后面', preview.includes('已注入'));
const full = sandbox.chatMsgRowHtml(longMsg, {});
ok('不传 previewChars 时正文完整（表格里那条不受影响）', full.includes('这是一条很长很长的消息'.repeat(5)));
// 逐个单元格比，而不是比整行 HTML 的长度：一行骨架（时间/名字/两个按钮）本身就有
// 两三百字符，拿整行长度去比正文长度是自欺欺人（最初那条断言就是这么写过、然后假绿的）。
const cellOf = (h) => (/<td class="text">([\s\S]*?)<\/td>/.exec(h) || [, ''])[1];
ok('裁剪只发生在正文单元格里：8 个字符 + 省略号，其余行不受影响',
  cellOf(sandbox.chatMsgRowHtml(longMsg, { previewChars: 8 })).length === 9
  && cellOf(sandbox.chatMsgRowHtml(longMsg, {})).length === longMsg.text.length,
  `${cellOf(sandbox.chatMsgRowHtml(longMsg, { previewChars: 8 })).length} / ${cellOf(sandbox.chatMsgRowHtml(longMsg, {})).length}`);
// 关键回归：调用方可能写成 `.map(chatMsgRowHtml)`，那第二个参数是**下标**（数字）。
// 不在函数里挡一下，下标会被当成 previewChars —— 除第一行外全被截断，
// 而且症状是"表格里大部分正文都断在半句"，极难联想到这里。
const mapped = [1, 2, 3].map(() => longMsg).map((m, i) => sandbox.chatMsgRowHtml(m, i));
ok('被当成 .map 回调（第二个参数是下标）时不会误解成裁剪参数', mapped.every((h) => !h.includes('…')));

// ═══════════ A3. 存档页顶部「历史印象」块 ═══════════
console.log('\n═══ 存档页顶部：历史印象块（哪些摘要真的会进提示词）═══');
const D = Date.parse('2026-09-24T12:00:00');
const digEntry = (id, from, to, count, body) => ({
  id, mid: null, ts: D - (100 - id) * 1000, senderId: 'digest', senderName: '聊天记录摘要',
  text: `【历史摘要 ${from} ~ ${to} · 共 ${count} 条】\n${body}`,
  self: false, read: true, reply: null, media: [], kind: 'digest',
  digest: {
    from: Date.parse(`2026-${from.replace(' ', 'T')}:00`),
    to: Date.parse(`2026-${to.replace(' ', 'T')}:00`),
    count, archivedFile: '', model: 'm', createdAt: D
  }
});
const DIG1 = digEntry(2, '08-01 03:20', '08-01 06:00', 400, '那天主要在聊天气。');
const DIG2 = digEntry(4, '08-20 10:00', '08-20 12:00', 250, '后来聊了吃的。');
const PLAIN = { id: 5, mid: 'm5', ts: D - 1000, senderId: '1', senderName: '小刚', text: '最近的一条', self: false, read: true, reply: null, media: [] };
const statusOf = (over = {}) => ({
  config: { injectEveryRound: false, merge: true, maxChars: 8000 },
  injectedIds: [2, 4], truncatedId: null, droppedIds: [],
  chars: 900, budget: 8000, total: 2, totalChars: 900, ...over
});
const dig = () => {
  state.chatMessages = [PLAIN, DIG1, DIG2];
  state.chatDigests = statusOf();
  state.chatQuery = '';
  state.chatDigestSig = '';
  sandbox.updateChatDigestBlock();
};

dig();
ok('有摘要时块显示出来', $el('#chat-digest-panel').hidden === false);
const sum1 = $el('#chat-digest-summary').textContent;
ok('summary 给出「已注入 2/2 段 · 字数 · 覆盖范围」',
  sum1.includes('已注入 2/2 段') && sum1.includes('900/8000 字') && sum1.includes('08-01 03:20') && sum1.includes('08-20 12:00'), sum1);
ok('覆盖范围用的是最老段的起点 + 最新段的终点（不是把四条时间摞在一起）',
  (sum1.match(/~/g) || []).length === 1, sum1);
ok('summary 还汇总了原始消息条数（400+250）', sum1.includes('650 条原始消息'), sum1);
let listHtml = $el('#chat-digest-list').innerHTML;
ok('两段都列出来，各带一个「已注入」徽标', (listHtml.match(/digest-badge is-in/g) || []).length === 2);
ok('列出的是时间正序（最早的一段在前，与提示词里的顺序一致）',
  listHtml.indexOf('聊天气') < listHtml.indexOf('聊了吃的'));
ok('每行带 data-midrow —— 直接复用 tbody 那套删除委托', listHtml.includes('data-midrow="2"') && listHtml.includes('data-midrow="4"'));
ok('行里给了删按钮（摘要删得掉；改不了）', listHtml.includes('data-op="del"') && !listHtml.includes('data-op="edit"'));
ok('没有未注入的就不显示那组', !listHtml.includes('digest-dropped'));
ok('右下的补充说明为空（没东西要说）', $el('#chat-digest-more').textContent === '');
let metaHtml = $el('#chat-digest-meta').innerHTML;
ok('meta 说明白"只在读历史那一轮带上"（默认没勾每轮注入）', metaHtml.includes('读历史') && !metaHtml.includes('每一轮'));
ok('meta 不谎称"本轮已注入"（面板不知道那一轮用的哪个档位）',
  metaHtml.includes('下一轮') && !metaHtml.includes('上一轮实际读到什么'));

// 长正文只给预览：一条摘要可达 4000 字，整段铺在页面最上面会把表格顶到屏幕外
state.chatMessages = [DIG1, { ...DIG2, text: DIG2.text + '长'.repeat(600) }];
state.chatDigests = statusOf();
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
listHtml = $el('#chat-digest-list').innerHTML;
ok('正文只给预览（截断 + 省略号），完整正文仍在下方表格里', listHtml.includes('…') && !listHtml.includes('长'.repeat(300)));

// 被预算挤掉的那些
dig();
state.chatDigests = statusOf({ injectedIds: [4], droppedIds: [2], chars: 300 });
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
listHtml = $el('#chat-digest-list').innerHTML;
ok('summary 如实写「已注入 1/2 段」', $el('#chat-digest-summary').textContent.includes('已注入 1/2 段'));
ok('未注入的收进一个默认收起的组', listHtml.includes('digest-dropped') && listHtml.includes('未注入 1 段'));
ok('未注入的那段标着「未注入」，并说明模型看不到', (listHtml.match(/digest-badge is-out/g) || []).length === 1 && listHtml.includes('模型看不到'));
ok('两部分合起来仍是全部条目（不丢段）', (listHtml.match(/data-midrow="/g) || []).length === 2);
ok('补充说明告诉用户没丢、模型可以自己往前翻',
  $el('#chat-digest-more').textContent.includes('get_recent_messages'), $el('#chat-digest-more').textContent);

// 截断的那条
state.chatDigests = statusOf({ truncatedId: 4 });
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
ok('唯一一条被截断时徽标写作「已注入（已截断）」',
  $el('#chat-digest-list').innerHTML.includes('已注入（已截断）'));

// 存档量那句（与"注入多少"是两笔账：存档大、注入小是常态）
dig();
const storedChars = DIG1.text.length + DIG2.text.length;
metaHtml = $el('#chat-digest-meta').innerHTML;
ok('meta 报的是**存档**总量（数的是条目正文，不是服务端给的注入量 900）',
  metaHtml.includes(`摘要存档共 ${storedChars} 字`) && !metaHtml.includes('摘要存档共 900 字'), metaHtml);
ok('上限 0（默认）→ 明说"不限"，并指出去哪儿设',
  metaHtml.includes('上限为 0 = 不限') && metaHtml.includes('聊天设置'));
state.chatDigests = statusOf({ config: { injectEveryRound: false, merge: true, maxChars: 8000, maxKeepChars: 300 } });
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
metaHtml = $el('#chat-digest-meta').innerHTML;
ok('设了上限 → 说清"超出后丢最旧的整条，但永远留最新的一条"（用户最怕设小了被清空）',
  metaHtml.includes('上限 300 字') && metaHtml.includes('最旧的整条') && metaHtml.includes('永远留最新的一条'), metaHtml);
ok('设了上限就不再出现"不限"的说法（同一句话里的两种状态必须互斥）', !metaHtml.includes('上限为 0'));
// 只有"存档上限"变了也得刷新：它进了 memo 签名，否则轮询时那个数字会一直停在旧值
$el('#chat-digest-meta').innerHTML = 'SENTINEL';
state.chatDigests = statusOf({ config: { injectEveryRound: false, merge: true, maxChars: 8000, maxKeepChars: 1234 } });
sandbox.updateChatDigestBlock();
ok('只有存档上限变了（摘要与注入量都没动）→ 照样重写，不靠"id 变了"才刷新',
  $el('#chat-digest-meta').innerHTML.includes('上限 1234 字'), $el('#chat-digest-meta').innerHTML);

// 设置里关掉注入
dig();
state.chatDigests = statusOf({
  config: { injectEveryRound: false, merge: true, maxChars: 0 },
  injectedIds: [], droppedIds: [2, 4], chars: 0, budget: 0
});
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
ok('maxChars=0：summary 写明「已关闭注入」', $el('#chat-digest-summary').textContent.includes('已关闭注入'));
ok('maxChars=0：全部归入未注入那组', (($el('#chat-digest-list').innerHTML.match(/digest-badge is-out/g) || []).length) === 2);
ok('maxChars=0：meta 告诉用户去哪开', $el('#chat-digest-meta').innerHTML.includes('聊天设置'));

// 勾上「每轮都注入」
state.chatDigests = statusOf({ config: { injectEveryRound: true, merge: true, maxChars: 8000 } });
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
ok('勾了每轮注入 → meta 说「每一轮都会带上」',
  $el('#chat-digest-meta').innerHTML.includes('每一轮') && $el('#chat-digest-meta').innerHTML.includes('不读历史的唤醒'));

// 该收起的情况
dig();
state.chatQuery = '天气';
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
ok('查找态整块收起（查找是行级操作，上面挂一块不跟着过滤的纪要看像结果集不肯缩）',
  $el('#chat-digest-panel').hidden === true);
state.chatQuery = '';
state.chatMessages = [PLAIN];
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
ok('会话里压根没有摘要 → 收起（勾了什么设置都不该显示一个空块）', $el('#chat-digest-panel').hidden === true);
state.chatMessages = [PLAIN, DIG1];
state.chatDigests = null;
state.chatDigestSig = '';
sandbox.updateChatDigestBlock();
ok('注入状态还没回来（切换会话的间隙）→ 收起，绝不用上一个会话的数字糊弄',
  $el('#chat-digest-panel').hidden === true);

// memo：轮询每 15 秒一次，数据没变就不该重写 innerHTML
dig();
const firstHtml = $el('#chat-digest-list').innerHTML;
ok('（前置）这块确实渲染出了内容', firstHtml.includes('digest-badge'));
$el('#chat-digest-list').innerHTML = 'SENTINEL';
sandbox.updateChatDigestBlock();
ok('同一份数据再来一次（模拟轮询）→ 不重写 innerHTML，展开状态与滚动位置得以保留',
  $el('#chat-digest-list').innerHTML === 'SENTINEL');
state.chatDigests = statusOf({ injectedIds: [2], droppedIds: [4] });
sandbox.updateChatDigestBlock();
ok('数据真变了才重写', $el('#chat-digest-list').innerHTML !== 'SENTINEL');

// ═══════════ B. 表情包页 ═══════════
console.log('\n═══ 表情包页：列表 → 详情 ═══');
const LIB = [
  { id: 'q1', url: 'https://qpic.example/a.png', desc: 'QQ备注：猫猫', localNote: '一只很困的猫', tags: ['困', '猫'], usage: '深夜', source: 'qq', deletable: false, useCount: 3, lastUsedAt: Date.now(), md5: 'aaa' },
  // 既没备注也没 QQ 备注名 —— 该显示（未标注）
  { id: 'a1', url: 'https://qpic.example/b.gif', desc: '', localNote: '', tags: [], usage: '', source: 'ai', deletable: true, useCount: 0, md5: 'bbb' },
  // 只有 QQ 备注名 —— 卡片该拿 desc 兜底，而不是也显示（未标注）
  { id: 'm1', url: 'https://qpic.example/c.png', desc: 'QQ里给的名字', localNote: '', tags: ['无语'], usage: '被问爆时', source: 'manual', deletable: true, useCount: 0, md5: 'ccc' }
];
const hits = routeFetch([
  [/\/api\/stickers\?/, { stickers: LIB, total: 3, fromCache: false, syncError: '' }]
]);
await sandbox.loadStickerView();

ok('真的请求了 /api/stickers', hits.some((h) => h.url.startsWith('/api/stickers?')));
const grid = $el('#sticker-items').innerHTML;
ok('渲染出卡片网格', grid.includes('sticker-grid') && (grid.match(/sticker-card /g) || []).length === 3);
ok('缩略图走后端代理端点', grid.includes('/api/stickers/q1/image') && grid.includes('/api/stickers/a1/image'));
ok('缩略图没有直连图床（否则裂图 + 用户浏览器打内网）', !grid.includes('qpic.example'));
ok('既没备注也没 QQ 名的那张显示（未标注）', (grid.match(/（未标注）/g) || []).length === 1);
ok('只有 QQ 备注名时拿 desc 兜底显示，不误报（未标注）', grid.includes('QQ里给的名字'));
ok('来源标签本地化（不是裸的 qq/ai）', grid.includes('QQ收藏') && grid.includes('AI收藏') && grid.includes('手工'));
ok('用过次数渲染出来', grid.includes('用过 3 次'));
ok('计数条显示总数', $el('#sticker-count').textContent.includes('共 3 张'), $el('#sticker-count').textContent);
ok('卡片 url 里的 note 被转义进 title/alt', grid.includes('一只很困的猫'));

// 选一张 QQ 收藏 → 删除按钮必须是禁用的
state.stickerSelectedId = 'q1';
sandbox.renderStickerItems();
const gridSel = $el('#sticker-items').innerHTML;
ok('选中的卡片带 selected 类', /sticker-card selected[^>]*data-id="q1"/.test(gridSel));
sandbox.renderStickerDetail(LIB[0]);
const dQq = $el('#sticker-detail').innerHTML;
ok('QQ 收藏的详情页有「改」按钮', dQq.includes('sticker-edit-btn'));
ok('QQ 收藏的删除按钮被禁用并写明原因', dQq.includes('QQ 收藏不能在这里删') && dQq.includes('disabled'));
ok('QQ 收藏的详情页解释了为什么删不掉', dQq.includes('QQ 里取消收藏'));
ok('详情页大图也走代理', dQq.includes('/api/stickers/q1/image') && !dQq.includes('qpic.example'));
ok('详情页说明改动只影响下一轮', dQq.includes('下一轮'));
ok('详情页把 desc 标成不可编辑', dQq.includes('自动同步，不可编辑'));

sandbox.renderStickerDetail(LIB[1]);
const dAi = $el('#sticker-detail').innerHTML;
ok('AI 收藏的删除按钮可用（不是 disabled）', dAi.includes('sticker-del-btn') && !dAi.includes('QQ 收藏不能在这里删'));
ok('AI 收藏没有备注时显示（未标注）', dAi.includes('（未标注）'));

console.log('\n  ── 空库 / 搜索 / 同步失败 ──');
state.stickers = []; state.stickerTotal = 0; state.stickerQuery = '';
sandbox.renderStickerItems();
ok('空库给出可操作的指引而不是空白', $el('#sticker-items').innerHTML.includes('表情库是空的'));
state.stickers = []; state.stickerQuery = '猫';
sandbox.renderStickerItems();
ok('搜索无结果时说的是「没有匹配」而不是「库是空的」', $el('#sticker-items').innerHTML.includes('没有匹配'));

state.stickers = LIB; state.stickerTotal = 3; state.stickerQuery = '猫';
const hits2 = routeFetch([[/\/api\/stickers\?/, { stickers: [LIB[0]], total: 3, fromCache: true, syncError: '' }]]);
await sandbox.loadStickerView({ quiet: true });
ok('搜索词编进了查询串', hits2.some((h) => h.url.includes('q=%E7%8C%AB')), hits2.map((h) => h.url).join(' | '));
ok('匹配态计数写成「匹配 K / 总」', $el('#sticker-count').textContent.includes('匹配 1 / 3'), $el('#sticker-count').textContent);
ok('命中缓存时标出「缓存」', $el('#sticker-count').textContent.includes('缓存'));

routeFetch([[/\/api\/stickers\?/, { stickers: [], total: 0, fromCache: true, syncError: '同步超时' }]]);
await sandbox.loadStickerView({ quiet: true });
ok('QQ 同步失败时必须说出来（否则用户以为看到的是 QQ 真实收藏）',
  $el('#sticker-count').textContent.includes('同步 QQ 失败'), $el('#sticker-count').textContent);

console.log('\n  ── 选中的那张被删掉之后 ──');
state.stickerSelectedId = 'a1';
routeFetch([[/\/api\/stickers\?/, { stickers: [LIB[0]], total: 1, fromCache: false, syncError: '' }]]);
await sandbox.loadStickerView({ quiet: true });
ok('选中项消失后回落到提示、不残留上一张的详情',
  $el('#sticker-detail').innerHTML.includes('从左侧选择一个表情查看'));
ok('选中 id 被清空（否则 SSE 每次推送都会再撞一次）', state.stickerSelectedId === null);

// ═══════════ C. 记忆页 ═══════════
console.log('\n═══ 记忆页：印象行 / 查找 ═══');
const MEMBERS = [
  { userId: '10001', name: '小明', impressions: [{ content: '喜欢猫', createdAt: Date.parse('2026-01-02T03:04:05') }, { content: '常半夜出没', createdAt: Date.parse('2026-02-03T04:05:06') }] },
  { userId: '', name: '神秘人', impressions: [{ content: '不说话', createdAt: Date.now() }] }
];
routeFetch([
  [/\/api\/memory-files\/group_123$/, { members: MEMBERS }],
  [/\/api\/config$/, { memberNotes: {}, api: {}, allow: {} }]
]);
state.memQuery = '';
await sandbox.loadMemoryDetail('group:123');
const mHtml = $el('#memory-detail').innerHTML;
ok('每个成员一块', mHtml.includes('小明') && mHtml.includes('神秘人'));
ok('每条印象一行 .imp-row', (mHtml.match(/class="imp-row"/g) || []).length === 3);
ok('每行都有 改 / 删', (mHtml.match(/imp-edit/g) || []).length === 3 && (mHtml.match(/imp-del/g) || []).length === 3);
ok('每行都有 ＋ 加一条', (mHtml.match(/mem-add-one/g) || []).length === 2);
ok('没有 QQ 号的成员不给 QQ 标注', !/神秘人.*QQ 10001/s.test(mHtml));
ok('保留原有时长信息：没有 QQ 号的成员也能被寻址（data-uid 为空、靠 data-name）',
  mHtml.includes('data-name="神秘人"'));
ok('印象内容转义正确', mHtml.includes('喜欢猫'));
ok('计数写成「N 条」', mHtml.includes('（2 条）'));
ok('界面写清了单条改与批量编辑的时间差异', mHtml.includes('保留原本的记录时间') && mHtml.includes('批量编辑'));
ok('查找框在（模板串里）', mHtml.includes('id="mem-search"'));

// data-idx 必须是该成员印象数组里的下标，服务端按 (userId, content) 校验
const idxs = [...mHtml.matchAll(/class="btn btn-small imp-edit" data-uid="([^"]*)" data-idx="(\d+)"/g)].map((m) => `${m[1]}#${m[2]}`);
ok('data-idx 是成员内下标（10001 的两条 = 0/1，神秘人的一条 = 0）',
  idxs.join(',') === '10001#0,10001#1,#0', idxs.join(','));

console.log('\n  ── 查找 ──');
state.memQuery = '猫';
await sandbox.loadMemoryDetail('group:123');
const fHtml = $el('#memory-detail').innerHTML;
ok('只留下命中的人', fHtml.includes('小明') && !fHtml.includes('神秘人'));
ok('命中的人只留命中的那条印象', fHtml.includes('喜欢猫') && !fHtml.includes('常半夜出没'));
ok('计数切换成「匹配 K / N 条」', fHtml.includes('匹配 1 / 2 条'));
ok('data-idx 仍指向原数组下标（不是过滤后的下标）', fHtml.includes('data-idx="0"') && !fHtml.includes('data-idx="1"'));

state.memQuery = '不存在的词';
await sandbox.loadMemoryDetail('group:123');
ok('无命中时给出提示（而不是一块空白）', $el('#memory-detail').innerHTML.includes('没有匹配'));
ok('无命中时保留查找框（否则用户没法改词）', $el('#memory-detail').innerHTML.includes('id="mem-search"'));

console.log('\n  ── 接口失败 ──');
state.memQuery = '';
routeFetch([[/\/api\/memory-files\/group_123$/, { __status: 500, error: '炸了' }], [/\/api\/config$/, { memberNotes: {} }]]);
await sandbox.loadMemoryDetail('group:123');
ok('接口 500 时不抛到外面（面板不该整页崩）', true);

// ═══════════ F. 会话详情：读图那一轮的记录 ═══════════
// 编排层把模型"看完图说了什么"回填到 toolImages 记录上（见 orchestrator 的
// pendingImageEntry）。这里验的就是那份记录渲染出来长什么样：能不能看见模型
// 到底读到了什么，以及会不会同一句话显示两遍。
console.log('\n═══ 会话详情：读图轮（注入的图 + 模型看完说了什么）═══');
state.tab = 'sessions';
const detailHtml = (s) => { sandbox.renderSessionDetail(s); return $el('#session-detail').innerHTML; };

const readTurn = detailHtml({
  id: 'sess-read-1', chatKey: 'group:123', status: 'done', rounds: 3, model: 'm', activity: '',
  messages: [
    { toolCall: { name: 'get_message_images', args: { messageId: 972644978 }, result: '消息 972644978 的图片内容：', isError: false } },
    { toolImages: { tool: 'get_message_images', count: 1, reply: {
      text: '这是一只橘猫趴在键盘上，旁边还有半杯奶茶。',
      calls: [{ name: 'send_message', args: { messages: ['好可爱'] } }]
    } } },
    // 读图那一轮的输出：已经显示在卡片里了，这里必须被跳过（否则同一句话出现两遍）
    { role: 'assistant', content: '这是一只橘猫趴在键盘上，旁边还有半杯奶茶。', imageReply: true, tool_calls: [{ function: { name: 'send_message', arguments: '{"messages":["好可爱"]}' } }] }
  ],
  sent: [{ type: 'text', text: '好可爱', at: '12:00:00' }]
});
ok('★ 模型看完图说了什么，直接显示在读图那张卡片上', readTurn.includes('模型读图后说：这是一只橘猫趴在键盘上'));
ok('★ 同一轮还调用了哪个工具，也写在同一张卡片上', readTurn.includes('同一轮还调用了：') && readTurn.includes('send_message(&quot;好可爱&quot;)'));
ok('★ 那段话只显示一次（带 imageReply 的 assistant 条被跳过）',
  readTurn.split('橘猫趴在键盘上').length - 1 === 1,
  `出现了 ${readTurn.split('橘猫趴在键盘上').length - 1} 次`);
ok('原来那句"图片已注入"仍在', readTurn.includes('1 张图片已作为图像输入注入模型'));

// 模型还没开口 / 半路出错：只显示原来那句，不编内容
const noReply = detailHtml({
  id: 'sess-read-2', chatKey: 'group:123', status: 'noreply', rounds: 1, model: 'm', activity: '',
  messages: [{ toolImages: { tool: 'get_message_images', count: 2 } }], sent: []
});
ok('没有读图结论时不编一句话（只留"已注入"）',
  noReply.includes('2 张图片已作为图像输入注入模型') && !noReply.includes('模型读图后说'));
ok('没有结论时也不多出一块空的 result 区', !/tool-result[^>]*>\s*</.test(noReply));

// 模型看完图什么都没说（纯工具调用）→ 卡片还在，只是没有那句结论
const silent = detailHtml({
  id: 'sess-read-3', chatKey: 'group:123', status: 'done', rounds: 2, model: 'm', activity: '',
  messages: [
    { toolImages: { tool: 'get_sticker_image', count: 1, reply: { text: '', calls: [{ name: 'sticker_note', args: { note: '阴阳怪气' } }] } } }
  ], sent: []
});
ok('模型没说话但顺手标了注：只显示工具调用，不留一句空的"模型读图后说"',
  silent.includes('同一轮还调用了：') && silent.includes('sticker_note(&quot;阴阳怪气&quot;)') && !silent.includes('模型读图后说'));

// 老记录（升级前留下的，toolImages 里没有 reply 字段）必须照旧能渲染
const legacy = detailHtml({
  id: 'sess-read-4', chatKey: 'group:123', status: 'done', rounds: 1, model: 'm', activity: '',
  messages: [{ toolImages: { tool: 'get_message_images', count: 1 } }], sent: []
});
ok('升级前的老会话记录照旧渲染（没有 reply 字段也不炸）', legacy.includes('1 张图片已作为图像输入注入模型'));

// 摘要有长度上限；这里顺手守一下参数摘要本身不吃掉正文
const longSay = detailHtml({
  id: 'sess-read-5', chatKey: 'group:123', status: 'done', rounds: 2, model: 'm', activity: '',
  messages: [{ toolImages: { tool: 'get_message_images', count: 1, reply: { text: '看清楚了', calls: [{ name: 'send_message', args: { messages: ['啊'.repeat(200)] } }] } } }],
  sent: []
});
ok('参数摘要太长时截断（不让一行工具摘要把卡片撑爆）', longSay.includes('…') && !longSay.includes('啊'.repeat(120)));

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
