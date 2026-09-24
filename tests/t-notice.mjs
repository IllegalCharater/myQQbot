// 验证：群公告卡片解析 + read_group_notice 工具链路（不接真实 QQ）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { load } from './lib/src.mjs';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-notice-'));
process.env.QQ_AGENT_DATA_DIR = DIR;

const { parseCardSegment, decodeBase64Text, OneBotClient } = await load('onebot.js');
const { buildToolDefs } = await load('tools.js');
const { buildSystemPrompt } = await load('prompt.js');
const { updateConfig } = await load('config.js');
const { ChatStore } = await load('store.js');

updateConfig({ persona: { botName: '小鲸鱼', selfNickname: '小鲸鱼' }, api: { model: 'stub', baseUrl: 'http://x' } });

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const okv = JSON.stringify(got) === JSON.stringify(want);
  okv ? pass++ : fail++;
  console.log(`${okv ? '  ✅' : '  ❌'} ${label}`);
  if (!okv) console.log(`       得到 ${JSON.stringify(got)}\n       期望 ${JSON.stringify(want)}`);
};
const truthy = (label, v) => { v ? pass++ : fail++; console.log(`${v ? '  ✅' : '  ❌'} ${label}`); if (!v) console.log('       实际:', JSON.stringify(v)); };

console.log('\n=== 1. decodeBase64Text 边界 ===');
eq('用户那条 "576k5YWs5ZGK" → 群公告', decodeBase64Text('576k5YWs5ZGK'), '群公告');
eq('长中文 base64', decodeBase64Text(Buffer.from('新的群公告：本周六晚八点开黑', 'utf8').toString('base64')), '新的群公告：本周六晚八点开黑');
eq('普通中文标题不误伤', decodeBase64Text('张三'), '');
eq('普通英文标题不误伤', decodeBase64Text('QQ音乐'), '');
eq('英文 base64 被拒（无 CJK）', decodeBase64Text('aGVsbG8gd29ybGQ='), '');
eq('太短被拒', decodeBase64Text('abcd'), '');
eq('长度非 4 倍数被拒', decodeBase64Text('5paw55qE576k5YWs5ZGK1'), '');
eq('控制字符载荷被拒', decodeBase64Text(Buffer.from('群\u0001公告', 'utf8').toString('base64')), '');
eq('非字符串被拒', decodeBase64Text(null), '');

console.log('\n=== 2. 卡片解析：公告卡片 ===');
const announceCard = {
  app: 'com.tencent.mobileqq.announce', view: 'main', desc: '群公告', prompt: '[群公告]', ver: '0.0.0.1',
  meta: { detail_1: { appid: '', desc: '', title: '576k5YWs5ZGK', view: 'main', host: { nick: '群主', uin: 12345 }, icon: 'http://example.com/a.png' } }
};
const a = parseCardSegment({ data: JSON.stringify(announceCard) });
console.log('  text =', a.text);
truthy('渲染成 [群公告] 占位符', a.text.startsWith('[群公告]'));
truthy('提到 read_group_notice', a.text.includes('read_group_notice'));
truthy('不再出现 base64 原文', !a.text.includes('576k5YWs5ZGK'));
eq('media 仍是 kind:card', a.media[0]?.kind, 'card');

console.log('\n=== 2b. 公告卡片的另外两种识别路径 ===');
// 只有 prompt 带 [群公告]，app 不是 announce、title 也不是"群公告"
const promptOnly = { app: 'com.tencent.structmsg', view: 'main', prompt: '[群公告]', meta: { detail_1: { title: '本周活动安排' } } };
const po = parseCardSegment({ data: JSON.stringify(promptOnly) });
truthy('靠 prompt "[群公告]" 兜底也能识别（带方括号，历史上这里是死分支）', po.text.startsWith('[群公告]'));
// 只有解码后的 title 恰好是"群公告"
const titleOnly = { app: 'x.y', view: 'v', meta: { d: { title: Buffer.from('群公告', 'utf8').toString('base64') } } };
const to = parseCardSegment({ data: JSON.stringify(titleOnly) });
truthy('靠 title 解出"群公告"也能识别', to.text.startsWith('[群公告]'));
eq('不重复啰嗦"标题：群公告"', /标题：群公告/.test(to.text), false);

