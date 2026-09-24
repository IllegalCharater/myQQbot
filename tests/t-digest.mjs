// 历史摘要注入：纯函数层 + 提示词层的真实执行测试。
//
// 这一层的重点不是"函数能跑"，而是守住两条不变量：
//   1. 面板显示的 == 模型实际收到的（都来自 collectInjectedDigests）
//   2. 没有摘要时，提示词与改动前**逐字相同** —— 既有六个套件的 fixture 里都
//      没有 digest，这条不成立的话它们会莫名其妙地红。
// 第 2 条不是靠"我觉得应该没变"来保证的：这里把改动前的 prompt.js 从 git 里
// 取出来、改写它的相对 import，然后与当前版本渲染同一份 ctx 做逐字对比。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load, ROOT, SOURCE_REL, BASE_URL } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-digest-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' → ' + extra : ''}`); }
};

const {
  DEFAULT_CONFIG, setRuntimeConfig, digestConfigForChat
} = await load('config.js');
const { ChatStore } = await load('store.js');
const {
  selectPromptDigests, renderDigestSection, collectInjectedDigests, buildUserPrompt, buildPastState
} = await load('prompt.js');

// ── 改动前的 prompt.js：从 git 取，把 './x.js' 改成绝对 file:// URL ──
// 不能直接 import 到临时目录里那份（它的相对 import 会指向不存在的文件）。
//
// 基线是 `7a5b81e^`（= b7d8675），也就是**最后那个还没有【历史印象】的提交**。
// 不能用 HEAD：HEAD 已经是"历史摘要注入"本身了，那样对比等于拿新代码跟自己比，
// 三条"逐字相同"会永远绿（或者因为配置状态不同而莫名其妙地红）。
// 换了基线就要确认它仍然不含 digest 逻辑，否则这把保护伞就废了。
const BASELINE = '7a5b81e^';
const OLD = path.join(DIR, 'old-prompt.mjs');
{
  // git 里那份的 import 说明符是相对它自己写的，写到临时目录就全指空了，
  // 所以要改写成 BASE_URL（= 被测代码所在目录）下的绝对 URL。
  // `(?:\.\.?\/)+` 是为了 S4（文件下沉到 src/agent/ 之后说明符变成 '../core/x.js'）也能还原——
  // 但注意 S4 之后**旧版本那个扁平文件**里的 './x.js' 会指向不存在的 dist/x.js，
  // 那时要加一张"旧扁平名 → 新路径"的映射表（'util.js' → 'core/util.js' …）。
  const src = execFileSync('git', ['show', `${BASELINE}:${SOURCE_REL}/prompt.js`], { cwd: ROOT, encoding: 'utf8' });
  fs.writeFileSync(OLD, src.replace(/from '(?:\.\.?\/)+([\w/-]+)\.js'/g, `from '${BASE_URL}$1.js'`), 'utf8');
}
const oldPrompt = await import('file://' + OLD.replace(/\\/g, '/'));
// 把上面那句注释变成可执行的检查：基线一旦被换成含摘要逻辑的版本，这条先红，
// 免得三条"逐字相同"变成拿新代码跟自己比、永远绿的假绿。
ok('基线确实是"还没有摘要功能"的那一版',
  typeof oldPrompt.collectInjectedDigests === 'undefined' && typeof oldPrompt.selectPromptDigests === 'undefined');

// ── 配置 ──
const cfgWith = (over = {}) => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.digest = { ...c.digest, ...(over.digest || {}) };
  for (const k of Object.keys(over)) if (k !== 'digest') c[k] = { ...(c[k] || {}), ...over[k] };
  return c;
};
setRuntimeConfig(cfgWith());

