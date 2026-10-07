// B 站分享页解析层：分享链接/短链 -> 首个分 P 的音频播放地址。
//
// 这里不下载媒体，也不记录页面或播放地址。所有网络请求继续复用 safe-fetch 的
// DNS 固定、私网拦截和逐跳重定向校验；解析出的短时效播放地址还会在 FFmpeg
// 本地代理真正访问时再校验一次。
//
// ── 为什么它在 `parsers/` 而不是 `providers/` ──
//
// 这两层是**平台无关的契约**与**平台自己的实现**的分工，分开才好各改各的：
//   · `providers/bilibili.ts` —— **适配器**：把"QQ 卡片报文"翻译成 B 站自己的提取函数，
//     并把本文件贴进 `MediaSourceProvider` 契约。它**不认识接口细节**。
//   · `parsers/bilibili.ts`（本文件）—— **实现**：短链展开、`view`/`playurl` 两个接口、
//     挑最小音频流、CDN 要求的 Referer。它是纯 B 站知识，**不知道 QQ 卡片长什么样**。
//
// 合成一个文件也能跑，但那样"加一个平台"就变成"在一个文件里同时改协议端形态与平台接口"，
// 而这两件事的改动理由完全不同（前者跟着协议端变，后者跟着站点改版变）。
import { openSafeStream } from '../../safe-fetch.js';

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

/**
 * 从一批候选链接里挑出属于 B 站的那个（找不到返回 ''）。
 *
 * 入参由 `qq/card-payload.ts` 摊平给出（`fields` 白名单 + `urls` 兜底），
 * **本层不认识卡片字段名** —— "哪张卡片长什么样"是协议端知识，属于接入侧。
 *
 * `preferred` 是已知字段名的优先级：小程序卡片的链接只在 `qqdocurl` 里，
 * 而它可能不是报文里第一个出现的 B 站链接，所以要按名先取。
 */
export function bilibiliUrlFromCandidates(
  payload: { fields?: Record<string, string>; urls?: string[] },
  preferred: readonly string[] = []
): string {
  const fields = payload && typeof payload === 'object' ? payload.fields ?? {} : {};
  for (const name of preferred) {
    const hit = bilibiliUrlField(fields[name]);
    if (hit) return hit;
  }
  for (const value of Object.values(fields)) {
    const hit = bilibiliUrlField(value);
    if (hit) return hit;
  }
  for (const value of payload && typeof payload === 'object' ? payload.urls ?? [] : []) {
    const hit = bilibiliUrlField(value);
    if (hit) return hit;
  }
  return '';
}

// ── 卡片报文里的 B 站链接 ───────────────────────────────────────────────
// ⚠️ 这里**只做域名判定**。卡片字段名（`qqdocurl` / `jumpUrl` / 小程序那些 `view_*`）
// 是**协议端与 QQ 之间的私有约定**，属于接入侧知识，已经搬到 `qq/card-payload.ts`：
// 那个文件把报文摊平成"白名单字段 + 兜底链接列表"，本层只负责从里头挑出 B 站的。
// 两层分开的理由是改动理由不同：字段名跟着协议端变，域名判定跟着站点变。

/** 单个候选链接的长度上限。 */
const CARD_URL_MAX = 300;

/** 只收 http(s) 的 B 站地址；其余（mqqapi:// 之类）一律丢弃。 */
function bilibiliUrlField(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const s = String(value).trim().slice(0, CARD_URL_MAX);
  return isBilibiliUrl(s) ? s : '';
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
