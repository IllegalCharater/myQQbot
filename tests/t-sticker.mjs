// 验证：表情工具的可寻址性（A/C/E）—— 标签寻址、报错可教学、收藏后引导补备注。
// 不接真实 QQ：StickerManager 的同步会失败并退回本地缓存，正是我们要测的那条路径。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-sticker-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

// 真实库里就有 desc 是 "9"/"AA"/"GIF" 这种极短标签，以及 URL 里含数字的表情 ——
// 这里按同样的形状造数据，才能测出"标签被 URL 子串抢先命中"那类坑。
const LIB = [
  { id: '1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0', resId: '1130975926_0_0_0_1DD9',
    url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-1DD908F7/0', md5: '',
    desc: '蕾米的凝', localNote: '', tags: ['东方'], usage: '', useCount: 3, source: 'qq', createdAt: '2025-01-01T00:00:00.000Z' },
  { id: 'sticker_dio', resId: 'sticker_dio',
    url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-DIO99/0', md5: 'ABCDEF01',
    desc: 'DIO的肯定', localNote: '赞同、点头', tags: [], usage: '赞同别人时', useCount: 1, source: 'qq', createdAt: '2025-02-01T00:00:00.000Z' },
  { id: 'sticker_nine', resId: 'sticker_nine',
    url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-9NINE/0', md5: '',
    desc: '9', localNote: '', tags: [], usage: '', useCount: 0, source: 'qq', createdAt: '2025-03-01T00:00:00.000Z' },
  { id: 'sticker_nine2', resId: 'sticker_nine2',
    url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-9TWO/0', md5: '',
    desc: '9', localNote: '', tags: [], usage: '', useCount: 0, source: 'qq', createdAt: '2025-04-01T00:00:00.000Z' },
  { id: 'collected_-162267900', resId: 'collected_-162267900',
    url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-THEDI/0', md5: '',
    desc: '别人的图', localNote: '别人的图', tags: [], usage: '', useCount: 0, source: 'ai', createdAt: '2025-05-01T00:00:00.000Z' }
];
fs.writeFileSync(path.join(DIR, 'stickers.json'), JSON.stringify(LIB, null, 2), 'utf8');

const {
  findSticker, matchStickerLabel, applyStickerNote, buildStickerContext,
  cleanStickerRef, resolveStickerRef, selectEvictions, normalizeStickerEntry, loadStickerStore,
  buildStickerStrategyHint
} = await load('stickers.js');
const { StickerManager } = await load('sticker-manager.js');
const { buildToolDefs } = await load('tools.js');
const { updateConfig } = await load('config.js');

updateConfig({
  persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' },
  api: { model: 'stub', baseUrl: 'http://x' },
  sticker: { enabled: true, collectEnabled: true, maxCollectPerHour: 10, encourage: 1 }
});

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  okv ? pass++ : fail++;
  console.log(`${okv ? '  ✅' : '  ❌'} ${label}`);
  if (!okv) console.log(`       得到 ${JSON.stringify(got)}\n       期望 ${JSON.stringify(want)}`);
};
const truthy = (label, v) => { v ? pass++ : fail++; console.log(`${v ? '  ✅' : '  ❌'} ${label}`); if (!v) console.log('       实际:', JSON.stringify(v)); };
const falsy = (label, v) => { !v ? pass++ : fail++; console.log(`${!v ? '  ✅' : '  ❌'} ${label}`); if (v) console.log('       实际:', JSON.stringify(v)); };

const offlineOnebot = { call: async () => { throw new Error('offline'); } };

console.log('\n=== 1. findSticker：id/md5/url 照旧能用 ===');
eq('按 id', findSticker(LIB, 'sticker_dio')?.id, 'sticker_dio');
eq('按 resId', findSticker(LIB, 'sticker_dio')?.id, 'sticker_dio');
eq('按 md5（大小写不敏感）', findSticker(LIB, 'abcdef01')?.id, 'sticker_dio');
eq('按完整 url', findSticker(LIB, 'https://gchat.qpic.cn/gchatpic_new/0/0-0-DIO99/0')?.id, 'sticker_dio');
eq('空串 → null', findSticker(LIB, '  '), null);