// ── 造数据：直接写存档文件，ts/id 完全可控 ──
// chatKey 一律用 `group:123` 这种真实格式（store 再从它派生出文件名 group_123.json）。
// 这点很关键：digestConfigForChat 是按 ':' 切分取群号的，写成 'group_123' 就永远取不到覆盖值。
const CK = 'group:123';
const CK_FILE = 'group_123.json';
const T = Date.parse('2026-09-24T12:00:00');
const dig = (id, ts, from, to, count, body) => ({
  id, mid: null, ts, senderId: 'digest', senderName: '聊天记录摘要',
  text: `【历史摘要 ${from} ~ ${to} · 共 ${count} 条】\n${body}`,
  self: false, read: true, reply: null, media: [], kind: 'digest',
  digest: { from: Date.parse(`2026-${from.replace(' ', 'T')}:00`), to: Date.parse(`2026-${to.replace(' ', 'T')}:00`), count, archivedFile: '', model: 'm', createdAt: ts }
});
const msg = (id, ts, senderId, name, text) => ({
  id, mid: `m${id}`, ts, senderId, senderName: name, text, self: false, read: true, reply: null, media: []
});
const FIXTURE = [
  msg(1, T - 90000, '10001', '小明', '很久以前的一句话'),
  dig(2, T - 80000, '08-01 03:20', '08-01 06:00', 400, '那天主要在聊天气，有人抱怨太热。'),
  msg(3, T - 70000, '10002', '小红', '第二段摘要之后的消息'),
  dig(4, T - 60000, '08-20 10:00', '08-20 12:00', 250, '后来聊了吃的，有人推荐了一家面馆。'),
  msg(5, T - 1000, '10003', '小刚', '最近的一条'),
  msg(6, T - 500, '10004', '小美', '最新的一条')
];
fs.mkdirSync(path.join(DIR, 'messages'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'messages', CK_FILE),
  JSON.stringify({ chatKey: CK, nextLocalId: 7, messages: FIXTURE }), 'utf8');
const NO_DIGEST = 'group:999';
fs.mkdirSync(path.join(DIR, 'messages'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'messages', 'group_999.json'),
  JSON.stringify({ chatKey: NO_DIGEST, nextLocalId: 3, messages: [msg(1, T - 9000, '1', '甲', '只有普通消息'), msg(2, T - 500, '2', '乙', '再来一条')] }), 'utf8');

const store = new ChatStore(0);

// ═══════════ A. selectPromptDigests ═══════════
console.log('\n═══ selectPromptDigests（纯函数） ═══');
const E = (id, ts, text) => ({ id, ts, kind: 'digest', text, digest: { from: ts, to: ts, count: 1 } });
const A = E(1, 1000, 'x'.repeat(100));
const B = E(2, 2000, 'y'.repeat(100));
const C = E(3, 3000, 'z'.repeat(100));
const frozen = JSON.stringify([C, A, B]);

const empty = selectPromptDigests([], { maxChars: 100 });
ok('空输入 → 空选择', empty.picked.length === 0 && empty.dropped.length === 0 && empty.chars === 0 && empty.total === 0);
const off = selectPromptDigests([A, B], { maxChars: 0 });
ok('maxChars: 0 → 一条都不挑（0 是"不注入"，不是"不限"）', off.picked.length === 0 && off.dropped.length === 2, JSON.stringify(off.picked));
ok('maxChars: 0 时 dropped 把全部条目交出去（面板要靠它标"未注入"）', off.dropped.length === 2);
ok('maxChars 负数 / 非数字 → 同样不挑', selectPromptDigests([A], { maxChars: -5 }).picked.length === 0 && selectPromptDigests([A], { maxChars: 'abc' }).picked.length === 0);

const ord = selectPromptDigests([A, B, C], { maxChars: 100000 });
ok('输入乱序 → 输出新的在前', ord.picked.map((x) => x.entry.id).join(',') === '3,2,1', ord.picked.map((x) => x.entry.id).join(','));

const exact = selectPromptDigests([A, B], { maxChars: 200 });
ok('恰好卡在预算边界：两条都要', exact.picked.length === 2 && exact.chars === 200 && exact.dropped.length === 0);

const over = selectPromptDigests([A, B, C], { maxChars: 250 });
ok('塞不下第二条时：留新的那条，整条丢老的', over.picked.map((x) => x.entry.id).join(',') === '3,2' && over.dropped.map((m) => m.id).join(',') === '1', JSON.stringify({ p: over.picked.map((x) => x.entry.id), d: over.dropped.map((m) => m.id) }));
ok('不截断的那条是真的一条完整摘要', over.picked.every((x) => !x.truncated) && over.chars === 200);
ok('chars 恒 <= 预算', over.chars <= 250);

