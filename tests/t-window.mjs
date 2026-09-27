// 动态上下文窗口探针（src/context-window.js）
// 跑法：node tests/t-window.mjs（验的是 tsc 产物 dist/）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-win-'));
process.env.QQ_AGENT_DATA_DIR = DIR;
const { ChatStore } = await load('chat/store.js');
const { SessionRegistry } = await load('chat/sessions.js');
const { SendQueue } = await load('qq/sender.js');
const { Orchestrator } = await load('agent/orchestrator.js');
const { ContextWindow, ContextWindowRegistry } = await load('agent/context-window.js');
const { updateConfig } = await load('core/config.js');

let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};
const msg = (id, text, extra = {}) => ({ id, ts: 1700000000000 + id * 1000, senderId: '555', senderName: '张三', text, self: false, read: false, ...extra });

updateConfig({ api: { baseUrl: 'http://127.0.0.1:1/v1', model: 'stub', maxRounds: 1 },
  allowAllWhenEmpty: true, persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextSliderPos: 95, historyCount: 80, maxContextMessages: 0 },
  reply: { maxWaitMs: 0, maxLimitWaitMs: 0 }, wakeDelayMs: 50, drainDelayMs: 50 });

function harness() {
  const store = new ChatStore(0);
  const sessions = new SessionRegistry(0);
  const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
  const stickers = { sync: async () => ({ entries: [] }) };
  const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true, sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({}), sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };
  const sender = new SendQueue({ onebot, store });
  const orc = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit: () => {} });
  return { store, orc, sessions, sender };
}
const KEY = 'group:123';
// 每个端到端用例一个独立会话：同目录下存档会互相看见，共用一个 key 会串味
let keySeq = 0;
const key = () => `group:${1000 + (++keySeq)}`;

// ── 1. 类级：入窗 / 幂等 / 只收对方消息 ───────────────────────────────
console.log('=== 1. 入窗与幂等 ===');
{
  const w = new ContextWindow({ chatKey: KEY, capacity: 5 });
  ok('push 普通消息入窗', w.push(msg(1, '你好')) === true && w.stats().win === 1);
  ok('同一 id 重投被忽略', w.push(msg(1, '你好')) === false && w.stats().win === 1);
  ok('自己发的消息不入窗', w.push(msg(2, '我', { self: true })) === false && w.stats().win === 1);
  ok('摘要不入窗', w.push(msg(3, '纪要', { kind: 'digest' })) === false && w.stats().win === 1);
  ok('人工备注不入窗', w.push(msg(4, '备注', { kind: 'note' })) === false && w.stats().win === 1);
  ok('乱序的旧 id 被忽略', w.push(msg(1, 'x')) === false);
  ok('新 id 正常入窗', w.push(msg(9, '在的')) === true && w.stats().win === 2);
  const snapshot = w.pending(); snapshot[0].text = '外部篡改';
  ok('外部拿到的是快照，不能修改窗口成员', w.pending()[0].text === '你好');
  ok('窗口不暴露删除成员的方法', typeof w.remove === 'undefined');
}

// ── 2. 类级：容量 / 滑动 / 折走条数 ─────────────────────────────────
console.log('\n=== 2. 容量 5、连来 8 条 ===');
{
  const w = new ContextWindow({ chatKey: KEY, capacity: 5 });
  for (let i = 1; i <= 8; i++) w.push(msg(i, `第${i}条`));
  ok('窗口只留最新 5 条', w.stats().win === 5, `win=${w.pending().map(m => m.id).join(',')}`);
  ok('被挤出的 3 条只记折叠账本', w.stats().folded === 3);
  ok('pending() 严格不超过窗口上限', w.pending().length === 5 && w.pending()[0].id === 4);
  ok('batch() = 5（进【本次唤醒】）', w.batch().length === 5 && w.batch()[0].id === 4);
  ok('foldedCount() = 3', w.foldedCount() === 3);
  ok('takeFoldedIds() 专门取出滑出的 3 个 id', w.takeFoldedIds().join(',') === '1,2,3');
  ok('取走待提交 id 后 foldedCount 仍保留本轮统计', w.foldedCount() === 3 && w.takeFoldedIds().length === 0);
  const crossed = w.seen();
  ok('seen() 只返回窗口中的 5 条快照', crossed.length === 5);
  ok('游标推到 8', w.stats().cursor === 8);
  ok('settled 只处理仍在窗口内的 5 个 id', w.takeSettled().length === 5);
  ok('消费后折叠账本清空、pending 归零', w.stats().folded === 0 && w.pending().length === 0 && w.foldedCount() === 0);
  w.push(msg(9, '第9条'));
  ok('消费后再来一条只算它自己', w.pending().length === 1 && w.batch().length === 1 && w.foldedCount() === 0);
}