console.log('\n=== 3. 卡片解析：回归（普通卡片逐字未变）===');
const music = { app: 'com.tencent.structmsg', view: 'music', meta: { music: { title: '某首歌', desc: '某歌手', jumpUrl: 'https://y.qq.com/x', tag: 'QQ音乐', preview: 'https://p.qpic.cn/c.png' } } };
const m = parseCardSegment({ data: JSON.stringify(music) });
eq('音乐卡片文本未变', m.text, '[卡片 QQ音乐] 标题：某首歌 ｜ 描述：某歌手 ｜ 链接：https://y.qq.com/x');
eq('音乐卡片 media 未变', m.media.map((x) => x.kind), ['card', 'image']);

console.log('\n=== 4. 卡片解析：先解码再截断（长 base64）===');
const longText = '群公告：'.repeat(1) + '本周活动安排'.repeat(30);   // > 120 字符
const longB64 = Buffer.from(longText, 'utf8').toString('base64');
truthy('长 base64 本身超过 120 字符', longB64.length > 120);
const lb = parseCardSegment({ data: JSON.stringify({ app: 'x.y', view: 'v', meta: { d: { title: longB64 } } }) });
const decodedLen = lb.text.replace(/^\[卡片[^\]]*\] 标题：/, '').replace(/…$/, '').length;
truthy(`长 base64 被完整解码（原文 ${longText.length} 字，解出 ${decodedLen} 字，没被 120 截断）`, decodedLen === longText.length);

console.log('\n=== 5. 提示词 ===');
const sp = buildSystemPrompt();
truthy('提示词里有 [群公告] → read_group_notice 说明', sp.includes('[群公告]') && sp.includes('read_group_notice'));
truthy('提示词点明公告卡片是分享卡片的例外', /例外/.test(sp));

