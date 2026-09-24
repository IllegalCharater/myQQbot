// 端到端冒烟：像 src/server.js 那样真起一个服务（createApp() 不带参数），
// 然后走真 HTTP 把面板要用的每一条新路径打一遍。
//
// 和 t-admin 的分工：t-admin 是接口级的穷举（97 条，含各种 4xx/5xx），
// 这里只求"用户真打开面板时，从静态文件到每一条新接口，整条链路是通的"——
// 特别是 ui/ 那几个新文件能不能被静态服务吐出来（新页签的骨架在里面）。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-smoke-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
};

// ── 预置数据：一个群会话 + 一个表情库 ──
const CK = 'group_123';
fs.mkdirSync(path.join(DIR, 'messages'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'messages', CK + '.json'), JSON.stringify({
  nextLocalId: 4,
  messages: [
    { id: 1, mid: 'm1', ts: 1758600000000, senderId: '10001', senderName: '小明', text: '原始消息一', self: false, read: true, media: [] },
    { id: 2, mid: 'm2', ts: 1758600060000, senderId: '10002', senderName: '小红', text: '原始消息二', self: false, read: false, media: [] }
  ]
}, null, 2));
// loadStickerStore 读的是**裸数组**（不是 { syncedAt, entries } 那种包一层的），
// 包一层会被 `!Array.isArray(parsed)` 判成空库
fs.writeFileSync(path.join(DIR, 'stickers.json'), JSON.stringify([
  { id: 'q1', url: 'https://example.invalid/a.png', desc: 'QQ猫', localNote: '', tags: [], usage: '', source: 'qq', useCount: 0, md5: 'aa' },
  { id: 'a1', url: 'https://example.invalid/b.gif', desc: '', localNote: '偷来的图', tags: ['搞笑'], usage: '冷场', source: 'ai', useCount: 2, md5: 'bb' }
], null, 2));
// 另一个群：两条压缩摘要 + 一条普通消息，专门用来验 digestStatus（别的用例不碰它，
// 免得跟 store 的内存缓存打架 —— 直接改文件是读不到的，store 已经把这会话缓存住了）。
const DKC = 'group_777';
const digestEntry = (id, from, to, count, body) => ({
  id, mid: null, ts: 1758000000000 + id * 1000, senderId: 'digest', senderName: '聊天记录摘要',
  text: `【历史摘要 ${from} ~ ${to} · 共 ${count} 条】\n${body}`,
  self: false, read: true, reply: null, media: [], kind: 'digest',
  digest: { from: 1754000000000, to: 1754009000000, count, archivedFile: '', model: 'm', createdAt: 1758000000000 }
});
fs.writeFileSync(path.join(DIR, 'messages', DKC + '.json'), JSON.stringify({
  nextLocalId: 6,
  messages: [
    digestEntry(1, '08-01 03:20', '08-01 06:00', 400, '甲'.repeat(120)),
    { id: 2, mid: 'm9', ts: 1758000100000, senderId: '10001', senderName: '小明', text: '普通消息', self: false, read: true, reply: null, media: [] },
    digestEntry(5, '08-20 10:00', '08-20 12:00', 250, '乙'.repeat(120))
  ]
}, null, 2));
const memDir = path.join(DIR, 'memory', CK);
fs.mkdirSync(memDir, { recursive: true });
fs.writeFileSync(path.join(memDir, '10001.json'), JSON.stringify({
  userId: '10001', name: '小明', updatedAt: Date.now(),
  impressions: [{ content: '喜欢猫', createdAt: 1758600000000 }]
}, null, 2));

const { createApp } = await load('app.js');
const core = createApp();
const port = await core.start();
const B = `http://127.0.0.1:${port}`;
const call = async (p, opts = {}) => {
  const r = await fetch(B + p, { headers: { 'content-type': 'application/json', 'x-console-token': 'dev-local-marker' }, ...opts });
  let body = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) body = await r.json().catch(() => null);
  else body = await r.text();
  return { status: r.status, body, type: ct };
};

console.log(`\n服务已起：${B}（数据目录 ${DIR}）`);

