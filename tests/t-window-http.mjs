// 接口层探针：面板「标为已读」「恢复并丢弃积压」「删消息」现在都走窗口消费，
// 这里起真 app（createApp + 真 HTTP），确认存档镜像与窗口游标一致。
// 跑法：node tests/t-window-http.mjs（验的是 tsc 产物 dist/）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-winhttp-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
};

// 预置：group:123 有 3 条（1 条已读、2 条未读）；group:456 有 2 条未读
const write = (key, msgs) => {
  fs.mkdirSync(path.join(DIR, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'messages', key.replace(':', '_') + '.json'),
    JSON.stringify({ chatKey: key, nextLocalId: msgs.length + 1, messages: msgs }, null, 2));
};
const m = (id, text, read) => ({ id, mid: `m${id}`, ts: 1758600000000 + id * 1000, senderId: '1000' + id, senderName: `群友${id}`, text, self: false, read, reply: null, media: [] });
write('group:123', [m(1, '老消息', true), m(2, '没看的一', false), m(3, '没看的二', false)]);
write('group:456', [m(1, '另一个群一', false), m(2, '另一个群二', false)]);

const { createApp } = await load('app.js');
const core = createApp({ log() {} });
const port = await core.start();
const B = `http://127.0.0.1:${port}`;
const call = async (p, opts = {}) => {
  const r = await fetch(B + p, { headers: { 'content-type': 'application/json', 'x-console-token': 'dev-local-marker' }, ...opts });
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
  return { status: r.status, body };
};
const chats = async () => (await call('/api/chats')).body;

console.log('\n═══ 1. 面板「标为已读」真的推进游标 ═══');
{
  const before = await chats();
  const row = (before.chats || before.rows || before).find?.((c) => (c.chatKey || c.key) === 'group:123');
  ok('存档页显示未读 2', row && row.unread === 2, JSON.stringify(row));
  const r = await call('/api/chats/group_123/mark-read', { method: 'POST' });
  ok('POST mark-read 返回 200 且 marked=2', r.status === 200 && r.body?.marked === 2, JSON.stringify(r.body));
  const after = await chats();
  const row2 = (after.chats || after.rows || after).find?.((c) => (c.chatKey || c.key) === 'group:123');
  ok('存档未读归零', row2 && row2.unread === 0, JSON.stringify(row2));
  ok('窗口里也没有待处理的了', core.orchestrator.windows.pendingCount('group:123') === 0);
  ok('另一群不受影响（还是 2）', (await chats()).chats?.find?.((c) => c.chatKey === 'group:456')?.unread === 2);
}

console.log('\n═══ 2. 恢复运行并丢弃积压（DELETE /api/pause）═══');
{
  core.orchestrator.setPaused(true);
  const r = await call('/api/pause', { method: 'DELETE' });
  ok('返回 200 且未暂停', r.status === 200 && r.body?.paused === false, JSON.stringify(r.body));
  ok('只有还有未读的那个群被标记（group:456 → 2）', JSON.stringify(r.body?.marked) === '{"group:456":2}', JSON.stringify(r.body?.marked));
  ok('存档页全部归零', (await chats()).chats.every((c) => c.unread === 0));
  ok('窗口全部清空', ['group:123', 'group:456'].every((k) => core.orchestrator.windows.pendingCount(k) === 0));
}

console.log('\n═══ 3. 删消息时窗口跟着忘掉 ═══');
{
  const st = core.store;
  const e = st.appendIncoming('group:123', { mid: 99, ts: Date.now(), senderId: '10009', senderName: '群友9', text: '待删', media: [] });
  core.orchestrator.onIncoming('group:123', e);
  ok('新消息进了窗口', core.orchestrator.windows.pendingCount('group:123') === 1);
  const localId = st.recent('group:123', { limit: 5 }).find((x) => x.text === '待删').id;
  const r = await call(`/api/chats/group_123/messages/${localId}`, { method: 'DELETE' });
  ok('DELETE 消息返回 200', r.status === 200, JSON.stringify(r.body));
  ok('窗口里也没了', core.orchestrator.windows.pendingCount('group:123') === 0);
}

console.log('\n═══ 4. 走真实 ingest 的消息能被窗口接住（onIncoming 带条目）═══');
{
  // 直接调编排器的入站接口，模拟 app.js 里 ingest 的两处调用
  const st = core.store;
  const e = st.appendIncoming('group:123', { mid: 100, ts: Date.now(), senderId: '10010', senderName: '群友10', text: '新来的', media: [] });
  core.orchestrator.onIncoming('group:123', e);
  ok('窗口收到 1 条', core.orchestrator.windows.pendingCount('group:123') === 1);
  ok('存档未读也是 1（镜像一致）', st.unreadCount('group:123') === 1);
  ok('窗口 stats 里 capacity 跟着配置走', core.orchestrator.windows.stats('group:123').capacity === 0);
}

await core.stop?.();
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
fs.rmSync(DIR, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
