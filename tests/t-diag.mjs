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
  store: { contextTier: 4, allCount: 80 }, reply: { maxWaitMs: 0 }, wakeDelayMs: 800 });
const store = new ChatStore(0), sessions = new SessionRegistry(0);
const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts:{memberImpression:0}, members:[], lastConsolidatedAt:0 }), listChats: () => [] };
const onebot = { selfId:'999', selfNickname:'小鲸鱼', connected:true, sendText: async()=>({message_id:1}), sendSticker: async()=>({}), sendPoke: async()=>({}), getGroupInfo: async()=>({group_name:'G'}), call: async()=>({}) };
const sender = new SendQueue({ onebot, store });
const orc = new Orchestrator({ store, memory, stickers:{sync:async()=>({entries:[]})}, sender, sessions, onebot, emit:()=>{} });
const key = 'group:123';
let n = 0;
const say = () => { n++; store.appendIncoming(key, { mid:n, ts:Date.now(), senderId:'555', senderName:'张三', text:`第${n}条` }); };

say(); orc.scheduleWake(key);
console.log('第一次 scheduleWake →', orc.chatState(key)?.state, orc.chatState(key)?.phase);
orc.abortAll();
console.log('abortAll 后 aborted =', orc.aborted, '| paused =', orc.paused, '| chatStates =', orc.chatStates.size, '| pendingWake =', orc.pendingWake.size);
say();
console.log('新消息未读数 =', store.unreadCount(key));
orc.scheduleWake(key);
console.log('第二次 scheduleWake → state =', orc.chatState(key)?.state, '| phase =', orc.chatState(key)?.phase);
console.log('pendingWake =', orc.pendingWake.size, '| pendingSessions =', orc.pendingSessions.size, '| wakeTimers =', orc.wakeTimers.size);
fs.rmSync(DIR, { recursive: true, force: true });
