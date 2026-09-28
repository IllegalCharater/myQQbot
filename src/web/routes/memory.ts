import { errorMessage, isRecord, readBody } from '../http.js';
import { EVENTS } from '../../core/events.js';
import type { Route } from '../types.js';

const recordBody = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

export const memoryRoutes: Route[] = [
  {
    method: 'GET', path: '/api/memory-files', async handle(ctx) {
      const files: Array<{ chatKey: string; impressionCount: number; memberCount: number; updatedAt: number; consolidating: boolean }> =
        ctx.memory.listChats().map((rawChatKey) => { const chatKey = String(rawChatKey); const members = ctx.memory.members(chatKey); return { chatKey,
          impressionCount: members.reduce((count, member) => count + member.impressions.length, 0), memberCount: members.length,
          updatedAt: Math.max(0, ...members.map((member) => Number(member.updatedAt) || 0)), consolidating: false }; });
      const seen = new Set(files.map((file) => file.chatKey));
      for (const id of ctx.getConfig().allow?.groups || []) { const chatKey = `group:${String(id)}`; if (!seen.has(chatKey)) files.push({ chatKey, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false }); }
      for (const id of ctx.getConfig().allow?.private || []) { const chatKey = `private:${String(id)}`; if (!seen.has(chatKey)) files.push({ chatKey, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false }); }
      for (const file of files) file.consolidating = ctx.orchestrator.consolidating.has(file.chatKey);
      files.sort((a, b) => b.updatedAt - a.updatedAt);
      return { status: 200, body: { files, consolidating: [...ctx.orchestrator.consolidating] } };
    },
  },
  {
    method: 'GET', path: /^\/api\/memory-files\/(group|private)_(\d+)$/, async handle(ctx, _req, match) {
      const chatKey = `${match?.[1]}:${match?.[2]}`; return { status: 200, body: { ...ctx.memory.query(chatKey), members: ctx.memory.members(chatKey) } };
    },
  },
  {
    method: 'PUT', path: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/, async handle(ctx, req, match) {
      const chatKey = `${match?.[1]}:${match?.[2]}`; const body = recordBody(await readBody(req).catch(() => ({})));
      try {
        const member = ctx.memory.editMemberImpression(chatKey, { userId: match?.[3] ?? '', name: String(body.name ?? ''), note: body.note ?? '', impressions: body.impressions ?? [] });
        ctx.emit(EVENTS.memoryUpdate, { chatKey }); return { status: 200, body: { ok: true, member } };
      } catch (error) { return { status: 400, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'DELETE', path: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/, async handle(ctx, _req, match) {
      const chatKey = `${match?.[1]}:${match?.[2]}`; ctx.memory.removeMember(chatKey, match?.[3] ?? ''); ctx.emit(EVENTS.memoryUpdate, { chatKey });
      return { status: 200, body: { ok: true } };
    },
  },
  ...(['POST', 'PATCH', 'PUT', 'DELETE'] as const).map((method): Route => ({
    method, path: /^\/api\/memory-files\/(group|private)_(\d+)\/impressions$/,
    async handle(ctx, req, match) {
      const chatKey = `${match?.[1]}:${match?.[2]}`; const body = recordBody(await readBody(req).catch(() => ({})));
      const userId = String(body.userId ?? '').trim(); const target = String(body.target ?? '').trim(); const content = String(body.content ?? '').trim();
      if (!userId && !target) return { status: 400, body: { ok: false, error: '缺少 userId 或 target' } };
      if (userId && !/^\d{1,15}$/.test(userId)) return { status: 400, body: { ok: false, error: 'userId 必须是数字 QQ 号' } };
      if (method === 'POST') {
        if (!content) return { status: 400, body: { ok: false, error: '印象内容不能为空' } };
        if (content.length > 300) return { status: 400, body: { ok: false, error: '印象最长 300 字' } };
        const before = userId ? ctx.memory.getMember(chatKey, userId).impressions.length : ctx.memory.members(chatKey).find((member) => String(member.name) === target)?.impressions.length ?? 0;
        if (!ctx.memory.append(chatKey, 'memberImpression', content, { userId, target })) return { status: 400, body: { ok: false, error: '无法写入印象' } };
        const member = userId ? ctx.memory.getMember(chatKey, userId) : ctx.memory.members(chatKey).find((item) => String(item.name) === target);
        ctx.emit(EVENTS.memoryUpdate, { chatKey }); return { status: 200, body: { ok: true, duplicate: (member?.impressions?.length ?? 0) === before, member: member || null } };
      }
      if (method === 'PATCH' || method === 'PUT') {
        const next = String(body.next ?? body.nextContent ?? '').trim();
        if (!content) return { status: 400, body: { ok: false, error: '缺少 content（要改的那条原文）' } };
        if (!next) return { status: 400, body: { ok: false, error: '新内容不能为空' } };
        if (next.length > 300) return { status: 400, body: { ok: false, error: '印象最长 300 字' } };
        try { const member = ctx.memory.updateImpression(chatKey, { userId, target, content, next });
          if (!member) return { status: 404, body: { ok: false, error: '找不到这条印象，可能已被整理流程改写，请刷新' } };
          ctx.emit(EVENTS.memoryUpdate, { chatKey }); return { status: 200, body: { ok: true, member } };
        } catch (error) { return { status: 409, body: { ok: false, error: errorMessage(error) } }; }
      }
      if (!content) return { status: 400, body: { ok: false, error: '缺少 content（要删的那条原文）' } };
      const before = userId ? ctx.memory.getMember(chatKey, userId).impressions.length : ctx.memory.members(chatKey).find((member) => String(member.name) === target)?.impressions.length ?? 0;
      if (!ctx.memory.remove(chatKey, 'memberImpression', { userId, target, content })) return { status: 404, body: { ok: false, error: '找不到这条印象，可能已被整理流程改写，请刷新' } };
      const left = userId ? ctx.memory.getMember(chatKey, userId).impressions.length : ctx.memory.members(chatKey).find((member) => String(member.name) === target)?.impressions.length ?? 0;
      ctx.emit(EVENTS.memoryUpdate, { chatKey }); return { status: 200, body: { ok: true, memberGone: left === 0 && before > 0, memberKey: userId || target, member: userId ? ctx.memory.getMember(chatKey, userId) : null } };
    },
  })),
  {
    method: 'POST', path: '/api/memory-files/consolidate', async handle(ctx, req) {
      try {
        const body = recordBody(await readBody(req).catch(() => ({}))); const chatKey = String(body.chatKey || '');
        if (!/^(group|private):\d+$/.test(chatKey)) return { status: 400, body: { ok: false, error: 'chatKey 格式错误' } };
        let userIds: string[] | null = null;
        if (body.userIds != null) { const raw = Array.isArray(body.userIds) ? body.userIds : [body.userIds]; userIds = raw.map((id) => String(id ?? '').trim()).filter((id) => /^\d{1,15}$/.test(id));
          if (!userIds.length) return { status: 400, body: { ok: false, error: 'userIds 需为 QQ 号数组' } }; }
        if (ctx.orchestrator.consolidating.has(chatKey)) return { status: 409, body: { ok: false, error: '该群已在整理中' } };
        ctx.orchestrator.consolidating.add(chatKey); ctx.emit(EVENTS.memoryUpdate, { chatKey, phase: 'consolidate-start', userIds });
        void ctx.orchestrator.consolidateMemoryForChat(chatKey, { userIds, force: body.force !== false })
          .then((result) => ctx.emit(EVENTS.memoryUpdate, { chatKey, phase: 'consolidate-done', ...(result || {}) }))
          .catch((error: unknown) => ctx.emit(EVENTS.memoryUpdate, { chatKey, phase: 'consolidate-error', error: errorMessage(error) }))
          .finally(() => ctx.orchestrator.consolidating.delete(chatKey));
        return { status: 202, body: { ok: true, started: true } };
      } catch (error) { return { status: 400, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
];