console.log('\n=== 2. findSticker：纯标签不再被 URL 子串抢走 ===');
// 老代码里 "9" 会被 urlNormalized.includes 命中（几乎每个 URL 都含数字），
// 于是"按标签找"会静默指到错误的表情上。这正是 A 必须先堵的洞。
eq('"9" 不按 URL 命中任何表情', findSticker(LIB, '9'), null);
eq('"DIO" 不按 URL 命中', findSticker(LIB, 'DIO'), null);
truthy('真 URL（带 / ）仍能命中', findSticker(LIB, 'gchatpic_new/0/0-0-9NINE/0')?.id === 'sticker_nine');

console.log('\n=== 3. matchStickerLabel：全等匹配 desc/localNote/usage/tags ===');
eq('desc 唯一命中', matchStickerLabel(LIB, '蕾米的凝').map((e) => e.id), ['1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0']);
eq('localNote 命中', matchStickerLabel(LIB, '赞同、点头').map((e) => e.id), ['sticker_dio']);
eq('usage 命中', matchStickerLabel(LIB, '赞同别人时').map((e) => e.id), ['sticker_dio']);
eq('tags 命中', matchStickerLabel(LIB, '东方').map((e) => e.id), ['1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0']);
eq('首尾空白/大小写不敏感', matchStickerLabel(LIB, '  dio的肯定 ').map((e) => e.id), ['sticker_dio']);
eq('desc "9" 命中两条（歧义用例）', matchStickerLabel(LIB, '9').map((e) => e.id), ['sticker_nine', 'sticker_nine2']);
eq('子串不算命中', matchStickerLabel(LIB, '蕾米'), []);
eq('空串不命中', matchStickerLabel(LIB, ''), []);

console.log('\n=== 4. applyStickerNote：唯一命中才写，歧义就报错不改 ===');
let r = applyStickerNote(LIB, '蕾米的凝', { note: '东方表情' });
eq('标签唯一命中 → 写入', r.entry?.id, '1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0');
eq('写的是 localNote', r.entry?.localNote, '东方表情');

r = applyStickerNote(LIB, '9', { note: '随便改' });
eq('标签歧义 → entry 为 null', r.entry, null);
eq('歧义时返回候选 id', r.ambiguous.map((e) => e.id), ['sticker_nine', 'sticker_nine2']);
eq('歧义时不落库（原条目未被改）', r.entries.find((e) => e.id === 'sticker_nine').localNote, '');

r = applyStickerNote(LIB, '不存在的标签', { note: 'x' });
eq('完全找不到 → entry 为 null', r.entry, null);
eq('完全找不到 → 候选为空', r.ambiguous, []);

r = applyStickerNote(LIB, 'sticker_nine2', { note: 'id 精确命中，即使 desc 有歧义' });
eq('id 优先于标签歧义', r.entry?.id, 'sticker_nine2');