// ── 6. read_group_notice 工具链路（假 OneBot HTTP 服务）──
console.log('\n=== 6. read_group_notice 工具链路 ===');
let mode = 'ok';   // ok | fallback | allfail | weird | huge | many
const srv = http.createServer((req, res) => {
  const action = req.url.replace(/^\//, '');
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (mode === 'ok' && action === 'get_group_notice') {
      return reply({ status: 'ok', retcode: 0, data: [
        { notice_id: 'n1', sender_id: '999', publish_time: Math.floor(Date.now() / 1000), message: { text: Buffer.from('群规：禁止刷屏', 'utf8').toString('base64'), images: [] } },
        { notice_id: 'n2', sender_id: '888', publish_time: Math.floor(Date.now() / 1000) - 86400, message: { text: '本周六晚八点开黑', images: [{ id: 'a' }, { id: 'b' }] } }
      ] });
    }
    if (mode === 'fallback' && action === '_get_group_notice') {
      return reply({ status: 'ok', retcode: 0, data: { notices: [{ notice_id: 'n9', sender_id: '777', publish_time: Math.floor(Date.now() / 1000), message: { text: '只有旧接口能拿到的公告' } }] } });
    }
    // 结构不认识：既不是数组，也没有 notices / data 字段
    if (mode === 'weird' && action === 'get_group_notice') {
      return reply({ status: 'ok', retcode: 0, data: { notice_list: [{ id: 'x' }] } });
    }
    // 单条超长正文（3000 字，远超 NOTICE_TEXT_MAX = 1500）
    if (mode === 'huge' && action === 'get_group_notice') {
      return reply({ status: 'ok', retcode: 0, data: [{ notice_id: 'big', sender_id: '1', publish_time: Math.floor(Date.now() / 1000), message: { text: '公告正文'.repeat(750) } }] });
    }
    // 10 条各 2000 字：单条截到 1501，整批 6000 预算装不下
    if (mode === 'many' && action === 'get_group_notice') {
      return reply({ status: 'ok', retcode: 0, data: Array.from({ length: 10 }, (_, i) => ({
        notice_id: 'm' + i, sender_id: '1', publish_time: Math.floor(Date.now() / 1000) - i * 60,
        message: { text: `第${i}条：` + '公告正文'.repeat(500) }
      })) });
    }
    reply({ status: 'failed', retcode: 1404, wording: 'unsupported action: ' + action });
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const onebot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: `http://127.0.0.1:${PORT}`, accessToken: '', onEvent: () => {} });
const store = new ChatStore(0);
store.appendIncoming('group:123', { mid: 1, ts: Date.now(), senderId: '888', senderName: '李四', text: 'hi' });
const tool = buildToolDefs().find((t) => t.name === 'read_group_notice');
truthy('工具已注册', !!tool);
const ctx = { kind: 'group', chatId: '123', chatKey: 'group:123', onebot, store };

mode = 'ok';
let r = JSON.parse((await tool.execute(ctx, {})).content);
console.log('  →', JSON.stringify(r));
eq('返回 2 条公告', r.count, 2);
eq('base64 正文被解码', r.notices.find((n) => n.text.includes('群规'))?.text, '群规：禁止刷屏');
eq('图片张数带上', r.notices.find((n) => n.images)?.images, 2);
eq('发布者名字从聊天记录解析出来', r.notices.find((n) => n.sender === '李四')?.sender, '李四');
eq('senderId 一并返回（模型要 @ 发布者时用得上）', r.notices.find((n) => n.text.includes('群规'))?.senderId, '999');
eq('按时间倒序（最新在前）', r.notices[0].text, '群规：禁止刷屏');

console.log('\n  -- 响应结构不认识（不能答成"这个群没有公告"）--');
mode = 'weird';
const ew = await tool.execute(ctx, {});
truthy('返回 isError', ew.isError === true);
console.log('  →', ew.content);
truthy('点明结构不认识', /无法识别的结构/.test(ew.content));
truthy('带上真实字段名，方便定位版本差异', /notice_list/.test(ew.content));
truthy('没有谎称"这个群还没有发过群公告"', !/还没发过/.test(ew.content));

console.log('\n  -- 超长公告被截断 --');
mode = 'huge';
const rh = JSON.parse((await tool.execute(ctx, {})).content);
eq('截到 NOTICE_TEXT_MAX 再补省略号', rh.notices[0].text.length, 1501);
truthy('结尾是省略号', rh.notices[0].text.endsWith('…'));

console.log('\n  -- 整批预算（10 条各 2000 字）--');
mode = 'many';
const rm = JSON.parse((await tool.execute(ctx, { limit: 10 })).content);
truthy(`没有全塞进来（total=${rm.total} count=${rm.count}）`, rm.count < rm.total && rm.count >= 3);
truthy('用 note 说明省略了几条，不静默丢', /省略/.test(String(rm.note)));

console.log('\n  -- 只有 _get_group_notice 可用时的回退链 --');
mode = 'fallback';
r = JSON.parse((await tool.execute(ctx, {})).content);
eq('回退链生效', r.notices?.[0]?.text, '只有旧接口能拿到的公告');

console.log('\n  -- 两个接口都失败 --');
mode = 'allfail';
const e = await tool.execute(ctx, {});
truthy('返回 isError', e.isError === true);
console.log('  →', e.content);
truthy('提示里点明协议端可能没这个接口', /协议端没有群公告接口/.test(e.content));
truthy('提示里给了下一步（不要编内容）', /不要编内容/.test(e.content));

console.log('\n  -- 私聊 --');
const e2 = await tool.execute({ ...ctx, kind: 'private', chatKey: 'private:1' }, {});
truthy('私聊明确回绝', e2.isError === true && /只在群聊/.test(e2.content));

srv.close();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
