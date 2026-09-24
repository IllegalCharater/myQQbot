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
  reply: { maxWaitMs: 0 }, wakeDelayMs: 300 });

const store = new ChatStore(0);
const sessions = new SessionRegistry(0);
const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: { memberImpression: 0 }, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true, sendText: async () => ({ message_id: 1 }), sendSticker: async () => ({}), sendPoke: async () => ({}), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };
const sender = new SendQueue({ onebot, store });
const key = 'group:123';
const orc = new Orchestrator({ store, memory, stickers: { sync: async () => ({ entries: [] }) }, sender, sessions, onebot, emit: () => {} });

let n = 0;
for (let i = 0; i < 6; i++) { n++; store.appendIncoming(key, { mid: n, ts: 1700000000000 + n * 1000, senderId: '555', senderName: '张三', text: `第${n}条` }); }
orc.scheduleWake(key, 0);

const s = await new Promise((r) => { const iv = setInterval(() => { for (const x of sessions.current.values()) if (x.userPrompt) { clearInterval(iv); r(x); } }, 10); setTimeout(() => { clearInterval(iv); r(null); }, 4000); });
const up = String(s?.userPrompt || '');
console.log('折叠提示句:', JSON.stringify((up.match(/（这批消息[^）]*）/) || ['<无>'])[0]));
console.log('【本次唤醒】里的条数:', (up.split('【本次唤醒】')[1] || '').split('\n').filter(l => /^\[/.test(l.trim())).length, '(期望 3)');

// 等待整个重试阶梯跑完（LLM 3 次 × 会话 3 次 ≈ 12s+）
for (let i = 0; i < 40; i++) { if (orc.chatStates.size === 0 && orc.runningChats.size === 0) break; await new Promise(r => setTimeout(r, 1000)); }
console.log('\n运行彻底结束后：');
console.log('  chatStates 清空:', orc.chatStates.size === 0, '| sender.replying 清空:', orc.sender.replying.size === 0);
console.log('  runningChats 清空:', orc.runningChats.size === 0, '| activeRuns 清空:', orc.activeRuns.size === 0);
console.log('  无会话停在 waiting:', ![...sessions.current.values()].some(x => x.status === 'waiting'));
console.log('  状态可再次进入（静默→回复）:', (() => { orc.scheduleWake(key, 0); const ok = orc.chatStates.get(key)?.state === 'replying'; orc.abortAll(); return ok; })());
console.log('  abortAll 后全清:', orc.chatStates.size === 0 && orc.sender.replying.size === 0 && orc.compactTimer === null);
fs.rmSync(DIR, { recursive: true, force: true });
