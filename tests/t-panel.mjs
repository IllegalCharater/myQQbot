// 检查：压缩后，存档面板（GET /api/chats/<key>/messages）到底显示什么。
// 用一个本地假模型服务跑完整链路（真的走 HTTP 请求），再看接口返回。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-panel-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

// ── 假模型服务：把请求里的消息行数数出来，原样回一个合法摘要 ──
let lastSeen = 0;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let lines = 0;
    try {
      const j = JSON.parse(body);
      const user = (j.messages || []).find((m) => m.role === 'user');
      const content = String(user?.content ?? '');
      const m = /共 (\d+) 行/.exec(content);
      lines = Number(m?.[1] || 0);
    } catch { /* ignore */ }
    lastSeen = lines;
    const content = JSON.stringify({ summary: `【摘要】整理了 ${lines} 行群聊记录。`, seen: lines });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], model: 'stub-model' }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
console.log('假模型服务: http://127.0.0.1:' + PORT);

const { ChatStore } = await load('chat/store.js');
const { SessionRegistry } = await load('chat/sessions.js');
const { SendQueue } = await load('qq/sender.js');
const { Orchestrator } = await load('agent/runtime/orchestrator.js');
const { updateConfig } = await load('core/config.js');
const { createApp } = await load('web/app.js');

updateConfig({
  api: { baseUrl: `http://127.0.0.1:${PORT}/v1`, model: 'stub-model', apiKey: 'x', maxRounds: 1 },
  allow: { groups: [], private: [] }, allowAllWhenEmpty: true,
  persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextSliderPos: 95, historyCount: 80, maxContextMessages: 0 },
  reply: { maxWaitMs: 0, maxPerMinute: 0 },
  compact: { enabled: true, minMessagesToCompact: 10, keepRecentMessages: 5, maxMessagesPerRound: 400, maxContextChars: 24000 }
});

const store = new ChatStore(0);
const sessions = new SessionRegistry(0);
const memory = { formatForPrompt: () => '', members: () => [], consolidationState: () => ({ counts: {}, members: [], lastConsolidatedAt: 0 }), listChats: () => [] };
const stickers = { sync: async () => ({ entries: [] }) };
const onebot = { selfId: '999', selfNickname: '小鲸鱼', connected: true,
  sendText: async () => ({ message_id: 1 }), getGroupInfo: async () => ({ group_name: '测试群' }), call: async () => ({}) };
const sender = new SendQueue({ onebot, store });
// S10d 起 emit 必填：这个实例下面真的会走到 compactChat → emit，所以这里是 8 个构造点里
// 唯一一个"漏传就当场炸"的（其余 7 个静默拿到 undefined，只有被调用时才炸 —— 见 t-ports 第 1c 段）。
const orc = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit: () => {} });

const key = 'group:123';
const base = Date.now() - 1000 * 3600;
for (let i = 1; i <= 30; i++) {
  store.appendIncoming(key, { mid: i, ts: base + i * 1000, senderId: '555', senderName: '张三', text: `第${i}条消息` });
}
store.drainUnread(key);   // 全部置已读（真实运行跑完之后就是这个状态）

const show = (label) => {
  const all = store.recent(key, { limit: 100000 });
  console.log(`\n${label}：共 ${all.length} 条`);
  console.log('  ' + all.map((m) => `[${m.id}]${m.kind === 'digest' ? '摘要' : m.text}`).join(' → '));
};
show('压缩前');

console.log('\n── 执行压缩 ──');
const r = await orc.compactChat(key, { force: true });
console.log(JSON.stringify(r));
show('压缩后（store.recent，即面板数据源）');

