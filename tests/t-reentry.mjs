import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
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
  store: { contextTier: 4, allCount: 80 }, reply: { maxWaitMs: 0, maxPerMinute: 3 }, wakeDelayMs: 800 });
const store = new ChatStore(0), sessions = new SessionRegistry(0);
const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts:{memberImpression:0}, members:[], lastConsolidatedAt:0 }), listChats: () => [] };
const onebot = { selfId:'999', selfNickname:'小鲸鱼', connected:true, sendText: async()=>({message_id:1}), sendSticker: async()=>({}), sendPoke: async()=>({}), getGroupInfo: async()=>({group_name:'G'}), call: async()=>({}) };
const sender = new SendQueue({ onebot, store });
const orc = new Orchestrator({ store, memory, stickers:{sync:async()=>({entries:[]})}, sender, sessions, onebot, emit:()=>{} });
const key = 'group:123';
let n = 0;
const say = () => { n++; store.appendIncoming(key, { mid:n, ts:Date.now(), senderId:'555', senderName:'张三', text:`第${n}条` }); };

say(); orc.scheduleWake(key);
console.log('静默→回复（等待中）:', JSON.stringify(orc.chatState(key)?.phase), '/ sender 标记:', sender.replying.has(key));
console.log('  UI 数据源 /api/chats 语义 replying =', orc.chatState(key)?.state === 'replying');

// 等到它开跑
await new Promise(r => setTimeout(r, 1200));
console.log('等待→运行:', orc.chatState(key)?.phase);
// 用 abortAll 走一遍"运行被打断"
orc.abortAll();
console.log('\nabortAll 后：chatStates =', orc.chatStates.size, '| sender.replying =', sender.replying.size, '| compactTimer =', orc.compactTimer);

// 再走一遍完整的静默→回复（验证删键后可重建）
say(); orc.scheduleWake(key);
console.log('删键后重建成功:', orc.chatState(key)?.state === 'replying', '/ phase =', orc.chatState(key)?.phase);
// 硬上限打点也应在重建后正常工作
console.log('batchStartedAt 已打点:', orc.chatState(key)?.batchStartedAt > 0, '| roll 已作废:', orc.chatState(key)?.roll === null);
orc.abortAll();
fs.rmSync(DIR, { recursive: true, force: true });
