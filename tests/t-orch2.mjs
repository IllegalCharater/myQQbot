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
  store: { contextTier: 4, maxContextMessages: 0 }, reply: { maxWaitMs: 0 } });

const mk = () => {
  const store = new ChatStore(0);
  const sessions = new SessionRegistry(0);
  const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
  const stickers = { sync: async () => ({ entries: [] }) };
  const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true, sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({ message_id: 2 }), sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };
  const sender = new SendQueue({ onebot, store });
  return { store, sessions, orc: new Orchestrator({ store, memory, stickers, sender, sessions, onebot }), sender };
};
const key = 'group:123';
const waitingOf = (orc) => { const id = orc.pendingSessions.get(key); return id ? orc.sessions.get(id) : null; };

console.log('=== 硬上限：maxWaitMs=4000, wakeDelayMs=2000 ===');
const { store, orc } = mk();
let seq = 0;
const say = (n) => { for (let i = 0; i < n; i++) { seq++; store.appendIncoming(key, { mid: seq, ts: Date.now(), senderId: '555', senderName: '张三', text: `你好${seq}` }); } };
updateConfig({ reply: { maxWaitMs: 4000 }, wakeDelayMs: 2000 });
say(1);
const t0 = Date.now();
orc.scheduleWake(key);
console.log(`t=0    等待会话 waitUntil-t0 = ${waitingOf(orc).waitUntil - t0}  (期望 2000)`);
await new Promise(r => setTimeout(r, 1500));
orc.scheduleWake(key);
console.log(`t=1.5s 等待会话 waitUntil-t0 = ${waitingOf(orc).waitUntil - t0}  (期望 3500 = min(2000, 4000-1500))`);
await new Promise(r => setTimeout(r, 1400));
orc.scheduleWake(key);
console.log(`t=2.9s 等待会话 waitUntil-t0 = ${waitingOf(orc).waitUntil - t0}  (期望 4000 = min(2000, 4000-2900)=1100 → t0+4000)`);
console.log(`batchStartedAt 未被重置 = ${orc.chatState(key).batchStartedAt - t0 < 50}`);
orc.abortAll();

console.log('\n=== maxWaitMs=0 时应与旧行为逐字一致 ===');
const m2 = mk();
updateConfig({ reply: { maxWaitMs: 0 }, wakeDelayMs: 2000 });
m2.store.appendIncoming(key, { mid: 1, ts: Date.now(), senderId: '555', senderName: '张三', text: 'hi' });
const t1 = Date.now();
m2.orc.scheduleWake(key);
console.log(`waitUntil-t1 = ${waitingOf(m2.orc).waitUntil - t1}  (期望 2000)`);
m2.orc.abortAll();

console.log('\n=== 压缩：模型不可达 → 必须零改动且不抛穿 ===');
const m3 = mk();
let n = 0;
for (let i = 0; i < 120; i++) { n++; m3.store.appendIncoming(key, { mid: n, ts: 1700000000000 + n * 1000, senderId: '555', senderName: '张三', text: `msg${n}` }); }
m3.store.drainUnread(key);
updateConfig({ compact: { enabled: true, minMessagesToCompact: 50, keepRecentMessages: 100, maxMessagesPerRound: 400 } });
const before = m3.store.recent(key, { limit: 10000 }).length;
const res = await m3.orc.compactChat(key, { force: true });
const after = m3.store.recent(key, { limit: 10000 }).length;
console.log('返回:', JSON.stringify(res));
console.log(`条数未变 (${before} → ${after}):`, before === after);
console.log('无 digest 条目:', !m3.store.recent(key, { limit: 10000 }).some(m => m.kind === 'digest'));
console.log('无归档文件:', !fs.existsSync(path.join(DIR, 'messages', 'archive', 'group_123.jsonl')));
console.log('无备份文件:', !fs.existsSync(path.join(DIR, 'messages', 'group_123.json.bak')));
console.log('lastCompactedAt 未写入:', m3.store.lastCompactedAt(key) === 0);
console.log('compacting 已清空:', m3.orc.compacting.size === 0);
fs.rmSync(DIR, { recursive: true, force: true });