// ── 再看真实 HTTP 接口返回（面板实际拿到的 JSON）──
const core = createApp({ log: () => {} });
// 把已经压好的 store 注入进去（同进程复用同一份数据目录，直接新建 app 即可读到磁盘）
const port = await core.start();
const j = await (await fetch(`http://127.0.0.1:${port}/api/chats/group_123/messages?limit=100000`)).json();
console.log(`\nGET /api/chats/group_123/messages → ${j.messages.length} 条`);
console.log('  ' + j.messages.map((m) => `[${m.id}]${m.kind === 'digest' ? '摘要(' + m.digest.count + '条)' : m.text}`).join(' → '));
const remaining = j.messages.filter((m) => m.kind !== 'digest');
console.log('\n检查：');
console.log('  已被压缩的 25 条（第1~25条）是否还在面板里：',
  remaining.some((m) => /第(\d+)条消息/.test(m.text) && Number(/第(\d+)条消息/.exec(m.text)[1]) <= 25) ? '❌ 还在' : '✅ 不在了');
console.log('  摘要条目是否存在：', j.messages.some((m) => m.kind === 'digest') ? '✅' : '❌');
console.log('  未压缩的新信息（第26~30条）是否都在：',
  [26, 27, 28, 29, 30].every((n) => remaining.some((m) => m.text === `第${n}条消息`)) ? '✅' : '❌');
console.log('  摘要位置（应为最老一行，即数组第 0 位）：', j.messages[0]?.kind === 'digest' ? '✅' : '❌ 在第 ' + j.messages.findIndex((m) => m.kind === 'digest') + ' 位');
console.log('  冷归档文件:');
for (const f of fs.readdirSync(path.join(DIR, 'messages', 'archive'))) {
  const txt = fs.readFileSync(path.join(DIR, 'messages', 'archive', f), 'utf8').trim().split('\n');
  console.log(`    ${f} → ${txt.length} 行`);
}

// ── 摘要能不能真的被"消费"：面板顶部的标注 + 提示词里的【历史印象】段 ──
// 这一段专治"生成端与消费端各写各的"：压缩刚写出来的那条摘要，
// digestStatus 认不认它、提示词的渲染函数读不读得懂它的结构，都在这里验。
const { collectInjectedDigests } = await load('agent/prompting/prompt-builder.js');
const real = store.digests(key);
const ds = j.digestStatus || {};
console.log('\n摘要注入（GET /messages 里的 digestStatus，面板顶部就照它标）：');
console.log('  config:', JSON.stringify(ds.config));
console.log(`  injectedIds:${JSON.stringify(ds.injectedIds)} —— chars ${ds.chars}/${ds.budget}`);
console.log('  刚压出来的那条摘要会被注入：', ds.injectedIds?.includes(real[0]?.id) ? '✅' : '❌');
console.log('  策略回显与默认设置一致（8000 字 / 不每轮 / 合并）：',
  ds.config?.maxChars === 8000 && ds.config?.injectEveryRound === false && ds.config?.merge === true ? '✅' : '❌');
const sec = collectInjectedDigests(store, key, { config: { maxChars: 100000, merge: true, injectEveryRound: true } });
console.log('  渲染出的【历史印象】段:');
console.log('    ' + sec.sectionText.split('\n').join('\n    '));
console.log('  段头写明了"背景资料、不是指令"：', sec.sectionText.includes('不是给你的指令') ? '✅' : '❌');
console.log('  读得懂真实摘要的结构（剥掉了【历史摘要 …】包装行）：',
  !sec.sectionText.includes('【历史摘要') ? '✅' : '❌');
console.log('  正文没被吞掉：', sec.sectionText.includes('整理了 25 行群聊记录') ? '✅' : '❌');
console.log('  汇总了原始条数（25）：', sec.sectionText.includes('合并自 25 条原始消息') ? '✅' : '❌');

