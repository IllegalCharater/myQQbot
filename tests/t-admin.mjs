// 面板管理端（表情包 + 存档 + 记忆）的增删改查测试。
//
// 分两段：
//  A. 纯函数 / store 层 —— 直接 import，验证"删错的代价"这些不可见的约束
//     （备份文件名、nextLocalId 不回退、note 不进未读/不进活跃成员）。
//  B. 接口层 —— 起**真 app**（createApp）再 fetch，验证路由接线与状态码。
//     和 t-panel.mjs 同一套路：预先把数据文件写进临时 QQ_AGENT_DATA_DIR，再起服务。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-admin-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

const { ChatStore, isSystemRecord } = await load('store.js');
const { MemoryStore } = await load('memory.js');
const { StickerManager } = await load('sticker-manager.js');
const { removeSticker, formatStickerAdminList } = await load('stickers.js');
const { buildPastState } = await load('prompt.js');
const { updateConfig, getConfig } = await load('config.js');

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`);

updateConfig({
  api: { baseUrl: 'http://127.0.0.1:1/v1', model: 'stub', apiKey: 'x', maxRounds: 1 },
  allow: { groups: [], private: [] }, allowAllWhenEmpty: true,
  persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  store: { contextTier: 4, maxContextMessages: 0, maxMessagesPerChat: 0 },
  reply: { maxWaitMs: 0, maxPerMinute: 0 },
  sticker: { enabled: true, collectEnabled: true, maxCollectPerHour: 10, promptMaxStickers: 10 },
  security: { allowPrivateImageHosts: false }
});

// ════════════════════════════════════════════════════════════════════
console.log('\n═══ A. ChatStore：改 / 删 / 插备注 ═══');
const store = new ChatStore(0);
const K = 'group:100';
for (let i = 1; i <= 5; i++) {
  store.appendIncoming(K, { mid: 900 + i, ts: 1000 + i, senderId: '555', senderName: '张三', text: `第${i}条` });
}
const before = store.findByLocalId(K, 3);
const beforeJson = JSON.stringify(before);

// ── 改文本：只动 text ──
const edited = store.updateByLocalId(K, 3, { text: '改过的第三条' });
ok('updateByLocalId 改到文本', edited.text === '改过的第三条');
ok('updateByLocalId 只动 text（senderId/ts/mid/read/self/id 全不变）', (() => {
  const a = { ...beforeJson && JSON.parse(beforeJson), text: '改过的第三条' };
  const b = { ...edited, updatedAt: undefined };
  delete a.updatedAt; delete b.updatedAt;
  return JSON.stringify({ ...a }) === JSON.stringify({ ...b });
})(), JSON.stringify(edited));
eq('updateByLocalId 找不到返回 null', store.updateByLocalId(K, 999, { text: 'x' }), null);

// ── 删一条：备份文件名不能冲掉压缩的回滚点 ──
const del = store.deleteByLocalId(K, 3);
ok('deleteByLocalId 返回被删条目', del?.removed?.id === 3);
eq('剩余 id 原样（1,2,4,5）', store.recent(K, { limit: 100 }).map((m) => m.id), [1, 2, 4, 5]);
ok('生成了 .panel.bak', !!del.backup && fs.existsSync(del.backup) && del.backup.endsWith('.panel.bak'), del.backup);
ok('**没有**生成压缩用的 .json.bak（回滚点未被冲掉）', !fs.existsSync(path.join(DIR, 'messages', 'group_100.json.bak')));
eq('删除不存在的 id 返回 null', store.deleteByLocalId(K, 999), null);

// ── id 绝不回收 ──
const next = store.appendIncoming(K, { mid: 999, ts: 2000, senderId: '555', senderName: '张三', text: '新消息' });
ok('nextLocalId 不回退（新消息 id = 6，不复用被删的 3）', next.id === 6, `得到 ${next.id}`);

// ── 插备注 ──
const note = store.insertNote(K, { text: '这里是人工更正', ts: 1900 });
ok("insertNote kind === 'note'", note.kind === 'note');
ok('insertNote read === true（不会变成一次唤醒的触发批）', note.read === true);
ok('insertNote mid === null（拿不到 #id，模型无法引用它）', note.mid === null);
ok('insertNote 按 ts 落位（1900 排在 ts=2000 的"新消息"之前）', (() => {
  const all = store.recent(K, { limit: 100 });
  return all.findIndex((m) => m.kind === 'note') === all.findIndex((m) => m.text === '新消息') - 1;
})());
eq('备注不被 drainUnread 取走', store.drainUnread(K).filter((m) => m.kind === 'note').length, 0);
eq('备注不在 activeMembers 里（否则会多出一个幽灵成员）', store.activeMembers(K, 20).filter((m) => m.userId === '' || m.name === '').length, 0);
eq('备注不被 selectArchiveRange 当成压缩候选', store.selectArchiveRange(K, { keepRecent: 0, maxMessages: 100 }).entries.filter((m) => m.kind === 'note').length, 0);
ok('isSystemRecord 认 note 与 digest', isSystemRecord({ kind: 'note' }) && isSystemRecord({ kind: 'digest' }) && !isSystemRecord({}));
ok('备注仍在 recent 里（模型读得到）', store.recent(K, { limit: 100 }).some((m) => m.kind === 'note'));

// ── 渲染：不能读成"群里一个没名字的人" ──
const ps = buildPastState(store, K, { limit: 50 });
const noteLine = String(ps.text || ps).split('\n').find((l) => l.includes('人工更正')) || '';
ok('提示词里备注渲染成【人工备注】', noteLine.includes('【人工备注】'), noteLine);
ok('提示词里备注不套"某人："（不冒充群友）', !noteLine.includes('：', noteLine.indexOf('】')), noteLine);

// ════════════════════════════════════════════════════════════════════
console.log('\n═══ B. MemoryStore：单条印象改 / 删 ═══');
const memory = new MemoryStore();
const MK = 'group:100';
memory.append(MK, 'memberImpression', '喜欢猫', { userId: '777', target: '小明' });
memory.append(MK, 'memberImpression', '话很多', { userId: '777', target: '小明' });
const orig = memory.getMember(MK, '777');
const catAt = orig.impressions.find((e) => e.content === '喜欢猫').createdAt;

const upd = memory.updateImpression(MK, { userId: '777', content: '喜欢猫', next: '非常喜欢猫' });
ok('updateImpression 改到内容', !!upd && upd.impressions.some((e) => e.content === '非常喜欢猫'));
ok('updateImpression 保留 createdAt（时间线不能丢）', upd.impressions.find((e) => e.content === '非常喜欢猫').createdAt === catAt, `${upd.impressions[0].createdAt} vs ${catAt}`);
ok('updateImpression 未碰同成员的其它条目', upd.impressions.some((e) => e.content === '话很多'));
ok('updateImpression 落了盘', JSON.parse(fs.readFileSync(path.join(DIR, 'memory', 'group_100', '777.json'), 'utf8')).impressions.some((e) => e.content === '非常喜欢猫'));

let dupErr = '';
try { memory.updateImpression(MK, { userId: '777', content: '非常喜欢猫', next: '话很多' }); } catch (e) { dupErr = e.message; }
ok('改成与其它条目重复 → 抛错（不能静默合并成两条一样的）', dupErr.includes('重复'), dupErr);
eq('updateImpression 改不存在的内容 → null', memory.updateImpression(MK, { userId: '777', content: '没这条', next: 'x' }), null);
eq('updateImpression 缺少 userId 与 target → 抛错', (() => { try { memory.updateImpression(MK, { content: 'a', next: 'b' }); return 'no-throw'; } catch { return 'throw'; } })(), 'throw');

// 无 QQ 号的旧成员只能按名字寻址
memory.append(MK, 'memberImpression', '匿名的一条', { target: '某路人' });
const anon = memory.updateImpression(MK, { target: '某路人', content: '匿名的一条', next: '匿名改过的' });
ok('updateImpression 可按 target（无 QQ 号成员）寻址', !!anon && anon.impressions.some((e) => e.content === '匿名改过的'));

const removedOk = memory.remove(MK, 'memberImpression', { userId: '777', content: '话很多' });
ok('remove 单条印象成功', removedOk === true);
ok('remove 掉最后一条时连成员文件一起删（面板要如实告知）', (() => {
  memory.remove(MK, 'memberImpression', { userId: '777', content: '非常喜欢猫' });
  return !fs.existsSync(path.join(DIR, 'memory', 'group_100', '777.json'));
})());

// ════════════════════════════════════════════════════════════════════
console.log('\n═══ C. 表情库：纯函数（删除只认 id，不按标签猜） ═══');
const LIB = [
  { id: 'sticker_qq1', url: 'https://example.com/a.png', desc: '猫猫', localNote: '常用', tags: ['可爱'], source: 'qq' },
  { id: 'sticker_ai1', url: 'https://example.com/b.png', desc: '偷来的', localNote: '', tags: [], source: 'ai' },
  { id: 'sticker_nine', url: 'https://example.com/c.png', desc: '9', source: 'qq' },
  { id: 'sticker_nine2', url: 'https://example.com/d.png', desc: '9', source: 'ai' }
];
const r1 = removeSticker(LIB, 'sticker_ai1');
ok('removeSticker 按 id 删掉 ai 来源', r1.removed?.id === 'sticker_ai1' && !r1.entries.some((e) => e.id === 'sticker_ai1'));
eq('removeSticker 不按备注名兜底（"偷来的"不命中）', removeSticker(LIB, '偷来的').removed, null);
eq('removeSticker 撞车标签不命中（"9" 对应两条 → 宁可失败也不猜）', removeSticker(LIB, '9').removed, null);
ok('removeSticker 没改动输入的数组', LIB.length === 4);

const adminList = formatStickerAdminList(LIB, '', 100);
ok('formatStickerAdminList 带上 url / usage / useCount', 'url' in adminList.stickers[0] && 'usage' in adminList.stickers[0] && 'useCount' in adminList.stickers[0]);
ok('formatStickerAdminList 标记 deletable（qq 来源为 false）', adminList.stickers.find((e) => e.id === 'sticker_qq1').deletable === false && adminList.stickers.find((e) => e.id === 'sticker_nine2').deletable === true);
eq('formatStickerAdminList 的 total/matched', [adminList.total, adminList.matched], [4, 4]);
eq('formatStickerAdminList 搜索命中 localNote', formatStickerAdminList(LIB, '常用', 100).matched, 1);

// ════════════════════════════════════════════════════════════════════
console.log('\n═══ D. 接口层（起真 app 再 fetch） ═══');
// 预置数据：表情库 + 存档 + 记忆（内存里的实例在 createApp 时才读盘）
fs.mkdirSync(path.join(DIR, 'messages'), { recursive: true });
const HK = 'group:200';
fs.writeFileSync(path.join(DIR, 'messages', 'group_200.json'), JSON.stringify({
  chatKey: HK, nextLocalId: 6,
  messages: [
    { id: 1, mid: 11, ts: 1001, senderId: '555', senderName: '张三', text: '一', self: false, read: true, reply: null, media: [] },
    { id: 2, mid: 12, ts: 1002, senderId: '556', senderName: '李四', text: '二', self: false, read: true, reply: null, media: [] },
    { id: 3, mid: null, ts: 1003, senderId: 'digest', senderName: '摘要', text: '【摘要】...', self: false, read: true, reply: null, media: [], kind: 'digest', digest: { count: 9, summary: 'x' } },
    { id: 4, mid: 14, ts: 1004, senderId: '555', senderName: '张三', text: '四', self: false, read: false, reply: null, media: [] }
  ]
}, null, 1), 'utf8');

// 本地假图床（1×1 PNG）
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');
const imgSrv = http.createServer((req, res) => {
  if (req.url === '/ok.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  if (req.url === '/evil.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<script>alert(1)</script>'); }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => imgSrv.listen(0, '127.0.0.1', r));
const IMG = `http://127.0.0.1:${imgSrv.address().port}`;

