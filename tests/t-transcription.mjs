// 视频 URL 转写：命令边界、SSRF 快速拦截、环境变量回退、单并发状态机与配置脱敏。
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { checker, dataDir } from './lib/harness.mjs';
import { ROOT, load, stripComments } from './lib/src.mjs';

dataDir('qqagent-transcription-');
const { ok, done } = checker();

const {
  VideoTranscriptionQueue, buildFlashRecognitionRequest, normalizeTranscriptionUrl,
  parseTranscriptionCommand, resolveTranscriptionConfig
} = await load('media/transcription/index.js');
const { isBilibiliUrl, bilibiliUrlFromCandidates } = await load('media/media-source/parsers/bilibili.js');
const { cardPayloadCandidates, xmlPayloadCandidates } = await load('media/media-source/providers/card-payload.js');
const { DEFAULT_CONFIG, updateConfig } = await load('core/config.js');

const rejected = [
  'file:///etc/passwd', 'data:text/plain,hello', 'ftp://example.com/a.mp4',
  'http://localhost/a.mp4', 'http://127.0.0.1/a.mp4', 'http://[::1]/a.mp4',
  'http://10.1.2.3/a.mp4', 'http://172.16.0.1/a.mp4', 'http://172.31.255.254/a.mp4',
  'http://192.168.1.1/a.mp4', 'http://169.254.169.254/latest/meta-data'
];
ok('危险协议、本机、私网与云元数据字面地址全部被快速拦截',
  rejected.every((url) => {
    try { normalizeTranscriptionUrl(url); return false; } catch { return true; }
  }),
  rejected.filter((url) => { try { normalizeTranscriptionUrl(url); return true; } catch { return false; } }).join('、'));
ok('公网 http/https URL 可通过快速校验',
  normalizeTranscriptionUrl('https://example.com/a.mp4') === 'https://example.com/a.mp4');
ok('/转写 可取显式 URL，也可取 video media URL',
  parseTranscriptionCommand('/转写 https://example.com/a.mp4') === 'https://example.com/a.mp4'
  && parseTranscriptionCommand('/转写[视频]', [{ kind: 'video', url: 'https://example.com/b.mp4' }]) === 'https://example.com/b.mp4');
ok('普通聊天不是转写命令', parseTranscriptionCommand('看看这个视频 https://example.com/a.mp4') === null);
ok('B 站主站、移动站与短链可识别，近似域名不会误判',
  isBilibiliUrl('https://www.bilibili.com/video/BV1xx411c7mD')
  && isBilibiliUrl('https://m.bilibili.com/video/BV1xx411c7mD')
  && isBilibiliUrl('https://b23.tv/fixture')
  && !isBilibiliUrl('https://bilibili.com.evil.example/video/BV1xx411c7mD'));

// ── 卡片链接抽取（纯函数）───────────────────────────────────────
// B 站 App 分享到 QQ 的是小程序卡片：链接在 meta.detail_1.qqdocurl，通用卡片解析认的
// jumpUrl 根本不存在。只认 jumpUrl 的后果是卡片看着有链接、存档里却没有。
//
// ⚠️ 接口在 2026-10 拆成两层（按"改动理由"切，详见 `media/media-source/providers/card-payload.ts`）：
//   · `cardPayloadCandidates` / `xmlPayloadCandidates` —— 把报文摊平成"字段 + 候选链接"，**不认识平台**；
//   · `bilibiliUrlFromCandidates` —— 从候选里挑 B 站的，**不认识卡片字段名**。
// 下面照新接口写；`CARD_URL_FIELDS` 与 xm 的摊平都在适配器那一侧。
const cardData = (payload) => ({ data: JSON.stringify(payload) });
const CARD_FIELDS = ['qqdocurl', 'jumpUrl', 'url'];
const fromCard = (value) => bilibiliUrlFromCandidates(cardPayloadCandidates(value), CARD_FIELDS);
const fromXml = (value) => bilibiliUrlFromCandidates(xmlPayloadCandidates(value), CARD_FIELDS);

ok('小程序卡从 qqdocurl 取到链接（这个形态没有 jumpUrl）',
  fromCard(cardData({ app: 'com.tencent.miniapp_01', meta: { detail_1: { qqdocurl: 'https://www.bilibili.com/video/BV1xx411c7mD' } } }))
    === 'https://www.bilibili.com/video/BV1xx411c7mD');
ok('老式 news 卡的 jumpUrl 仍然认（回归）',
  fromCard(cardData({ meta: { news: { jumpUrl: 'https://b23.tv/legacy' } } })) === 'https://b23.tv/legacy');
ok('已解析成对象的卡片报文同样认（有的协议端不下发字符串）',
  fromCard({ data: { meta: { detail_1: { qqdocurl: 'https://b23.tv/obj' } } } }) === 'https://b23.tv/obj');
