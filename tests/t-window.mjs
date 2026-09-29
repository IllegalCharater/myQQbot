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
const { Orchestrator } = await load('agent/runtime/orchestrator.js');
const { ContextWindow, ContextWindowRegistry } = await load('agent/context/context-window.js');
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
  // 转写结果与上面两种**故意相反**：它是 `isSystemRecord` 之外的一种 kind，
  // 恰恰必须进窗（否则模型永远看不到异步到达的识别文本）。这条与下面第 16 段
  // 的分档位断言合起来，就是"谓词拆分"这个承重改动的守护。
  ok('转写结果入窗（它不是系统记录，恰恰必须让模型看到）',
    w.push(msg(5, '【转写结果】视频里在讲这个那个', { kind: 'transcript', senderId: '', senderName: '转写' })) === true && w.stats().win === 2);
  ok('乱序的旧 id 被忽略', w.push(msg(1, 'x')) === false);
  ok('新 id 正常入窗', w.push(msg(9, '在的')) === true && w.stats().win === 3);
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

// ── 15. 主动冒泡的唤醒带着 `proactive: true` ─────────────────────────
//
// 为什么这条在这里：`Orchestrator` 递给 `ProactiveController` 的那个 `wake` 回调，是
// `{ proactive: true }` 的**唯一载体**。这个标志在 `wake-scheduler.wake()` 里做两件事——
// 越过暂停闸门，以及**跳过整个响应档位判定**（含"窗口里没有未读就早退"那条）。
//
// 而 `candidates()` 挑的恰恰是**窗口里没有未读**的空闲群（`pending().length > 0` 就跳过）。
// 所以这个标志一旦丢掉，主动冒泡不是"偶尔失灵"，而是**恒为 no-op**：每次都撞死在
// `pending().length === 0` 的早退上。实测确认过：把 `{ proactive: true }` 去掉，
// 全量 23 个套件**全绿**——在补上这一段之前，这条语义没有任何守护。
console.log('\n=== 15. 主动机会：空闲群也能被唤醒 ===');
{
  const { store, orc, sessions } = harness();
  const K = key();
  // **必须把 allow 钉死成本群**：`ProactiveController.tick()` 是
  // `candidates[Math.floor(Math.random() * candidates.length)]` —— 从**所有**合格群聊里随机挑一个。
  // 存档是按 `QQ_AGENT_DATA_DIR` 落盘的，而整个套件共用一个临时目录，于是前面 9 个小节留下的
  // 空闲群全都合格，本群被选中只有约 1/N 的概率。第一版没钉 allow，实测六次里挂三次
  // （`❌ 压根没建会话`）——**一条会随机红的断言比没有断言更坏**，它会把 `npm run check` 变成抽奖。
  updateConfig({
    allow: { groups: [K.split(':')[1]] },
    allowAllWhenEmpty: false,
    proactive: { enabled: true, probability: 1, idleThresholdMs: 300000 }
  });
  // 只落存档、**不进窗口**，并且标成已读：这正是 candidates() 认的空闲群
  // （久无消息、窗口里无未读）。不标已读的话，第一次 `ensure()` 播种会把这条未读
  // 拉进窗口，`pending()` 就不是 0 了——那样无论有没有 proactive 标志都会往下走，
  // 这条断言会退化成假的绿。
  store.appendIncoming(K, { mid: 1, ts: 1700000000000, senderId: '555', senderName: '张三', text: '很久以前' });
  store.markRead(K, { ids: [1] });
  ok('前置：这个群是唯一的冒泡候选（窗口无未读 + 白名单只有它）',
    orc.windows.pendingCount(K) === 0, `pending=${orc.windows.pendingCount(K)}`);

  // 本套件没有假时钟，所以只在 `start()` 那一瞬截下它排的 15s tick，再手动触发；
  // 截完立刻还原，避免影响后面的用例（同 t-timers 的 try/finally 约定）。
  const realSetTimeout = globalThis.setTimeout;
  let tick = null;
  globalThis.setTimeout = (fn, ms) => (ms === 15000 ? (tick = fn) : realSetTimeout(fn, ms));
  try { orc.startProactiveLoop(); } finally { globalThis.setTimeout = realSetTimeout; }
  ok('截到了冒泡巡检的 tick', typeof tick === 'function');

  if (typeof tick === 'function') await tick();
  // tick 里 `deps.wake(...)` 是 fire-and-forget，给它一点时间落地
  const created = await new Promise((resolve) => {
    const iv = setInterval(() => {
      const hit = [...sessions.current.values()].find((s) => s.chatKey === K);
      if (hit) { clearInterval(iv); resolve(hit); }
    }, 10);
    setTimeout(() => { clearInterval(iv); resolve(null); }, 3000);
  });
  ok('主动唤醒真的建出了会话（丢掉 proactive: true 会恒在这里早退）',
    created != null, created ? `session=${created.id} trigger=${JSON.stringify(created.trigger)}` : '压根没建会话');
  orc.abortAll();
}