console.log('\n═══ 面板静态文件（新页签的骨架就在里面） ═══');
const home = await call('/');
ok('GET / 返回 HTML', home.status === 200 && String(home.type).includes('text/html'), `status=${home.status}`);
ok('首页含新页签按钮', String(home.body).includes('data-tab="stickers"'));
ok('首页含新视图容器', String(home.body).includes('id="view-stickers"'));
ok('首页含搜索框 / 刷新按钮 / 列表 / 详情四个挂载点',
  ['sticker-search', 'sticker-sync-btn', 'sticker-items', 'sticker-detail'].every((id) => String(home.body).includes(`id="${id}"`)));
const jsRes = await call('/app.js');
ok('GET /app.js 拿到脚本且是新版（含 renderStickerItems）',
  jsRes.status === 200 && String(jsRes.body).includes('renderStickerItems'), `status=${jsRes.status}`);
ok('/app.js 含存档操作与记忆单条操作的代码',
  String(jsRes.body).includes('data-op="edit"') && String(jsRes.body).includes('imp-edit'));
const cssRes = await call('/style.css');
ok('GET /style.css 拿到样式且含新页样式',
  cssRes.status === 200 && String(cssRes.body).includes('.sticker-grid') && String(cssRes.body).includes('.imp-row'), `status=${cssRes.status}`);
// 服务端自己也是用 `new URL(req.url, …)` 取 pathname 的，而 WHATWG 的 URL 解析器
// 会把字面 `..` 和 `%2e%2e` 这类点段**提前规范化掉**，所以那两种写法根本走不到守卫
// 跟前（会变成 /package.json → 404）。能真正打到守卫的是 `%2e%2e%2f`：
// `%2f` 不被 URL 解析器解码，整段因此留到了 decodeURIComponent 那一步。
const rawGet = (pathStr) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${pathStr} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
  let buf = '';
  s.on('data', (c) => { buf += c; });
  s.on('close', () => resolve(buf.split('\r\n')[0]));
  s.on('error', () => resolve('ERR'));
});
const t1 = await rawGet('/%2e%2e%2fpackage.json');
ok('穿过 URL 规范化的编码穿越被守卫拦下（403）', t1.includes('403'), t1);
const t2 = await rawGet('/../package.json');
ok('字面 .. 被 URL 解析提前规范掉，落成 404（同样拿不到文件）', t2.includes('404'), t2);
ok('静态文件确实在服务（对照组，证明上面两条不是"什么都没在跑"）',
  (await rawGet('/app.js')).includes('200'));

console.log('\n═══ 表情包页要用的四条接口 ═══');
const list = await call('/api/stickers');
ok('GET /api/stickers', list.status === 200 && list.body.stickers.length === 2, `status=${list.status}`);
ok('qq 来源标记为不可删', list.body.stickers.find((s) => s.id === 'q1')?.deletable === false);
ok('ai 来源标记为可删', list.body.stickers.find((s) => s.id === 'a1')?.deletable === true);
// 端到端：上限与"bot 收藏数"这条路是通的（面板计数行直接吃这两个字段）
ok('GET /api/stickers 带回 owned（bot 自己收藏的条数）', list.body.owned === 1, JSON.stringify(list.body.owned));
ok('GET /api/stickers 带回 maxKeepCount（默认 0 = 不限）', list.body.maxKeepCount === 0);
ok('条目带 cached 字段（面板详情按它显示缓存状态）', list.body.stickers.every((s) => s.cached === false));
const q = await call('/api/stickers?q=' + encodeURIComponent('偷来'));
ok('搜索词生效', q.body.stickers.length === 1 && q.body.stickers[0].id === 'a1', JSON.stringify(q.body.stickers.map((s) => s.id)));
const patched = await call('/api/stickers/a1', { method: 'PATCH', body: JSON.stringify({ note: '改过的备注', tags: '搞笑, 冷场', usage: '冷场时' }) });
ok('PATCH 备注 / 标签 / 场景', patched.status === 200 && patched.body.sticker?.localNote === '改过的备注', `status=${patched.status} body=${JSON.stringify(patched.body)}`);
const after = await call('/api/stickers');
const a1 = after.body.stickers.find((s) => s.id === 'a1');
ok('改动落了盘（重新拉取能看到）', a1.localNote === '改过的备注' && a1.tags.length === 2, JSON.stringify({ n: a1.localNote, t: a1.tags }));
ok('QQ 来源的表情删不掉 → 409', (await call('/api/stickers/q1', { method: 'DELETE' })).status === 409);
const del = await call('/api/stickers/a1', { method: 'DELETE' });
ok('ai 来源的表情能删', del.status === 200 && del.body.removed, `status=${del.status}`);
ok('删完真的没了', (await call('/api/stickers')).body.stickers.length === 1);