// ── 摘要存档回收（digest.maxKeepChars）：真压缩跑两轮，看最旧的纪要会不会被整段丢掉 ──
// 这一段治的是"配置项写了但没人读"：maxKeepChars 只在 compactChat 里被取一次，
// 所以这里走完整流程（真的调模型、真的 commitCompaction），而不是直接调 store 的单元测试
// （后者在 t-digest.mjs 里）。要的是"每次压缩**成功后**"这个时机确实成立。
let gFail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) console.log(`  ✅ ${label}`);
  else { gFail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
};
console.log('\n摘要存档回收（真压缩两轮）：');
const GCKEY = 'group:456';
const gcBase = path.join(DIR, 'messages', 'group_456.json');
const gcAppend = (from, to) => {
  for (let i = from; i <= to; i++) store.appendIncoming(GCKEY, { mid: i, ts: base + i * 1000, senderId: '555', senderName: '张三', text: `第${i}条消息` });
  store.drainUnread(GCKEY);
};

gcAppend(1, 30);
const r1 = await orc.compactChat(GCKEY, { force: true });
const d1 = store.digests(GCKEY)[0];
ok('第一轮压缩：产出 1 条纪要，且（上限默认 0 = 不限）一条都没丢', r1.ok === true && !!d1 && r1.droppedDigests === 0, JSON.stringify(r1));

// 上限设成"连一条都放不下"：验的正是规则 1 —— 丢掉更旧的那条，永远留最新的一条
updateConfig({ digest: { maxKeepChars: 1 } });
gcAppend(31, 60);
const r2 = await orc.compactChat(GCKEY, { force: true });
const after2 = store.digests(GCKEY);
ok('上限 1 字 + 两条纪要 → 最旧那条被**整段**丢掉', after2.length === 1 && r2.droppedDigests === 1, JSON.stringify({ n: after2.length, dropped: r2.droppedDigests }));
ok('留下的是**最新**的那条（绝不是新的先没）', after2[0] && after2[0].id !== d1.id && after2[0].digest.from > d1.digest.from, JSON.stringify({ kept: after2[0]?.id, d1: d1.id }));
ok('回执里说清了丢了几条（面板/日志要能看见，不能静默删数据）',
  r2.note.includes('摘要存档超出上限') && r2.note.includes('丢弃了最旧的 1 条'), r2.note);
// 两个备份各用各的名字：压缩的回滚点是 `<文件>.bak`（store.backupChatFile），
// 回收用的是 `<文件>.digestgc.bak`（backupChatFileTo 带 tag）—— 名字写错就等于没验。
ok('备份用独立后缀，压缩回滚点没被回收冲掉（.digestgc.bak vs .bak 同时都在）',
  fs.existsSync(gcBase + '.digestgc.bak') && fs.existsSync(gcBase + '.bak'),
  `digestgc=${fs.existsSync(gcBase + '.digestgc.bak')} compress=${fs.existsSync(gcBase + '.bak')}`);

// 面板那一侧（接口返回的 JSON = 存档页真正读到的东西）
const j2 = await (await fetch(`http://127.0.0.1:${port}/api/chats/group_456/messages?limit=100000`)).json();
ok('被丢的那条在存档里真没了', !j2.messages.some((m) => m.id === d1.id));
ok('最新那条还在', j2.messages.some((m) => m.id === after2[0].id));
ok('digestStatus 回显了回收上限（存档页顶部就照它写"上限 N 字"）', j2.digestStatus?.config?.maxKeepChars === 1, JSON.stringify(j2.digestStatus?.config));
ok('被丢的那条**不**出现在 droppedIds 里（它已经不在存档，不是"没进预算"）',
  !(j2.digestStatus?.droppedIds || []).includes(d1.id));

// 对照：上限 0 = 不限 → 再压一轮，旧的照样都在（证明上面那次丢的是"上限"干的，不是压缩自带的）
updateConfig({ digest: { maxKeepChars: 0 } });
gcAppend(61, 90);
const r3 = await orc.compactChat(GCKEY, { force: true });
ok('对照：上限 0 = 不限，又压一轮、又多一条纪要，旧的仍然都在',
  r3.ok === true && r3.droppedDigests === 0 && store.digests(GCKEY).length === 2, JSON.stringify({ ok: r3.ok, dropped: r3.droppedDigests, n: store.digests(GCKEY).length }));
ok('对照的回执里没有"丢弃"字样', !r3.note.includes('丢弃'), r3.note);