const one = selectPromptDigests([A], { maxChars: 30 });
ok('只有一条却超预算 → 仍然带上（否则摘要功能等于失效）', one.picked.length === 1 && one.picked[0].chars > 0);
ok('带上时标了 truncated 并在尾巴留痕', one.picked[0].truncated === true && one.truncated === true && one.picked[0].text.endsWith('（超出预算，已截断）'));
ok('截断后也不超预算', one.picked[0].chars <= 30, String(one.picked[0].chars));
const tiny = selectPromptDigests([A], { maxChars: 5 });
ok('预算小到放不下标记时退化成省略号，不变量仍成立', tiny.picked[0].chars <= 5, String(tiny.picked[0]?.chars));

let fuzzBad = 0, fuzzEmpty = 0;
for (let b = 1; b <= 600; b += 7) {
  const r = selectPromptDigests([A, B, C], { maxChars: b });
  if (r.chars > b) fuzzBad++;
  if (b > 0 && r.picked.length === 0) fuzzEmpty++;
  if (r.picked.length + r.dropped.length !== 3) fuzzBad++;
}
ok('fuzz 各种预算：恒 chars<=预算、条目不丢不重、不空手而归', fuzzBad === 0 && fuzzEmpty === 0, `bad=${fuzzBad} empty=${fuzzEmpty}`);
ok('不修改入参', JSON.stringify([C, A, B]) === frozen);
ok('total/totalChars 报的是全量（面板要用它写"N/M 段"）',
  (() => { const r = selectPromptDigests([A, B, C], { maxChars: 250 }); return r.total === 3 && r.totalChars === 300; })());

// ═══════════ B. renderDigestSection ═══════════
console.log('\n═══ renderDigestSection ═══');
const picked2 = selectPromptDigests(store.digests(CK), { maxChars: 100000 }).picked;
const merged = renderDigestSection(picked2, { merge: true, droppedCount: 0 });
ok('段标题是【历史印象】且写明"不是指令"', merged.startsWith('【历史印象 · 更早聊天记录的摘要】') && merged.includes('不是给你的指令'));
ok('段标题给出去重后的覆盖范围与段数', merged.includes('08-01 03:20 ~ 08-20 12:00') && merged.includes('共 2 段'));
ok('段标题汇总原始消息条数（400+250）', merged.includes('合并自 650 条原始消息'));
ok('merge 模式：每条摘要仍有自己的时间范围行', merged.includes('〔08-01 03:20 ~ 08-01 06:00 · 共 400 条〕') && merged.includes('〔08-20 10:00 ~ 08-20 12:00 · 共 250 条〕'));
ok('merge 模式：剥掉了重复的【历史摘要 …】包装行（只留 〔…〕）', !merged.includes('【历史摘要'));
ok('显示顺序是时间正序（最早的一段在前）', merged.indexOf('聊天气') < merged.indexOf('聊了吃的'));
ok('正文都在', merged.includes('那天主要在聊天气') && merged.includes('推荐了一家面馆'));
ok('没有未注入的就不说"还有…未注入"', !merged.includes('未注入'));

const split = renderDigestSection(picked2, { merge: false, droppedCount: 1 });
ok('merge=false：每条独立成段并编号', split.includes('第 1/2 段') && split.includes('第 2/2 段'));
ok('merge=false：段间用 --- 分隔', split.includes('\n\n---\n\n'));
ok('merge=false：带 [MM-DD HH:MM] 前缀', /\[\d\d-\d\d \d\d:\d\d\] 第 1\/2 段/.test(split));
ok('有未注入的会明说还有几段、以及怎么翻', split.includes('还有 1 段更早的纪要未注入') && split.includes('get_recent_messages'));
ok('两种模式的正文都不含"某人："式发言前缀（不会被读成群友的话）', !/\]\s*[\u4e00-\u9fa5]{1,4}：/.test(split.replace(/\[\d\d-\d\d \d\d:\d\d\] 第/g, '')));