// ── 3. 类级：容量 0 = 不限 ───────────────────────────────────────────
console.log('\n=== 3. 容量 0 = 不限 ===');
{
  const w = new ContextWindow({ chatKey: KEY, capacity: 0 });
  for (let i = 1; i <= 30; i++) w.push(msg(i, `第${i}条`));
  ok('30 条全在窗里、折叠账本恒空', w.stats().win === 30 && w.stats().folded === 0);
  ok('batch() = pending() = 30', w.batch().length === 30 && w.pending().length === 30);
}

// ── 4. 类级：容量调小不追溯毁掉积压 ──────────────────────────────────
console.log('\n=== 4. 容量调小 ===');
{
  let cap = 0;
  const w = new ContextWindow({ chatKey: KEY, capacity: () => cap });
  for (let i = 1; i <= 6; i++) w.push(msg(i, `第${i}条`));
  w.seen();                       // 1~6 全部消费过
  cap = 2;                        // 设置页把上限从"不限"改成 2
  w.push(msg(7, '第7条')); w.push(msg(8, '第8条'));
  ok('调小后窗口只留 2 条', w.stats().win === 2, `win=${w.pending().map(m => m.id).join(',')}`);
  ok('已消费的被直接丢掉、不进折叠账本', w.stats().folded === 0);
  ok('pending 只剩没看过的 7,8', w.pending().map(m => m.id).join(',') === '7,8');
  w.push(msg(9, '第9条')); w.push(msg(10, '第10条'));
  ok('没消费的被滑出后不再属于窗口，只保留结算 id', w.pending().map(m => m.id).join(',') === '9,10' && w.stats().folded === 2);
}

// ── 6. 类级：用带 read 前缀的存档播种 ────────────────────────────────
console.log('\n=== 6. 播种还原游标 ===');
{
  // 情形 A：比窗口更老的都处理过了（read 前缀吃满整个窗口）
  const a = new ContextWindow({ chatKey: KEY, capacity: 5,
    initialEntries: [msg(1, 'a', { read: true }), msg(2, 'b', { read: true }), msg(3, 'c'), msg(4, 'd')] });
  ok('游标 = read 前缀末尾（2）', a.stats().cursor === 2);
  ok('pending() 只剩没看过的 3,4', a.pending().map(m => m.id).join(',') === '3,4');
  ok('batch() 同上', a.batch().map(m => m.id).join(',') === '3,4');
  ok('maxPushedId 取到最大 id', a.maxPushedId === 4);
  // 情形 B：窗外还有没处理过的（read 前缀为空 → 游标 0，窗外那批照算待处理）
  const b = new ContextWindow({ chatKey: KEY, capacity: 2,
    initialEntries: [msg(3, 'c'), msg(4, 'd')], initialFoldedIds: [1, 2] });
  ok('窗外未处理 → 游标 0', b.stats().cursor === 0);
  ok('pending() 只含严格窗口内 2 条', b.pending().map(m => m.id).join(',') === '3,4');
  ok('batch() 只含窗内 2 条', b.batch().map(m => m.id).join(',') === '3,4');
  ok('foldedCount() = 2', b.foldedCount() === 2);
}

