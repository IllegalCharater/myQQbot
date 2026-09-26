import { errorMessage, isRecord, readBody } from '../http.js';
import type { Route } from '../types.js';
import path from 'node:path';
import { collectInjectedDigests } from '../../agent/prompt.js';

interface ChatSummary extends Record<string, unknown> {
  key: string; lastTs: number; replying: boolean; phase: string; compacting: boolean; chatName: string;
}

export const chatRoutes: Route[] = [
  {
    method: 'POST', path: /^\/api\/chats\/(group|private)_(\d+)\/compact$/, async handle(ctx, _req, match) {
      const chatKey = `${match?.[1]}:${match?.[2]}`;
      try {
        const result = await ctx.orchestrator.compactChat(chatKey, { force: true }); ctx.emit('chat-update', chatKey);
        if (!result?.ok) return { status: 409, body: { ok: false, error: result?.note || '压缩未执行' } };
        return { status: 200, body: { ...result, chatKey } };
      } catch (error) { return { status: 500, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'GET', path: /^\/api\/chats\/(group|private)_(\d+)\/messages$/, async handle(ctx, _req, match, url) {
      const chatKey = `${match?.[1]}:${match?.[2]}`; const limit = Math.min(1_048_576, Math.max(1, Number(url.searchParams.get('limit')) || 1_048_576));
      const messages = ctx.store.recent(chatKey, { limit }).map((message) => ({
        id: message.id, mid: message.mid, ts: message.ts, senderId: message.senderId, senderName: message.senderName,
        text: message.text, self: message.self, read: message.read, reply: message.reply, media: message.media || [],
        kind: message.kind || '', digest: message.digest || null,
      }));
      const dig = collectInjectedDigests(ctx.store, chatKey);
      const digestStatus = { config: dig.config, injectedIds: dig.injected.map((item) => item.entry.id),
        truncatedId: dig.injected.find((item) => item.truncated)?.entry.id ?? null, droppedIds: dig.dropped.map((item) => item.id),
        chars: dig.chars, budget: dig.budget, total: dig.total, totalChars: dig.totalChars };
      return { status: 200, body: { chatKey, messages, digestStatus } };
    },
  },
  {
    method: 'PATCH', path: /^\/api\/chats\/(group|private)_(\d+)\/messages\/(\d+)$/, async handle(ctx, req, match) {
      const chatKey = `${match?.[1]}:${match?.[2]}`; const localId = Number(match?.[3]); const body = await readBody(req).catch(() => ({}));
      const record = isRecord(body) ? body : {}; const text = typeof record.text === 'string' ? record.text : null;
      if (text == null) return { status: 400, body: { ok: false, error: '缺少 text' } };
      if (!text.trim()) return { status: 400, body: { ok: false, error: '内容不能为空' } };
      if (text.length > 8_000) return { status: 400, body: { ok: false, error: '内容过长' } };
      const current = ctx.store.findByLocalId(chatKey, localId); if (!current) return { status: 404, body: { ok: false, error: '找不到这条记录' } };
      if (current.kind === 'digest') return { status: 400, body: { ok: false, error: '摘要由模型生成，不能手改；可以删除' } };
      const message = ctx.store.updateByLocalId(chatKey, localId, { text }); ctx.emit('chat-update', chatKey);
      return { status: 200, body: { ok: true, message } };
    },
  },
  {
    method: 'DELETE', path: /^\/api\/chats\/(group|private)_(\d+)\/messages\/(\d+)$/, async handle(ctx, _req, match) {
      const chatKey = `${match?.[1]}:${match?.[2]}`; const localId = Number(match?.[3]); const result = ctx.store.deleteByLocalId(chatKey, localId);
      if (!result) return { status: 404, body: { ok: false, error: '找不到这条记录（可能已在别处删掉）' } };
      ctx.orchestrator.forgetMessage(chatKey, localId); ctx.emit('chat-update', chatKey);
      return { status: 200, body: { ok: true, removed: { id: result.removed.id, senderName: result.removed.senderName, ts: result.removed.ts },
        backup: result.backup ? path.basename(result.backup) : '', remaining: ctx.store.getChatMeta(chatKey).total } };
    },
  },
  {
    method: 'POST', path: /^\/api\/chats\/(group|private)_(\d+)\/notes$/, async handle(ctx, req, match) {
      const chatKey = `${match?.[1]}:${match?.[2]}`; const body = await readBody(req).catch(() => ({})); const record = isRecord(body) ? body : {};
      const text = String(record.text ?? '').trim(); if (!text) return { status: 400, body: { ok: false, error: '备注内容不能为空' } };
      if (text.length > 2_000) return { status: 400, body: { ok: false, error: '备注过长（上限 2000 字）' } };
      const note = ctx.store.insertNote(chatKey, { text, ts: Number(record.ts) || Date.now() }); ctx.emit('chat-update', chatKey);
      return { status: 200, body: { ok: true, note } };
    },
  },
  {
    method: 'GET', path: '/api/chats', async handle(ctx) {
      const chats: ChatSummary[] = ctx.store.listChats().map((key) => ({
        key, ...ctx.store.getChatMeta(key), replying: false, phase: '', compacting: false, chatName: '',
      })).sort((a, b) => b.lastTs - a.lastTs);
      for (const chat of chats) {
        const state = ctx.orchestrator.chatState(chat.key); chat.replying = state?.state === 'replying';
        chat.phase = chat.replying ? state?.phase || '' : ''; chat.compacting = ctx.orchestrator.compacting.has(chat.key);
      }
      await Promise.allSettled(chats.map(async (chat) => {
        const match = /^group:(\d+)$/.exec(chat.key); if (!match) return;
        try { chat.chatName = await Promise.race([ctx.orchestrator.getChatName(match[1]), new Promise<string>((resolve) => setTimeout(() => resolve(''), 3_000))]) || ''; }
        catch { chat.chatName = ''; }
      }));
      return { status: 200, body: { chats } };
    },
  },
  {
    method: 'GET', path: /^\/api\/groups\/(\d+)\/members$/, async handle(ctx, _req, match) {
      try {
        const raw = await ctx.onebot.call('get_group_member_list', { group_id: Number(match?.[1]) });
        const data = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
        const members = data.filter(isRecord).map((member) => ({ userId: String(member.user_id), nickname: String(member.nickname || ''), card: String(member.card || '') }))
          .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
        return { status: 200, body: { members } };
      } catch (error) { return { status: 502, body: { error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: /^\/api\/chats\/(group|private)_(\d+)\/wake$/, async handle(ctx, _req, match) {
      return { status: 200, body: { ok: ctx.orchestrator.forceWake(`${match?.[1]}:${match?.[2]}`) } };
    },
  },
  {
    method: 'POST', path: /^\/api\/chats\/(group|private)_(\d+)\/test-send$/, async handle(ctx, req, match) {
      const body = await readBody(req); const record = isRecord(body) ? body : {}; const text = String(record.text ?? '').trim();
      if (!text) return { status: 400, body: { error: '消息内容为空' } };
      try {
        const kind = match?.[1] ?? ''; const id = match?.[2] ?? ''; const chatKey = `${kind}:${id}`;
        const raw = await ctx.onebot.sendText(kind, id, text); ctx.store.appendSelf(chatKey, { text, ts: Date.now() }); ctx.emit('chat-update', chatKey);
        return { status: 200, body: { ok: true, messageId: isRecord(raw) ? raw.message_id ?? null : null } };
      } catch (error) { return { status: 502, body: { error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/, async handle(ctx, _req, match) {
      return { status: 200, body: { ok: true, marked: ctx.orchestrator.markChatSeen(`${match?.[1]}:${match?.[2]}`) } };
    },
  },
];