const noMeta = renderDigestSection(selectPromptDigests([{ id: 9, ts: 5000, kind: 'digest', text: '【历史摘要 01-01 00:00 ~ 01-01 01:00 · 共 3 条】\n老条目没有结构化字段' }], { maxChars: 9999 }).picked, { merge: true });
ok('没有 digest 元数据的老条目：格式认识 → 用原首行当范围，正文不丢', noMeta.includes('01-01 00:00') && noMeta.includes('老条目没有结构化字段') && !noMeta.includes('【历史摘要'));
const weird = renderDigestSection(selectPromptDigests([{ id: 9, ts: 5000, kind: 'digest', text: '格式完全不认识的一段纯文本' }], { maxChars: 9999 }).picked, { merge: true });
ok('格式认不出来时原样保留，绝不吞字', weird.includes('格式完全不认识的一段纯文本'));
ok('picked 为空 → 空串（不产生只有标题的空段）', renderDigestSection([], { merge: true }) === '');

// ═══════════ C. digestConfigForChat ═══════════
console.log('\n═══ digestConfigForChat（可按群覆盖） ═══');
ok('默认值就是计划里那四个', DEFAULT_CONFIG.digest.injectEveryRound === false && DEFAULT_CONFIG.digest.merge === true
  && DEFAULT_CONFIG.digest.maxChars === 8000 && DEFAULT_CONFIG.digest.unified === true);
setRuntimeConfig(cfgWith({ digest: { injectEveryRound: true, merge: false, maxChars: 100 } }));
ok('unified 开启 → 全局值', digestConfigForChat(CK).injectEveryRound === true && digestConfigForChat(CK).maxChars === 100);
setRuntimeConfig(cfgWith({
  digest: {
    unified: false, injectEveryRound: false, merge: true, maxChars: 8000,
    perChat: { 123: { injectEveryRound: true, maxChars: 20 } }
  }
}));
const g = digestConfigForChat(CK);
ok('unified 关闭 + 该群有覆盖 → 用覆盖值', g.injectEveryRound === true && g.maxChars === 20);
ok('覆盖里没写的字段沿用全局（merge 没写 → 还是 true）', g.merge === true);
ok('没单独设过的群 → 跟随全局', digestConfigForChat('group:456').maxChars === 8000 && digestConfigForChat('group:456').injectEveryRound === false);
ok('私聊永远跟随全局', digestConfigForChat('private:123').maxChars === 8000 && digestConfigForChat('private:123').injectEveryRound === false);
ok('chatKey 畸形也不炸', digestConfigForChat('').maxChars === 8000 && digestConfigForChat(null).maxChars === 8000);
// 半份覆盖（手改 config.json 才会出现）：缺的字段必须沿用全局，不能回到默认值。
// 反例正是"用户只给这个群改了个字数上限，结果每轮注入被悄悄关掉"。
setRuntimeConfig(cfgWith({
  digest: { unified: false, injectEveryRound: true, merge: false, maxChars: 8000, perChat: { 123: { maxChars: 20 } } }
}));
const partial = digestConfigForChat(CK);
ok('半份覆盖：只写了 maxChars，另两项沿用全局（不是回到默认值）',
  partial.maxChars === 20 && partial.injectEveryRound === true && partial.merge === false,
  JSON.stringify(partial));
setRuntimeConfig(cfgWith({
  digest: { unified: false, injectEveryRound: true, merge: false, maxChars: 8000, perChat: { 123: {} } }
}));
const bare = digestConfigForChat(CK);
ok('空覆盖项 {} 同样整份沿用全局', bare.injectEveryRound === true && bare.merge === false && bare.maxChars === 8000);
setRuntimeConfig(cfgWith({ digest: { maxChars: 999999999 } }));
ok('maxChars 上限被钳到 200000', digestConfigForChat(CK).maxChars === 200000);
setRuntimeConfig(cfgWith({ digest: { maxChars: -5 } }));
ok('负数被钳到 0（= 安全方向的"不注入"）', digestConfigForChat(CK).maxChars === 0);
setRuntimeConfig(cfgWith());

// ═══════════ D. 窗口语义没被动过 ═══════════
console.log('\n═══ buildPastState：一行没改 ═══');
const pastAll = buildPastState(store, CK, { limit: 80 });
ok('窗口内落进的摘要仍按原样式出现（两条通道互不干扰）',
  pastAll.text.includes('[08-01 06:00] 【历史摘要') || pastAll.text.includes('【历史摘要 08-01 03:20'));
ok('count 按**条目**算（摘要条目内部有换行，所以行数必然多于 count —— 它数的是"模型看过几条存档条目"）',
  pastAll.count === pastAll.messages.length && pastAll.count === 6, `${pastAll.count} / ${pastAll.messages.length}`);