// 表情库落盘（含缩略图代理的三个夹具）——必须在 createApp 之前写完：
// StickerManager 在构造时就把 stickers.json 读进内存，之后再改文件它也不会看见。
const SEED = [
  ...LIB,
  { id: 'p_ok', url: `${IMG}/ok.png`, desc: '正常图', source: 'ai' },
  { id: 'p_evil', url: `${IMG}/evil.html`, desc: '假图', source: 'ai' },
  { id: 'p_dead', url: 'https://example.invalid/x.png', desc: '死链', source: 'ai' }
];
fs.writeFileSync(path.join(DIR, 'stickers.json'), JSON.stringify(SEED, null, 2), 'utf8');

const { createApp } = await load('app.js');
const core = createApp({ log: () => {} });
const port = await core.start();
const api = async (p, options = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: { 'content-type': 'application/json', 'x-console-token': 'qq-agent-console' },
    ...options
  });
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('application/json')) return { status: res.status, raw: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const J = (o) => JSON.stringify(o.body ?? o.raw?.length);

// ── 表情包 ──
console.log('\n-- 表情包 --');
const list = await api('/api/stickers');
eq('GET /api/stickers → 200', list.status, 200);
ok('列表带 url（缩略图要用）', list.body.stickers.every((s) => 'url' in s));
ok('列表如实报告同步状态（离线时 fromCache=true）', list.body.fromCache === true && !!list.body.syncError, J(list));

const patched = await api('/api/stickers/sticker_qq1', {
  method: 'PATCH', body: JSON.stringify({ note: '改过的备注', tags: '可爱, 常用 高频', usage: '打招呼', desc: '想改描述' })
});
eq('PATCH 改备注 → 200', patched.status, 200);
eq('PATCH 把标签串拆成数组', patched.body.sticker.tags, ['可爱', '常用', '高频']);
eq('PATCH 的 desc 被忽略（QQ 同步会盖回来，不可编辑）', patched.body.sticker.desc, '猫猫');
const reread = await api('/api/stickers');
ok('PATCH 落了盘（重新拉取能看到）', reread.body.stickers.find((s) => s.id === 'sticker_qq1').localNote === '改过的备注');
ok('PATCH 写了 usage', reread.body.stickers.find((s) => s.id === 'sticker_qq1').usage === '打招呼');

const amb = await api('/api/stickers/9', { method: 'PATCH', body: JSON.stringify({ note: 'x' }) });
eq('PATCH 撞车标签 → 409 + 候选', amb.status, 409);
ok('409 里列了两个候选 id', (amb.body.candidates || []).map((c) => c.id).sort().join(',') === 'sticker_nine,sticker_nine2', J(amb));

eq('DELETE 一条 qq 来源 → 409（QQ 收藏是源，本地删不掉）', (await api('/api/stickers/sticker_qq1', { method: 'DELETE' })).status, 409);
const del1 = await api('/api/stickers/sticker_ai1', { method: 'DELETE' });
eq('DELETE 一条 ai 来源 → 200', del1.status, 200);
const after = await api('/api/stickers');
ok('删掉的条目不在列表里', !after.body.stickers.some((s) => s.id === 'sticker_ai1'));
eq('DELETE 不存在的 id → 404', (await api('/api/stickers/nope', { method: 'DELETE' })).status, 404);
eq('DELETE 纯标签不命中 → 404（删除绝不按标签猜）', (await api('/api/stickers/' + encodeURIComponent('偷来的'), { method: 'DELETE' })).status, 404);
eq('PATCH 不存在的 id → 404', (await api('/api/stickers/nope', { method: 'PATCH', body: JSON.stringify({ note: 'x' }) })).status, 404);
eq('PATCH 没有可改字段 → 400', (await api('/api/stickers/sticker_nine', { method: 'PATCH', body: '{}' })).status, 400);
eq('坏编码的 id → 400（不是 500）', (await api('/api/stickers/%/image')).status, 400);

// 缩略图代理：SSRF 闸。
// 不重启 app —— validateImageUrl / safeFetchBinary 每次都读 getConfig()，
// 运行时翻一下开关就够了，省掉一次 createApp（新实例会另起 OneBot 连接，反而添乱）。
const blocked = await api('/api/stickers/p_ok/image');
eq('内网图床在默认配置下被拒（SSRF 闸生效）', blocked.status, 502);
updateConfig({ security: { allowPrivateImageHosts: true } });
const api2 = api;
const img = await api2('/api/stickers/p_ok/image');
eq('放行内网后 → 200', img.status, 200);
eq('代理返回 image/png', img.headers.get('content-type'), 'image/png');
ok('返回的是原始字节（不是 base64-in-JSON）', img.raw.length === PNG.length && img.raw.equals(PNG), `${img.raw.length} vs ${PNG.length}`);
eq('带 nosniff（防内容嗅探）', img.headers.get('x-content-type-options'), 'nosniff');
const evil = await api2('/api/stickers/p_evil/image');
eq('非图片内容 → 415（不把 HTML 注入面板同源页）', evil.status, 415);
eq('取不到图 → 502', (await api2('/api/stickers/p_dead/image')).status, 502);
eq('图片代理对不存在的 id → 404', (await api2('/api/stickers/nope/image')).status, 404);

// ── 表情图片本地缓存（需求 2：从文件夹里拿图片）──
console.log('\n-- 表情图片本地缓存 --');
const CACHE_DIR = path.join(DIR, 'sticker-cache');
const st1 = await api2('/api/stickers');
eq('GET /api/stickers 带回上限（默认 0 = 不限）', st1.body.maxKeepCount, 0);
eq('owned 就是 bot 自己收藏的条数（QQ 收藏不算）', st1.body.owned, st1.body.stickers.filter((s) => s.source !== 'qq').length);
ok('还没缓存过时 cached 全是 false', st1.body.stickers.every((s) => s.cached === false));

const cachePost = await api2('/api/stickers/cache', { method: 'POST' });
eq('POST /api/stickers/cache → 200', cachePost.status, 200);
ok('至少缓存成功一张（p_ok）', cachePost.body.cached >= 1, J(cachePost.body));
ok('取不到的条目如实报错，不是静默跳过', cachePost.body.failed >= 1 && cachePost.body.errors.length >= 1, J(cachePost.body));
const st2 = await api2('/api/stickers');
ok('缓存成功的条目标记为 cached', st2.body.stickers.find((s) => s.id === 'p_ok').cached === true);
const cachedName = fs.readdirSync(CACHE_DIR).find((n) => n.startsWith('p_ok'));
ok('缓存文件名带条目 id 前缀（人肉排查得下去）', !!cachedName, cachedName);
ok('落盘的字节就是图床给的', fs.readFileSync(path.join(CACHE_DIR, cachedName)).equals(PNG));

// 彻底掐断图床（连 keep-alive 连接池一起掐）：此后缩略图还能回图，就只可能来自本地文件
imgSrv.close();
imgSrv.closeAllConnections?.();
const local = await api2('/api/stickers/p_ok/image');
eq('图床关了，缩略图仍然 200（真的从文件夹里拿）', local.status, 200);
ok('返回的还是同一份字节', local.raw.equals(PNG), `${local.raw.length} vs ${PNG.length}`);
eq('content-type 由本地字节判定', local.headers.get('content-type'), 'image/png');

const delCached = await api2('/api/stickers/p_ok', { method: 'DELETE' });
eq('删掉一条已缓存的表情 → 200', delCached.status, 200);
ok('它的本地图片一起没了（缓存目录不许留孤儿）', !fs.existsSync(path.join(CACHE_DIR, cachedName)));

fs.writeFileSync(path.join(CACHE_DIR, 'zzz_orphan.png'), PNG);
const sweepPost = await api2('/api/stickers/cache', { method: 'POST' });
ok('「缓存图片」顺手清掉没人认领的文件', sweepPost.body.swept >= 1, J(sweepPost.body));
ok('孤儿文件确实没了', !fs.existsSync(path.join(CACHE_DIR, 'zzz_orphan.png')));

// ── 存档 ──
console.log('\n-- 存档 --');
const put = await api2('/api/chats/group_200/messages/2', { method: 'PATCH', body: JSON.stringify({ text: '二（改过）' }) });
eq('PATCH 消息文本 → 200', put.status, 200);
eq('PATCH 不存在的 id → 404', (await api2('/api/chats/group_200/messages/999', { method: 'PATCH', body: JSON.stringify({ text: 'x' }) })).status, 404);
eq('PATCH 空文本 → 400', (await api2('/api/chats/group_200/messages/2', { method: 'PATCH', body: JSON.stringify({ text: '   ' }) })).status, 400);
eq('PATCH 摘要 → 400（改手会让 digest.summary 对不上）', (await api2('/api/chats/group_200/messages/3', { method: 'PATCH', body: JSON.stringify({ text: 'x' }) })).status, 400);
eq('PATCH 请求体不是 JSON → 400', (await api2('/api/chats/group_200/messages/2', { method: 'PATCH', body: 'not json' })).status, 400);

const delMsg = await api2('/api/chats/group_200/messages/4', { method: 'DELETE' });
eq('DELETE 消息 → 200', delMsg.status, 200);
ok('返回值里带上备份文件名（UI 要告诉用户去哪找回）', String(delMsg.body.backup || '').includes('.panel.bak'), J(delMsg));
ok('确实生成了 .panel.bak', fs.existsSync(path.join(DIR, 'messages', 'group_200.json.panel.bak')));
ok('**没有**把压缩的 .json.bak 冲掉', !fs.existsSync(path.join(DIR, 'messages', 'group_200.json.bak')));
eq('DELETE 不存在的 id → 404', (await api2('/api/chats/group_200/messages/999', { method: 'DELETE' })).status, 404);

const got = await api2('/api/chats/group_200/messages?limit=100000');
eq('改过的文本出现在接口里', got.body.messages.find((m) => m.id === 2)?.text, '二（改过）');
ok('删掉的条目不在接口里', !got.body.messages.some((m) => m.id === 4));
eq('剩下的 id 原样（1,2,3）', got.body.messages.map((m) => m.id), [1, 2, 3]);
ok('kind 字段仍透传给前端（摘要行样式靠它）', got.body.messages.find((m) => m.id === 3)?.kind === 'digest');

const noteRes = await api2('/api/chats/group_200/notes', { method: 'POST', body: JSON.stringify({ text: '记得周三开会', ts: 1005 }) });
eq('POST /notes → 200', noteRes.status, 200);
ok('新备注 kind=note / read=true / mid=null', noteRes.body.note.kind === 'note' && noteRes.body.note.read === true && noteRes.body.note.mid === null);
eq('POST 空备注 → 400', (await api2('/api/chats/group_200/notes', { method: 'POST', body: JSON.stringify({ text: '  ' }) })).status, 400);
const got2 = await api2('/api/chats/group_200/messages?limit=100000');
ok('备注在存档接口里可见，且排在 ts=1005 的位置', got2.body.messages[got2.body.messages.length - 1].text === '记得周三开会', got2.body.messages.map((m) => m.id + ':' + m.text).join(' | '));
eq('备忘 id 取 nextLocalId（=6），不复用被删的 4', noteRes.body.note.id, 6);

// ── 记忆 ──
console.log('\n-- 记忆 --');
const post1 = await api2('/api/memory-files/group_200/impressions', { method: 'POST', body: JSON.stringify({ userId: '888', target: '小明', content: '喜欢猫' }) });
eq('POST 印象 → 200', post1.status, 200);
eq('POST 重复内容 → duplicate=true', (await api2('/api/memory-files/group_200/impressions', { method: 'POST', body: JSON.stringify({ userId: '888', target: '小明', content: '喜欢猫' }) })).body.duplicate, true);
await api2('/api/memory-files/group_200/impressions', { method: 'POST', body: JSON.stringify({ userId: '888', content: '话很多' }) });
const mBefore = (await api2('/api/memory-files/group_200')).body.members.find((m) => m.userId === '888');
const catAtHttp = mBefore.impressions.find((e) => e.content === '喜欢猫').createdAt;

const patch = await api2('/api/memory-files/group_200/impressions', { method: 'PATCH', body: JSON.stringify({ userId: '888', content: '喜欢猫', next: '非常喜欢猫' }) });
eq('PATCH 印象 → 200', patch.status, 200);
ok('PATCH 保留 createdAt', patch.body.member.impressions.find((e) => e.content === '非常喜欢猫')?.createdAt === catAtHttp);
eq('PATCH 内容对不上 → 404（并提示刷新）', (await api2('/api/memory-files/group_200/impressions', { method: 'PATCH', body: JSON.stringify({ userId: '888', content: '没这条', next: 'x' }) })).status, 404);
eq('PATCH 撞已有条目 → 409', (await api2('/api/memory-files/group_200/impressions', { method: 'PATCH', body: JSON.stringify({ userId: '888', content: '非常喜欢猫', next: '话很多' }) })).status, 409);
eq('userId 非数字 → 400', (await api2('/api/memory-files/group_200/impressions', { method: 'POST', body: JSON.stringify({ userId: 'abc', content: 'x' }) })).status, 400);
eq('既没 userId 也没 target → 400', (await api2('/api/memory-files/group_200/impressions', { method: 'POST', body: JSON.stringify({ content: 'x' }) })).status, 400);

const d1 = await api2('/api/memory-files/group_200/impressions', { method: 'DELETE', body: JSON.stringify({ userId: '888', content: '话很多' }) });
eq('DELETE 单条印象 → 200', d1.status, 200);
eq('还有剩余时 memberGone=false', d1.body.memberGone, false);
const d2 = await api2('/api/memory-files/group_200/impressions', { method: 'DELETE', body: JSON.stringify({ userId: '888', content: '非常喜欢猫' }) });
eq('删掉最后一条 → memberGone=true（成员文件一并消失，UI 必须说明）', d2.body.memberGone, true);
ok('成员文件确实没了', !fs.existsSync(path.join(DIR, 'memory', 'group_200', '888.json')));
eq('DELETE 内容对不上 → 404', (await api2('/api/memory-files/group_200/impressions', { method: 'DELETE', body: JSON.stringify({ userId: '888', content: '没这条' }) })).status, 404);

// ── 未授权时不得放行（authorize 在 token 为空时默认放行，这里只验证带错 token 的情况）──
updateConfig({ server: { token: 'sekret' } });
eq('带错 token → 401（写操作也走同一道闸）', (await api2('/api/stickers/sticker_qq1', { method: 'DELETE', headers: { 'x-console-token': 'wrong' } })).status, 401);

core.stop(); imgSrv.close();
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