// ── 16. 转写结果强制唤醒：任何档位都必须被响应 ───────────────────────
//
// 为什么必须有这条规则：转写结果是**异步交付**的，它到达时群里没有任何人在说话。
// 低档位（默认的"只认 @"）下这批消息会被判成"未触发"、被静默消费 —— 模型永远看不到
// 识别文本，用户等了半分钟只等来一片沉默。
//
// 判定器是唯一的落点：`forceWake` 只是 `scheduleWake(chatKey, 0)`，wake() 照样会跑这个
// 判定并把不该响应的批次静默消费掉。所以断言直接打在 `evaluateWindowTrigger` 上。
console.log('\n=== 16. 转写结果：任何档位都必须被响应 ===');
{
  const { evaluateWindowTrigger } = await load('agent/context/response-policy.js');
  const tr = (text = '【转写结果】视频里在讲一个关于茶叶的故事') =>
    ({ id: 1, ts: 1, senderId: '', senderName: '转写', text, self: false, read: false, kind: 'transcript' });
  const chatter = (text) => ({ id: 2, ts: 2, senderId: '555', senderName: '张三', text, self: false, read: false });
  const identity = { selfNickname: '小鲸鱼', botName: '小鲸鱼', selfId: '999' };
  // 档位 1 = 只认 @：正是"会被静默消费"的最低档
  const tier1 = { responseTier: 1, randomPercent: 0, keywords: [] };
  const allRandom = { responseTier: 3, randomPercent: 100, keywords: [] };
  const decide = (entries, { policy = tier1, roll = 50, id = identity } = {}) =>
    evaluateWindowTrigger({ entries, identity: id, policy, roll });

  const only = decide([tr()]);
  ok('只有转写结果 ⇒ 必须响应（档位 1 也不会静默消费）', only.shouldRespond === true, JSON.stringify(only));
  ok('原因写作「转写结果」，档位编码沿用非档位来源的 0',
    only.responseTier === 0 && only.reason === '转写结果', JSON.stringify(only));

  // 规则作用于**整批**：转写结果与无关闲聊同批到达时，一整批都要交给模型
  const mixed = decide([chatter('今天好热'), tr()]);
  ok('转写 + 无关闲聊 ⇒ 仍响应（规则作用于整批，不是只把转写那条挑出来）',
    mixed.shouldRespond === true && mixed.reason === '转写结果', JSON.stringify(mixed));

  // 认的是 kind，不是"任何非人类条目"：只为 digest/note 时一条都不能响应
  const digestOnly = decide([{ id: 3, ts: 3, senderId: 'digest', senderName: '摘要', text: '纪要', self: false, read: false, kind: 'digest' }]);
  ok('只有 digest ⇒ 不响应（规则不是"看到非人类条目就开口"）', digestOnly.shouldRespond === false, JSON.stringify(digestOnly));
  const noteOnly = decide([{ id: 4, ts: 4, senderId: '', senderName: '', text: '人工备注', self: false, read: false, kind: 'note' }]);
  ok('只有 note ⇒ 不响应', noteOnly.shouldRespond === false, JSON.stringify(noteOnly));

  // roll 无关：`#resolvePendingResponse` 同时被 scheduleWake（建等待会话前）与 wake
  // 调用。规则一旦读 roll，两处就可能给出不同答案 —— 一个建了会话、一个静默消费。
  ok('randomPercent 取 0（roll=0）与 100（roll=99）得到同一结论',
    decide([tr()], { policy: { responseTier: 3, randomPercent: 0, keywords: [] }, roll: 0 }).shouldRespond === true
    && decide([tr()], { policy: allRandom, roll: 99 }).shouldRespond === true);
  ok('转写结果压过"随机命中"（同样命中随机时原因仍是转写结果）',
    decide([tr()], { policy: allRandom, roll: 0 }).reason === '转写结果',
    decide([tr()], { policy: allRandom, roll: 0 }).reason);

  // 分支顺序不是随手写的：更具体的原因要胜出
  ok('有人真的艾特时，原因仍是「被艾特」（转写分支排在它后面）',
    decide([tr(), chatter('@小鲸鱼 看看这个')]).reason === '被艾特',
    decide([tr(), chatter('@小鲸鱼 看看这个')]).reason);
  ok('配了"全部响应"时仍报「全部响应」',
    decide([tr()], { policy: { responseTier: 4, randomPercent: 0, keywords: [] } }).reason === '全部响应');
  ok('空批不响应（规则不制造凭空的唤醒）', decide([]).shouldRespond === false);
}