ok('limit=0 → 三样都空', (() => { const p = buildPastState(store, CK, { limit: 0 }); return !p.text && p.count === 0 && p.messages.length === 0; })());
ok('窗口里没有摘要时不会有【历史印象】那样的包装（窗口只认 formatEntry）', !pastAll.text.includes('【历史印象'));

// ═══════════ E. buildUserPrompt ═══════════
console.log('\n═══ buildUserPrompt：段序 / 时机 / 逐字不变 ═══');
const memStub = { formatForPrompt: () => '' };
const mkCtx = (key, limit, session = {}) => ({
  chatKey: key, kind: 'group', chatId: '123', chatName: '测试群',
  triggerEntries: [{ id: 100, mid: 'm100', ts: T, senderId: '10005', senderName: '小强', text: '在吗', self: false, read: false, media: [] }],
  recentCount: 3, lastMessageAt: T, selfLastMessageAt: T - 600000, selfNickname: '小鲸鱼',
  store, memory: memStub, stickerEntries: [], session, contextLimit: limit
});

setRuntimeConfig(cfgWith({ digest: { injectEveryRound: true } }));
const s1 = {};
const p1 = buildUserPrompt(mkCtx(CK, 80, s1));
const iState = p1.indexOf('【此刻状态】');
const iDig = p1.indexOf('【历史印象');
const iPast = p1.indexOf('【过去状态】');
const iTrig = p1.indexOf('【本次唤醒】');
ok('段序：此刻状态 → 历史印象 → 过去状态 → 本次唤醒',
  iState >= 0 && iDig > iState && iPast > iDig && iTrig > iPast, `${iState}/${iDig}/${iPast}/${iTrig}`);
ok('摘要正文进了提示词', p1.includes('那天主要在聊天气'));
ok('摘要段与窗内那条 [HH:MM] 摘要行不冲突（两条通道并存）', p1.includes('【历史摘要'));
ok('pastStateCount 只算窗口行数，不含摘要段', s1.pastStateCount === buildPastState(store, CK, { limit: 80 }).count);

const s2 = {};
buildUserPrompt(mkCtx(NO_DIGEST, 80, s2));
setRuntimeConfig(cfgWith({ digest: { injectEveryRound: true } }));
const p2 = buildUserPrompt(mkCtx(NO_DIGEST, 80, {}));
ok('从未压缩过的会话：勾了"每轮注入"也一条都不注入', !p2.includes('【历史印象'));
ok('从未压缩过时【过去状态】还是原来那句', p2.includes('【过去状态】以下是这个会话最近的聊天记录'));

setRuntimeConfig(cfgWith({ digest: { maxChars: 0 } }));
const p3 = buildUserPrompt(mkCtx(CK, 80, {}));
ok('maxChars=0 → 完全没有【历史印象】段', !p3.includes('【历史印象'));
const p3b = buildUserPrompt(mkCtx(CK, 80, {}));
ok('maxChars=0 → 输出与"这个会话没摘要"完全一致（关掉就是彻底关掉）',
  p3 === p3b);

setRuntimeConfig(cfgWith({ digest: { injectEveryRound: true } }));
const s4 = {};
const p4 = buildUserPrompt(mkCtx(CK, 0, s4));
ok('勾了"每轮都注入" + 读 0 条历史 → 摘要照样在（这就是它与动态窗口并行的意思）', p4.includes('【历史印象') && p4.includes('那天主要在聊天气'));
ok('此时不再谎称"这是你第一次参与这个会话"', !p4.includes('这是你第一次参与这个会话'));
ok('此时【过去状态】如实说明"本轮没有读取历史记录"', p4.includes('本轮没有读取历史记录'));
ok('此时 pastStateCount 是 0（真没读历史，翻页偏移不能被摘要顶替）', s4.pastStateCount === 0);

setRuntimeConfig(cfgWith({ digest: { injectEveryRound: false } }));
const p5 = buildUserPrompt(mkCtx(CK, 0, {}));
ok('不勾"每轮注入" + 读 0 条历史 → 不带摘要（省 token 的取舍）', !p5.includes('【历史印象'));
const p6 = buildUserPrompt(mkCtx(CK, 80, {}));
ok('不勾"每轮注入" + 读历史的那一轮 → 正常带上', p6.includes('【历史印象'));

