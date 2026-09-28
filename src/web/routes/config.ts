import { readBody } from '../http/http.js';
import type { Route } from '../types.js';

export const configRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/config',
    async handle(ctx) {
      return { status: 200, body: ctx.sanitizeConfig(ctx.getConfig()) };
    },
  },
  {
    method: 'POST',
    path: '/api/config',
    async handle(ctx, req) {
      const patch = await readBody(req);
      const config = ctx.applyConfigPatch(patch);
      // 保存响应同 GET /api/config 一样必须脱敏；否则新增的热搜 Key 会在浏览器响应里回显。
      return { status: 200, body: { ok: true, config: ctx.sanitizeConfig(config) } };
    },
  },
];
