// 存档层：追加日志（JSONL）而不是"每条消息重写整份 JSON"。
//
// 这条改动治的是**入站热路径上的同步全量写盘**：旧实现每收到一条消息就把整份存档
// （含全部历史与媒体数组）序列化一遍，写盘时间随历史长度线性增长，而它发生在
// OneBot 的回调里。换成追加日志后，一条消息 = 一行 append。
//
// 这里验的是**重放的确定性**：写入时对内存做了什么，换一个实例从日志读回来必须一模一样
// —— 追加日志最怕的就是"写入路径与重放路径对同一条 op 的理解不同"。
import fs from 'node:fs';
import path from 'node:path';
import { load } from './lib/src.mjs';
import { checker, dataDir } from './lib/harness.mjs';

const DIR = dataDir();
const { ChatStore } = await load('chat/store.js');
const { ok, done } = checker();

const MSG_DIR = path.join(DIR, 'messages');
const fileOf = (key) => path.join(MSG_DIR, `${String(key).replace(/[^a-z0-9_]/gi, '_')}.jsonl`);
const legacyOf = (key) => path.join(MSG_DIR, `${String(key).replace(/[^a-z0-9_]/gi, '_')}.json`);
const readLines = (key) => fs.readFileSync(fileOf(key), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const ids = (store, key) => store.recent(key, { limit: 10000 }).map((m) => m.id);
const texts = (store, key) => store.recent(key, { limit: 10000 }).map((m) => m.text);
const msg = (id, ts, sender, text, extra = {}) => ({
  id, mid: id, ts, senderId: '555', senderName: sender, text,
  self: false, read: false, reply: null, media: [], ...extra
});

console.log('=== 1. 一条消息 = 一行追加，而不是整份重写 ===');
{
  const K = 'group:700';
  const store = new ChatStore();
  ok('尚未写入时磁盘上没有文件', !fs.existsSync(fileOf(K)));

  store.appendIncoming(K, { mid: 1, ts: 1000, senderId: '555', senderName: '张三', text: '一' });
  const first = readLines(K);
  ok('新会话的第一笔写入是一行快照（保证第一行永远是快照）',
    first.length === 1 && first[0].t === 'snapshot', JSON.stringify(first.map((l) => l.t)));

  const snapshotLine = fs.readFileSync(fileOf(K), 'utf8').split('\n')[0];
  store.appendSelf(K, { text: '我回一句', ts: 2000, mid: 2 });
  const after = readLines(K);
  ok('后续消息只追加一行 add，旧行一个字节都不动（旧实现每次重写整份）',
    after.length === 2 && after[1].t === 'add'
    && fs.readFileSync(fileOf(K), 'utf8').split('\n')[0] === snapshotLine,
    JSON.stringify(after.map((l) => l.t)));

  const reload = new ChatStore();
  ok('换一个实例从日志重放出同样的消息与 nextLocalId',
    ids(reload, K).join(',') === '1,2' && texts(reload, K).join(',') === '一,我回一句'
    && reload.recent(K, { limit: 1 })[0].read === true,
    JSON.stringify(reload.recent(K, { limit: 10 })));
}

console.log('\n=== 2. read / set / insert / del 四种 op 都必须可重放 ===');
{
  const K = 'group:701';
  const store = new ChatStore();
  store.appendIncoming(K, { mid: 11, ts: 1000, senderId: '555', senderName: '张三', text: '一' });
  store.appendIncoming(K, { mid: 12, ts: 3000, senderId: '556', senderName: '李四', text: '二' });
  store.markRead(K, { ids: [1] });
  store.updateByLocalId(K, 2, { text: '二（改过）' });
  store.insertNote(K, { text: '插在中间的备注', ts: 2000 });
  store.deleteByLocalId(K, 2);

  const reload = new ChatStore();
  const got = reload.recent(K, { limit: 100 });
  ok('重放后的顺序与内容一致（insert 按 ts 找位置，不是追加到末尾）',
    got.map((m) => m.text).join('|') === '一|插在中间的备注', JSON.stringify(got.map((m) => m.text)));
  ok('read / set 的改动都在重放后保留',
    got.find((m) => m.id === 1)?.read === true && got.some((m) => m.kind === 'note'),
    JSON.stringify(got));
  const nextId = reload.appendIncoming(K, { mid: 13, ts: 4000, senderId: '555', senderName: '张三', text: '三' }).id;
  ok('重放出来的 nextLocalId 接着用（删掉的 id 不回收）', nextId === 4, String(nextId));
}

console.log('\n=== 3. maxMessagesPerChat 的裁剪也要落进日志 ===');
{
  const K = 'group:702';
  const store = new ChatStore(2);
  for (let i = 1; i <= 3; i++) {
    store.appendIncoming(K, { mid: i, ts: i * 1000, senderId: '555', senderName: '张三', text: `m${i}` });
  }
  ok('内存里只留最新两条', ids(store, K).join(',') === '2,3', ids(store, K).join(','));
  const reload = new ChatStore(2);
  ok('重放后同样只剩最新两条（裁剪写过 del op）', ids(reload, K).join(',') === '2,3', ids(reload, K).join(','));
}

console.log('\n=== 4. 旧版整份 JSON 自动迁移 ===');
{
  const K = 'group:703';
  fs.mkdirSync(MSG_DIR, { recursive: true });
  fs.writeFileSync(legacyOf(K), JSON.stringify({
    chatKey: K, nextLocalId: 4,
    messages: [msg(1, 1000, '张三', '旧一', { read: true }), msg(2, 2000, '李四', '旧二')]
  }), 'utf8');

  const store = new ChatStore();
  const got = store.recent(K, { limit: 10 });
  ok('旧存档能被读出来（消息与已读状态都在）',
    got.map((m) => m.text).join(',') === '旧一,旧二' && got[0].read === true, JSON.stringify(got));
  ok('迁移写出了新格式 .jsonl，且第一行是快照',
    fs.existsSync(fileOf(K)) && readLines(K)[0].t === 'snapshot');
  ok('旧文件改名保留（不删除）—— 留着原名的话删会话后它会把会话复活',
    !fs.existsSync(legacyOf(K)) && fs.existsSync(`${legacyOf(K)}.migrated.bak`));
  const reload = new ChatStore();
  ok('再换一个实例读到的是迁移后的新格式', ids(reload, K).join(',') === '1,2', ids(reload, K).join(','));
}

console.log('\n=== 5. 日志达到阈值后折叠成一行快照 ===');
{
  const K = 'group:704';
  const store = new ChatStore();
  for (let i = 1; i <= 1005; i++) {
    store.appendIncoming(K, { mid: i, ts: i, senderId: '555', senderName: '张三', text: `m${i}` });
  }
  const lines = readLines(K);
  ok('折叠发生过：文件里是「一行快照 + 少量 op」而不是 1006 行',
    lines[0].t === 'snapshot' && lines.length <= 6, `lines=${lines.length}`);
  const reload = new ChatStore();
  ok('折叠后重放仍是完整的 1005 条，一条不多一条不少',
    reload.recent(K, { limit: 10000 }).length === 1005, String(reload.recent(K, { limit: 10000 }).length));
}

console.log('\n=== 6. 半截行不能毒死整份存档 ===');
{
  const K = 'group:705';
  const store = new ChatStore();
  store.appendIncoming(K, { mid: 1, ts: 1000, senderId: '555', senderName: '张三', text: '一' });
  store.appendIncoming(K, { mid: 2, ts: 2000, senderId: '555', senderName: '张三', text: '二' });
  // 模拟"进程在 append 中途被杀"：最后一行只写了一半。
  fs.appendFileSync(fileOf(K), '{"t":"add","msg":{"id":99', 'utf8');
  const reload = new ChatStore();
  ok('坏行被跳过，前面的消息照常读出来',
    reload.recent(K, { limit: 10 }).map((m) => m.text).join(',') === '一,二',
    JSON.stringify(reload.recent(K, { limit: 10 }).map((m) => m.text)));
}

console.log('\n=== 7. 删除语义没变：删空删文件、removeChat 连带冷归档 ===');
{
  const D = 'group:706';
  const store = new ChatStore();
  const only = store.appendIncoming(D, { mid: 1, ts: 1000, senderId: '555', senderName: '张三', text: '唯一一条' });
  const dropped = store.deleteByLocalId(D, only.id);
  ok('删到一条不剩 → 整份存档文件一起删（不留空壳）',
    dropped?.chatDropped === true && !fs.existsSync(fileOf(D)), JSON.stringify(dropped));
  ok('删干净之后 listChats 不再列出它',
    !store.listChats().includes(D), JSON.stringify(store.listChats()));

  const R = 'group:707';
  store.appendIncoming(R, { mid: 2, ts: 1000, senderId: '555', senderName: '张三', text: '要删的' });
  const archive = path.join(MSG_DIR, 'archive', 'group_707.jsonl');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, '{"kind":"archive"}\n', 'utf8');
  const removed = store.removeChat(R);
  ok('removeChat 把主存档与冷归档一起删掉，并留了备份',
    !fs.existsSync(fileOf(R)) && !fs.existsSync(archive)
    && !!removed.backup && removed.backup.endsWith('.jsonl.removed.bak'),
    JSON.stringify(removed));
}

console.log('\n=== 8. 面板备份用的是新扩展名 ===');
{
  const K = 'group:708';
  const store = new ChatStore();
  store.appendIncoming(K, { mid: 1, ts: 1000, senderId: '555', senderName: '张三', text: '一' });
  store.appendIncoming(K, { mid: 2, ts: 2000, senderId: '555', senderName: '张三', text: '二' });
  const del = store.deleteByLocalId(K, 1);
  ok('单条删除的备份是 .jsonl.panel.bak',
    !!del?.backup && del.backup.endsWith('.jsonl.panel.bak') && fs.existsSync(del.backup), String(del?.backup));
}

process.exit(done() ? 0 : 1);
