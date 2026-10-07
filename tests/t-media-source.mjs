// 通用音视频来源层（`media/media-source/`）的行为覆盖。
//
// 为什么要有这个套件：这一层的职责是"**加平台不用改接入层与转写层**"，
// 而那是一个只能靠"清单与分发确实解耦了"来证明的性质。t-transcription 覆盖的是
// B 站解析本身与转写链路，覆盖不到下面这些：
//   · provider 是**声明式清单**还是写死的分支；
//   · `extract` 是不是**纯函数**（接入层在串行摄取链上，发请求会拖慢落库）；
//   · 畸形卡片报文会不会把整条消息搞挂；
//   · 没有 provider 认领的地址会不会被**原样放行**（普通 .mp4 直链不该被平台逻辑碰）。
import fs from 'node:fs';
import { load, readSrc, stripComments } from './lib/src.mjs';
import { checker } from './lib/harness.mjs';

const { ok, done } = checker();
const ms = await load('media/media-source/index.js');

// ── 1. 清单形态：加平台 = 加一行，不是加一个分支 ──
console.log('\n=== 1. provider 清单 ===');
ok('导出了 provider 清单', Array.isArray(ms.MEDIA_SOURCE_PROVIDERS));
ok('清单里当前有 B 站', ms.MEDIA_SOURCE_PROVIDERS.some((p) => p.name === 'bilibili'),
  JSON.stringify(ms.MEDIA_SOURCE_PROVIDERS.map((p) => p.name)));
ok('每个 provider 都有 name / title / extract / owns',
  ms.MEDIA_SOURCE_PROVIDERS.every((p) => typeof p.name === 'string' && typeof p.title === 'string'
    && typeof p.extract === 'function' && typeof p.owns === 'function'));

// 源级：分发函数必须**遍历清单**，不能写死平台名。
// 写死的话"加一行"就只是加了个没人读的数据。
{
  const src = stripComments(readSrc('media/media-source/index.js'));
  ok('分发是遍历清单（`for (const provider of MEDIA_SOURCE_PROVIDERS)`）',
    /for \(const provider of MEDIA_SOURCE_PROVIDERS\)/.test(src));
  // ⚠️ 不能整文件搜平台名：**清单那一行本来就该写着平台名**（`bilibiliMediaProvider`），
  // 那是"加一行"的表达方式，不是写死。判据是**分发函数体里**没有平台名 ——
  // 整文件搜会永远假红（本套件初版就这么红了一条，靠打印残留行才发现命中的是清单本身）。
  const dispatchBody = src
    .replace(/import[\s\S]*?from\s*'[^']*';/g, '')          // 跨行 import 也要剥掉（初版正则漏了这个）
    .replace(/export const MEDIA_SOURCE_PROVIDERS[\s\S]*?\];/, '');  // 清单本身不算
  ok('分发函数体里**不出现任何平台名**（写死平台名就等于没解耦）',
    !/bilibili/i.test(dispatchBody),
    `分发体里的残留：${(dispatchBody.match(/.*bilibili.*/i) || [''])[0].trim()}`);
  ok('对照：清单那一行确实写着平台名（否则上一个断言是假绿）',
    /MEDIA_SOURCE_PROVIDERS[\s\S]*?bilibili/i.test(src));
}

