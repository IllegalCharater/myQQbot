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
} = await load('media/video-transcription.js');
const { isBilibiliUrl, bilibiliUrlFromCardData, bilibiliUrlFromXml } = await load('media/bilibili.js');
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
const cardData = (payload) => ({ data: JSON.stringify(payload) });
ok('小程序卡从 qqdocurl 取到链接（这个形态没有 jumpUrl）',
  bilibiliUrlFromCardData(cardData({ app: 'com.tencent.miniapp_01', meta: { detail_1: { qqdocurl: 'https://www.bilibili.com/video/BV1xx411c7mD' } } }))
    === 'https://www.bilibili.com/video/BV1xx411c7mD');
ok('老式 news 卡的 jumpUrl 仍然认（回归）',
  bilibiliUrlFromCardData(cardData({ meta: { news: { jumpUrl: 'https://b23.tv/legacy' } } })) === 'https://b23.tv/legacy');
ok('已解析成对象的卡片报文同样认（有的协议端不下发字符串）',
  bilibiliUrlFromCardData({ data: { meta: { detail_1: { qqdocurl: 'https://b23.tv/obj' } } } }) === 'https://b23.tv/obj');
// 长度上限判的是**去掉首尾空白后**的报文（纯空白不算内容，也不必为它分配解析树）；
// 所以这里用一个真的超长报文，而不是往小报文后面补空格。
ok('非 B 站链接、坏 JSON、超大报文一律返回空串',
  bilibiliUrlFromCardData(cardData({ meta: { detail_1: { qqdocurl: 'https://example.com/video/1' } } })) === ''
  && bilibiliUrlFromCardData({ data: '{不是 JSON' }) === ''
  && bilibiliUrlFromCardData(cardData({ meta: { detail_1: { title: 'x'.repeat(40000), qqdocurl: 'https://b23.tv/x' } } })) === ''
  && bilibiliUrlFromCardData(undefined) === '');
// 卡片报文是群成员可伪造的不可信输入：只读白名单字段，绝不把对象展开进任何地方。
ok('伪造的卡片报文既不污染原型也不抛错',
  bilibiliUrlFromCardData({ data: JSON.stringify({ __proto__: { polluted: 1 }, meta: { __proto__: { polluted: 1 } } }) }) === ''
  && ({}.polluted === undefined));
ok('xml 分享卡里抠出 B 站链接（&amp; 先还原）',
  bilibiliUrlFromXml('<msg serviceID="1"><item><url>https://b23.tv/a?x=1&amp;y=2</url></item></msg>') === 'https://b23.tv/a?x=1&y=2');
ok('xml 里没有 B 站链接时返回空串',
  bilibiliUrlFromXml('<msg><url>https://example.com/a</url></msg>') === '' && bilibiliUrlFromXml(null) === '');

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
const transcribeSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/media/video-transcription.ts'), 'utf8'));
const safeFetchSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/media/safe-fetch.ts'), 'utf8'));
ok('FFmpeg 输入是本机流式代理，不直接使用 job.sourceUrl',
  /'-i',\s*proxy\.url/.test(transcribeSrc) && !/'-i',\s*job\.sourceUrl/.test(transcribeSrc));
ok('B 站页面先解析为短时效媒体源，实际媒体仍走同一安全代理',
  /resolveBilibiliMedia\(sourceUrl, signal, config\.maxDurationSeconds\)/.test(transcribeSrc)
  && /createMediaProxy\(source, signal, config\.maxSourceBytes\)/.test(transcribeSrc));
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
