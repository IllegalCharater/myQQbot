import type { Route } from '../types.js';

export const sessionRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/sessions',
    async handle(ctx, _req, _match, url) {
      const limit = Math.min(1_048_576, Math.max(1, Number(url.searchParams.get('limit')) || 1_048_576));
      return { status: 200, body: { sessions: ctx.sessions.listSummaries(limit) } };
    },
  },
  {
    method: 'GET',
    path: /^\/api\/sessions\/([\w-]+)$/,
    async handle(ctx, _req, match) {
      const session = ctx.sessions.get(match?.[1] ?? '');
      return session
        ? { status: 200, body: session }
        : { status: 404, body: { error: '会话不存在' } };
    },
  },
];