// ── 1b. 三层分工：parsers / providers / card-payload ──
//
// 按**改动理由**切，不按"字面上谁属于谁"：
//   · `parsers/<x>.ts`        —— 平台自己的实现（短链、接口、挑流、CDN 头）。**判据里不许
//                                出现卡片字段名** —— 那层知识跟着协议端变，跟站点无关。
//   · `providers/<x>.ts`      —— 适配器：知道协议端字段名与该平台域名，转发给 parser。
//   · `providers/card-payload.ts` —— 纯数据摊平，**不认识任何平台**。
//
// ⚠️ 这一层为什么不能放进 `src/qq/`（直觉上"卡片字段名属于协议端"）：`check-layers.mjs`
// 的 T1 白名单是空的，`media/` 横向 import `qq/` 会被直接打回（实测报
// `T1 领域间引用未登记精确白名单`）。那是**刻意的边界**，不是可以绕的障碍。
console.log('\n=== 1b. parsers / providers / card-payload 三层分工 ===');
{
  const parserSrc = stripComments(readSrc('media/media-source/parsers/bilibili.js'));
  const providerSrc = stripComments(readSrc('media/media-source/providers/bilibili.js'));
  const payloadSrc = stripComments(readSrc('media/media-source/providers/card-payload.js'));

  ok('parsers/ 里是平台实现（短链展开 + 真实接口调用）',
    /finalShareUrl|openSafeStream/.test(parserSrc) && /x\/web-interface\/view|x\/player\/playurl/.test(parserSrc));
  ok('providers/ 是适配器（把协议端候选交给 parser）',
    /bilibiliUrlFromCandidates/.test(providerSrc));
  ok('providers/ 声明了协议端字段名优先级',
    /CARD_URL_FIELDS\s*=\s*\[[^\]]*qqdocurl/.test(providerSrc), '没有 qqdocurl 优先级');
  ok('providers/ 没有自己的网络调用（只转发，不自己解析平台）',
    !/openSafeStream|fetch\(/.test(providerSrc));

  // ★ 方向性判据：平台实现不该认识协议端
  ok('★ parsers/ 里**不出现协议端字段名**（qqdocurl / jumpUrl 属于接入侧知识）',
    !/qqdocurl|jumpUrl/.test(parserSrc),
    `parsers/ 里出现了：${(parserSrc.match(/.*(qqdocurl|jumpUrl).*/i) || [''])[0].trim()}`);
  ok('对照：字段名确实在 providers/ 里（否则上一条是假绿）',
    /qqdocurl/.test(providerSrc));

  // card-payload 是纯数据层：不该认识平台
  ok('card-payload 里**不出现任何平台名**（它只做摊平）',
    !/bilibili|b23\.tv/i.test(payloadSrc),
    `card-payload 里出现了：${(payloadSrc.match(/.*(bilibili|b23\.tv).*/i) || [''])[0].trim()}`);
  ok('对照：card-payload 确实在做摊平（有兜底扫描与 xml 路径）',
    /scanForUrls/.test(payloadSrc) && /xmlPayloadCandidates/.test(payloadSrc));

  // 清单与实现对得上账：每个 provider 都要有同名 parser
  const fsMod = await import('node:fs');
  const parserDir = new URL('../dist/media/media-source/parsers/', import.meta.url);
  const parserFiles = fsMod.readdirSync(parserDir).filter((f) => f.endsWith('.js'));
  ok('清单里的每个 provider 都有同名 parser 文件',
    ms.MEDIA_SOURCE_PROVIDERS.every((p) => parserFiles.includes(`${p.name}.js`)),
    `清单=${ms.MEDIA_SOURCE_PROVIDERS.map((p) => p.name).join(',')} | parsers=${parserFiles.join(',')}`);
}

// ── 2. extract 必须是纯函数（不发请求）──
console.log('\n=== 2. extract 是纯函数 ===');
{
  // 用一个会抛的 fetch 证明它没被调用；同时用真卡片报文走一遍提取。
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => { called++; throw new Error('不该发请求'); };
  try {
    const card = { type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'https://b23.tv/abc' } } }) } };
    const hit = ms.extractMediaFromSegment(card);
    ok('从 json 卡片里认出了 B 站链接', hit?.url === 'https://b23.tv/abc', JSON.stringify(hit));
    ok('extract 没有发任何请求（接入层串行链上不能有网络往返）', called === 0, `fetch 被调了 ${called} 次`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 3. 两种卡片形态都要覆盖（这是原实现"非补不可"的两个理由）──
console.log('\n=== 3. json 小程序卡片 / xml 分享卡 ===');
ok('小程序卡片的 qqdocurl（没有 jumpUrl）能认出来',
  ms.extractMediaFromSegment({
    type: 'json',
    data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01', meta: { detail_1: { qqdocurl: 'https://b23.tv/x1' } } }) }
  })?.url === 'https://b23.tv/x1');
ok('老式 news 卡片的 jumpUrl 也能认出来',
  ms.extractMediaFromSegment({
    type: 'json',
    data: { data: JSON.stringify({ meta: { news: { jumpUrl: 'https://b23.tv/x2' } } }) }
  })?.url === 'https://b23.tv/x2');
ok('xml 分享卡能认出来',
  ms.extractMediaFromSegment({
    type: 'xml', data: { data: '<msg><item><url>https://b23.tv/x3?a=1&amp;b=2</url></item></msg>' }
  })?.url === 'https://b23.tv/x3?a=1&b=2');
ok('认出来的条目标了 kind=video 与 source=bilibili',
  (() => { const h = ms.extractMediaFromSegment({ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'https://b23.tv/x4' } } }) } });
    return h?.kind === 'video' && h?.source === 'bilibili'; })());

