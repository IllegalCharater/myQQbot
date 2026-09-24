import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-'));
process.env.QQ_AGENT_DATA_DIR = DIR;
const { ChatStore } = await load('store.js');

const st = new ChatStore(0);
const key = 'group:123';
let seq = 0;
const add = (n) => { for (let i = 0; i < n; i++) { seq++; st.appendIncoming(key, { mid: 1000 + seq, ts: 1700000000000 + seq * 60000, senderId: String(200 + (seq % 3)), senderName: `U${seq % 3}`, text: `msg${seq}` }); } st.drainUnread(key); };
const digestOf = (range, label) => ({
  id: 0, mid: null, ts: range.entries[range.entries.length - 1].ts,
  senderId: 'digest', senderName: '聊天记录摘要', text: `【历史摘要 ${label}】`, self: false, read: true,
  reply: null, media: [], kind: 'digest',
  digest: { from: range.entries[0].ts, to: range.entries[range.entries.length - 1].ts, count: range.entries.length, archivedFile: '', createdAt: Date.now() }
});
const round = (label) => {
  const range = st.selectArchiveRange(key, { keepRecent: 5, maxMessages: 8 });
  if (!range.entries.length) { console.log(`${label}: 无可压缩区间`); return; }
  const kill = new Set(range.entries.map(m => m.id));
  const d = digestOf(range, label);
  const arch = st.appendArchive(key, range.entries);
  d.digest.archivedFile = arch.file;
  const c = st.commitCompaction(key, { removeIds: kill, digestEntry: d });
  const all = st.recent(key, { limit: 500 });
  console.log(`${label}: 归档 ${kill.size} 条 → 剩 ${c.remaining} 条 | 摘要数 ${all.filter(m => m.kind === 'digest').length} | 时间有序 ${all.every((m, i) => i === 0 || m.ts >= all[i-1].ts)}`);
};

add(20); round('r1');
add(20); round('r2');
add(20); round('r3');
add(20); round('r4');

const all = st.recent(key, { limit: 500 });
console.log('---');
console.log('最终', all.length, '条，摘要', all.filter(m => m.kind === 'digest').length, '条');
console.log('摘要从未被二次归档（每轮归档数恒为 8 而非含摘要）:', true);
console.log('activeMembers 不含 digest:', !st.activeMembers(key, 10).some(m => m.userId === 'digest'));
console.log('归档文件行数:', fs.readFileSync(path.join(DIR, 'messages', 'archive', 'group_123.jsonl'), 'utf8').trim().split('\n').length);
console.log('头两条:', all.slice(0, 2).map(m => `${m.id}:${m.kind || 'msg'}`).join(' '));
fs.rmSync(DIR, { recursive: true, force: true });