// ── 7. 注册表 + 编排器：容量 5、8 条、一次运行 ───────────────────────
console.log('\n=== 7. 端到端：容量 5 + 8 条 → 触发批 5、折走 3、全部落已读 ===');
{
  updateConfig({ store: { contextSliderPos: 95, historyCount: 80, maxContextMessages: 5 } });
  const { store, orc, sessions } = harness();
  const K = key();
  for (let i = 1; i <= 8; i++) {
    const e = store.appendIncoming(K, { mid: i, ts: 1700000000000 + i * 1000, senderId: '555', senderName: '张三', text: `第${i}条` });
    orc.onIncoming(K, e);          // 走真实入口（app.js 的 ingest 就是这么调的）
  }
  ok('窗口 stats：容量 5 / 窗口严格 5 条', JSON.stringify(orc.windows.stats(K)) === JSON.stringify({ chatKey: K, capacity: 5, win: 5, folded: 3, pending: 5, batch: 5, cursor: 0 }), JSON.stringify(orc.windows.stats(K)));
  ok('被折走的 3 条在唤醒前就已自动进入已读历史', store.unreadCount(K) === 5);
  orc.scheduleWake(K, 0);
  const trig = await new Promise((resolve) => {
    const iv = setInterval(() => {
      for (const s of sessions.current.values()) if (s.status === 'running' && s.trigger && s.chatKey === K) { clearInterval(iv); resolve(s.trigger); }
    }, 10);
    setTimeout(() => { clearInterval(iv); resolve(null); }, 5000);
  });
  ok('触发的就是窗口里那 5 条', trig && trig.length === 5 && trig[0].text === '第4条', trig ? trig.map(m => m.text).join(',') : '没抓到');
  ok('被折走的 3 条仍在存档里', store.recent(K, { limit: 100 }).filter(m => ['第1条', '第2条', '第3条'].includes(m.text)).length === 3);
  ok('消费后存档未读归零', store.unreadCount(K) === 0);
  ok('消费后窗口也空了', orc.windows.pendingCount(K) === 0);
  orc.abortAll();
}

// ── 8. 端到端：响应判定严格只看窗口 ─────────────────────────────────
console.log('\n=== 8. 窗口只有 2 条，被滑出的 @ 不再参与响应判定 ===');
{
  updateConfig({ store: { contextSliderPos: 5, historyCount: 20, maxContextMessages: 2 } });   // 响应档1：只认 @；历史独立为20
  const { store, orc, sessions } = harness();
  const K = key();
  const push = (t) => { const e = store.appendIncoming(K, { mid: t, ts: Date.now(), senderId: '555', senderName: '张三', text: t }); orc.onIncoming(K, e); return e; };
  push('@小鲸鱼 在吗'); push('闲聊一'); push('闲聊二');   // @ 是最老的，会被后面两条挤出窗口
  ok('窗口只留最新 2 条、@ 已滑出', orc.windows.stats(K).win === 2 && orc.windows.pending(K).every(m => !m.text.includes('@')));
  ok('pending() 不再暴露窗外消息', !orc.windows.pending(K).some(m => m.text.includes('@')));
  orc.scheduleWake(K, 3000);       // ms>0 → 预判通过才建"等待中"会话
  await new Promise(r => setTimeout(r, 120));
  ok('预判为不响应（不会出现等待中会话）', ![...sessions.current.values()].some(s => s.status === 'waiting' && s.chatKey === K));
  orc.abortAll();
}

// ── 9. 端到端：暂停期间只入窗、不写 read ─────────────────────────────
console.log('\n=== 9. 暂停期间仍按窗口容量自动沉入历史 ===');
{
  updateConfig({ store: { contextSliderPos: 95, historyCount: 80, maxContextMessages: 2 } });
  const { store, orc } = harness();
  const K = key();
  orc.setPaused(true);
  for (let i = 1; i <= 4; i++) {
    const e = store.appendIncoming(K, { mid: i, ts: Date.now() + i, senderId: '555', senderName: '张三', text: `积压${i}` });
    orc.onIncoming(K, e);
  }
  ok('窗口严格只保留最新 2 条', orc.windows.stats(K).win === 2 && orc.windows.pendingCount(K) === 2);
  ok('滑出的 2 条已进入历史，窗口内最新 2 条仍未读', store.unreadCount(K) === 2);
  orc.setPaused(false);
  orc.abortAll();
}

