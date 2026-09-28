import fs from 'node:fs';
import { EVENTS } from '../../core/events.js';
import { detectMime } from '../../agent/tools/index.js';
import { safeFetchBinary, validateImageUrl } from '../../media/safe-fetch.js';
import { cachedPath } from '../../stickers/sticker-cache.js';
import type { StickerPatch } from '../../stickers/types.js';
import { errorMessage, isRecord, readBody } from '../http/http.js';
import type { Route } from '../types.js';

const imageHeaders = (mime: string, length: number): Record<string, string> => ({
  'content-type': mime, 'content-length': String(length), 'cache-control': 'private, max-age=600',
  'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'",
});

export const stickerRoutes: Route[] = [
  {
    method: 'GET', path: '/api/stickers', async handle(ctx, _req, _match, url) {
      try {
        const data = await ctx.stickers.adminList(String(url.searchParams.get('q') ?? ''), Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200)), url.searchParams.get('force') === '1');
        return { status: 200, body: { ok: true, ...data, maxKeepCount: Math.max(0, Number(ctx.getConfig().sticker?.maxKeepCount) || 0) } };
      } catch (error) { return { status: 502, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/stickers/sync', async handle(ctx) {
      try {
        const data = await ctx.stickers.adminList('', 500, true); ctx.emit(EVENTS.stickerUpdate, {});
        return { status: 200, body: { ok: !data.syncError, count: data.total, fromCache: data.fromCache, error: data.syncError || '' } };
      } catch (error) { return { status: 502, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/stickers/cache', async handle(ctx) {
      try {
        const targets = ctx.stickers.entries.filter((entry) => entry.source !== 'qq' && !cachedPath(entry)); let cached = 0;
        const errors: Array<{ id: string; error: string }> = [];
        for (const item of targets.slice(0, 200)) { const result = await ctx.stickers.cacheOne(item.id); if (result.cached) cached += 1; else errors.push({ id: item.id, error: result.error || '缓存失败' }); }
        const swept = ctx.stickers.sweep(); if (cached || swept) ctx.emit(EVENTS.stickerUpdate, {});
        return { status: 200, body: { ok: true, cached, swept, failed: errors.length, errors: errors.slice(0, 5), remains: Math.max(0, targets.length - 200) } };
      } catch (error) { return { status: 502, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'GET', path: /^\/api\/stickers\/([^/]+)\/image$/, async handle(ctx, _req, match) {
      let ref: string; try { ref = decodeURIComponent(match?.[1] ?? ''); } catch { return { status: 400, body: { error: '表情 id 编码错误' } }; }
      const entry = await ctx.stickers.find(ref).catch(() => null); if (!entry) return { status: 404, body: { error: '找不到这个表情' } };
      const local = cachedPath(entry);
      if (local) { try { const buffer = await fs.promises.readFile(local); const mime = detectMime(buffer); if (mime) return { kind: 'binary', status: 200, body: buffer, headers: imageHeaders(mime, buffer.length) }; } catch { /* 回退网络图源 */ } }
      if (!entry.url) return { status: 404, body: { error: '该表情没有图片地址' } };
      try {
        const { buffer, contentType } = await safeFetchBinary(await validateImageUrl(entry.url));
        const mime = detectMime(buffer) || (/^image\//i.test(String(contentType || '')) ? String(contentType).split(';')[0] : '');
        if (!mime) return { status: 415, body: { error: '取回的内容不是图片' } };
        return { kind: 'binary', status: 200, body: buffer, headers: imageHeaders(mime, buffer.length) };
      } catch (error) { return { status: 502, body: { error: errorMessage(error) } }; }
    },
  },
  {
    method: 'PATCH', path: /^\/api\/stickers\/([^/]+)$/, async handle(ctx, req, match) {
      let ref: string; try { ref = decodeURIComponent(match?.[1] ?? ''); } catch { return { status: 400, body: { ok: false, error: '表情 id 编码错误' } }; }
      const raw = await readBody(req).catch(() => ({})); const body = isRecord(raw) ? raw : {}; const patch: StickerPatch = {};
      if (body.note !== undefined) patch.note = String(body.note ?? '').trim().slice(0, 200);
      if (body.usage !== undefined) patch.usage = String(body.usage ?? '').trim().slice(0, 200);
      if (body.tags !== undefined) { const source = Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(/[,，\s]+/); patch.tags = [...new Set(source.map((tag) => String(tag ?? '').trim().slice(0, 30)).filter(Boolean))].slice(0, 20); }
      if (!Object.keys(patch).length) return { status: 400, body: { ok: false, error: '没有可改的字段（note / tags / usage）' } };
      const result = ctx.stickers.noteVerbose(ref, patch);
      if (result.ambiguous?.length) return { status: 409, body: { ok: false, error: `「${ref}」对应 ${result.ambiguous.length} 个表情，请用 id 指定：${result.ambiguous.map((entry) => entry.id).join(' / ')}`, candidates: result.ambiguous.map((entry) => ({ id: entry.id, desc: entry.desc, url: entry.url })) } };
      if (!result.entry) return { status: 404, body: { ok: false, error: '找不到这个表情' } };
      ctx.emit(EVENTS.stickerUpdate, { id: result.entry.id }); const entry = result.entry;
      return { status: 200, body: { ok: true, sticker: { id: entry.id, localNote: entry.localNote || '', tags: entry.tags || [], usage: entry.usage || '', desc: entry.desc || '' } } };
    },
  },
  {
    method: 'DELETE', path: /^\/api\/stickers\/([^/]+)$/, async handle(ctx, _req, match) {
      let ref: string; try { ref = decodeURIComponent(match?.[1] ?? ''); } catch { return { status: 400, body: { ok: false, error: '表情 id 编码错误' } }; }
      const result = ctx.stickers.remove(ref);
      if (result.refused === 'qq') return { status: 409, body: { ok: false, error: '这是 QQ 收藏里的表情，本地删不掉（下次同步就会回来）。请到 QQ 里取消收藏。' } };
      if (!result.removed) return { status: 404, body: { ok: false, error: '找不到这个表情（删除只认 id / resId / md5 / 图片地址，不按备注名猜）' } };
      ctx.emit(EVENTS.stickerUpdate, {}); return { status: 200, body: { ok: true, removed: { id: result.removed.id, desc: result.removed.desc || '' } } };
    },
  },
];
