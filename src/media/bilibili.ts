// B 站分享页解析层：分享链接/短链 -> 首个分 P 的音频播放地址。
//
// 这里不下载媒体，也不记录页面或播放地址。所有网络请求继续复用 safe-fetch 的
// DNS 固定、私网拦截和逐跳重定向校验；解析出的短时效播放地址还会在 FFmpeg
// 本地代理真正访问时再校验一次。
import { openSafeStream } from './safe-fetch.js';

const BILIBILI_API = 'https://api.bilibili.com';
const MAX_API_BYTES = 2 * 1024 * 1024;
const API_HEADERS = {
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com'
};

interface BilibiliIdentity {
  bvid?: string;
  aid?: string;
}

export interface ResolvedMediaSource {
  url: string;
  headers?: Record<string, string>;
}

export class BilibiliResolveError extends Error {
  constructor(public code: string, message = '无法解析 B 站视频') {
    super(message);
    this.name = 'BilibiliResolveError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBilibiliHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'bilibili.com' || host.endsWith('.bilibili.com')
    || host === 'b23.tv' || host.endsWith('.b23.tv');
}

/** 只识别 B 站自有域名；相似后缀域名不会命中。 */
export function isBilibiliUrl(raw: unknown): boolean {
  try {
    const url = new URL(String(raw ?? '').trim());
    return ['http:', 'https:'].includes(url.protocol) && isBilibiliHost(url.hostname);
  } catch {
    return false;
  }
}

// ── 卡片报文里的 B 站链接 ───────────────────────────────────────────────
// 为什么需要这两个函数：B 站 App 分享到 QQ 的是**小程序卡片**，链接在
// `meta.detail_1.qqdocurl`，而通用卡片解析只认 `meta.*.jumpUrl`（那是老式 news 卡片的字段）。
// 只认 jumpUrl 的后果是"卡片看着有链接、存档里却没有"——`/转写` 与 `transcribe_video`
// 都靠 media 里的 `kind:'video'` 定位目标，于是两者都报"没有视频链接"。
// 另有一部分协议端把分享卡下发成 `xml` 段，通用解析层完全不认这个段（不产生任何 media）。

const CARD_PAYLOAD_MAX = 32 * 1024;
const CARD_URL_MAX = 300;
/** 链接可能出现的字段名。qqdocurl 排第一：小程序卡片只有它。 */
const CARD_URL_FIELDS = ['qqdocurl', 'jumpUrl', 'url'];

/** 只收 http(s) 的 B 站地址；其余（mqqapi:// 之类）一律丢弃。 */
function bilibiliUrlField(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const s = String(value).trim().slice(0, CARD_URL_MAX);
  return isBilibiliUrl(s) ? s : '';
}

/**
 * json 卡片报文里的 B 站链接（找不到返回 ''）。
 *
 * 入参是 json 段的 `data`（形如 `{ data: <JSON字符串|对象> }`，与 parseCardSegment 同一形状）。
 * 只按白名单读字段、只下探 meta 一层：卡片报文是群成员可伪造的不可信输入，
 * 这里既不展开对象也不请求任何地址（请求交给后续的 safe-fetch 与 B 站解析层）。
 */
export function bilibiliUrlFromCardData(value: unknown): string {
  const data = isRecord(value) ? value : {};
  const raw = data.data;
  let payload: Record<string, unknown> | null = null;
  if (isRecord(raw)) {
    payload = raw;   // 有的协议端直接给已解析好的对象
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s.length > CARD_PAYLOAD_MAX) return '';
    try {
      const parsed: unknown = JSON.parse(s);
      if (isRecord(parsed)) payload = parsed;
    } catch { return ''; }
  }
  if (!payload) return '';

  const bodies: Array<Record<string, unknown>> = [payload];
  const meta = payload.meta;
  if (isRecord(meta)) {
    for (const key of Object.keys(meta)) {
      const child = meta[key];
      if (isRecord(child)) bodies.push(child);
    }
  }
  for (const body of bodies) {
    for (const field of CARD_URL_FIELDS) {
      const hit = bilibiliUrlField(body[field]);
      if (hit) return hit;
    }
  }
  return '';
}

/**
 * xml 分享卡里的第一个 B 站链接（找不到返回 ''）。
 *
 * 不解析 XML 结构，只把 `http(s)://…` 逐个挑出来做域名判定：xml 卡片的正文是
 * 协议端与 QQ 之间的私有约定，按标签名取值只会更脆。`&amp;` 先还原，否则带参数的
 * 链接会被当成另一个地址。
 */
export function bilibiliUrlFromXml(value: unknown): string {
  const xml = typeof value === 'string' ? value : '';
  if (!xml || xml.length > CARD_PAYLOAD_MAX) return '';
  const decoded = xml.replace(/&amp;/g, '&');
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
    const hit = bilibiliUrlField(match[0]);
    if (hit) return hit;
  }
  return '';
}