// ── 管理端的三处删除 + 两处存储上限 ──
//
// 这四项都是"删数据"的入口，所以断言的重点不只是"删掉了"，还有两条容易漏的：
//   · **删干净**：存档的冷归档（archive/）也必须一起没 —— 只删主文件的话，历史压缩后的
//     原文还在磁盘上，而界面上看不到它，用户会以为删干净了；
//   · **删得掉是因为真的落盘了**：内存里那份缓存不摘掉的话，下一次写入会把文件原样写回来。
console.log('\n管理端删除与存储上限：');

// ① ChatStore.removeChat：存档 + 冷归档一起走，且留备份
const DELKEY = 'group:789';
const delBase = path.join(DIR, 'messages', 'group_789.json');
const delArchive = path.join(DIR, 'messages', 'archive', 'group_789.jsonl');
for (let i = 1; i <= 5; i++) {
  store.appendIncoming(DELKEY, { mid: 900 + i, ts: base + i * 1000, senderId: '555', senderName: '张三', text: `待删${i}` });
}
// 冷归档是压缩产出的；这里直接造一个，验的就是"删存档时它会不会被漏掉"
fs.mkdirSync(path.dirname(delArchive), { recursive: true });
fs.writeFileSync(delArchive, '{"kind":"archive"}\n', 'utf8');
ok('前置：存档与冷归档都真的在磁盘上', fs.existsSync(delBase) && fs.existsSync(delArchive));
const delResult = store.removeChat(DELKEY);
ok('removeChat 把主存档删掉了', !fs.existsSync(delBase), `still=${fs.existsSync(delBase)}`);
ok('removeChat 把**冷归档**也删掉了（只删主文件的话原文会留在磁盘上）',
  !fs.existsSync(delArchive), `archive still=${fs.existsSync(delArchive)}`);
ok('删除前留了备份（这是唯一一个一次抹掉整段历史的入口）',
  !!delResult.backup && fs.existsSync(delResult.backup), JSON.stringify(delResult));
ok('删完内存里的缓存也摘了（不摘的话下一次写入会把文件原样写回来）',
  !store.chats.has(DELKEY) && store.getChatMeta(DELKEY).total === 0,
  `cached=${store.chats.has(DELKEY)} total=${store.getChatMeta(DELKEY).total}`);

// ② DELETE /api/chats/<key>：HTTP 那一条
const HTTPDEL = 'group:790';
for (let i = 1; i <= 3; i++) {
  store.appendIncoming(HTTPDEL, { mid: 800 + i, ts: base + i * 1000, senderId: '555', senderName: '张三', text: `HTTP待删${i}` });
}
const httpDelFile = path.join(DIR, 'messages', 'group_790.json');
ok('前置：HTTP 删除目标的存档在磁盘上', fs.existsSync(httpDelFile));
const httpDel = await (await fetch(`http://127.0.0.1:${port}/api/chats/group_790`, { method: 'DELETE' })).json();
ok('DELETE /api/chats/<key> 回报删掉的条数与剩余 0',
  httpDel.ok === true && httpDel.removedMessages >= 3 && httpDel.remaining === 0, JSON.stringify(httpDel));
ok('DELETE /api/chats/<key> 真的把文件删了', !fs.existsSync(httpDelFile));

// ③ 会话记录：单条删除 + keepFiles 上限
const { SessionRegistry: SR } = await load('chat/sessions.js');
const sdir = path.join(DIR, 'sessions');
fs.mkdirSync(sdir, { recursive: true });
// 文件名前缀是 base36 时间戳，sort() 即时间序 —— 上限逻辑按它丢最老的，这里照同一约定造。
for (const [id, label] of [['aaa-1', '最老'], ['bbb-2', '中间'], ['ccc-3', '最新']]) {
  fs.writeFileSync(path.join(sdir, `${id}.json`),
    JSON.stringify({ id, chatKey: 'group:123', startedAt: base, endedAt: base, status: 'done', usage: {} }), 'utf8');
  void label;
}
const srDel = new SR(0);
srDel.index = [{ id: 'aaa-1' }, { id: 'bbb-2' }, { id: 'ccc-3' }];
const removed = srDel.remove('bbb-2');
ok('SessionsRegistry.remove 删掉了指定会话（文件 + 索引都掉了）',
  removed.ok === true && !fs.existsSync(path.join(sdir, 'bbb-2.json')) && !srDel.index.some((e) => e.id === 'bbb-2'),
  JSON.stringify({ removed, files: fs.readdirSync(sdir) }));
