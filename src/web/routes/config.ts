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
      return { status: 200, body: { ok: true, config } };
    },
  },
];
