// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程。
//
// 例外开关：security.allowPrivateImageHosts = true 时，图片下载跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { getConfig } from '../core/config.js';
import type { IncomingMessage } from 'node:http';

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower: unknown) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h: unknown) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip: unknown) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────

async function lookupWithTimeout(hostname: string): Promise<dns.LookupAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

async function resolveSafeHost(hostname: unknown, { allowPrivate = false }: { allowPrivate?: boolean } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error: unknown) {
    throw new Error(`域名解析失败：${error instanceof Error ? error.message : error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip }。 */
export async function validateFetchUrl(raw: unknown, { allowPrivate = false }: { allowPrivate?: boolean } = {}) {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s: string, max: number) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBounded(res: IncomingMessage, maxBytes: number, asText: true): Promise<string>;
function readBounded(res: IncomingMessage, maxBytes: number, asText: false): Promise<Buffer>;
function readBounded(res: IncomingMessage, maxBytes: number, asText: boolean): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chunks: Buffer[] = [];
    let total = 0;
    let text = '';
    let settled = false;
    const finish = (fn: (value: string | Buffer | PromiseLike<string | Buffer>) => void, val: string | Buffer) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (settled) return;
      total += chunk.length;
      if (asText) text += decoder.write(chunk);
      else chunks.push(chunk);
      // 只用字节数判断是否超限。原实现还额外判断了 text.length >= maxBytes，
      // 但 text.length 是字符数而 maxBytes 是字节数（UTF-8 下中文 1 字符 = 3 字节），
      // 单位不一致，会让刚好读满的响应被误标成 truncated。
      if (total >= maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        finish(resolve, asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes));
      }
    });
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end();
          finish(resolve, sliceByCodePoints(text, maxBytes));
        } else {
          finish(resolve, Buffer.concat(chunks));
        }
      }
    });
    res.on('error', reject);
  });
}

interface RequestResult { statusCode: number; redirect?: string; body?: string | Buffer; contentType?: string }

export interface SafeStreamResult {
  url: URL;
  response: IncomingMessage;
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url: URL, ip: string, { asBinary = false, maxBytes = 50000, signal }: { asBinary?: boolean; maxBytes?: number; signal?: AbortSignal } = {}): Promise<RequestResult> {  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000,
      // 与 `openSafeStream` 同一写法。调用方不传时行为逐字不变（undefined 就是这个字段的
      // 默认值）。注意信号**只覆盖请求本身**：DNS 校验（`lookupWithTimeout` 的 5s）在它之前，
      // 那一段撤不掉 —— 所以预算得把它算进去，不能按"signal 一响就立刻返回"来推。
      signal
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      const bodyPromise = asBinary ? readBounded(res, maxBytes, false) : readBounded(res, maxBytes, true);
      bodyPromise.then((body) => resolve({ statusCode, body, contentType: String(res.headers['content-type'] || '') })).catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 打开一个经过 SSRF 校验的流式响应。每次重定向都会重新做协议、主机与 DNS 校验，
 * 真正发请求时固定到已经校验过的 IP，避免 DNS rebinding。调用方负责消费/销毁 response。
 *
 * 这是给 FFmpeg 本地流式代理用的低层入口：不缓存完整响应，也不把用户 URL 交给 shell。
 */
export async function openSafeStream(urlString: unknown, {
  method = 'GET', headers = {}, signal, maxRedirects = MAX_REDIRECTS
}: {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
} = {}): Promise<SafeStreamResult> {
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= maxRedirects; i++) {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const port = url.port || (url.protocol === 'https:' ? 443 : 80);
      const req = mod.request({
        hostname: ip,
        port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          host: url.host,
          'user-agent': 'qq-agent-transcription/1.0',
          accept: '*/*'
        },
        servername: url.protocol === 'https:' ? url.hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: 20_000,
        signal
      }, resolve);
      req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
      req.on('error', reject);
      req.end();
    });

    const statusCode = response.statusCode || 0;
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      const location = String(response.headers.location || '');
      response.resume();
      if (!location) throw new Error(`重定向缺少 Location: ${statusCode}`);
      const next = new URL(location, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (statusCode < 200 || statusCode >= 300) {
      response.resume();
      throw new Error(`远程媒体返回 HTTP ${statusCode}`);
    }
    return { url, response };
  }
  throw new Error('重定向次数过多，已停止');
}

const MAX_REDIRECTS = 5;

/**
 * 抓取网页文本返回的**原始字节**上限。
 *
 * 为什么从 50000 提到 250000：这个上限是"防内存爆炸"，不是"省模型上下文"——
 * 后者由调用方（`web_fetch` 的 `FETCH_TEXT_MAX_CHARS`）负责。旧值对**现代网页**实在太小：
 * 实测萌娘百科一个词条整页 486K 字节，前 50000 字节**几乎全是 `<head>` 里的 `<script>`**
 * （MediaWiki 的 `RLCONF={…}`），剥掉脚本后只剩不到 6K 字可读文本，而**正文根本还没开始**
 * （第一个 `<p>` 在 23306 字符处）。提上来之后 `web_fetch` 能拿到**完整正文**再按
 * 20000 字符给模型 —— 同一页从 206 字变到 20000 字。
 *
 * 250000 的依据：它够装下 `web_fetch` 20000 字符上限对应的**全部** HTML（含标签与实体，
 * 实测萌娘初音未来词条 555K 字节里去掉脚本后 446K，20000 字正文对应的 HTML 约 20 万字节），
 * 同时仍是个有界的内存承诺（单次抓取最多 250KB 字符串）。
 */
const TEXT_MAX_BYTES = 250000;

/** 抓取网页文本（≤250000 字节），SSRF 全防护（不做内网例外）。 */
export async function safeFetch(urlString: unknown) {
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: false, maxBytes: TEXT_MAX_BYTES });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = typeof result.body === 'string' ? result.body : '';
    // `contentType` 要一起带出去：`web_fetch` 靠它决定"要不要按 HTML 剥正文"
    // （见 `media/html-to-text.ts` 开头那个 bug）。少了它只能猜正文形态。
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: body.length >= TEXT_MAX_BYTES,
      body,
      contentType: result.contentType || ''
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。
 *
 * `signal` **可选**：不传时行为与从前逐字相同。搜图服务层传它 —— 下载是整轮预算的一部分，
 * 撤得掉就意味着"引擎还没开火"的那部分时间能被收回来（见 `image-loader.ts`）。
 * 每一跳重定向都带上同一个信号。
 */
export async function safeFetchBinary(urlString: unknown, maxBytes = 12 * 1024 * 1024, signal?: AbortSignal) {
  const allowPrivate = getConfig().security?.allowPrivateImageHosts === true;
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes, signal });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    return { buffer: Buffer.isBuffer(result.body) ? result.body : Buffer.alloc(0), contentType: result.contentType || '' };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 按魔数判图片类型（png/jpeg/gif/webp），认不出返回 null。
 *
 * 放在这里而不是 tools.js：它只跟"拿到的字节"有关，跟网络、跟工具集都无关，
 * 而落盘缓存（sticker-cache.js）也要用它定文件后缀 —— 让那个模块去 import 整个
 * 工具集不合适。tools.js 照旧转出这个名字，调用点一行都不用改。
 */
export function detectMime(buf: Buffer | Uint8Array | null | undefined) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw: unknown) {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}