ok('remove 不动别的会话', fs.existsSync(path.join(sdir, 'aaa-1.json')) && fs.existsSync(path.join(sdir, 'ccc-3.json')));
// 运行中的会话必须拒绝：它还在写这个文件，删掉会被收尾时的持久化原样写回来
const srRun = new SR(0);
srRun.current.set('run-1', { id: 'run-1', status: 'running', usage: {} });
fs.writeFileSync(path.join(sdir, 'run-1.json'), '{}', 'utf8');
const refused = srRun.remove('run-1');
ok('运行中的会话拒绝删除，并说明原因（否而删了会立刻被收尾写回来）',
  refused.ok === false && String(refused.reason).includes('正在运行') && fs.existsSync(path.join(sdir, 'run-1.json')),
  JSON.stringify(refused));

const srCap = new SR(2);
// ⚠️ 上限的清理**只发生在 finish() 里**（`get()` 只裁内存索引，不动磁盘）——
// 所以这里必须把会话跑一遍 create→finish，而不是直接摆几个文件再 get()：
// 后者验的是"我以为的清理时机"，不是代码里那个时机（本套件初版就这么假红了一条）。
// 也不自己改 id：`#persist` 按 `s.id` 落盘，改了 id 就与索引对不上。
// 真 id 是 `<base36 时间戳>-<随机>`，连续 create 即时间序，正好是清理逻辑依赖的顺序。
const capIds = [];
for (let i = 0; i < 3; i++) {
  const s = srCap.create({ chatKey: 'group:999', trigger: 'probe', triggerSummary: 'x' });
  capIds.push(s.id);
  srCap.finish(s.id, 'done');
}
const left = fs.readdirSync(sdir).filter((f) => f.endsWith('.json')).sort();
ok('keepFiles=2 时 finish 会把最老的会话文件清掉、只留最新 2 个',
  left.length === 2 && !left.includes(`${capIds[0]}.json`) && left.includes(`${capIds[2]}.json`),
  `left=${JSON.stringify(left)} 期望保留 ${capIds[2]}、删掉 ${capIds[0]}`);

// ④ DELETE /api/sessions/<id>
const httpSessionId = 'ddd-4';
fs.writeFileSync(path.join(sdir, `${httpSessionId}.json`),
  JSON.stringify({ id: httpSessionId, chatKey: 'group:123', startedAt: base, endedAt: base, status: 'done', usage: {} }), 'utf8');
const sDel = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${httpSessionId}`, { method: 'DELETE' })).json();
ok('DELETE /api/sessions/<id> 删掉了会话文件', sDel.ok === true && !fs.existsSync(path.join(sdir, `${httpSessionId}.json`)), JSON.stringify(sDel));
ok('删不存在的会话不会报错（重复点两次不该红）',
  (await fetch(`http://127.0.0.1:${port}/api/sessions/no-such-id`, { method: 'DELETE' })).status === 200);

