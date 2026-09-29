// 验证：引用错人事故的两条修复（#id 可见性 + 提示词禁令）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-reply-'));
process.env.QQ_AGENT_DATA_DIR = DIR;
const { buildPastState, buildUserPrompt, buildSystemPrompt, buildTriggerBlock } = await load('agent/prompting/prompt-builder.js');
const { evaluateWindowTrigger } = await load('agent/context/response-policy.js');
const { resolveHistoryPolicy } = await load('agent/context/history-policy.js');
const { updateConfig, responseConfigForChat } = await load('core/config.js');
const { ChatStore } = await load('chat/store.js');

updateConfig({ persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' }, api: { model: 'stub', baseUrl: 'http://x' } });

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '  ✅' : '  ❌'} ${label}${cond ? '' : ' ' + extra}`); };

// ── 复刻 09/24 10:31 那次运行：10 条历史，其中只有 1 条带图 ──
const store = new ChatStore(0);
const KEY = 'group:623820457';
const t0 = new Date('2026-09-24T10:28:00').getTime();
const hist = [
  { mid: 1608895488, who: '我', self: true, text: '反正骂完还得买 优化个屁' },
  { mid: -322766845, who: '赤心', text: '00系商业成绩好像' },
  { mid: -507238434, who: '赤心', text: '反正万代根本不重视' },
  { mid: -1945536185, who: '赤心', text: '四台主角机' },
  { mid: -562467262, who: '赤心', text: '前前后后可能花了十几年才出齐' },
  { mid: 172230596, who: '赤心', text: '[图片]', media: [{ kind: 'image', url: 'https://x/a.jpg' }] },   // ← 被误引的那条
  { mid: 1085647448, who: '我', self: true, text: '熬到出齐 人都退坑了' },
  { mid: -1199277246, who: '清三', text: '为什么这么关注这个申必表情' },
  { mid: -788759164, who: '我', self: true, text: '盯一下怎么了' },
  { mid: -605347416, who: '清三', text: '和其他表情没什么区别吧' },
];
hist.forEach((h, i) => store.appendIncoming(KEY, {
  mid: h.mid, ts: t0 + i * 60000, senderId: h.self ? '9999' : (h.who === '赤心' ? '3228552813' : '2035800860'),
  senderName: h.who, text: h.text, media: h.media || []
}));
// 拍一拍：mid 为 null，进【本次唤醒】
const poke = store.appendIncoming(KEY, { mid: null, ts: t0 + 20000, senderId: '2035800860', senderName: '清三', text: '[拍一拍] 你拍了拍（来自 清三）', media: [] });
const ids = (t) => (t.match(/#-?\d+/g) || []);

console.log('\n=== 0. 窗口触发与历史档位职责分离 ===');
updateConfig({ store: { contextSliderPos: 55, historyCount: 21 } });
const responsePolicy = responseConfigForChat(KEY);
const windowDecision = evaluateWindowTrigger({ entries: [{ text: '@小鲸鱼 在吗' }], identity: { selfNickname: '小鲸鱼' }, policy: responsePolicy, roll: 99 });
const pureHistory = resolveHistoryPolicy({ historyCount: 21 });
ok('窗口判定器只决定是否响应', windowDecision.responseTier === 1 && windowDecision.shouldRespond && !('historyCount' in windowDecision));
ok('历史策略不读窗口与触发原因', pureHistory.historyCount === 21);
ok('响应策略配置不携带历史深度', !('historyCount' in responsePolicy));

console.log('\n=== 1. 【过去状态】的 #id 可见性（修复点 2）===');
const past10 = buildPastState(store, KEY, { excludeIds: [poke.id], limit: 10 });
console.log('  实际文本：\n' + past10.text.split('\n').map((l) => '    ' + l).join('\n'));
ok('10 行历史全部带上 #id（旧规则下只有 1 个）', ids(past10.text).length === 10, `实际 ${ids(past10.text).length} 个`);
ok('被误引那条第 1 行仍是赤心的图片', /#172230596 赤心：\[图片\]/.test(past10.text));
ok('紧邻拍一拍的前几条也能引用了（旧规则下它们没有 id）', ids(past10.text).includes('#-605347416') && ids(past10.text).includes('#-788759164'));

console.log('\n=== 2. 更早的消息仍不给 id（噪音控制）===');
for (let i = 0; i < 15; i++) store.appendIncoming(KEY, { mid: 5000 + i, ts: t0 - (20 - i) * 1000, senderId: '1', senderName: '路人', text: '更早的 ' + i, media: [] });
const past30 = buildPastState(store, KEY, { excludeIds: [], limit: 30 });
const lines = past30.text.split('\n');
const withId = lines.filter((l) => /#-?\d/.test(l)).length;
// 期望 = 最近 12 行 + 窗口外但凡带媒体的（这里是那张图，1 条）
const expected = 12 + lines.slice(0, lines.length - 12).filter((l) => /#172230596/.test(l)).length;
ok(`30 行里只有 ${expected} 行带 id（最近 12 行 + 窗口外带图的那 1 条）`, withId === expected, `实际 ${withId}`);
ok('最早那几行不带 id', !/#-?\d/.test(lines[0]));
ok('带图消息即使落在窗口外也保留 id', (() => {
  const far = buildPastState(store, KEY, { excludeIds: [], limit: 30 });
  return /#172230596/.test(far.text);
})());

console.log('\n=== 3. 提示词禁令（修复点 1）===');
const sp = buildSystemPrompt();
ok('系统提示写明"没有 #数字 的消息引用不了"', /没有 #数字 的引用不了/.test(sp));
ok('系统提示明确禁止拿别的消息的 id 凑', /不要拿别的消息的 #数字 去凑/.test(sp));
ok('系统提示点名拍一拍就是这类', /拍一拍/.test(sp) && /根本没有消息 id/.test(sp));
const up = buildUserPrompt({
  chatKey: KEY, kind: 'group', chatId: '623820457', chatName: '13号',
  triggerEntries: [store.recent(KEY, { limit: 1 })[0]], store, memory: { formatForPrompt: () => '' },
  selfNickname: '小鲸鱼', historyLimit: 10, recentCount: 5, lastMessageAt: Date.now()
});
ok('引用防错规则只在系统提示保留一份，用户提示不再重复灌入',
  !/宁可不用引用，也不要拿别的消息的 id 凑/.test(up));
ok('【过去状态】表头说明已与新规则一致', /最近的消息和带图的消息前有 #消息id/.test(up));
ok('旧表头那句（只有带图才有 id）已不复存在', !/带图的消息前有 #消息id，看图/.test(up));

console.log('\n=== 4. 独立历史与当前消息窗口彻底分离 ===');
const resident = store.recent(KEY, { limit: 100 }).find((m) => m.text === '为什么这么关注这个申必表情');
store.appendIncoming(KEY, { mid: 'after-boundary', ts: Date.now(), senderId: '10086', senderName: '后来者', text: '边界之后的新消息不应伪装成历史' });
const separated = buildUserPrompt({
  chatKey: KEY, kind: 'group', chatId: '623820457', chatName: '13号',
  triggerEntries: [poke], historyBeforeId: poke.id,
  store, memory: { formatForPrompt: () => '' }, selfNickname: '小鲸鱼',
  historyLimit: 30, recentCount: 5, lastMessageAt: Date.now()
});
ok('当前窗口消息只在【本次唤醒】出现一次', (separated.match(/\[拍一拍\]/g) || []).length === 1);
ok('当前窗口之前的消息可按档位作为历史注入', separated.includes('为什么这么关注这个申必表情'));
ok('窗口外历史仍按 historyLimit 注入', separated.includes('四台主角机'));
ok('历史边界之后到达的消息不会混进【过去状态】', !separated.includes('边界之后的新消息不应伪装成历史'));

console.log('\n=== 5. 统一字符预算优先保护当前新消息 ===');
updateConfig({ store: { promptContextMaxChars: 2200 }, digest: { maxChars: 0 } });
const budgeted = buildUserPrompt({
  chatKey: KEY, kind: 'group', chatId: '623820457', chatName: '13号',
  triggerEntries: [{ ...poke, text: '必须完整保留的当前消息-XYZ' }], historyBeforeId: poke.id,
  store, memory: { formatForPrompt: () => '很长的长期记忆'.repeat(1000) },
  stickerEntries: [], selfNickname: '小鲸鱼', historyLimit: 30,
  recentCount: 5, lastMessageAt: Date.now(), session: {}
});
ok('预算内仍完整保留【本次唤醒】', budgeted.includes('必须完整保留的当前消息-XYZ'));
ok('可选背景被收缩后不超过统一预算', budgeted.length <= 2200, `实际 ${budgeted.length}`);

// ── 6. 转写结果的渲染（【本次唤醒】与【过去状态】两条路径）──────────────
//
// 转写正文里出现"吗/呢"、以"？"结尾、或提到 bot 的名字都是常事；触发标签那几条
// 正则一旦不作数就会把机器输出标成「提问」「提到我」——模型会以为有人在向它提问。
console.log('\n=== 6. 【转写结果】的渲染与触发标签 ===');
updateConfig({ store: { promptContextMaxChars: 32000, historyCount: 30 } });
const trPlain = store.appendTranscript(KEY, { text: '视频里在讲一个关于茶叶的故事', chars: 15 });
const trCut = store.appendTranscript(KEY, { text: `【开场】${'茶叶'.repeat(40)}`, chars: 5000, truncated: true });
const trTrap = store.appendTranscript(KEY, { text: '@小鲸鱼 这视频里提到小鲸鱼了吗？', chars: 18 });

const tbPlain = buildTriggerBlock([trPlain], { selfNickname: '小鲸鱼' });
ok('【本次唤醒】里渲染成【转写结果】（时间戳 + 标记 + 正文，不套"某人："）',
  /^\[.+\] 【转写结果】视频里在讲一个关于茶叶的故事$/.test(tbPlain), tbPlain);
ok('未截断时不出现截断标记', !tbPlain.includes('原文共'), tbPlain);
ok('转写结果不产生 #消息id 前缀（mid 是 null，引用不了）', !/#/.test(tbPlain), tbPlain);
const tbCut = buildTriggerBlock([trCut], { selfNickname: '小鲸鱼' });
ok('截断时标出原文全长（模型不能把半截当成全文照转）', tbCut.includes('（原文共 5000 字，超出上限，此处为开头部分）'), tbCut);
const tbTrap = buildTriggerBlock([trTrap], { selfNickname: '小鲸鱼' });
ok('不打任何触发标签（正文里的 @、『吗』、『？』都不作数）', !tbTrap.includes('（'), tbTrap);
ok('正文照旧完整保留', tbTrap.includes('@小鲸鱼 这视频里提到小鲸鱼了吗？'), tbTrap);

const psTr = buildPastState(store, KEY, { limit: 30 });
const trLines = psTr.text.split('\n').filter((l) => l.includes('【转写结果】'));
ok('【过去状态】用的是同一套渲染', trLines.length >= 3, `实际 ${trLines.length} 行`);
ok('过去状态里也带截断标记', psTr.text.includes('（原文共 5000 字'));
ok('转写结果不套"某人："（不冒充群友）',
  trLines.length > 0 && trLines.every((l) => !l.slice(0, l.indexOf('【转写结果】')).includes('：')), trLines[0]);
ok('转写结果在【过去状态】里也没有 #id',
  trLines.length > 0 && trLines.every((l) => !/#-?\d/.test(l)), trLines[0]);

console.log('\n=== 7. 引用预览：结构化 reply 渲染成 [引用 #id 谁：什么] ===');
// 复刻 09/29 18:43 那次唤醒：清三发图 → 源赖氏佐田引用那张图问"评价一下"。
// 修复前提示词里只有 `[引用 清三：[图片]]`（id 被吃掉），模型只能从可见的 id 里瞎挑，
// 挑中了清三的**另一张图**。这一段钉的就是"被引用消息的 id 必须出现在模型眼前"。
const rstore = new ChatStore(0);
const RKEY = 'group:777';
const rT0 = new Date('2026-09-29T18:43:00').getTime();
rstore.appendIncoming(RKEY, {
  mid: -966228343, ts: rT0, senderId: '2035800860', senderName: '清三',
  text: '[图片]', media: [{ kind: 'image', url: 'https://x/quoted.jpg' }]
});
rstore.appendIncoming(RKEY, {
  mid: -942293892, ts: rT0 + 60000, senderId: '3228552813', senderName: '源赖氏佐田',
  text: '@小鲸鱼 评价一下', reply: { mid: '-966228343', sender: '清三', text: '[图片]' }
});
const quoting = rstore.findByMid(RKEY, -942293892);
const rPast = buildPastState(rstore, RKEY, { limit: 10 });
ok('被引用消息的 id 进了提示词（模型不必再从可见 id 里瞎挑）',
  rPast.text.includes('[引用 #-966228343 清三：[图片]]'), rPast.text);
ok('引用预览紧跟在说话人名之后、正文之前（引用的是别人说的那句，不是本轮新消息）',
  /源赖氏佐田：\[引用 #-966228343 清三：\[图片\]\]@小鲸鱼 评价一下/.test(rPast.text), rPast.text);
const rTrigger = buildTriggerBlock([quoting], { selfNickname: '小鲸鱼' });
ok('【本次唤醒】里同样带被引用 id', rTrigger.includes('[引用 #-966228343 清三：[图片]]'), rTrigger);
ok('触发标签认的是结构化 reply（预览已从 text 里搬走，按前缀判会静默失灵）',
  /（[^）]*引用[^）]*）/.test(rTrigger), rTrigger);
// 兼容：本改动之前入库的条目把预览拍在 text 里、reply 是 null，标签不能因此丢。
ok('老存档（预览还在 text 里）照样给「引用」标签',
  buildTriggerBlock([{
    id: 1, mid: -1, ts: rT0, senderId: '1', senderName: '甲', self: false, read: false,
    text: '[引用 乙：[图片]]什么梗', reply: null
  }], { selfNickname: '小鲸鱼' }).includes('引用'));
// 被引用正文取不到时只剩 id：这时仍然有用（模型可以拿它去看图/看详情）。
ok('只有 id 没有预览时印成 [引用 #id]',
  buildTriggerBlock([{
    id: 2, mid: -2, ts: rT0, senderId: '1', senderName: '甲', self: false, read: false,
    text: '看看', reply: { mid: '-5', sender: '', text: '' }
  }], { selfNickname: '小鲸鱼' }).includes('[引用 #-5]'));

console.log('\n=== 8. 历史压缩的输入行同样带引用预览 ===');
// 摘要行由 history-compactor 自己拼（不走 formatEntry），预览与正文分居两处 ——
// 这里漏了的话摘要会把"某人回了什么"压成"某人说了句没头没尾的话"，被回复的对象消失。
// 直接调压实的公开入口 compactChat(force)，用一个假 consolidator 把提示词截下来看。
{
  const { HistoryCompactor } = await load('agent/maintenance/history-compactor.js');
  const { ContextWindowRegistry } = await load('agent/context/context-window.js');
  updateConfig({ compact: { keepRecentMessages: 3, minMessagesToCompact: 1, maxMessagesPerRound: 20 } });
  const cstore = new ChatStore(0);
  const CKEY = 'group:888';
  const c0 = new Date('2026-09-29T12:00:00').getTime();
  for (let i = 0; i < 10; i++) {
    cstore.appendIncoming(CKEY, {
      mid: 1000 + i, ts: c0 + i * 1000, senderId: '1', senderName: '甲', text: `第 ${i} 条`,
      reply: i === 4 ? { mid: '999', sender: '乙', text: '[图片]' } : null
    });
  }
  cstore.drainUnread(CKEY);   // 压缩只归档已读条目（未读的还没被任何一次运行看到过）
  const prompts = [];
  const compactor = new HistoryCompactor({
    store: cstore,
    windows: new ContextWindowRegistry({ store: cstore, capacity: 10 }),
    runningChats: new Set(),
    pendingWake: new Set(),
    memoryConsolidator: {
      chat: async (messages) => {
        const user = String(messages?.[1]?.content ?? '');
        prompts.push(user);
        const n = Number(/共 (\d+) 行/.exec(user)?.[1] || 0);   // 幻觉守卫要求 seen === 行数
        return { message: { content: JSON.stringify({ summary: '聊了几句。', seen: n }) }, model: 'stub' };
      },
      maybeSchedule: () => {}
    },
    emit: () => {},
    isPaused: () => false,
    isAborted: () => false
  });
  const compactRes = await compactor.compactChat(CKEY, { force: true });
  ok('压缩真的跑起来了（否则下面两条是空转的绿）', compactRes.ok === true, JSON.stringify(compactRes));
  ok('摘要的输入行里带被引用消息的 id',
    /甲：\[引用 #999 乙：\[图片\]\]第 4 条/.test(prompts[0] || ''), (prompts[0] || '').slice(0, 400));
  ok('没有引用的行不受影响（不凭空多出 [引用]）',
    !/甲：\[引用[^\]]*\]第 3 条/.test(prompts[0] || ''), (prompts[0] || '').slice(0, 400));
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
