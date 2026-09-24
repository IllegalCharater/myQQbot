import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-'));
// 模拟"老配置文件"：只有旧键，没有 reply/compact/maxContextMessages
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({ api: { model: 'x' }, wakeDelayMs: 1500, store: { maxMessagesPerChat: 0, contextTier: 4 } }), 'utf8');
process.env.QQ_AGENT_DATA_DIR = DIR;
const { loadConfig, getConfig } = await load('config.js');
const c = loadConfig();
console.log('wakeDelayMs 保留用户值:', c.wakeDelayMs === 1500);
console.log('reply 回填:', JSON.stringify(c.reply));
console.log('compact 回填:', JSON.stringify(c.compact));
console.log('store.maxContextMessages 回填:', c.store.maxContextMessages);
console.log('store 旧键保留:', c.store.contextTier === 4, c.store.allCount);
fs.rmSync(DIR, { recursive: true, force: true });