// ⑤ DELETE /api/memory-files/<key>：整个会话的记忆
const MEMKEY = 'group:791';
const memDir = path.join(DIR, 'memory', 'group_791');
fs.mkdirSync(memDir, { recursive: true });
fs.writeFileSync(path.join(memDir, '10001.json'), JSON.stringify({ userId: '10001', name: '甲', impressions: [{ content: 'a', createdAt: base }] }), 'utf8');
fs.writeFileSync(path.join(memDir, '10002.json'), JSON.stringify({ userId: '10002', name: '乙', impressions: [{ content: 'b', createdAt: base }] }), 'utf8');
const memDel = await (await fetch(`http://127.0.0.1:${port}/api/memory-files/group_791`, { method: 'DELETE' })).json();
ok('DELETE /api/memory-files/<key> 回报删掉的成员数', memDel.ok === true && memDel.removedMembers === 2, JSON.stringify(memDel));
// 整会话删除要连**目录**一起清掉：只清成员文件、留着空目录的话 `listChats()`（扫目录）
// 会继续列出它，用户删完发现那条还在、以为没删干净。
ok('整会话记忆删除把目录也清掉了（留空目录的话列表里那条会一直在）',
  !fs.existsSync(memDir), `目录仍存在：${fs.existsSync(memDir)}`);
// 成员级删除（既有能力）不能被整会话那条路由吞掉 —— 两条正则的区分就在这里
const memDir2 = path.join(DIR, 'memory', 'group_792');
fs.mkdirSync(memDir2, { recursive: true });
fs.writeFileSync(path.join(memDir2, '20001.json'), JSON.stringify({ userId: '20001', name: '丙', impressions: [{ content: 'c', createdAt: base }] }), 'utf8');
const oneDel = await (await fetch(`http://127.0.0.1:${port}/api/memory-files/group_792/members/20001`, { method: 'DELETE' })).json();
ok('成员级删除仍然走它自己那条路由（没被整会话删除抢走）',
  oneDel.ok === true && !fs.existsSync(path.join(memDir2, '20001.json')), JSON.stringify(oneDel));

// ⑥ 删到一条不剩 → 整份存档文件一起删掉（用户明确要求）
//
// 判据是"这个会话在磁盘上还在不在"，不是"messages 数组空不空" ——
// 留个空文件的话 `listChats()`（扫文件名）会继续列出它，存档页上就多出一个
// "看似有、点开全空"的条目。
const DROPKEY = 'group:793';
const dropFile = path.join(DIR, 'messages', 'group_793.json');
store.appendIncoming(DROPKEY, { mid: 7001, ts: base, senderId: '555', senderName: '张三', text: '唯一一条' });
store.drainUnread(DROPKEY);
const oneMsg = store.recent(DROPKEY, { limit: 10 })[0];
ok('前置：这个会话只有一条消息、文件在磁盘上', !!oneMsg && fs.existsSync(dropFile));
const dropOne = await (await fetch(`http://127.0.0.1:${port}/api/chats/group_793/messages/${oneMsg.id}`, { method: 'DELETE' })).json();
ok('删掉最后一条消息时，整份存档文件一起被删（不留空壳）',
  dropOne.ok === true && !fs.existsSync(dropFile), JSON.stringify({ resp: dropOne, exists: fs.existsSync(dropFile) }));
ok('响应里点明这次把整份存档删掉了（界面要能说清发生了什么）',
  dropOne.chatDropped === true, JSON.stringify(dropOne));
// **必须再列一次列表**（只验"文件没了"是不够的，本套件初版就漏了这条而放过一个真 bug）：
// `#state()` 是"读不到就建个空对象放进缓存"的语义，所以删除之后任何一次碰这个会话
// （`reloadWindow` 的播种、`getChatMeta`、`recentIncoming`……）都会在缓存里重建出一个
// **没有文件**的对象；照着缓存列的话，删干净的会话会一直挂在存档列表里、点开却是空的。
// 文件才是权威，`listChats()` 现在按它过滤。
const chatsAfterDrop = (await (await fetch(`http://127.0.0.1:${port}/api/chats`)).json()).chats.map((c) => c.key);
ok('删干净之后，存档列表里不再列出它（缓存里的空对象不算"存在"）',
  !chatsAfterDrop.includes(DROPKEY), JSON.stringify(chatsAfterDrop));

