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

const { ChatStore } = await load('store.js');
const { SessionRegistry } = await load('sessions.js');
const { SendQueue } = await load('sender.js');
const { Orchestrator } = await load('orchestrator.js');
const { updateConfig } = await load('config.js');
const { createApp } = await load('app.js');

updateConfig({
  api: { baseUrl: `http://127.0.0.1:${PORT}/v1`, model: 'stub-model', apiKey: 'x', maxRounds: 1 },
  allow: { groups: [], private: [] }, allowAllWhenEmpty: true,
  persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextTier: 4, maxContextMessages: 0 },
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
const orc = new Orchestrator({ store, memory, stickers, sender, sessions, onebot });

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
const { collectInjectedDigests } = await load('prompt.js');
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

core.stop(); srv.close();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n════ 新增断言：通过 ${gFail === 0 ? '全部' : '有失败'} / 失败 ${gFail} ════`);
process.exit(gFail === 0 ? 0 : 1);