// 长度上限判的是**去掉首尾空白后**的报文（纯空白不算内容，也不必为它分配解析树）；
// 所以这里用一个真的超长报文，而不是往小报文后面补空格。
ok('非 B 站链接、坏 JSON、超大报文一律取不到',
  fromCard(cardData({ meta: { detail_1: { qqdocurl: 'https://example.com/video/1' } } })) === ''
  && fromCard({ data: '{不是 JSON' }) === ''
  && fromCard(cardData({ meta: { detail_1: { title: 'x'.repeat(40000), qqdocurl: 'https://b23.tv/x' } } })) === ''
  && fromCard(undefined) === '');
// 兜底扫描：字段名穷举不完。线上真实卡片 `com.tencent.miniapp_01` /
// `view_8C8E89B49BE609866298ADDFF2DBABA4` 解析出的 media 里 url 就是空的
// （kind:'card' 有 title/desc 却没有链接），而下游只认 kind:'video'，于是报"没有视频链接"。
ok('字段名不在白名单里时靠兜底扫描照样取到链接',
  fromCard(cardData({
    meta: { detail_1: { title: '哔哩哔哩', desc: '领赛博鸡蛋没想到家被偷', targetUrl: 'https://www.bilibili.com/video/BV1xx411c7mD' } }
  })) === 'https://www.bilibili.com/video/BV1xx411c7mD');
ok('白名单字段胜过扫描结果（卡片含多个链接时以目标字段为准）',
  fromCard(cardData({
    meta: { detail_1: { qqdocurl: 'https://b23.tv/wanted', extra: 'https://b23.tv/noise' } }
  })) === 'https://b23.tv/wanted');
ok('兜底扫描只认 B 站域名，卡片封面等第三方图床不会被当成视频',
  fromCard(cardData({
    meta: { detail_1: { preview: 'https://qq.ugcimg.cn/fixture-cover', icon: 'https://i0.hdslb.com/fixture.png' } }
  })) === '');
ok('白名单与扫描都取不到时不返回半截结果',
  fromCard(cardData({ meta: { detail_1: { url: 'mqqapi://miniapp/open' } } })) === '');
// 卡片报文是群成员可伪造的不可信输入：只读字段，绝不把对象展开进任何地方。
ok('伪造的卡片报文既不污染原型也不抛错',
  fromCard({ data: JSON.stringify({ __proto__: { polluted: 1 }, meta: { __proto__: { polluted: 1 } } }) }) === ''
  && ({}.polluted === undefined));
ok('xml 分享卡里抠出 B 站链接（&amp; 先还原）',
  fromXml('<msg serviceID="1"><item><url>https://b23.tv/a?x=1&amp;y=2</url></item></msg>') === 'https://b23.tv/a?x=1&y=2');
ok('xml 里没有 B 站链接时取不到',
  fromXml('<msg><url>https://example.com/a</url></msg>') === '' && fromXml(null) === '');

// ★ 方向性：`cardPayloadCandidates` 是**平台无关**的摊平 —— 非 B 站的地址也要照收，
// 由调用方去挑。它若自己就按 B 站过滤，将来第二个平台就没法复用它。
{
  const anyPayload = cardPayloadCandidates(cardData({ meta: { detail_1: { url: 'https://example.com/x' } } }));
  ok('★ 摊平层不按平台过滤（非 B 站地址照样进候选，供别的平台复用）',
    anyPayload.urls.includes('https://example.com/x'), JSON.stringify(anyPayload.urls));
  ok('摊平层给出白名单字段（字段名 → 值）', anyPayload.fields.url === 'https://example.com/x');
  ok('对照：B 站挑拣层才做域名判定（同一个候选它不认）',
    bilibiliUrlFromCandidates(anyPayload, CARD_FIELDS) === '');
}

const { createIngest } = await load('web/onebot/ingest.js');
const { ChatStore } = await load('chat/store.js');
const { ContextWindowRegistry } = await load('agent/context/context-window.js');
const commandStore = new ChatStore();
const commandWindows = new ContextWindowRegistry({ store: commandStore, capacity: 10 });
const priorEntry = commandStore.appendIncoming('group:123', {
  mid: 788, ts: Date.now() - 1, senderId: '456', senderName: '测试者', text: '先处理这条普通消息'
});
commandWindows.push('group:123', priorEntry);
const enqueuedCommands = [];
const commandReplies = [];
const forwardedToAgent = [];
const commandConfig = structuredClone(DEFAULT_CONFIG);
commandConfig.allowAllWhenEmpty = true;
const ingest = createIngest({
  onebot: { selfId: '999999' },
  store: commandStore,
  sender: { sendTextBatch: async (...args) => { commandReplies.push(args); return {}; } },
  orchestrator: {
    onIncoming: (...args) => {
      forwardedToAgent.push(args);
      commandWindows.push(...args);
    }
  },
  transcription: {
    enqueue: (input) => {
      enqueuedCommands.push(input);
      return { id: '12345678-fixture', chatKey: input.chatKey, status: 'queued', createdAt: 1, updatedAt: 1 };
    }
  },
  emit: () => {},
  getConfig: () => commandConfig,
  log: () => {}
});
await ingest.handle({
  post_type: 'message', message_type: 'group', group_id: 123, user_id: 456,
  message_id: 789, sender: { user_id: 456, nickname: '测试者' },
  message: [
    { type: 'text', data: { text: '/转写' } },
    { type: 'video', data: { url: 'https://example.com/from-media.mp4', file: 'fixture.mp4' } }
  ]
});
ok('真实入站命令只做入队与即时回执，不进入 LLM 调度',
  enqueuedCommands.length === 1 && enqueuedCommands[0].url === 'https://example.com/from-media.mp4'
  && commandReplies.length === 1 && String(commandReplies[0][1]).includes('已开始处理')
  && forwardedToAgent.length === 0
  && commandStore.findByMid('group:123', 789)?.read === true
  && commandStore.unreadCount('group:123') === 1);
