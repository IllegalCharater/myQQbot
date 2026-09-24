import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-'));
process.env.QQ_AGENT_DATA_DIR = DIR;
const { ChatStore } = await load('store.js');
const st = new ChatStore(0);
const key = 'group:1';
let seq = 0;
// 构造"头部堆满摘要"的场景：keepRecent 很小 + 摘要占满头部
for (let i = 0; i < 30; i++) { seq++; st.appendIncoming(key, { mid: seq, ts: 1700000000000 + seq * 1000, senderId: '200', senderName: 'U', text: `m${seq}` }); }
st.drainUnread(key);
// 手工插入 6 条摘要到头部
const st0 = st.recent(key, { limit: 1 });
console.log('keepRecent=0, cap=3 时头部全是摘要:', JSON.stringify(st.selectArchiveRange(key, { keepRecent: 0, maxMessages: 3 }).entries.map(m => m.id)));
console.log('keepRecent=25（只留最近25条，前5条可选）:', JSON.stringify(st.selectArchiveRange(key, { keepRecent: 25, maxMessages: 3 }).entries.map(m => m.id)));
console.log('keepRecent=30（无可压缩）:', JSON.stringify(st.selectArchiveRange(key, { keepRecent: 30, maxMessages: 3 }).entries.map(m => m.id)));
fs.rmSync(DIR, { recursive: true, force: true });