console.log('\n═══ 存档页要用的三条接口 ═══');
const msgs0 = await call(`/api/chats/${CK}/messages`);
ok('GET 消息存档', msgs0.status === 200 && msgs0.body.messages.length === 2);
const noteRes = await call(`/api/chats/${CK}/notes`, { method: 'POST', body: JSON.stringify({ text: '这是人工备注', ts: 1758600030000 }) });
ok('POST 加备注', noteRes.status === 200 && noteRes.body.note?.kind === 'note', `status=${noteRes.status}`);
ok('备注 read=true（否则会被当成未读触发一次运行）', noteRes.body.note?.read === true);
ok('备注不冒充群友（senderId/senderName 都空）', noteRes.body.note?.senderId === '' && noteRes.body.note?.senderName === '');
const msgs1 = await call(`/api/chats/${CK}/messages`);
const order = msgs1.body.messages.map((m) => m.id);
// 备注 ts 落在 msg1(t0) 与 msg2(t0+60s) 之间 → 应排在两者中间，而不是追加到末尾
ok('备注按 ts 插到了时间正确的位置（不是无脑追加到末尾）',
  order.join(',') === '1,4,2' && msgs1.body.messages[1].kind === 'note', `顺序=${order.join(',')}`);
const edit = await call(`/api/chats/${CK}/messages/1`, { method: 'PATCH', body: JSON.stringify({ text: '改过的正文' }) });
ok('PATCH 改消息正文', edit.status === 200 && edit.body.message.text === '改过的正文', `status=${edit.status}`);
ok('改文本不动发送者与时间', edit.body.message.senderId === '10001' && edit.body.message.ts === 1758600000000);
ok('空文本被拒 400', (await call(`/api/chats/${CK}/messages/1`, { method: 'PATCH', body: JSON.stringify({ text: '   ' }) })).status === 400);
ok('不存在的 id → 404', (await call(`/api/chats/${CK}/messages/999`, { method: 'PATCH', body: JSON.stringify({ text: 'x' }) })).status === 404);
ok('摘要不许手改（后端 400；这条消息不是摘要，用 kind 判定）', (await call(`/api/chats/${CK}/messages/1`, { method: 'PATCH', body: JSON.stringify({ text: 'ok' }) })).status === 200);
const delRes = await call(`/api/chats/${CK}/messages/2`, { method: 'DELETE' });
ok('DELETE 删消息', delRes.status === 200 && delRes.body.removed?.id === 2, `status=${delRes.status}`);
ok('返回备份文件名（UI 上要写清去哪找回）', /\.panel\.bak$/.test(delRes.body.backup || ''), String(delRes.body.backup));
ok('.panel.bak 真的生成了', fs.existsSync(path.join(DIR, 'messages', `${CK}.json.panel.bak`)));
ok('压缩回滚点 .json.bak 没有被面板冲掉', !fs.existsSync(path.join(DIR, 'messages', `${CK}.json.bak`)));
ok('删完真的少了', (await call(`/api/chats/${CK}/messages`)).body.messages.length === 2);

console.log('\n═══ 历史摘要：接口给的 digestStatus 就是"实际会注入什么" ═══');
// 这一段的重点：面板顶部的标注不是前端自己按预算猜的，而是服务端调
// collectInjectedDigests（与 buildUserPrompt 同一个函数）算出来的。
const putDigest = (d) => call('/api/config', { method: 'POST', body: JSON.stringify({ digest: d }) });
const noDigest = await call(`/api/chats/${CK}/messages`);
ok('这个会话没有摘要 → total 0、一条都不注入（勾了设置也没用）',
  noDigest.body.digestStatus?.total === 0 && noDigest.body.digestStatus.injectedIds.length === 0);