ok('/转写 不会进入已有动态窗口，也不会误消费它之前的普通未读',
  commandWindows.pending('group:123').map((m) => m.mid).join(',') === '788',
  JSON.stringify(commandWindows.pending('group:123').map((m) => ({ mid: m.mid, text: m.text }))));
commandWindows.reload('group:123');
ok('窗口从存档重播后仍排除 /转写',
  commandWindows.pending('group:123').map((m) => m.mid).join(',') === '788');

const bilibiliCardUrl = 'https://b23.tv/fixture-card';
const cardCommands = [];
const cardReplies = [];
const cardIngest = createIngest({
  onebot: {
    selfId: '999999',
    getMsg: async () => ({
      sender: { nickname: '卡片发送者' },
      message: [{
        type: 'json',
        data: { data: JSON.stringify({
          app: 'com.tencent.structmsg', view: 'news',
          meta: { detail_1: { title: 'B站视频', desc: '测试卡片', jumpUrl: bilibiliCardUrl } }
        }) }
      }]
    })
  },
  store: new ChatStore(),
  sender: { sendTextBatch: async (...args) => { cardReplies.push(args); return {}; } },
  orchestrator: { onIncoming: () => { throw new Error('显式转写命令不应进入 Agent'); } },
  transcription: {
    enqueue: (input) => {
      cardCommands.push(input);
      return { id: 'card-task-fixture', chatKey: input.chatKey, status: 'queued', createdAt: 1, updatedAt: 1 };
    }
  },
  emit: () => {},
  getConfig: () => commandConfig,
  log: () => {}
});
await cardIngest.handle({
  post_type: 'message', message_type: 'group', group_id: 123, user_id: 456,
  message_id: 790, sender: { user_id: 456, nickname: '测试者' },
  message: [{ type: 'reply', data: { id: '789' } }, { type: 'text', data: { text: '/转写' } }]
});
ok('回复 B 站视频卡片发送 /转写，会从被引用卡片提取链接并立即入队',
  cardCommands.length === 1 && cardCommands[0].url === bilibiliCardUrl
  && cardReplies.length === 1 && String(cardReplies[0][1]).includes('已开始处理'));

// ── 引用（reply）的存档形状 ──────────────────────────────────────────────
// 被引用消息的 **id** 必须结构化地留下来，不能只把预览串拍进 text ——
// 典型故障：A 发图、B 引用那张图问"这是什么"，模型看见 `[引用 清三：[图片]]`，
// 而 `[图片]` 是常量占位符、同一发送者的两张图在文本上逐字相同，它只能瞎挑一个 id，
// 结果把**另一张图**当成了被引用的那张（实测踩到）。所以这一段的每一条都在钉"id 在不在"。
// ⚠️ 每个用例一个**独立的群号**：`new ChatStore()` 会从磁盘 `group_<id>.json` 重新载入，
// 同一个群号在同一个临时数据目录里是共享的 —— 存档里于是有多条 mid=800，而 `findByMid`
// 返回**最早**那条，后面的用例会拿到前面用例留下的条目（实测：断言读到的是 `[图片]`）。
async function replyIngestFor(groupId, { replyId = '789', getMsg, segments }) {
  const store = new ChatStore();
  const forwarded = [];
  const ingest = createIngest({
    onebot: { selfId: '999999', getMsg },
    store,
    sender: { sendTextBatch: async () => ({}) },
    orchestrator: { onIncoming: (...args) => { forwarded.push(args); } },
    transcription: { enqueue: () => { throw new Error('本用例不涉及转写'); } },
    emit: () => {},
    getConfig: () => commandConfig,
    log: () => {}
  });
  await ingest.handle({
    post_type: 'message', message_type: 'group', group_id: groupId, user_id: 456,
    message_id: 800, sender: { user_id: 456, nickname: '测试者' },
    message: segments ?? [{ type: 'reply', data: { id: replyId } }, { type: 'text', data: { text: '这是哪张图' } }]
  });
  return { store, forwarded, chatKey: `group:${groupId}` };
}
const quotedOf = (r) => r.store.findByMid(r.chatKey, 800);