// ── 10. 面板「全部标为已读」= 真推进游标 ─────────────────────────────
console.log('\n=== 10. markChatSeen ===');
{
  const { store, orc } = harness();
  const K = key();
  for (let i = 1; i <= 3; i++) {
    const e = store.appendIncoming(K, { mid: i, ts: Date.now() + i, senderId: '555', senderName: '张三', text: `消息${i}` });
    orc.onIncoming(K, e);
  }
  const n = orc.markChatSeen(K);
  ok('返回当前窗口实际消费条数 2（滑出的 1 条此前已结算）', n === 2);
  ok('存档未读归零', store.unreadCount(K) === 0);
  ok('游标真推进（pending 归零，不会再被当成待回应）', orc.windows.pendingCount(K) === 0);
  orc.abortAll();
}

// ── 11. 重启后播种：带 read 的存档能还原出正确的待处理量 ─────────────
console.log('\n=== 11. 进程重启后从存档播种 ===');
{
  updateConfig({ store: { contextSliderPos: 95, historyCount: 80, maxContextMessages: 0 } });
  const first = harness();
  const K = key();
  for (let i = 1; i <= 5; i++) {
    const e = first.store.appendIncoming(K, { mid: i, ts: 1700000000000 + i, senderId: '555', senderName: '张三', text: `老${i}` });
    first.orc.onIncoming(K, e);
  }
  first.orc.markChatSeen(K);            // 前 5 条处理过了，read 镜像落盘
  for (let i = 6; i <= 8; i++) {
    const e = first.store.appendIncoming(K, { mid: i, ts: 1700000000000 + i, senderId: '555', senderName: '张三', text: `新${i}` });
    first.orc.onIncoming(K, e);
  }
  const fresh = harness().orc;          // 新进程 = 新窗口，只能靠存档播种
  ok('只认未读的 3 条为待处理', fresh.windows.pending(K).map(m => m.text).join(',') === '新6,新7,新8', JSON.stringify(fresh.windows.pending(K).map(m => m.text)));
  ok('已读的 5 条不进【本次唤醒】', fresh.windows.batch(K).every(m => !m.text.startsWith('老')));
  first.orc.abortAll(); fresh.abortAll();
}

// ── 12. 兜底：绕过 onIncoming 直接写 store，窗口仍能补齐 ─────────────
console.log('\n=== 12. 分叉兜底（#sync）===');
{
  const { store, orc } = harness();
  const K = key();
  const e = store.appendIncoming(K, { mid: 1, ts: Date.now(), senderId: '555', senderName: '张三', text: '第一条' });
  orc.onIncoming(K, e);
  store.appendIncoming(K, { mid: 2, ts: Date.now() + 1, senderId: '555', senderName: '张三', text: '绕过入口的第二条' });
  ok('直接写存档的消息也被补进窗口', orc.windows.pendingCount(K) === 2, JSON.stringify(orc.windows.pending(K).map(m => m.text)));
  orc.abortAll();
}

// ── 14. 容量改动即时生效（不用重启） ─────────────────────────────────
console.log('\n=== 14. 容量即时生效 ===');
{
  updateConfig({ store: { contextSliderPos: 95, historyCount: 80, maxContextMessages: 0 } });
  const { store, orc } = harness();
  const K = key();
  for (let i = 1; i <= 6; i++) {
    const e = store.appendIncoming(K, { mid: i, ts: Date.now() + i, senderId: '555', senderName: '张三', text: `第${i}条` });
    orc.onIncoming(K, e);
  }
  ok('起点：6 条全在窗里', orc.windows.stats(K).win === 6, JSON.stringify(orc.windows.stats(K)));
  updateConfig({ store: { maxContextMessages: 2 } });
  const e7 = store.appendIncoming(K, { mid: 7, ts: Date.now(), senderId: '555', senderName: '张三', text: '第7条' });
  orc.onIncoming(K, e7);
  ok('改成 2 后立刻只留 2 条', orc.windows.stats(K).win === 2, JSON.stringify(orc.windows.stats(K)));
  ok('裁掉的内容不再算窗口成员，只保留折叠结算数', orc.windows.pendingCount(K) === 2 && orc.windows.stats(K).folded === 5, JSON.stringify(orc.windows.stats(K)));
  orc.abortAll();
}

console.log(`\n${bad === 0 ? '✅ 全部通过' : `❌ ${bad} 项失败`}`);
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);
