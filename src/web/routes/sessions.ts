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
  {
    // 删除单个会话记录（会话页的删除按钮）。
    // 运行中的会话会被 `SessionsRegistry.remove` 拒绝 —— 它还在写这个文件，
    // 删掉之后收尾时的持久化会把它原样写回来，用户看到的是"删了又出现"。
    method: 'DELETE',
    path: /^\/api\/sessions\/([\w-]+)$/,
    async handle(ctx, _req, match) {
      const id = match?.[1] ?? '';
      const result = ctx.sessions.remove(id);
      if (!result.ok) return { status: 409, body: { ok: false, error: result.reason || '删除失败' } };
      return { status: 200, body: { ok: true, id, fileRemoved: result.fileRemoved } };
    },
  },
];