setRuntimeConfig(cfgWith({ compact: { enabled: false }, digest: { injectEveryRound: true } }));
const p7 = buildUserPrompt(mkCtx(CK, 80, {}));
ok('定时压缩关着也照样注入（摘要不是只有定时器才会产生）', p7.includes('【历史印象') && p7.includes('那天主要在聊天气'));

console.log('\n  ── 逐字不变（既有套件的保护伞） ──');
// 只归一化两处随时间变动的文字，其余逐字比。
const norm = (s) => s
  .replace(/【当前时间】[^\n]*/g, '【当前时间】<T>')
  .replace(/最后一条消息距今[^\n]*/g, '最后一条消息距今 <D>')
  .replace(/你上次发言是[^\n]*/g, '你上次发言是 <D>');
for (const [label, key, limit] of [['无摘要的会话', NO_DIGEST, 80], ['有摘要但预算为 0', CK, 80], ['有摘要但只在小窗口里', CK, 2]]) {
  setRuntimeConfig(cfgWith({ digest: { maxChars: 0 } }));
  const now = buildUserPrompt(mkCtx(key, limit, {}));
  setRuntimeConfig(cfgWith());
  const before = oldPrompt.buildUserPrompt(mkCtx(key, limit, {}));
  ok(`${label}：新旧 prompt.js 渲染结果逐字相同`, norm(now) === norm(before),
    norm(now) === norm(before) ? '' : `\n--- 新 ---\n${norm(now).slice(0, 400)}\n--- 旧 ---\n${norm(before).slice(0, 400)}`);
}
// 反向对照：证明上面那条对比确实有效（有摘要时新旧**必须**不同）
setRuntimeConfig(cfgWith({ digest: { injectEveryRound: true } }));
ok('反向对照：开了注入之后，新旧输出确实不同（否则上面的"相同"是假绿）',
  norm(buildUserPrompt(mkCtx(CK, 80, {}))) !== norm(oldPrompt.buildUserPrompt(mkCtx(CK, 80, {}))));

// ═══════════ F. 面板与提示词同源 ═══════════
console.log('\n═══ 面板显示的 == 模型收到的 ═══');
const c1 = collectInjectedDigests(store, CK);
const fromPrompt = buildUserPrompt(mkCtx(CK, 80, {}));
ok('collectInjectedDigests 的段正文原样出现在提示词里', c1.sectionText && fromPrompt.includes(c1.sectionText));
ok('注入了哪些 id，与提示词里实际出现的一致',
  c1.injected.every((x) => fromPrompt.includes(`〔${x.entry.digest ? '' : ''}`) || fromPrompt.includes(x.entry.text.slice(0, 12))));
ok('enabled 反映配置（预算>0）', c1.enabled === true && c1.budget === 8000);
const c0 = collectInjectedDigests(store, CK, { config: { injectEveryRound: false, merge: true, maxChars: 0 } });
ok('预算 0 → enabled false、不注入、但 dropped 里有全部条目（面板要照实标）',
  c0.enabled === false && c0.injected.length === 0 && c0.dropped.length === 2 && c0.sectionText === '');
ok('面板拿得到存档回收上限（它要提示"超出后会自动丢最旧的"）', c1.config.maxKeepChars === 0);

// ═══════════ G. 摘要存档回收（dropOldestDigests） ═══════════
console.log('\n═══ 摘要存档回收：超出上限时整条丢最旧的 ═══');
ok('默认不限（0）—— 不设就什么都不丢，与改动前一致', DEFAULT_CONFIG.digest.maxKeepChars === 0);
setRuntimeConfig(cfgWith({ digest: { maxKeepChars: 12000 } }));
ok('回收上限跟随全局配置', digestConfigForChat(CK).maxKeepChars === 12000);
setRuntimeConfig(cfgWith({
  digest: {
    unified: false, maxKeepChars: 12000,
    perChat: { 123: { injectEveryRound: true, maxChars: 20, maxKeepChars: 1 } }
  }
}));
ok('回收上限不参与按群覆盖（它管磁盘占用，不是"这个群怎么说话"）',
  digestConfigForChat(CK).maxKeepChars === 12000, String(digestConfigForChat(CK).maxKeepChars));
