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
const { updateConfig, getConfig } = await load('config.js');

updateConfig({ api: { baseUrl: 'http://127.0.0.1:1/v1', model: 'stub', maxRounds: 1 },
  allow: { groups: [], private: [] }, allowAllWhenEmpty: true,
  persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextTier: 4, maxContextMessages: 0 },
  reply: { maxWaitMs: 0, maxPerMinute: 0, maxLimitWaitMs: 20000 } });

const store = new ChatStore(0);
const sessions = new SessionRegistry(0);
const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
const stickers = { sync: async () => ({ entries: [] }) };
const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true,
  sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({ message_id: 2 }),
  sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };
const sender = new SendQueue({ onebot, store });
const orc = new Orchestrator({ store, memory, stickers, sender, sessions, onebot });

const key = 'group:123';
const now = Date.now();
let seq = 0;
const say = (n) => { for (let i = 0; i < n; i++) { seq++; store.appendIncoming(key, { mid: seq, ts: now + seq * 10, senderId: '555', senderName: '张三', text: `你好${seq}` }); } };

console.log('=== 1. 等待窗口：maxWaitMs=0（原行为）===');
say(1);
const t0 = Date.now();
orc.scheduleWake(key);
let s = sessions.listSummaries(1)[0];
console.log('waitUntil-firstNow =', s.waitUntil - t0, 'ms（应≈ wakeDelayMs 2000）');
console.log('状态:', JSON.stringify(orc.chatState(key)));
orc.abortAll();
console.log('abortAll 未抛错 ✓ | chatStates 已清空:', orc.chatStates.size === 0, '| sender.replying 已清空:', sender.replying.size === 0);

console.log('\n=== 2. 等待窗口：maxWaitMs=4000，连发续命 ===');
const orc2 = new Orchestrator({ store, memory, stickers, sender, sessions, onebot });
updateConfig({ reply: { maxWaitMs: 4000 }, wakeDelayMs: 2000 });
const t1 = Date.now();
orc2.scheduleWake(key);
s = sessions.listSummaries(1)[0];
console.log('第1条后 waitUntil-t1 =', s.waitUntil - t1, '（应≈2000）');
await new Promise(r => setTimeout(r, 1500));
orc2.scheduleWake(key);           // 第 1.5s 来新消息
s = sessions.listSummaries(1)[0];
console.log('第1.5s 再来消息后 waitUntil-t1 =', s.waitUntil - t1, '（应≈3500，被硬上限 4000 钳住）');
await new Promise(r => setTimeout(r, 1500));
orc2.scheduleWake(key);           // 第 3s 又来
s = sessions.listSummaries(1)[0];
console.log('第3s 又来消息后 waitUntil-t1 =', s.waitUntil - t1, '（应≈4000，仍是硬上限）');
console.log('batchStartedAt 未重置:', orc2.chatState(key).batchStartedAt - t1 < 100);
orc2.abortAll();
console.log('abortAll 后状态:', JSON.stringify(orc2.chatState(key)), '(应为 null)');

console.log('\n=== 3. 骰子固定（#predictTier 与 wake 共用同一颗）===');
const orc3 = new Orchestrator({ store, memory, stickers, sender, sessions, onebot });
updateConfig({ store: { contextTier: 3, randomPercent: 50, atCount: 5, keywordCount: 5, randomCount: 5, allCount: 5 } });
orc3.scheduleWake(key);
const r1 = orc3.chatState(key).roll;
const r2 = orc3.chatState(key).roll;
console.log('同一批两次读取 roll 一致:', r1 === r2, '| roll =', r1?.toFixed(2));
orc3.abortAll();

console.log('\n=== 4. 压缩闸门 ===');
updateConfig({ compact: { enabled: true, minMessagesToCompact: 50, keepRecentMessages: 100, maxMessagesPerRound: 400 } });
const orc4 = new Orchestrator({ store, memory, stickers, sender, sessions, onebot });
console.log('条数不够:', JSON.stringify(await orc4.compactChat(key)));
store.drainUnread(key);
say(120); store.drainUnread(key);
console.log('正在等待聚批时应拒绝:', JSON.stringify(await (async () => { orc4.scheduleWake(key); const r = await orc4.compactChat(key); orc4.abortAll(); return r; })()));
const orc5 = new Orchestrator({ store, memory, stickers, sender, sessions, onebot });
// 模型不可达 → 摘要失败 → 必须零改动
const before = store.recent(key, { limit: 10000 }).length;
const t2 = Date.now();
const rr = await orc5.compactChat(key, { force: true });
const after = store.recent(key, { limit: 10000 }).length;
console.log('模型不可达时:', JSON.stringify(rr));
console.log(`消息条数未变（${before} → ${after}）:`, before === after, '| 无摘要条目:', !store.recent(key, { limit: 10 }).some(m => m.kind === 'digest'));
console.log('耗时', Date.now() - t2, 'ms');
fs.rmSync(DIR, { recursive: true, force: true });
