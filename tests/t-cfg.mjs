import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-'));
// 模拟"老配置文件"：只有旧键，没有 reply/compact/maxContextMessages
fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify({
  api: { model: 'x' }, wakeDelayMs: 1500,
  store: { maxMessagesPerChat: 0, contextTier: 4, allCount: 77 },
  send: { maxPerMinute: 80 }, reply: { maxPerMinute: 3 }
}), 'utf8');
process.env.QQ_AGENT_DATA_DIR = DIR;
const { loadConfig, getConfig } = await load('core/config.js');
const c = loadConfig();
console.log('wakeDelayMs 保留用户值:', c.wakeDelayMs === 1500);
console.log('reply 回填:', JSON.stringify(c.reply));
console.log('compact 回填:', JSON.stringify(c.compact));
console.log('store.maxContextMessages 回填:', c.store.maxContextMessages);
console.log('store 旧档位已迁移为唯一滑条字段:', c.store.contextSliderPos === 95,
  !('contextTier' in c.store), !('randomPercent' in c.store));
console.log('旧四套历史深度已迁移为独立字段:', c.store.historyCount === 77,
  !('atCount' in c.store), !('keywordCount' in c.store), !('randomCount' in c.store), !('allCount' in c.store));
console.log('旧回复态频率并入统一上限:', c.send.maxPerMinute === 3, !('maxPerMinute' in c.reply));
fs.rmSync(DIR, { recursive: true, force: true });