console.log('\n=== 5. StickerManager：note 的老契约没被改坏 ===');
const mgr = new StickerManager(offlineOnebot);
const e1 = mgr.note('sticker_dio', { note: '改了' });
eq('note() 仍返回条目本身', e1?.id, 'sticker_dio');
eq('note() 返回的是新备注', e1?.localNote, '改了');
const v = mgr.noteVerbose('9', { note: 'x' });
eq('noteVerbose() 能报歧义', v.ambiguous.length, 2);
eq('noteVerbose() 歧义时 entry 为 null', v.entry, null);
// collect 现在是 async（收藏那一刻要顺带把图落进本地缓存），调用点必须 await。
const c = await mgr.collect('123456', { url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-NEW/0', note: '好图' });
eq('collect() 仍返回条目（依赖 note 的返回值）', c?.id, 'collected_123456');
eq('collect() 的条目带 localNote', c?.localNote, '好图');

console.log('\n=== 6. 提示词里的标签 = 模型手上唯一的"源" ===');
const ctxText = buildStickerContext(mgr.entries, 10);
truthy('【可用表情包】列出了标签', ctxText.includes('蕾米的凝'));
// "标注过" = bot 自己记过 localNote，不是"有没有名字"：QQ 收藏一同步进来就带着 QQ 的
// 名字，bot 从没看过它 —— 按"有名字就算标注过"会让这整批漏出"待标注"那一队。
truthy('QQ 里只有名字、bot 没看过的也标成待标注（带 id=）', ctxText.includes('id=1130975926_0_0_0_1DD9'));
truthy('QQ 名一起带着（已有的线索不丢）', ctxText.includes('（QQ 名：蕾米的凝）'));
falsy('bot 标注过的照旧不给 id（省 token）', ctxText.includes('id=sticker_dio'));

console.log('\n=== 7. 工具链路：sticker_note 认标签（A） ===');
const tools = buildToolDefs();
const noteTool = tools.find((t) => t.name === 'sticker_note');
const imgTool = tools.find((t) => t.name === 'get_sticker_image');
const collectTool = tools.find((t) => t.name === 'collect_sticker');

// 工具用的 stickers 就是上面这个 manager（同一份内存库）
const ctx = {
  kind: 'group', chatId: '123', chatKey: 'group:123',
  stickers: mgr, onebot: offlineOnebot,
  session: { id: 's1', triggerText: '测试', sent: [] },
  emit() {},
  store: { findByMid: () => ({ mid: '123456', media: [{ kind: 'image', url: 'https://gchat.qpic.cn/gchatpic_new/0/0-0-IMG/0' }] }) }
};

let out = await noteTool.execute(ctx, { stickerId: '蕾米的凝', note: '东方角色表情', tags: ['东方'] });
truthy('A：直接填备注就能改', !out.isError);
eq('A：改的确实是那个表情', JSON.parse(out.content).id, '1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0');
eq('A：备注已写入', JSON.parse(out.content).localNote, '东方角色表情');

out = await noteTool.execute(ctx, { stickerId: '9', note: 'x' });
truthy('A：标签歧义时报错而不是瞎猜', out.isError === true);
truthy('A：报错里带候选 id（省一次来回）', out.content.includes('sticker_nine') && out.content.includes('sticker_nine2'));
truthy('A：报错说清了原因', out.content.includes('2 个表情'));

out = await noteTool.execute(ctx, { stickerId: 'sticker_nine', note: 'id 照样能用' });
truthy('A：id 路径不回归', !out.isError && JSON.parse(out.content).id === 'sticker_nine');

out = await noteTool.execute(ctx, { stickerId: 'json 引号', note: 'x' });
truthy('找不到时报"错误："', out.isError === true && out.content.startsWith('错误：'));

console.log('\n=== 8. 报错本身能教学（C） ===');
out = await noteTool.execute(ctx, { stickerId: '根本没有这个' });
truthy('C：sticker_note 报错含"请先用 list_stickers"', out.content.includes('请先用 list_stickers'));
truthy('C：并告诉它可以直接填备注', out.content.includes('备注'));

out = await imgTool.execute(ctx, { stickerId: '根本没有这个' });
truthy('C：get_sticker_image 报错含"请先用 list_stickers"', out.content.includes('请先用 list_stickers'));

const sendTool = tools.find((t) => t.name === 'send_sticker');
out = await sendTool.execute(ctx, { stickerId: '根本没有这个' });
truthy('C：send_sticker 口径不变（三处一致）', out.content.includes('请先用 list_stickers'));

console.log('\n=== 9. 收藏成功后就地引导补备注（E） ===');
out = await collectTool.execute(ctx, { messageId: '123456', note: '好图偷了' });
const payload = JSON.parse(out.content);
truthy('E：收藏成功', payload.collected === true && !out.isError);
eq('E：note 仍然是那条收藏备注（没被提示顶掉）', payload.note, '好图偷了');
truthy('E：新增 hint 引导 sticker_note', typeof payload.hint === 'string' && payload.hint.includes('sticker_note'));
truthy('E：hint 指出要补什么', payload.hint.includes('标签') && payload.hint.includes('场景'));

console.log('\n=== 10. 收藏出来的表情可以立刻按备注改（A+E 闭环） ===');
out = await noteTool.execute(ctx, { stickerId: '好图偷了', note: '下次回怼用' });
truthy('闭环：按备注找到刚收藏的表情', !out.isError && JSON.parse(out.content).id === 'collected_123456');
eq('闭环：备注已更新', JSON.parse(out.content).localNote, '下次回怼用');

// 备注撞车是真会发生的（persona 建议的备注就是"好图偷了"这种雷同句），
// 所以 collect 返回的 id 必须能直接用：模型不需要靠标签猜。
out = await collectTool.execute(ctx, { messageId: '654321', note: '好图偷了' });
const dup = JSON.parse(out.content);
truthy('收藏返回的 id 可直接定位', typeof dup.id === 'string' && dup.id.startsWith('collected_'));
out = await noteTool.execute(ctx, { stickerId: dup.id, note: '撞备注也能改' });
truthy('用 id 改不受备注撞车影响', !out.isError && JSON.parse(out.content).id === dup.id);

console.log('\n=== 11. 【可用表情包】必须把"没标注的"点出来（需求 1 的入口） ===');
// 未标注 = bot 还没记过 localNote。**QQ 收藏里那些只有 QQ 名字的也算**（不论来源），
// 否则"先标记再按标签挑"这条闭环永远走不到它们身上。
const FRESH = [
  { id: 'collected_-1', url: 'https://x/1.png', desc: '刚刚收的', localNote: '', tags: ['搞笑'], useCount: 0, source: 'ai', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'collected_-2', url: 'https://x/2.png', desc: '', localNote: '', tags: [], useCount: 0, source: 'ai', createdAt: '2026-02-01T00:00:00.000Z' },
  { id: 'collected_-3', url: 'https://x/3.png', desc: '', localNote: '', tags: [], useCount: 0, source: 'ai', createdAt: '2026-03-01T00:00:00.000Z' },
  { id: 'collected_-4', url: 'https://x/4.png', desc: '', localNote: '', tags: [], useCount: 0, source: 'ai', createdAt: '2026-04-01T00:00:00.000Z' }
];
const menuFixture = [...LIB, ...FRESH];
const menu = buildStickerContext(menuFixture, 10);
truthy('QQ 里只有名字、bot 没看过的也算待标注（带 id=）', menu.includes('id=1130975926_0_0_0_1DD9'));
truthy('QQ 名一起带着（已有的线索不丢）', menu.includes('（QQ 名：蕾米的凝）'));
truthy('非 QQ 的待标注条目也带着它的名字', menu.includes('（名称：刚刚收的）'));
truthy('待标注的排在最前', menu.indexOf('id=1130975926') < menu.indexOf('DIO的肯定'));
eq('菜单最前面那 3 个就是本轮优先标注的', (menu.match(/id=\S+/g) || []).slice(0, 3),
  ['id=1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0', 'id=collected_-4', 'id=collected_-3']);
eq('所有还没标注的都带 id=（规则统一，不会有的带有的不带）', (menu.match(/id=\S+/g) || []).length, 7);
truthy('打得多的先标（用得越频繁越值得知道它是什么）', menu.indexOf('id=1130975926') < menu.indexOf('id=collected_-4'));
truthy('同频率里新收的先标', menu.indexOf('id=collected_-4') < menu.indexOf('id=collected_-3'));
falsy('bot 标注过的（有 localNote）不带 id', menu.includes('id=sticker_dio') || menu.includes('id=collected_-162267900'));
truthy('剩下的位置照旧按使用次数排 —— 菜单不会被"未标注"饿成三行',
  menu.includes('DIO的肯定') && menu.includes('别人的图'));
truthy('段头报出还剩几个没标注', menu.includes('另有 4 个'));

const menuTight = buildStickerContext(menuFixture, 2);
eq('菜单位置紧张时待标注的按 limit 缩', (menuTight.match(/id=\S+/g) || []).length, 2);
truthy('段头跟着报剩余数量', menuTight.includes('另有 5 个'));

console.log('\n=== 12. 整行粘贴也能认（cleanStickerRef / resolveStickerRef） ===');
eq('剥掉列表符号 + 标签块 + 使用次数', cleanStickerRef('- 蕾米的凝 [东方]（用过3次）')[0], '蕾米的凝');
eq('id= 是最可信的候选（排在第一位）', cleanStickerRef('- （未标注）id=collected_-1 [搞笑]')[0], 'collected_-1');
eq('id= 后面跟着的名字不会把 id 一起吞掉', cleanStickerRef('- （未标注）id=collected_-1 （QQ 名：蕾米的凝） [东方]（用过3次）')[0], 'collected_-1');
eq('（QQ 名：…）这块装饰不影响标签候选', cleanStickerRef('蕾米的凝（QQ 名：蕾米的凝）')[0], '蕾米的凝');
eq('备注本身就叫 [doge] 时不被吃掉', cleanStickerRef('[doge]')[0], '[doge]');
eq('带 ?id= 的图床地址不会被当成 id 抽出来', cleanStickerRef('https://x/img?id=9')[0], 'https://x/img?id=9');
truthy('清理后为空也不丢用户原话', cleanStickerRef('（用过3次）').includes('（用过3次）'));
eq('空串 → 没有候选', cleanStickerRef('   '), []);

eq('resolve：整行粘贴能还原到那个表情', resolveStickerRef(menuFixture, '- 蕾米的凝 [东方]（用过3次）').entry?.id, '1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0');
eq('resolve：未标注的整行（id= 那条）也能还原', resolveStickerRef(menuFixture, '- （未标注）id=collected_-2 [搞笑]').entry?.id, 'collected_-2');
eq('resolve：QQ 收藏的整行（含 QQ 名）也能还原', resolveStickerRef(menuFixture, '- （未标注）id=1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0 （QQ 名：蕾米的凝） [东方]（用过3次）').entry?.id, '1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0');
eq('resolve：id= 优先于标签歧义', resolveStickerRef(LIB, '- （未标注）id=sticker_nine2 [9]').entry?.id, 'sticker_nine2');
eq('resolve：纯标签仍不被 URL 子串抢走（老契约）', resolveStickerRef(LIB, 'DIO').entry, null);
eq('resolve：标签歧义时报候选，不猜', resolveStickerRef(LIB, '9').ambiguous.map((e) => e.id), ['sticker_nine', 'sticker_nine2']);
eq('resolve：完全找不到 → 候选为空', resolveStickerRef(LIB, '根本没有这个'), { entry: null, ambiguous: [] });

console.log('\n=== 13. 收藏时把图落到本地缓存，发送就用本机图片（需求 2） ===');
// 真起一个本地假图床，走真实的 validateImageUrl + safeFetchBinary ——
// 只有真的下载、真的写盘，"从文件夹里拿图片"这条才算被证明过。
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex');
let imgHits = 0;
const startImgSrv = async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/ok.png') { imgHits++; res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
};

const CACHE_DIR = path.join(DIR, 'sticker-cache');
updateConfig({ security: { allowPrivateImageHosts: true } });
const img1 = await startImgSrv();
const c1 = await mgr.collect('777001', { url: `${img1.url}/ok.png`, note: '本地缓存用例' });
truthy('collect 把图落了盘（条目带 cacheFile）', !!c1?.cacheFile);
truthy('cacheFile 只是文件名，不含路径（换数据目录才不会失效）', !c1.cacheFile.includes('/') && !c1.cacheFile.includes('\\'));
const c1file = path.join(CACHE_DIR, c1.cacheFile);
truthy('data/sticker-cache/ 下真有这个文件', fs.existsSync(c1file));
eq('文件内容就是图床给的字节', fs.readFileSync(c1file).equals(PNG), true);
eq('图床确实被请求过一次', imgHits >= 1, true);

// 关掉图床：此后任何"还能取到图"都只可能来自本地文件
await new Promise((r) => img1.srv.close(r));

const sent = [];
const ctx2 = {
  ...ctx,
  sender: {
    sendSticker: async (chatKey, sticker, options) => {
      sent.push({ chatKey, id: sticker.id, file: options.file });
      return { message_id: 1 };
    }
  }
};

out = await sendTool.execute(ctx2, { stickerId: c1.id });
truthy('图床关了也发得出去（说明没走网络）', !out.isError);
eq('发给协议端的是本机绝对路径', path.isAbsolute(sent[0].file), true);
eq('而且就是缓存目录里的那个文件', path.resolve(sent[0].file), path.resolve(c1file));

out = await imgTool.execute(ctx2, { stickerId: c1.localNote });
const imgPart = (out.content || []).find((p) => p?.image_url?.url);
truthy('看图认备注，且直接读本地文件（图床已关）', !!imgPart && imgPart.image_url.url.startsWith('data:image/png;base64,'));
eq('取到的就是那张图的字节', Buffer.from(imgPart.image_url.url.split(',')[1], 'base64').equals(PNG), true);

// 缓存文件丢了（手删、同步崩了）：不能因此发不出去 —— 退回原始链接，行为与改动前一致
fs.rmSync(c1file, { force: true });
sent.length = 0;
out = await sendTool.execute(ctx2, { stickerId: c1.id });
truthy('缓存文件不在也照样发（不阻断）', !out.isError);
eq('退回的是原始图片地址', sent[0].file, c1.url);

console.log('\n=== 14. 发送/看图也认备注标签（需求 1 的后半截） ===');
sent.length = 0;
out = await sendTool.execute(ctx2, { stickerId: '蕾米的凝' });
truthy('按备注发送成功', !out.isError);
eq('发出去的确实是那一条', sent[0].id, '1130975926_0_0_0_1DD908F75F04A6DA5987B56408F46D59_0_0');

sent.length = 0;
out = await sendTool.execute(ctx2, { stickerId: '9' });
truthy('标签歧义时拒发（发错表情比报错更糟）', out.isError === true);
truthy('报错带候选 id', out.content.includes('sticker_nine') && out.content.includes('sticker_nine2'));
eq('歧义时一张都没发出去', sent.length, 0);

out = await sendTool.execute(ctx2, { stickerId: '- 9（用过0次）' });
truthy('整行粘贴进来也是"歧义"而不是"找不到"', out.isError === true && out.content.includes('2 个表情'));

out = await imgTool.execute(ctx2, { stickerId: '9' });
truthy('看图同样认标签、同样报歧义', out.isError === true && out.content.includes('sticker_nine2'));

console.log('\n=== 15. 上限淘汰：只删 bot 自己收藏的（需求 3） ===');
const evLib = [
  { id: 'q1', source: 'qq', useCount: 0, createdAt: '2020-01-01T00:00:00.000Z' },
  { id: 'a_low_old', source: 'ai', useCount: 0, createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'a_low_new', source: 'ai', useCount: 0, createdAt: '2025-01-01T00:00:00.000Z' },
  { id: 'a_used', source: 'ai', useCount: 9, createdAt: '2023-01-01T00:00:00.000Z' }
];
eq('超上限时删的是"用得最少、同频率里收得最早"的那条', selectEvictions(evLib, 2).drop.map((e) => e.id), ['a_low_old']);
eq('用得多的不会被删（哪怕它最老）', selectEvictions(evLib, 2).keep.some((e) => e.id === 'a_used'), true);
eq('QQ 收藏一条都不管（既不算进上限也不删）', selectEvictions(evLib, 1).drop.map((e) => e.id), ['a_low_old', 'a_low_new']);
eq('上限 ≥ 条数 → 一条不删', selectEvictions(evLib, 3).drop.length, 0);
eq('0 = 不限（默认绝不能删数据）', selectEvictions(evLib, 0).drop.length, 0);
eq('非数字 = 不限', selectEvictions(evLib, NaN).drop.length, 0);

fs.mkdirSync(CACHE_DIR, { recursive: true });
const deadFile = path.join(CACHE_DIR, 'a_seed1_deadbeef.png');
fs.writeFileSync(deadFile, PNG);
fs.writeFileSync(path.join(DIR, 'stickers.json'), JSON.stringify([
  { id: 'q_seed', url: 'https://gchat.qpic.cn/x', desc: 'QQ 的', source: 'qq', useCount: 99, createdAt: '2020-01-01T00:00:00.000Z' },
  { id: 'a_seed1', url: 'https://x/1.png', desc: '老收藏', source: 'ai', useCount: 0, createdAt: '2024-01-01T00:00:00.000Z', cacheFile: 'a_seed1_deadbeef.png' },
  { id: 'a_seed2', url: 'https://x/2.png', desc: '新收藏', source: 'ai', useCount: 0, createdAt: '2025-01-01T00:00:00.000Z' }
], null, 2), 'utf8');
updateConfig({ sticker: { enabled: true, collectEnabled: true, maxCollectPerHour: 100, maxKeepCount: 2 } });
const mgr2 = new StickerManager(offlineOnebot);

const img2 = await startImgSrv();
const c3 = await mgr2.collect('900001', { url: `${img2.url}/ok.png`, note: '第三张' });
eq('淘汰掉的是那条', (mgr2.lastEvicted || []).map((e) => e.id), ['a_seed1']);
truthy('被淘汰条目的本地图片一起删了', !fs.existsSync(deadFile));
truthy('QQ 收藏一条没动', mgr2.entries.some((e) => e.id === 'q_seed'));
truthy('刚收藏的那条没被删（useCount 0 里它最新）', mgr2.entries.some((e) => e.id === c3.id));
truthy('新收藏的图照样落盘（上限管的是条数，不是禁止缓存）', !!c3.cacheFile && fs.existsSync(path.join(CACHE_DIR, c3.cacheFile)));
eq('淘汰后 bot 收藏正好剩上限那么多', mgr2.entries.filter((e) => e.source !== 'qq').length, 2);

out = await collectTool.execute({ ...ctx, stickers: mgr2 }, { messageId: '900002', note: '第四张' });
const dup2 = JSON.parse(out.content);
truthy('回执里说清了删了谁（删收藏不能静默）', dup2.hint.includes('上限') && dup2.hint.includes('新收藏'));
await new Promise((r) => img2.srv.close(r));

console.log('\n=== 16. 新字段必须进白名单（不然一次读写就丢） ===');
eq('cacheFile 活过一次归一化', normalizeStickerEntry({ id: 'x', url: 'u', cacheFile: 'x_ab12cd34.png', cachedAt: '2026-01-01T00:00:00.000Z' }).cacheFile, 'x_ab12cd34.png');
eq('cachedAt 同上', normalizeStickerEntry({ id: 'x', url: 'u', cachedAt: '2026-01-01T00:00:00.000Z' }).cachedAt, '2026-01-01T00:00:00.000Z');
eq('没进白名单的字段确实会被吞（这就是要守着它的原因）', normalizeStickerEntry({ id: 'x', url: 'u', cachePath: 'C:/x.png' }).cachePath, undefined);
const backOnDisk = loadStickerStore(path.join(DIR, 'stickers.json')).find((e) => e.id === c3.id);
truthy('写盘 → 读回，cacheFile 仍在（发送时靠它找本地图）', !!backOnDisk?.cacheFile);
eq('读回来的文件名没被打歪', backOnDisk?.cacheFile, c3.cacheFile);

console.log('\n=== 17. 策略段要把"先标注再判断"说出来（不然菜单里的 id= 没人用） ===');
const hint = buildStickerStrategyHint(1);
truthy('点名两种来源都算（自己收藏的 + QQ 里原来就有的）', hint.includes('自己收藏的') && hint.includes('QQ 里原来就有的'));
truthy('说清顺序：先看图 → 标注 → 再判断这张合不合适', /先 get_sticker_image 看图[\s\S]{0,120}?标注完再判断/.test(hint));
truthy('一轮最多标 3 个（与菜单里那 3 个的额度对齐）', hint.includes('一轮最多标 3 个'));
truthy('不确定的先看图，不要瞎发', hint.includes('先 get_sticker_image 看图再决定'));
truthy('发送那行仍然说清备注/标签能用、撞了会报歧义', hint.includes('唯一命中时才作数'));

console.log('\n=== 18. 读图路径：真下载 → 转 data URL（这条以前没人守） ===');
// detectMime 从 tools.js 搬去 safe-fetch.js 后只 `export {…} from` 转出、忘了 import，
// 本模块里用它就 ReferenceError —— 而当时没有任何用例走过"真下载一张图"这条路，
// 结果是 get_message_images 整条链子在真机上全灭（报 detectMime is not defined）。
const img3 = await startImgSrv();
const ctxImg = { ...ctx, store: { findByMid: () => ({ mid: '972644978', media: [{ kind: 'image', url: `${img3.url}/ok.png` }] }) } };
const imgMsgTool = tools.find((t) => t.name === 'get_message_images');
out = await imgMsgTool.execute(ctxImg, { messageId: '972644978' });
truthy('真下载一张图能拿到图（不再是 detectMime is not defined）', Array.isArray(out.content) && !out.isError, JSON.stringify(out).slice(0, 200));
const got = (out.content || []).find((p) => p?.image_url?.url);
truthy('转成了 data URL 交给视觉模型', !!got && got.image_url.url.startsWith('data:image/png;base64,'), got?.image_url?.url?.slice(0, 40));
eq('字节没被打歪', Buffer.from(got.image_url.url.split(',')[1], 'base64').equals(PNG), true);
truthy('前面还带一句说明', (out.content || []).some((p) => p.type === 'text' && p.text.includes('972644978')));

out = await imgMsgTool.execute({ ...ctxImg, store: { findByMid: () => ({ mid: '1', media: [{ kind: 'image', url: `${img3.url}/nope.png` }] }) } }, { messageId: '1' });
truthy('取不到图时如实报错（不静默交出空图）', out.isError === true && out.content.startsWith('错误：图片获取失败'));
await new Promise((r) => img3.srv.close(r));

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
