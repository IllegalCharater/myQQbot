import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-'));
process.env.QQ_AGENT_DATA_DIR = DIR;
const { ChatStore } = await load('store.js');
const { SessionRegistry } = await load('sessions.js');
const { SendQueue } = await load('sender.js');
const { Orchestrator } = await load('orchestrator.js');
const { updateConfig } = await load('config.js');

updateConfig({ api: { baseUrl: 'http://127.0.0.1:1/v1', model: 'stub', maxRounds: 1 },
  allowAllWhenEmpty: true, persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextTier: 4, allCount: 80, maxContextMessages: 0 },
  reply: { maxWaitMs: 1200 }, wakeDelayMs: 800 });

const store = new ChatStore(0);
const sessions = new SessionRegistry(0);
const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
const stickers = { sync: async () => ({ entries: [] }) };
const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true, sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({}), sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };
const sender = new SendQueue({ onebot, store });
const events = [];
const orc = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit: (t, p) => events.push({ t, p }) });
const key = 'group:123';

console.log('=== 计时器是否在上限时刻触发（而不是每条消息后重新等 800）===');
let seq = 0;
const say = () => { seq++; store.appendIncoming(key, { mid: seq, ts: Date.now(), senderId: '555', senderName: '张三', text: `你好${seq}` }); };
say();
const t0 = Date.now();
orc.scheduleWake(key);
// 每 300ms 来一条，持续到 1.5s —— 尾沿防抖会让它一直等到最后一刻，但硬上限必须生效
const spam = setInterval(() => { if (Date.now() - t0 < 1500) { say(); orc.scheduleWake(key); } }, 300);
// 观察什么时候真正开跑
const started = await new Promise((resolve) => {
  const iv = setInterval(() => {
    const s = orc.chatState(key);
    if (s && s.phase === 'running') { clearInterval(iv); resolve(Date.now()); }
  }, 20);
  setTimeout(() => { clearInterval(iv); resolve(null); }, 8000);
});
clearInterval(spam);
console.log(started === null ? '❌ 从未开跑' : `✅ 开跑于 t0+${started - t0}ms（期望 ≈1200±150，即硬上限；若为 800 后重算则会拖到 1500+800=2300）`);
console.log('开跑后状态:', JSON.stringify({ ...orc.chatState(key), roll: undefined, batchStartedAt: undefined, waitingSessionId: undefined }));

// 等这次运行彻底结束（模型不可达 → 3 次重试）
await new Promise(r => setTimeout(r, 4500));
console.log('运行结束后回到静默态:', orc.chatState(key)?.state === 'silent', '| sender.replying 空:', !sender.replying.has(key));
console.log('runningChats 空:', orc.runningChats.size === 0);
orc.abortAll();

console.log('\n=== 动态上下文窗口：maxContextMessages=5，一次来 8 条 ===');
const m2 = (() => {
  const st = new ChatStore(0), se = new SessionRegistry(0);
  const ob = { ...onebot, getGroupInfo: async () => ({ group_name: 'G' }) };
  const sd = new SendQueue({ onebot: ob, store: st });
  return { store: st, sessions: se, orc: new Orchestrator({ store: st, memory, stickers, sender: sd, sessions: se, onebot: ob, emit: () => {} }) };
})();
updateConfig({ store: { contextTier: 4, allCount: 80, maxContextMessages: 5 }, reply: { maxWaitMs: 0 } });
let n = 0;
for (let i = 0; i < 8; i++) { n++; m2.store.appendIncoming(key, { mid: n, ts: 1700000000000 + n * 1000, senderId: '555', senderName: '张三', text: `第${n}条` }); }
m2.orc.scheduleWake(key, 0);
const trig = await new Promise((resolve) => {
  const iv = setInterval(() => {
    for (const s of m2.sessions.current.values()) if (s.status === 'running' && s.trigger) { clearInterval(iv); resolve(s.trigger); }
  }, 10);
  setTimeout(() => { clearInterval(iv); resolve(null); }, 4000);
});
console.log(trig ? `trigger 条数 = ${trig.length}（期望 5），内容 = ${trig.map(m => m.text).join(',')}` : '❌ 没抓到');
console.log('被折走的 3 条仍在存档里:', m2.store.recent(key, { limit: 100 }).filter(m => ['第1条','第2条','第3条'].includes(m.text)).length === 3);
console.log('全部已标记已读（不会二次触发）:', m2.store.unreadCount(key) === 0);
m2.orc.abortAll();
fs.rmSync(DIR, { recursive: true, force: true });