// ── 17. 转写结果端到端：入存档 → 入窗 → 低档位下唤醒一次运行 ─────────
console.log('\n=== 17. 转写结果端到端（低档位仍被唤醒）===');
{
  updateConfig({
    allow: { groups: [] }, allowAllWhenEmpty: true, proactive: { enabled: false },
    store: { contextSliderPos: 5, historyCount: 20, maxContextMessages: 0 }
  });

  // (a) 重启后播种：`read: false` 是"重启后仍看得见"的因果，不是随手写的字段。
  //     照抄 insertNote 写成 read:true 的话，播种时 `#lastSeenId` 会吃满这条，
  //     条目躺在水位线**之下** —— 进程内看得见、重启后永久不可见。
  const K2 = key();
  const h1 = harness();
  h1.store.appendTranscript(K2, { text: '视频里在讲一个关于茶叶的故事', chars: 16 });
  const h2 = harness();
  ok('重启后从存档播种：转写结果仍是待处理（read:false 的因果）',
    h2.orc.windows.pending(K2).map((m) => m.kind).join(',') === 'transcript',
    JSON.stringify(h2.orc.windows.pending(K2).map((m) => [m.kind, m.read])));
  h1.orc.abortAll(); h2.orc.abortAll();

  // (b) 真跑一次：档位 1（只认 @）+ 窗口里只有一条转写结果
  const { store, orc, sessions } = harness();
  const K = key();
  const entry = store.appendTranscript(K, { text: '视频里在讲一个关于茶叶的故事', chars: 16 });
  orc.onIncoming(K, entry);
  ok('转写结果经 onIncoming 进了窗口',
    orc.windows.pendingCount(K) === 1 && orc.windows.pending(K)[0].kind === 'transcript',
    JSON.stringify(orc.windows.pending(K).map((m) => m.kind)));
  ok('存档里是未读（它就是这次唤醒的触发批）', store.unreadCount(K) === 1);
  orc.scheduleWake(K, 0);
  const hit = await new Promise((resolve) => {
    const iv = setInterval(() => {
      for (const s of sessions.current.values()) if (s.chatKey === K && s.status === 'running' && s.trigger) { clearInterval(iv); resolve(s); }
    }, 10);
    setTimeout(() => { clearInterval(iv); resolve(null); }, 5000);
  });
  ok('档位 1 下，一条转写结果照样唤醒一次运行', hit != null, hit ? `session=${hit.id}` : '压根没建会话');
  ok('触发批就是那条转写结果',
    hit != null && hit.trigger.length === 1 && hit.trigger[0].kind === 'transcript',
    hit ? JSON.stringify(hit.trigger.map((m) => m.kind)) : '没抓到');
  // 会话摘要（等待中会话与日志都用它）渲染成 `${senderName || senderId}：…`：
  // senderName 空着会变成 ":<正文>"，senderId 空着则任何按 id 的匹配都认不上它 ——
  // 两者都是刻意的选择，这里是它们唯一可机检的地方。
  ok('会话摘要写作「转写：…」而不是「:…」',
    hit != null && /^转写：/.test(String(hit.triggerSummary || '')), hit ? String(hit.triggerSummary) : '');
  orc.abortAll();
}

console.log(`\n${bad === 0 ? '✅ 全部通过' : `❌ ${bad} 项失败`}`);
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);