function identityFromUrl(url: URL): BilibiliIdentity | null {
  const bvid = url.pathname.match(/(?:^|\/)video\/(BV[0-9A-Za-z]{10,20})(?:\/|$)/i)?.[1]
    || url.searchParams.get('bvid') || '';
  if (/^BV[0-9A-Za-z]{10,20}$/i.test(bvid)) return { bvid };

  const aid = url.pathname.match(/(?:^|\/)video\/av(\d+)(?:\/|$)/i)?.[1]
    || url.searchParams.get('aid') || url.searchParams.get('avid') || '';
  if (/^\d+$/.test(aid)) return { aid };

  // 一些 b23.tv 分享链接直接把 BV/av 号放在首段路径里。
  const shortId = url.pathname.split('/').filter(Boolean)[0] || '';
  if (/^BV[0-9A-Za-z]{10,20}$/i.test(shortId)) return { bvid: shortId };
  if (/^av\d+$/i.test(shortId)) return { aid: shortId.slice(2) };
  return null;
}

async function finalShareUrl(raw: string, signal: AbortSignal): Promise<URL> {
  const initial = new URL(raw);
  if (initial.hostname.toLowerCase() !== 'b23.tv' && !initial.hostname.toLowerCase().endsWith('.b23.tv')) {
    return initial;
  }
  const opened = await openSafeStream(initial.toString(), {
    headers: API_HEADERS,
    signal
  });
  opened.response.destroy();
  if (!isBilibiliHost(opened.url.hostname)) {
    throw new BilibiliResolveError('BILIBILI_REDIRECT_HOST');
  }
  return opened.url;
}

async function readJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const opened = await openSafeStream(url, { headers: API_HEADERS, signal });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const raw of opened.response) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > MAX_API_BYTES) {
        opened.response.destroy();
        throw new BilibiliResolveError('BILIBILI_RESPONSE_TOO_LARGE');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof BilibiliResolveError) throw error;
    throw new BilibiliResolveError('BILIBILI_API_READ_FAILED');
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(value)) throw new Error('invalid response');
    return value;
  } catch {
    throw new BilibiliResolveError('BILIBILI_INVALID_RESPONSE');
  }
}

function apiSucceeded(body: Record<string, unknown>): Record<string, unknown> {
  if (Number(body.code) !== 0 || !isRecord(body.data)) {
    throw new BilibiliResolveError(`BILIBILI_API_${String(body.code ?? 'UNKNOWN').replace(/[^\w-]/g, '').slice(0, 32) || 'UNKNOWN'}`);
  }
  return body.data;
}

function identityQuery(identity: BilibiliIdentity): string {
  if (identity.bvid) return `bvid=${encodeURIComponent(identity.bvid)}`;
  return `aid=${encodeURIComponent(identity.aid || '')}`;
}

/**
 * 将 B 站视频页解析为可交给安全流式代理的媒体源。当前只处理普通投稿的首个分 P；
 * 番剧、课程、登录可见或地区受限内容会明确失败，不会尝试携带用户 Cookie 绕过限制。
 */
export async function resolveBilibiliMedia(
  raw: string,
  signal: AbortSignal,
  maxDurationSeconds: number
): Promise<ResolvedMediaSource> {
  if (!isBilibiliUrl(raw)) return { url: raw };

  let pageUrl: URL;
  try {
    pageUrl = await finalShareUrl(raw, signal);
  } catch (error) {
    if (error instanceof BilibiliResolveError) throw error;
    throw new BilibiliResolveError('BILIBILI_LINK_UNREACHABLE');
  }
  const identity = identityFromUrl(pageUrl);
  if (!identity) throw new BilibiliResolveError('BILIBILI_ID_MISSING');

  const query = identityQuery(identity);
  const view = apiSucceeded(await readJson(`${BILIBILI_API}/x/web-interface/view?${query}`, signal));
  const pages = Array.isArray(view.pages) ? view.pages.filter(isRecord) : [];
  const firstPage = pages[0];
  const cid = String(firstPage?.cid ?? view.cid ?? '');
  if (!/^\d+$/.test(cid)) throw new BilibiliResolveError('BILIBILI_CID_MISSING');

  const duration = Number(firstPage?.duration ?? view.duration);
  if (Number.isFinite(duration) && duration > maxDurationSeconds) {
    throw new BilibiliResolveError('VIDEO_TOO_LONG', `视频超过 ${maxDurationSeconds} 秒限制`);
  }

  const play = apiSucceeded(await readJson(
    `${BILIBILI_API}/x/player/playurl?${query}&cid=${encodeURIComponent(cid)}&qn=16&fnver=0&fnval=16&fourk=0`,
    signal
  ));
  const dash = isRecord(play.dash) ? play.dash : {};
  const audio = Array.isArray(dash.audio) ? dash.audio.filter(isRecord) : [];
  // 转写不需要高码率，选最小音频流可降低带宽、临时文件和 FFmpeg 压力。
  audio.sort((a, b) => Number(a.bandwidth || Number.MAX_SAFE_INTEGER) - Number(b.bandwidth || Number.MAX_SAFE_INTEGER));
  const chosen = audio[0];
  const durl = Array.isArray(play.durl) ? play.durl.filter(isRecord)[0] : undefined;
  const mediaUrl = String(chosen?.baseUrl ?? chosen?.base_url ?? durl?.url ?? '').trim();
  if (!mediaUrl) throw new BilibiliResolveError('BILIBILI_AUDIO_MISSING');

  try {
    const parsed = new URL(mediaUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
  } catch {
    throw new BilibiliResolveError('BILIBILI_AUDIO_URL_INVALID');
  }
  return {
    url: mediaUrl,
    // B 站 CDN 校验 Referer；这里都是代码内固定值，不接受卡片注入任意请求头。
    headers: API_HEADERS
  };
}