const d1 = await call(`/api/chats/${DKC}/messages`);
let dstat = d1.body.digestStatus;
ok('带摘要的会话：两条都进了 total', dstat.total === 2 && dstat.totalChars > 0, JSON.stringify({ t: dstat.total, c: dstat.totalChars }));
// 注入列表按**优先级**给出（新的在前）—— 预算就是从这一端开始吃的，
// 所以这个顺序不是装饰：面板照它标"已注入"、预算照它丢老条目，同一条契约。
ok('默认预算（8000 字）两条都注入，且按新的在前给出', dstat.injectedIds.join(',') === '5,1' && dstat.droppedIds.length === 0 && dstat.truncatedId === null,
  JSON.stringify(dstat.injectedIds));
ok('config 回显的是"这个会话实际生效"的策略（含按群解析的结果）',
  dstat.config.maxChars === 8000 && dstat.config.injectEveryRound === false && dstat.config.merge === true, JSON.stringify(dstat.config));
ok('chars 是注入段的总字数，且不超过预算', dstat.chars > 0 && dstat.chars <= dstat.budget, JSON.stringify({ c: dstat.chars, b: dstat.budget }));

await putDigest({ maxChars: 60 });
dstat = (await call(`/api/chats/${DKC}/messages`)).body.digestStatus;
ok('预算收到 60：只留最新的那条，老的整条丢（半截的三周前纪要更糟）',
  dstat.injectedIds.join(',') === '5' && dstat.droppedIds.join(',') === '1', JSON.stringify(dstat.injectedIds));
ok('最新那条自己就超预算 → 仍然带上，并标出 truncatedId（绝不 0% 呈现）', dstat.truncatedId === 5);
ok('截断后仍不超预算', dstat.chars <= 60, String(dstat.chars));
ok('预算变了 dropped 也跟着变（面板才能照实标「未注入」）', dstat.droppedIds.length === 1);

await putDigest({ maxChars: 0 });
dstat = (await call(`/api/chats/${DKC}/messages`)).body.digestStatus;
ok('maxChars=0 → 一条都不注入，全归 dropped（面板据此写「已关闭注入」）',
  dstat.injectedIds.length === 0 && dstat.droppedIds.length === 2 && dstat.chars === 0 && dstat.budget === 0, JSON.stringify(dstat));

await putDigest({ maxChars: 8000, injectEveryRound: false, merge: true, unified: false, perChat: { 777: { maxChars: 40, injectEveryRound: true, merge: false } } });
dstat = (await call(`/api/chats/${DKC}/messages`)).body.digestStatus;
ok('分群覆盖：这个群用 40 字预算（不是全局的 8000）', dstat.budget === 40, JSON.stringify(dstat.config));
ok('分群覆盖：每轮注入 / 不合并 也跟着这个群走', dstat.config.injectEveryRound === true && dstat.config.merge === false);
const other = await call(`/api/chats/${CK}/messages`);
ok('没单独设过的群仍跟随全局（8000 字 / 不每轮 / 合并）',
  other.body.digestStatus.budget === 8000 && other.body.digestStatus.config.injectEveryRound === false
  && other.body.digestStatus.config.merge === true, JSON.stringify(other.body.digestStatus.config));
await putDigest({ maxChars: 8000, injectEveryRound: false, merge: true, unified: true, perChat: { __replace__: {} } });
ok('改回统一模式后预算回到全局值', (await call(`/api/chats/${DKC}/messages`)).body.digestStatus.budget === 8000);