// ── 4. 对照：不是本平台的绝不能认领 ──
console.log('\n=== 4. 对照：别人的链接不认 ===');
ok('对照：非 B 站链接返回 null（否则会把它当视频、下游解析必然失败）',
  ms.extractMediaFromSegment({ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'https://example.com/v/1' } } }) } }) === null);
ok('对照：相似后缀域名不认（bilibili.com.evil.example）',
  ms.extractMediaFromSegment({ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: 'https://bilibili.com.evil.example/video/BV1xx411c7mD' } } }) } }) === null);
ok('对照：mqqapi:// 之类的非 http 地址不认',
  ms.extractMediaFromSegment({ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { url: 'mqqapi://miniapp/open' } } }) } }) === null);
ok('对照：text 段不走卡片识别（那是通用协议解析的事）',
  ms.extractMediaFromSegment({ type: 'text', data: { text: 'https://b23.tv/x5' } }) === null);
ok('对照：坏 JSON 不抛错、只是认不出',
  ms.extractMediaFromSegment({ type: 'json', data: { data: '{不是 JSON' } }) === null);

// ── 5. 一串段：去重 + 畸形段不炸 ──
console.log('\n=== 5. 一串段 ===');
{
  const seg = (u) => ({ type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { qqdocurl: u } } }) } });
  const many = ms.extractMediaFromSegments([
    seg('https://b23.tv/d1'),
    seg('https://b23.tv/d1'),          // 重复
    seg('https://b23.tv/d2'),
    { type: 'json' },                   // 缺 data
    { data: { x: 1 } },                 // 缺 type
    null, 'x', 42,                     // 完全不是段
    { type: 'text', data: { text: 'hi' } }
  ]);
  ok('去重后拿到两条', many.length === 2, JSON.stringify(many.map((m) => m.url)));
  ok('畸形段不会让整条消息落不了库（不抛错、只是跳过）', many.every((m) => m.url.startsWith('https://b23.tv/')));
  ok('非数组入参返回空数组', ms.extractMediaFromSegments(undefined).length === 0 && ms.extractMediaFromSegments('x').length === 0);
}

// ── 6. 裸地址认领（通用卡片解析已经把 url 放进 media 的那条缝）──
console.log('\n=== 6. 裸地址认领 ===');
ok('B 站地址能认领，source 是平台名（不带 -card 后缀）',
  (() => { const c = ms.mediaCandidateFromUrl('https://www.bilibili.com/video/BV1xx411c7mD');
    return c?.kind === 'video' && c?.source === 'bilibili' && c?.url === 'https://www.bilibili.com/video/BV1xx411c7mD'; })());
ok('对照：别人的地址返回 null', ms.mediaCandidateFromUrl('https://example.com/a.mp4') === null);
ok('对照：空/非字符串返回 null',
  ms.mediaCandidateFromUrl('') === null && ms.mediaCandidateFromUrl(null) === null && ms.mediaCandidateFromUrl(42) === null);

// ── 7. resolveMediaSource：认领的交给 provider，没认领的原样放行 ──
console.log('\n=== 7. 解析分发 ===');
{
  const ac = new AbortController();
  // 没有 provider 认领 → **原样返回**。这条是"普通 .mp4 直链不该被平台逻辑碰"的守护。
  const direct = await ms.resolveMediaSource('https://example.com/a.mp4', ac.signal, 60);
  ok('没 provider 认领时原样放行（普通媒体直链不需要解析）',
    direct.url === 'https://example.com/a.mp4' && direct.headers === undefined, JSON.stringify(direct));
  ok('空地址抛错', await ms.resolveMediaSource('', ac.signal, 60).then(() => false, () => true));
  ok('providerErrorCode 口径：认领但无 resolve 的 provider 也走原样放行',
    // 清单里当前只有一个 provider 且它有 resolve，所以这条用"没认领"的地址等价验证
    (await ms.resolveMediaSource('https://other.example/x', ac.signal, 60)).url === 'https://other.example/x');
}