const quoted = quotedOf(await replyIngestFor(130, {
  getMsg: async () => ({
    sender: { nickname: '清三' },
    message: [{ type: 'image', data: { url: 'https://example.com/quoted.png' } }]
  })
}));
ok('被引用消息的 id 结构化落库（不是拼进 text 的预览串）',
  quoted?.reply?.mid === '789' && quoted?.reply?.sender === '清三'
  && quoted?.reply?.text === '[图片]',
  JSON.stringify(quoted?.reply));
ok('预览不再拍进 text：正文只剩自己的话，引用段由渲染层从 reply 拼',
  quoted?.text === '这是哪张图' && !String(quoted?.text).includes('[引用'),
  JSON.stringify(quoted?.text));
ok('被引用消息解析失败时 id 仍然留下（拿不到正文不等于没有引用）',
  quotedOf(await replyIngestFor(131, { getMsg: async () => { throw new Error('协议端取消息失败'); } }))?.reply?.mid === '789');
ok('引用段没带 id 时不产生 reply（按"没有引用"处理）',
  quotedOf(await replyIngestFor(132, {
    getMsg: async () => ({ sender: { nickname: '清三' }, message: [] }),
    segments: [{ type: 'reply', data: {} }, { type: 'text', data: { text: '在吗' } }]
  }))?.reply === null);
const longPreview = quotedOf(await replyIngestFor(133, {
  getMsg: async () => ({ sender: { nickname: '清三' }, message: [{ type: 'text', data: { text: '很'.repeat(400) } }] })
}));
ok('引用预览按上限截断，不把整段正文搬进每一条引用它的消息',
  String(longPreview?.reply?.text).length === 300,
  String(longPreview?.reply?.text).length);

// 真实入站契约：把**原始段**换成本轮新增的两种形态，其余断言与上面的老卡片完全一致。
// 这三种形态的差异只在"链接藏在哪个字段/哪种段里"（老卡片 jumpUrl / 小程序 qqdocurl / xml 正文），
// 对下游（媒体别名 → /转写 与 transcribe_video）应当是同一件事。
async function cardIngestFor(groupId, rawSegments) {
  const commands = [];
  const replies = [];
  const ingest = createIngest({
    onebot: { selfId: '999999', getMsg: async () => ({ sender: { nickname: '卡片发送者' }, message: rawSegments }) },
    store: new ChatStore(),
    sender: { sendTextBatch: async (...args) => { replies.push(args); return {}; } },
    orchestrator: { onIncoming: () => { throw new Error('显式转写命令不应进入 Agent'); } },
    transcription: {
      enqueue: (input) => {
        commands.push(input);
        return { id: 'card-task-fixture', chatKey: input.chatKey, status: 'queued', createdAt: 1, updatedAt: 1 };
      }
    },
    emit: () => {},
    getConfig: () => commandConfig,
    log: () => {}
  });
  await ingest.handle({
    post_type: 'message', message_type: 'group', group_id: groupId, user_id: 456,
    message_id: 791, sender: { user_id: 456, nickname: '测试者' },
    message: [{ type: 'reply', data: { id: '789' } }, { type: 'text', data: { text: '/转写' } }]
  });
  return { commands, replies };
}

const miniappCard = await cardIngestFor(124, [{
  type: 'json',
  data: { data: JSON.stringify({
    app: 'com.tencent.miniapp_01', view: 'viewMultiMsg',
    meta: { detail_1: { title: '【B站】视频', qqdocurl: 'https://www.bilibili.com/video/BV1xx411c7mD' } }
  }) }
}]);
ok('小程序卡片（链接只在 qqdocurl）回复 /转写 也能取到链接入队',
  miniappCard.commands.length === 1
  && miniappCard.commands[0].url === 'https://www.bilibili.com/video/BV1xx411c7mD'
  && miniappCard.replies.length === 1 && String(miniappCard.replies[0][1]).includes('已开始处理'));

const xmlCard = await cardIngestFor(125, [{
  type: 'xml',
  data: { data: '<msg serviceID="1"><item><title>B站视频</title><url>https://b23.tv/xml-card</url></item></msg>' }
}]);
ok('xml 分享卡回复 /转写 同样能取到链接入队',
  xmlCard.commands.length === 1 && xmlCard.commands[0].url === 'https://b23.tv/xml-card'
  && xmlCard.replies.length === 1 && String(xmlCard.replies[0][1]).includes('已开始处理'));

const noLinkCard = await cardIngestFor(126, [{
  type: 'xml', data: { data: '<msg><item><url>https://example.com/not-bilibili</url></item></msg>' }
}]);
ok('没有 B 站链接的卡片不会造出假视频，也不会误入队',
  noLinkCard.commands.length === 0 && noLinkCard.replies.length === 1
  && String(noLinkCard.replies[0][1]).includes('用法：/转写'));