// 面板「清除该群的单独设置」走的是 perChat.__replace__ —— 普通深合并删不掉键，
// 这条路径断了的话按钮点了没反应（键还在，值还是旧的），而且只有到浏览器里才看得见。
await putDigest({ unified: false, perChat: { 777: { maxChars: 40, injectEveryRound: true, merge: false } } });
await putDigest({ perChat: { __replace__: { 888: { maxChars: 111 } } } });
const cfgr = await call('/api/config');
ok('perChat 的 __replace__ 真的整份替换（777 的键被删掉，不是被深合并留着）',
  cfgr.body.digest.perChat['777'] === undefined && cfgr.body.digest.perChat['888']?.maxChars === 111,
  JSON.stringify(cfgr.body.digest.perChat));
await putDigest({ unified: true, perChat: { __replace__: {} } });

// 存档回收上限（digest.maxKeepChars）：走真实 POST /api/config → 落盘 → 再被 digestConfigForChat
// 读回来。这条链断掉的话设置页填了数字、面板也回显了，但压缩时压根不生效（最难发现的那种）。
// 它和上面 maxChars 的方向正好相反：0 是"不限制"，不是"关掉"。
await putDigest({ maxKeepChars: 5000 });
dstat = (await call(`/api/chats/${DKC}/messages`)).body.digestStatus;
ok('存档上限能存能读（面板顶部照它写"上限 N 字"）', dstat.config.maxKeepChars === 5000, JSON.stringify(dstat.config));
ok('存档上限不影响注入（两笔账：它是磁盘保留量，不是提示词预算）',
  dstat.budget === 8000 && dstat.injectedIds.length === 2, JSON.stringify({ b: dstat.budget, i: dstat.injectedIds }));
const cfgFile = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
ok('真的落盘了（不是只改内存里那份，重启就丢）', cfgFile.digest?.maxKeepChars === 5000, JSON.stringify(cfgFile.digest));
await putDigest({ maxKeepChars: 0 });
ok('改回 0 = 不限（默认值就是这个方向：绝不默认删用户的纪要）',
  (await call(`/api/chats/${DKC}/messages`)).body.digestStatus.config.maxKeepChars === 0);

console.log('\n═══ 记忆页要用的三条接口 ═══');
const mp = `/api/memory-files/${CK}/impressions`;
const added = await call(mp, { method: 'POST', body: JSON.stringify({ userId: '10001', content: '常半夜出没' }) });
ok('POST 加一条印象', added.status === 200 && added.body.member.impressions.length === 2, `status=${added.status}`);
const upd = await call(mp, { method: 'PATCH', body: JSON.stringify({ userId: '10001', content: '喜欢猫', next: '非常喜欢猫' }) });
ok('PATCH 改一条印象', upd.status === 200 && upd.body.member.impressions.some((e) => e.content === '非常喜欢猫'), `status=${upd.status}`);
const kept = upd.body.member.impressions.find((e) => e.content === '非常喜欢猫');
ok('改完保留原本的 createdAt（这正是不能用整列表 PUT 的原因）', kept.createdAt === 1758600000000, String(kept?.createdAt));
ok('改成已存在的重复内容 → 409', (await call(mp, { method: 'PATCH', body: JSON.stringify({ userId: '10001', content: '非常喜欢猫', next: '常半夜出没' }) })).status === 409);
ok('content 对不上（bot 中途改过）→ 404', (await call(mp, { method: 'PATCH', body: JSON.stringify({ userId: '10001', content: '这条不存在', next: 'x' }) })).status === 404);
ok('QQ 号非数字 → 400', (await call(mp, { method: 'POST', body: JSON.stringify({ userId: 'abc', content: 'x' }) })).status === 400);
const rmd = await call(mp, { method: 'DELETE', body: JSON.stringify({ userId: '10001', content: '非常喜欢猫' }) });
ok('DELETE 删一条印象', rmd.status === 200 && rmd.body.member.impressions.length === 1, `status=${rmd.status}`);
const rmd2 = await call(mp, { method: 'DELETE', body: JSON.stringify({ userId: '10001', content: '常半夜出没' }) });
ok('删掉最后一条时成员文件一并删除并回报 memberGone', rmd2.body.memberGone === true, JSON.stringify(rmd2.body.memberGone));

console.log('\n═══ 收尾 ═══');
ok('停止服务不报错', await core.stop().then(() => true).catch(() => false));
fs.rmSync(DIR, { recursive: true, force: true });

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