// 对照：还有别的消息时**不能**删文件 —— 否则删一条就等于清空整个会话
const KEEPKEY = 'group:794';
const keepFile = path.join(DIR, 'messages', 'group_794.json');
for (let i = 1; i <= 3; i++) store.appendIncoming(KEEPKEY, { mid: 7100 + i, ts: base + i, senderId: '555', senderName: '张三', text: `留${i}` });
store.drainUnread(KEEPKEY);
const keepFirst = store.recent(KEEPKEY, { limit: 10 })[0];
const keepOne = await (await fetch(`http://127.0.0.1:${port}/api/chats/group_794/messages/${keepFirst.id}`, { method: 'DELETE' })).json();
// ⚠️ 这里必须**读盘**校验，不能查本套件那个 `store` 实例：管理端走的是 app 自己的
// ChatStore（另一个实例，有自己的内存缓存），而本套件的实例还留着删之前的 3 条。
// 查实例会拿到过期的 3（本套件初版就这么假红了一条）。
const keepOnDisk = JSON.parse(fs.readFileSync(keepFile, 'utf8')).messages.length;
ok('对照：还有别的消息时存档文件保留（删一条不等于清空整个会话）',
  keepOne.ok === true && fs.existsSync(keepFile) && keepOnDisk === 2 && keepOne.remaining === 2,
  JSON.stringify({ exists: fs.existsSync(keepFile), onDisk: keepOnDisk, remaining: keepOne.remaining }));

// ⑦ 新建会话：一次建出空存档与空记忆，且能出现在两个列表里
const NEWKEY = 'private:556677';
const newArchive = path.join(DIR, 'messages', 'private_556677.json');
const newMemDir = path.join(DIR, 'memory', 'private_556677');
const made = await (await fetch(`http://127.0.0.1:${port}/api/chats/private_556677`, { method: 'POST', body: '{}' })).json();
ok('POST /api/chats/<key> 同时建出空存档与空记忆（只建一份的话另一个页签里找不到它）',
  made.ok === true && made.archiveCreated === true && made.memoryCreated === true, JSON.stringify(made));
ok('空存档文件真的落到磁盘上了', fs.existsSync(newArchive), `exists=${fs.existsSync(newArchive)}`);
ok('空记忆目录真的落到磁盘上了', fs.existsSync(newMemDir), `exists=${fs.existsSync(newMemDir)}`);
ok('新建的会话出现在**两个**列表接口里（列表是扫磁盘还原的，没落盘就不可能出现）',
  (await (await fetch(`http://127.0.0.1:${port}/api/chats`)).json()).chats.some((c) => c.key === NEWKEY)
  && (await (await fetch(`http://127.0.0.1:${port}/api/memory-files`)).json()).files.some((f) => f.chatKey === NEWKEY),
  '两个列表里至少有一个没出现');
// 幂等：再建一次不覆盖已有内容
store.appendIncoming(NEWKEY, { mid: 7201, ts: base, senderId: '556677', senderName: '甲', text: '我先加一条' });
store.drainUnread(NEWKEY);
const again = await (await fetch(`http://127.0.0.1:${port}/api/chats/private_556677`, { method: 'POST', body: '{}' })).json();
ok('重复创建是幂等的：回报都没新建，且已有内容没被清掉',
  again.archiveCreated === false && again.memoryCreated === false && store.getChatMeta(NEWKEY).total === 1,
  JSON.stringify({ again, total: store.getChatMeta(NEWKEY).total }));
// 非法键必须被拒：这个入口会把值拼进文件名，不能任由调用方决定路径
const badKey = await (await fetch(`http://127.0.0.1:${port}/api/chats/group_abc`, { method: 'POST', body: '{}' })).json();
ok('非数字号码被拒（路由正则本身就不匹配）', badKey.ok !== true, JSON.stringify(badKey));

core.stop(); srv.close();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n════ 新增断言：通过 ${gFail === 0 ? '全部' : '有失败'} / 失败 ${gFail} ════`);
process.exit(gFail === 0 ? 0 : 1);