// 同一聊天的异步解析必须按 OneBot 到达顺序提交：第一条引用查询被阻塞时，
// 后到的简单消息不能抢先拿到更小的本地 id。
const orderedStore = new ChatStore();
let releaseReply;
const replyGate = new Promise((resolve) => { releaseReply = resolve; });
const orderedForwarded = [];
const orderedIngest = createIngest({
  onebot: {
    selfId: '999999',
    getMsg: async () => replyGate
  },
  store: orderedStore,
  sender: { sendTextBatch: async () => ({ sent: [], failed: [] }) },
  orchestrator: { onIncoming: (_chatKey, entry) => orderedForwarded.push(entry) },
  transcription: { enqueue: () => { throw new Error('不应进入转写'); } },
  emit: () => {},
  getConfig: () => commandConfig,
  log: () => {}
});
const firstIngest = orderedIngest.handle({
  post_type: 'message', message_type: 'group', group_id: 321, user_id: 456,
  message_id: 1, sender: { user_id: 456, nickname: '测试者' },
  message: [{ type: 'reply', data: { id: 'quoted' } }, { type: 'text', data: { text: '第一条' } }]
});
const secondIngest = orderedIngest.handle({
  post_type: 'message', message_type: 'group', group_id: 321, user_id: 456,
  message_id: 2, sender: { user_id: 456, nickname: '测试者' },
  message: [{ type: 'text', data: { text: '第二条' } }]
});
await new Promise((resolve) => setTimeout(resolve, 20));
ok('第一条仍在解析时，后到的同聊天消息不会抢先落库',
  orderedStore.recent('group:321', { limit: 10 }).length === 0);
releaseReply({ sender: { nickname: '被引用者' }, message: [{ type: 'text', data: { text: '原文' } }] });
await Promise.all([firstIngest, secondIngest]);
ok('异步入站最终严格按到达顺序分配本地 id 并交给 Agent',
  orderedStore.recent('group:321', { limit: 10 }).map((m) => m.mid).join(',') === '1,2'
  && orderedForwarded.map((m) => m.mid).join(',') === '1,2');

// FFmpeg 实际只拿本机代理 URL；逐跳重定向在 safe-fetch 内重新校验，不能把原 URL 直传回去。
//
// ⚠️ 下面这些断言是**跨文件**的（拆模块之后，`spawn` 在 `extract.ts`、`https.request` 在
// `recognize.ts`、代理在 `media-proxy.ts`）。所以这里读**整个目录**并按文件拼起来，
// 而不是钉某一个文件 —— 钉单文件的话，下次再拆一层，断言就会以"找不到这段代码"的形式
// 假红（而它想守的性质其实完好）。用 `split/join` 换行而不是 `join('')`：
// 有几条正则含 `\s`，贴在一起会把两个文件的首尾误配成一次匹配。
const transcriptionDir = path.join(ROOT, 'src/media/transcription');
const transcribeSrc = stripComments(
  fs.readdirSync(transcriptionDir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => fs.readFileSync(path.join(transcriptionDir, f), 'utf8'))
    .join('\n')
);
const safeFetchSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/media/safe-fetch.ts'), 'utf8'));
ok('FFmpeg 输入是本机流式代理，不直接使用 job.sourceUrl',
  /'-i',\s*proxy\.url/.test(transcribeSrc) && !/'-i',\s*job\.sourceUrl/.test(transcribeSrc));
// ⚠️ 这条断言原来钉的是 `resolveBilibiliMedia(sourceUrl, …)` —— **具体平台名**。
// 通用媒体层落地后那行换成了 `resolveMediaSource(...)`（平台无关，谁认领谁解析），
// 于是它当场打红。**意图没变**（分享页必须先解析成短时效媒体源、且解析结果仍走同一个
// 安全代理），所以改成钉那个意图，而不是钉某个平台 ——
// 钉平台名的话，加第二个平台时这条断言会逼着人把平台名写回来。
ok('分享页先解析为短时效媒体源，实际媒体仍走同一安全代理',
  /resolveMediaSource\(sourceUrl, signal, config\.maxDurationSeconds\)/.test(transcribeSrc)
  && /createMediaProxy\(source, signal, config\.maxSourceBytes\)/.test(transcribeSrc));
ok('转写层不再直接依赖任何具体平台（平台知识只在 media-source/providers/ 下）',
  !/resolveBilibiliMedia|BilibiliResolveError|from '\.\.\/bilibili\.js'|from '\.\/bilibili\.js'/.test(transcribeSrc),
  'transcription/ 里仍有平台专用符号');
ok('流式响应每一跳重定向都重新调用 validateFetchUrl',
  /const next = new URL\(location, url\)\.toString\(\);\s*\(\{ url, ip \} = await validateFetchUrl\(next\)\)/s.test(safeFetchSrc));