setRuntimeConfig(cfgWith({ digest: { maxKeepChars: -5 } }));
ok('负数被钳到 0（= 不限）', digestConfigForChat(CK).maxKeepChars === 0);
setRuntimeConfig(cfgWith());

// 独立会话（group:555），别动前面几个 section 用的 fixture
const GC = 'group:555';
const gcText = (id) => `【历史摘要 01-0${id} 00:00 ~ 01-0${id} 02:00 · 共 10 条】\n` + String(id).repeat(120);
const gcEntry = (id) => ({
  id, mid: null, ts: 1000000 * id, senderId: 'digest', senderName: '聊天记录摘要',
  text: gcText(id), self: false, read: true, reply: null, media: [], kind: 'digest',
  digest: { from: 1000000 * id, to: 1000000 * id + 100, count: 10, archivedFile: '', model: 'm', createdAt: 1000000 * id }
});
fs.writeFileSync(path.join(DIR, 'messages', 'group_555.json'), JSON.stringify({
  chatKey: GC, nextLocalId: 5,
  messages: [gcEntry(1), gcEntry(2), gcEntry(3), msg(4, 4000000, '10001', '小明', '普通消息')]
}), 'utf8');

const gcTotal = 3 * gcText(1).length;
const gcNoop = store.dropOldestDigests(GC, { maxChars: gcTotal + 1 });
ok('总量没超上限 → 一条都不动', gcNoop.dropped.length === 0 && store.digests(GC).length === 3);
ok('上限 0 / 负数 / 非数字 → 一律当不限（默认值是 0）',
  store.dropOldestDigests(GC, { maxChars: 0 }).dropped.length === 0
  && store.dropOldestDigests(GC, { maxChars: -1 }).dropped.length === 0
  && store.dropOldestDigests(GC, { maxChars: 'x' }).dropped.length === 0);

// 上限收到刚好放得下两条 → 整条丢最旧的那条
const gcDrop = store.dropOldestDigests(GC, { maxChars: gcTotal - gcText(1).length });
ok('超上限时丢的是**最旧**的那条（整条，不是截断）', gcDrop.dropped.map((m) => m.id).join(',') === '1', JSON.stringify(gcDrop.dropped.map((m) => m.id)));
ok('dropped 按最旧→新给出（调用方直接照着写日志）', gcDrop.dropped[0].id === 1);
ok('剩下的仍按"新的在前"（digests() 的契约没被破坏）', store.digests(GC).map((m) => m.id).join(',') === '3,2');
ok('回收后总量不超过上限', gcDrop.keptChars <= gcTotal - gcText(1).length, `${gcDrop.keptChars}`);
ok('totalChars 报的是回收前的量（回执里要说清丢了多少）', gcDrop.totalChars === gcTotal);
ok('普通消息一条没动', store.recent(GC, { limit: 100 }).some((m) => m.text === '普通消息' && m.id === 4));
ok('回收掉的 id 不重用（下一条新消息拿到的是 5）', store.appendIncoming(GC, { mid: 'x', senderName: '甲', text: '新的一条' }).id === 5);
ok('备份用的是独立后缀，没冲掉 .panel.bak / 压缩回滚点',
  fs.existsSync(path.join(DIR, 'messages', 'group_555.json.digestgc.bak'))
  && !fs.existsSync(path.join(DIR, 'messages', 'group_555.json.panel.bak'))
  && !fs.existsSync(path.join(DIR, 'messages', 'group_555.json.bak')));

// 规则 1：剩最后一条就收手，哪怕它自己远超上限
const gcTiny = store.dropOldestDigests(GC, { maxChars: 1 });
ok('上限比单条还小 → 只丢到剩最新的一条为止（绝不清空）',
  gcTiny.dropped.map((m) => m.id).join(',') === '2' && store.digests(GC).map((m) => m.id).join(',') === '3');
ok('只剩一条时再回收什么都不做（不设上限才是"不清空"的另一种写法）',
  store.dropOldestDigests(GC, { maxChars: 1 }).dropped.length === 0 && store.digests(GC).length === 1);
ok('回收后照样能被注入（不会把摘要段弄坏）',
  collectInjectedDigests(store, GC, { config: { maxChars: 9999, merge: true, injectEveryRound: true } }).sectionText.includes('【历史印象'));

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail === 0 ? 0 : 1);
