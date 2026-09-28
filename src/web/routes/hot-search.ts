import { sanitizeHotSearchError } from '../../media/hot-search/api-client.js';
import type { Route } from '../types.js';

function errorReply(error: unknown, fallbackStatus = 502) {
  const message = sanitizeHotSearchError(error);
  const busy = message.includes('正在运行') || message.includes('已经成功播报过');
  const invalid = message.includes('目标群') || message.includes('Cron');
  return { status: busy ? 409 : invalid ? 400 : fallbackStatus, body: { ok: false, error: message } };
}

export const hotSearchRoutes: Route[] = [
  {
    method: 'GET', path: '/api/hot-search/status',
    async handle(ctx) {
      return { status: 200, body: { ok: true, status: ctx.hotSearch.status() } };
    }
  },
  {
    method: 'POST', path: '/api/hot-search/preview',
    async handle(ctx) {
      try {
        return { status: 200, body: { ok: true, preview: await ctx.hotSearch.preview() } };
      } catch (error) { return errorReply(error); }
    }
  },
  {
    method: 'POST', path: '/api/hot-search/broadcast',
    async handle(ctx) {
      try {
        return { status: 200, body: { ok: true, result: await ctx.hotSearch.broadcast() } };
      } catch (error) { return errorReply(error); }
    }
  }
];
