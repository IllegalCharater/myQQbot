// 表情图片的本地缓存：把 bot 自己收藏的表情的图落到 data/sticker-cache/。
//
// 为什么需要它：collect_sticker 存下的是**收藏那一刻**的 QQ 图床链接（带签名，会过期），
// 而 mergeStickerLibrary 只会刷新 QQ 收藏那些条目的 url —— bot 自己收的（source='ai'）
// 链接一旦过期就永远是死的，发送时就是 `HTTP download failed: 400`。
// 在收藏那一刻（链接最新鲜的时候）把字节落盘，之后发送直接给协议端一个本机绝对路径，
// 不再看图床脸色。
//
// ⚠️ 只管 QQ 收藏以外的条目（source !== 'qq'）。QQ 收藏的 url 每次同步都会换成新签名，
// 缓存它们只会"存一次就被换掉一次、换完就成孤儿"，而它们本来就不缺可用的链接。
// 这样一来"缓存文件的生命周期 == 条目本身的生命周期"：sticker.maxKeepCount 淘汰条目时
// 把文件一起删，那个上限同时也就是这个目录的上限。
//
// 模块边界：这里只有"字节 ↔ 磁盘"和"条目的图从哪来"，不碰表情库的结构（那是 stickers.js）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { validateImageUrl, safeFetchBinary, detectMime } from './safe-fetch.js';

export const CACHE_DIR = path.join(DATA_DIR, 'sticker-cache');

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** id 的 8 位哈希：让"两个 id 净化后撞名"和"id 里塞 ../"这两类事从根上不可能发生。 */
function shortHash(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 文件名 = 净化后的 id + 短哈希 + 后缀。只存文件名（存绝对路径的话换个数据目录就全失效）。 */
export function cacheFileName(id, mime = 'image/jpeg') {
  const base = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'sticker';
  return `${base}_${shortHash(id)}.${EXT_BY_MIME[mime] || 'jpg'}`;
}

/** 文件名 → 缓存目录内的绝对路径。越界直接抛（照 jmcomic.validatePdf 的先例）。 */
export function cachePath(name) {
  const p = path.resolve(CACHE_DIR, String(name ?? ''));
  if (!p.startsWith(path.resolve(CACHE_DIR) + path.sep)) throw new Error('缓存文件名越界');
  return p;
}

/** 这条表情的缓存文件绝对路径；没有记录或文件已不在 → null。 */
export function cachedPath(entry) {
  const name = String(entry?.cacheFile || '').trim();
  if (!name) return null;
  let p;
  try { p = cachePath(name); } catch { return null; }
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

/**
 * 把一条表情的图下载到缓存目录。返回 { name, file, mime, bytes }；QQ 收藏返回 null（不缓存）。
 * 调用方负责把 name 写回条目（entry.cacheFile）并落库。
 */
export async function ensureCached(entry) {
  if (!entry || entry.source === 'qq') return null;
  const url = String(entry.url || '').trim();
  if (!url) throw new Error('这条表情没有可缓存的图片地址');
  const safeUrl = await validateImageUrl(url);
  const { buffer } = await safeFetchBinary(safeUrl);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  // 认不出是图片就拒绝写盘：与缩略图路由的 415 同一条口径，
  // 免得被污染的库把 html/js 当"图片"囤进本地目录。
  const mime = detectMime(buffer);
  if (!mime) throw new Error('下载到的不是图片（png/jpeg/gif/webp），已拒绝写缓存');
  const name = cacheFileName(entry.id, mime);
  const file = cachePath(name);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
  return { name, file, mime, bytes: buffer.length };
}

/** 缓存文件的 data URL（看图工具用）；没有缓存文件 → null。 */
export async function cachedDataUrl(entry) {
  const file = cachedPath(entry);
  if (!file) return null;
  const buffer = await fs.promises.readFile(file);
  if (!buffer?.length) return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = detectMime(buffer) || MIME_BY_EXT[ext] || 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/** 删掉这条表情的缓存文件（尽力而为，绝不抛 —— 它是条目的附属品，删不掉不该拦住删条目）。 */
export function dropCached(entry) {
  const file = cachedPath(entry);
  if (!file) return false;
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

/** 删掉没人认领的缓存文件（手改过 stickers.json、或写盘写到一半崩了的残留）。返回删了几个。 */
export function sweepOrphans(entries) {
  const referenced = new Set(
    (Array.isArray(entries) ? entries : []).map((e) => String(e?.cacheFile || '').trim()).filter(Boolean)
  );
  let names;
  try { names = fs.readdirSync(CACHE_DIR); } catch { return 0; }
  let swept = 0;
  for (const name of names) {
    if (referenced.has(name)) continue;
    try {
      const p = cachePath(name);
      if (fs.statSync(p).isFile()) { fs.rmSync(p, { force: true }); swept++; }
    } catch { /* 越界名/读不到，跳过 */ }
  }
  return swept;
}

/**
 * 发送这条表情时该给协议端什么：本机绝对路径（有缓存时）或原始 url（QQ 收藏 / 缓存失败时）。
 *
 * 没有缓存就现下一份 —— 这也是老条目（本次改动之前收藏的）第一次被发送时补上缓存的时机。
 * 下载失败**不阻断发送**：退回原始 url，行为与改动前一致（这条链接要是还没过期就照样发得出去）。
 */
export async function sendTarget(entry) {
  const url = String(entry?.url || '').trim();
  if (!entry || entry.source === 'qq') return url;
  const cached = cachedPath(entry);
  if (cached) return cached;
  try {
    const result = await ensureCached(entry);
    return result?.file || url;
  } catch {
    return url;
  }
}

/** 判断一个发送目标是不是本模块写的缓存文件（tools.js 的安全闸据此放行，不必再过 URL 校验）。 */
export function isCacheFile(target) {
  const p = String(target || '');
  if (!p) return false;
  if (!p.startsWith(path.resolve(CACHE_DIR) + path.sep)) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