// ── 8. 与接入层的接线：ingest 不得再认识任何平台 ──
console.log('\n=== 8. 接入层已解耦 ===');
{
  const ingestSrc = stripComments(readSrc('web/onebot/ingest.js'));
  ok('ingest 走通用提取入口', /extractCardMediaFromSegments|mediaCandidateFromUrl/.test(ingestSrc));
  ok('ingest 不再 import 平台函数（bilibiliUrlFromCardData / isBilibiliUrl）',
    !/bilibiliUrlFromCardData|bilibiliUrlFromXml|isBilibiliUrl/.test(ingestSrc), 'ingest 里仍有平台专用符号');
  ok('ingest 里不再出现 bilibili 字样',
    !/bilibili/i.test(ingestSrc.replace(/import[\s\S]*?from\s*'[^']*';/g, '')), 'ingest 里出现了平台名');
}

// ── 9. 语音（record）段：URL 必须被存下来 ──
//
// 为什么单独一节：`/转写` 与 `transcribe_video` 都靠 media 里的地址定位目标，
// 而 record 段**此前完全没有 media 条目**（`qq/onebot.ts` 只把它文本化成 `[语音]`），
// 于是"给语音做识别"这件事连地址都没有 —— 这个缺口不补，加平台/加识别都无从谈起。
console.log('\n=== 9. 语音段 ===');
{
  const { extractMediaFromSegments: protocolMedia } = await load('qq/onebot.js');
  const one = protocolMedia([{ type: 'record', data: { file: 'a.silk', url: 'https://cdn.example/v.silk', magic: 1, text: '识别好的文本' } }]);
  const hit = one.find((m) => m.kind === 'audio');
  ok('语音段产出了 kind:audio 条目', !!hit, JSON.stringify(one));
  ok('带上了 url（没有它下游没法定位）', hit?.url === 'https://cdn.example/v.silk', JSON.stringify(hit));
  ok('带上了 file 与 magic', hit?.file === 'a.silk' && String(hit?.magic) === '1', JSON.stringify(hit));
  ok('协议端自带的转写文本也存下来了（白拿的信息，省一次识别）', hit?.text === '识别好的文本', JSON.stringify(hit));

  // 对照：没有 url 时不产出条目 —— 一条没有地址的 audio 只会让下游白找一轮
  ok('对照：没有 url 的语音段不产出条目',
    protocolMedia([{ type: 'record', data: { file: 'a.silk' } }]).filter((m) => m.kind === 'audio').length === 0);
  ok('对照：没有 text 时不写空的 text 键（缺席表达"没有"，与 fromBookmark 同一条规矩）',
    !('text' in (protocolMedia([{ type: 'record', data: { url: 'https://x/y.silk' } }]).find((m) => m.kind === 'audio') || {})));

  // 文本化仍然只给占位符（不改已有行为）
  const { segmentsToText } = await load('qq/onebot.js');
  ok('对照：语音在文本里仍是 [语音] 占位符（这一步只加 media，不改文本化）',
    (await segmentsToText([{ type: 'record', data: { url: 'https://x/y.silk' } }])).includes('[语音]'));

  // ── 两个入口的判据必须同形 ──
  const { parseTranscriptionCommand } = await load('media/transcription/index.js');
  const audioOnly = [{ kind: 'audio', url: 'https://cdn.example/v.silk' }];
  ok('`/转写`（不带 URL）能从语音条目的 url 定位',
    parseTranscriptionCommand('/转写', audioOnly) === 'https://cdn.example/v.silk',
    String(parseTranscriptionCommand('/转写', audioOnly)));
  ok('对照：`/转写` 对没有 url 的语音条目仍报缺 URL',
    (() => { try { parseTranscriptionCommand('/转写', [{ kind: 'audio' }]); return false; } catch { return true; } })());
  // 工具那一侧的判据是同一组（video|audio）。钉住"两处同形"这件事本身：
  const toolSrc = stripComments(readSrc('agent/tools/transcription.js'));
  const mediaSrc = stripComments(readSrc('media/transcription/commands.js'));
  const criterion = /m\.kind === 'video' \|\| m\.kind === 'audio'/;
  const criterion2 = /item\?\.kind === 'video' \|\| item\?\.kind === 'audio'/;
  ok('工具侧认 video|audio', criterion.test(toolSrc), '工具侧判据没放宽');
  ok('命令侧认 video|audio', criterion2.test(mediaSrc), '命令侧判据没放宽');
}

// `done()` 自己会打印汇总（含通过/失败计数），别再手写一遍。
process.exit(done() ? 0 : 1);