ok('FFmpeg 使用 spawn 参数数组且显式禁止 shell',
  /spawn\(config\.ffmpegPath, args, \{[^}]*shell:\s*false/s.test(transcribeSrc)
  && !/execSync\(|spawnSync\(/.test(transcribeSrc));

const envNames = [
  'QQ_AGENT_TRANSCRIPTION_ENABLED', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY',
  'TENCENTCLOUD_APP_ID'
];
const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
Object.assign(process.env, {
  QQ_AGENT_TRANSCRIPTION_ENABLED: 'true',
  TENCENTCLOUD_APP_ID: '1234567890',
  TENCENTCLOUD_SECRET_ID: 'placeholder-id',
  TENCENTCLOUD_SECRET_KEY: 'placeholder-key'
});
const cfg = structuredClone(DEFAULT_CONFIG);
const resolved = resolveTranscriptionConfig(cfg);
ok('腾讯云 AppID 与凭证支持服务端环境变量回退',
  resolved.enabled && resolved.secretId === 'placeholder-id' && resolved.secretKey === 'placeholder-key'
  && resolved.appId === '1234567890');
ok('极速版上限固定为 2 小时与 100 MiB，默认使用 mp3/16k 中文引擎',
  resolved.maxDurationSeconds === 7200 && resolved.maxAudioBytes === 100 * 1024 * 1024
  && resolved.engineType === '16k_zh');

const flash = buildFlashRecognitionRequest({
  appId: '1234567890', secretId: 'placeholder-id', secretKey: 'placeholder-key',
  engineType: '16k_zh', timestamp: 1700000000
});
const signatureSource = `POST${flash.hostname}${flash.path}`;
ok('极速版请求使用排序查询参数和 HMAC-SHA1/Base64 签名',
  flash.hostname === 'asr.cloud.tencent.com'
  && flash.path.startsWith('/asr/flash/v1/1234567890?convert_num_mode=1&engine_type=16k_zh')
  && flash.path.includes('&voice_format=mp3&word_info=0')
  && flash.authorization === createHmac('sha1', 'placeholder-key').update(signatureSource).digest('base64'));
ok('极速版直接 POST 二进制 MP3，不再依赖 COS 或 SentenceRecognition',
  /https\.request\(/.test(transcribeSrc) && /'Content-Type':\s*'application\/octet-stream'/.test(transcribeSrc)
  && !/SentenceRecognition|cos-nodejs-sdk|putObject|getObjectUrl/.test(transcribeSrc));

const logs = [];
const delivered = [];
const releases = [];
const observedStatuses = [];
let active = 0;
let maxActive = 0;
const fakeSender = { sendTextBatch: async () => ({ sent: [], failed: [] }) };
const queue = new VideoTranscriptionQueue({
  sender: fakeSender,
  onebot: { call: async () => ({}) },
  getConfig: () => cfg,
  log: (line) => logs.push(String(line)),
  operations: {
    checkFfmpeg: async () => {},
    runTask: async (_job, signal, setStatus) => {
      active++;
      maxActive = Math.max(maxActive, active);
      observedStatuses.push('extracting');
      setStatus('extracting');
      await new Promise((resolve, reject) => {
        releases.push(resolve);
        // 模拟与关停同时返回的云请求：队列仍不得交付迟到结果。
        signal.addEventListener('abort', resolve, { once: true });
      });
      observedStatuses.push('uploading'); setStatus('uploading');
      observedStatuses.push('recognizing'); setStatus('recognizing');
      active--;
      return 'fixture-result';
    },
    deliver: async (job, text) => { delivered.push([job.id, text]); }
  }
});
await queue.start();
const first = queue.enqueue({ chatKey: 'group:1', url: 'https://example.com/1.mp4' });
const second = queue.enqueue({ chatKey: 'group:1', url: 'https://example.com/2.mp4' });
const waitTurn = () => new Promise((resolve) => setTimeout(resolve, 10));
await waitTurn();
ok('队列只启动第一个任务，第二个保持 queued',
  releases.length === 1 && queue.get(first.id)?.status === 'extracting' && queue.get(second.id)?.status === 'queued');
releases.shift()();
await waitTurn();
ok('第一个结束后才启动第二个（全程单并发）',
  releases.length === 1 && queue.get(first.id)?.status === 'done' && queue.get(second.id)?.status === 'extracting'
  && maxActive === 1);
releases.shift()();
await waitTurn();
ok('状态机走到 done 且结果各交付一次',
  queue.get(second.id)?.status === 'done' && delivered.length === 2
  && ['extracting', 'uploading', 'recognizing'].every((status) => observedStatuses.includes(status)));
ok('转写日志不包含用户 URL、识别文本或腾讯云密钥',
  logs.every((line) => !line.includes('example.com') && !line.includes('fixture-result')
    && !line.includes('placeholder-id') && !line.includes('placeholder-key') && !line.includes('status=')));

const third = queue.enqueue({ chatKey: 'private:2', url: 'https://example.com/3.mp4' });
await waitTurn();
await queue.stop();
ok('stop 会中止当前 worker、禁止迟到结果发送并等待其落到 failed',
  queue.get(third.id)?.status === 'failed' && delivered.length === 2);

// ── 另一条投递路：模型自主（assisted）────────────────────────────────
//
// 上面那个队列注入了 `operations.deliver`，所以**队列默认的 `#deliver` 一直没被测过**。
// 这里另起一个不注入它的实例，专门覆盖 assisted：
//   · 结果交给回流端口 → 落成一条存档条目，由模型决定说什么
//   · 队列自己**不发任何群文本**（截断段会与模型的话重复）
//   · 超长时仍上传全文文件（群里那份完整的得另给）
//   · **绝不把异常抛回 `#drain`**：那里会同时把任务记成 failed 并往群里发一句莫须有的
//     「转写失败」——而结果其实已经拿到了
const assistedTexts = [];     // 队列自己发出去的群文本（assisted 下必须始终为空）
const assistedUploads = [];   // upload_* 调用的文件名
const sinkCalls = [];
const assistedLogs = [];
let uploadShouldFail = false;
let sinkShouldThrow = false;
const ASSIST_LIMIT = Math.max(200, resolveTranscriptionConfig(cfg).resultMaxChars - '转写结果：\n'.length - 20);
const SHORT_TEXT = '短视频里讲了茶叶';
const LONG_TEXT = '长'.repeat(4000);   // 远超 ASSIST_LIMIT

const assistedQueue = new VideoTranscriptionQueue({
  sender: {
    sendTextBatch: async (_chatKey, text) => { assistedTexts.push(String(text)); return { sent: [], failed: [] }; }
  },
  onebot: {
    call: async (_action, params) => {
      assistedUploads.push(String(params?.name || ''));
      if (uploadShouldFail) throw new Error('fixture-upload-failed');
      return {};
    }
  },
  getConfig: () => cfg,
  log: (line) => assistedLogs.push(String(line)),
  deliverTranscript: async (input) => {
    sinkCalls.push(input);
    if (sinkShouldThrow) throw new Error('fixture-sink-failed');
  },
  operations: {
    checkFfmpeg: async () => {},
    runTask: async (job, _signal, setStatus) => {
      setStatus('extracting');
      if (String(job.sourceUrl).includes('boom')) throw new Error('fixture-run-failed');
      return String(job.sourceUrl).includes('long') ? LONG_TEXT : SHORT_TEXT;
    }
  }
});
await assistedQueue.start();
const settle = async (jobId) => {
  for (let i = 0; i < 200; i++) {
    const status = assistedQueue.get(jobId)?.status;
    if (status === 'done' || status === 'failed') return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return assistedQueue.get(jobId)?.status;
};

const a1 = assistedQueue.enqueue({ chatKey: 'group:7', url: 'https://example.com/short.mp4', replyToMessageId: 42, mode: 'assisted' });
const a1Status = await settle(a1.id);
ok('assisted 短文本：结果交给回流端口，队列零群文本、零上传',
  a1Status === 'done' && sinkCalls.length === 1 && assistedTexts.length === 0 && assistedUploads.length === 0,
  `status=${a1Status} sink=${sinkCalls.length} text=${assistedTexts.length} upload=${assistedUploads.length}`);
ok('回流端口拿到原文、未截断事实、原会话与引用 id',
  sinkCalls[0]?.text === SHORT_TEXT && sinkCalls[0]?.truncated === false
  && sinkCalls[0]?.chars === Array.from(SHORT_TEXT).length
  && sinkCalls[0]?.chatKey === 'group:7' && sinkCalls[0]?.replyToMessageId === 42,
  JSON.stringify(sinkCalls[0]));

const a2 = assistedQueue.enqueue({ chatKey: 'group:7', url: 'https://example.com/long.mp4', mode: 'assisted' });
const a2Status = await settle(a2.id);
ok('assisted 超长：全文仍走文件上传，但**零群文本**（删掉这一步会与模型自己的话重复）',
  a2Status === 'done' && assistedUploads.length === 1 && assistedTexts.length === 0,
  `status=${a2Status} upload=${assistedUploads.length} text=${JSON.stringify(assistedTexts)}`);
ok('回流端口拿到的是开头一段（与群里那份截断段同一长度），并带原文全长',
  Array.from(sinkCalls[1]?.text || '').length === ASSIST_LIMIT
  && sinkCalls[1]?.truncated === true && sinkCalls[1]?.chars === 4000
  && sinkCalls[1]?.text === LONG_TEXT.slice(0, ASSIST_LIMIT),
  `${Array.from(sinkCalls[1]?.text || '').length} / limit=${ASSIST_LIMIT} truncated=${sinkCalls[1]?.truncated} chars=${sinkCalls[1]?.chars}`);

// 回归：默认的 standalone 路径逐字节不变（截断段 + 文件 + 上传失败时的补救文案）
uploadShouldFail = true;
const a3 = assistedQueue.enqueue({ chatKey: 'group:7', url: 'https://example.com/long.mp4' });
const a3Status = await settle(a3.id);
ok('/转写 那条路（默认 standalone）超长时仍是"截断段 + 上传 + 失败补救"，文案与顺序不变',
  a3Status === 'done' && assistedTexts.length === 2
  && String(assistedTexts[0]).startsWith('转写结果：\n')
  && String(assistedTexts[0]).includes('文本过长，已截断；完整内容将作为 UTF-8 文本文件发送。')
  && String(assistedTexts[1]).includes('完整文本文件发送失败')
  && assistedUploads.length === 2 && sinkCalls.length === 2,
  JSON.stringify(assistedTexts.map((t) => t.slice(0, 30))));

const a4 = assistedQueue.enqueue({ chatKey: 'group:7', url: 'https://example.com/long.mp4', mode: 'assisted' });
const a4Status = await settle(a4.id);
ok('assisted 上传失败：端口照旧被调用、任务仍 done、依旧零群文本',
  a4Status === 'done' && sinkCalls.length === 3 && assistedTexts.length === 2,
  `status=${a4Status} sink=${sinkCalls.length} text=${assistedTexts.length}`);
ok('上传失败只留固定错误码，日志不含 URL、识别文本或文件名',
  assistedLogs.every((line) => !line.includes('example.com') && !line.includes('长')
    && !line.includes('fixture-upload-failed') && !line.includes('transcription-')),
  assistedLogs.filter((l) => l.includes('example.com') || l.includes('长')).join(' | '));

// 端口抛错必须被吞掉：`#drain` 把异常一律当成"转写失败"，会在结果已拿到的情况下
// 同时记 failed 并往群里发一句莫须有的「转写失败」。
sinkShouldThrow = true;
const a5 = assistedQueue.enqueue({ chatKey: 'group:7', url: 'https://example.com/short.mp4', mode: 'assisted' });
const a5Status = await settle(a5.id);
uploadShouldFail = false;
sinkShouldThrow = false;
ok('端口抛错不外抛：任务照旧 done、不发任何失败文案、只记 DELIVER_FAILED',
  a5Status === 'done' && sinkCalls.length === 4 && assistedTexts.length === 2
  && assistedLogs.some((line) => line.includes('code=DELIVER_FAILED')),
  `status=${a5Status} sink=${sinkCalls.length} text=${assistedTexts.length}`);

// runTask 失败是另一回事：那时确实没有结果，必须照旧往群里说一句
const a6 = assistedQueue.enqueue({ chatKey: 'group:7', url: 'https://example.com/boom.mp4', mode: 'assisted' });
const a6Status = await settle(a6.id);
ok('转写本身失败：群里收到失败文案，回流端口**不被调用**',
  a6Status === 'failed' && assistedTexts.length === 3
  && String(assistedTexts[2]).startsWith('转写失败') && sinkCalls.length === 4,
  `status=${a6Status} text=${assistedTexts.length} sink=${sinkCalls.length}`);
await assistedQueue.stop();

// 没有回流端口时（例如某种装配缺失）不能无声无息：留一条日志说明结果没落地。
const noSinkLogs = [];
const noSinkTexts = [];
const noSinkQueue = new VideoTranscriptionQueue({
  sender: { sendTextBatch: async (_k, text) => { noSinkTexts.push(String(text)); return { sent: [], failed: [] }; } },
  onebot: { call: async () => ({}) },
  getConfig: () => cfg,
  log: (line) => noSinkLogs.push(String(line)),
  operations: {
    checkFfmpeg: async () => {},
    runTask: async (_job, _signal, setStatus) => { setStatus('extracting'); return SHORT_TEXT; }
  }
});
await noSinkQueue.start();
const a7 = noSinkQueue.enqueue({ chatKey: 'group:7', url: 'https://example.com/short.mp4', mode: 'assisted' });
for (let i = 0; i < 200 && noSinkQueue.get(a7.id)?.status !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
ok('缺回流端口：什么都不发，但留一条 NO_DELIVER_SINK 日志（不静默丢结果）',
  noSinkQueue.get(a7.id)?.status === 'done' && noSinkTexts.length === 0
  && noSinkLogs.some((line) => line.includes('code=NO_DELIVER_SINK')),
  `status=${noSinkQueue.get(a7.id)?.status} text=${noSinkTexts.length}`);
await noSinkQueue.stop();

// 控制台 GET /api/config 必须沿用既有 secret 递归脱敏，不能把新凭证带给浏览器。
updateConfig({
  server: { port: 39210 },
  transcription: {
    enabled: true,
    appId: '1234567890', secretId: 'config-secret-id', secretKey: 'config-secret-key'
  }
});
const { createApp } = await load('web/app.js');
const app = createApp({ log: () => {} });
const port = await app.start();
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/config`);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  ok('控制台配置响应删除 secretId/secretKey，只返回存在性标志',
    response.ok && !serialized.includes('config-secret-id') && !serialized.includes('config-secret-key')
    && body.transcription?.hasSecretId === true && body.transcription?.hasSecretKey === true
    && !('secretId' in body.transcription) && !('secretKey' in body.transcription));
  ok('控制台只返回环境变量存在性/生效状态，不泄露环境变量凭证',
    body.transcription?.hasAppId === true && body.transcription?.effectiveEnabled === true
    && !serialized.includes('placeholder-id') && !serialized.includes('placeholder-key'));
} finally {
  await app.stop();
}

for (const name of envNames) {
  if (oldEnv[name] === undefined) delete process.env[name];
  else process.env[name] = oldEnv[name];
}

process.exit(done() ? 0 : 1);
