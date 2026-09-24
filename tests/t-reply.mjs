// 验证：引用错人事故的两条修复（#id 可见性 + 提示词禁令）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-reply-'));
process.env.QQ_AGENT_DATA_DIR = DIR;
const { buildPastState, buildUserPrompt, buildSystemPrompt } = await load('prompt.js');
const { updateConfig } = await load('config.js');
const { ChatStore } = await load('store.js');

updateConfig({ persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' }, api: { model: 'stub', baseUrl: 'http://x' } });

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '  ✅' : '  ❌'} ${label}${cond ? '' : ' ' + extra}`); };

// ── 复刻 09/24 10:31 那次运行：10 条历史，其中只有 1 条带图 ──
const store = new ChatStore(0);
const KEY = 'group:623820457';
const t0 = new Date('2026-09-24T10:28:00').getTime();
const hist = [
  { mid: 1608895488, who: '我', self: true, text: '反正骂完还得买 优化个屁' },
  { mid: -322766845, who: '赤心', text: '00系商业成绩好像' },
  { mid: -507238434, who: '赤心', text: '反正万代根本不重视' },
  { mid: -1945536185, who: '赤心', text: '四台主角机' },
  { mid: -562467262, who: '赤心', text: '前前后后可能花了十几年才出齐' },
  { mid: 172230596, who: '赤心', text: '[图片]', media: [{ kind: 'image', url: 'https://x/a.jpg' }] },   // ← 被误引的那条
  { mid: 1085647448, who: '我', self: true, text: '熬到出齐 人都退坑了' },
  { mid: -1199277246, who: '清三', text: '为什么这么关注这个申必表情' },
  { mid: -788759164, who: '我', self: true, text: '盯一下怎么了' },
  { mid: -605347416, who: '清三', text: '和其他表情没什么区别吧' },
];
hist.forEach((h, i) => store.appendIncoming(KEY, {
  mid: h.mid, ts: t0 + i * 60000, senderId: h.self ? '9999' : (h.who === '赤心' ? '3228552813' : '2035800860'),
  senderName: h.who, text: h.text, media: h.media || []
}));
// 拍一拍：mid 为 null，进【本次唤醒】
const poke = store.appendIncoming(KEY, { mid: null, ts: t0 + 20000, senderId: '2035800860', senderName: '清三', text: '[拍一拍] 你拍了拍（来自 清三）', media: [] });
const ids = (t) => (t.match(/#-?\d+/g) || []);

console.log('\n=== 1. 【过去状态】的 #id 可见性（修复点 2）===');
const past10 = buildPastState(store, KEY, { excludeIds: [poke.id], limit: 10 });
console.log('  实际文本：\n' + past10.text.split('\n').map((l) => '    ' + l).join('\n'));
ok('10 行历史全部带上 #id（旧规则下只有 1 个）', ids(past10.text).length === 10, `实际 ${ids(past10.text).length} 个`);
ok('被误引那条第 1 行仍是赤心的图片', /#172230596 赤心：\[图片\]/.test(past10.text));
ok('紧邻拍一拍的前几条也能引用了（旧规则下它们没有 id）', ids(past10.text).includes('#-605347416') && ids(past10.text).includes('#-788759164'));

console.log('\n=== 2. 更早的消息仍不给 id（噪音控制）===');
for (let i = 0; i < 15; i++) store.appendIncoming(KEY, { mid: 5000 + i, ts: t0 - (20 - i) * 1000, senderId: '1', senderName: '路人', text: '更早的 ' + i, media: [] });
const past30 = buildPastState(store, KEY, { excludeIds: [], limit: 30 });
const lines = past30.text.split('\n');
const withId = lines.filter((l) => /#-?\d/.test(l)).length;
// 期望 = 最近 12 行 + 窗口外但凡带媒体的（这里是那张图，1 条）
const expected = 12 + lines.slice(0, lines.length - 12).filter((l) => /#172230596/.test(l)).length;
ok(`30 行里只有 ${expected} 行带 id（最近 12 行 + 窗口外带图的那 1 条）`, withId === expected, `实际 ${withId}`);
ok('最早那几行不带 id', !/#-?\d/.test(lines[0]));
ok('带图消息即使落在窗口外也保留 id', (() => {
  const far = buildPastState(store, KEY, { excludeIds: [], limit: 30 });
  return /#172230596/.test(far.text);
})());

console.log('\n=== 3. 提示词禁令（修复点 1）===');
const sp = buildSystemPrompt();
ok('系统提示写明"没有 #数字 的消息引用不了"', /没有 #数字 的引用不了/.test(sp));
ok('系统提示明确禁止拿别的消息的 id 凑', /不要拿别的消息的 #数字 去凑/.test(sp));
ok('系统提示点名拍一拍就是这类', /拍一拍/.test(sp) && /根本没有消息 id/.test(sp));
const up = buildUserPrompt({
  chatKey: KEY, kind: 'group', chatId: '623820457', chatName: '13号',
  triggerEntries: [store.recent(KEY, { limit: 1 })[0]], store, memory: { formatForPrompt: () => '' },
  selfNickname: '小鲸鱼', contextLimit: 10, recentCount: 5, lastMessageAt: Date.now()
});
ok('引导说明写明"宁可不用引用，也不要拿别的消息的 id 凑"', /宁可不用引用，也不要拿别的消息的 id 凑/.test(up));
ok('【过去状态】表头说明已与新规则一致', /最近的消息和带图的消息前有 #消息id/.test(up));
ok('旧表头那句（只有带图才有 id）已不复存在', !/带图的消息前有 #消息id，看图/.test(up));

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
