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
  store: { contextTier: 4, allCount: 80, maxContextMessages: 3 },
  reply: { maxWaitMs: 0 }, wakeDelayMs: 300, runRetries: 0 });

const store = new ChatStore(0);
const sessions = new SessionRegistry(0);
const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
const stickers = { sync: async () => ({ entries: [] }) };
const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true, sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({}), sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };
const key = 'group:123';
const orc = new Orchestrator({ store, memory, stickers, sender: new SendQueue({ onebot, store }), sessions, onebot, emit: () => {} });

let n = 0;
for (let i = 0; i < 6; i++) { n++; store.appendIncoming(key, { mid: n, ts: 1700000000000 + n * 1000, senderId: '555', senderName: '张三', text: `第${n}条` }); }
orc.scheduleWake(key, 0);
const s = await new Promise((r) => { const iv = setInterval(() => { for (const x of sessions.current.values()) if (x.trigger) { clearInterval(iv); r(x); } }, 10); setTimeout(() => { clearInterval(iv); r(null); }, 4000); });
console.log('折叠提示句是否渲染:', /较早的 3 条已折入【过去状态】/.test(s?.prompt || ''));
console.log('实际提示词片段:', (String(s?.prompt || '').match(/（这批消息[^）]*）/) || ['<无>'])[0]);

// 等运行彻底跑完（含会话重试）
await new Promise(r => setTimeout(r, 6000));
console.log('\n运行结束后：');
console.log('  chatStates 已清空:', orc.chatStates.size === 0, '| sender.replying 空:', orc.sender.replying.size === 0);
console.log('  runningChats 空:', orc.runningChats.size === 0, '| pendingWake 空:', orc.pendingWake.size === 0, '| pendingSessions 空:', orc.pendingSessions.size === 0);
console.log('  没有任何会话停在 waiting:', ![...sessions.current.values()].some(x => x.status === 'waiting'));
orc.abortAll();
fs.rmSync(DIR, { recursive: true, force: true });
