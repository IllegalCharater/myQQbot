import fs from 'node:fs';
import path from 'node:path';
import { EVENTS } from '../../core/events.js';
import { ROOT } from '../../core/paths.js';
import { listModels } from '../../llm/llm.js';
import { PERSONAS } from '../../core/prompt-catalog.js';
import { errorMessage, isRecord, readBody } from '../http.js';
import type { Route } from '../types.js';

function localVersion(): string {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'version' in parsed) return String(parsed.version || '0.0.0');
  } catch { /* 本地版本读取失败时保持旧回退值 */ }
  return '0.0.0';
}

export const systemRoutes: Route[] = [
  {
    method: 'GET', path: '/api/status',
    async handle(ctx) { return { status: 200, body: await ctx.buildStatus() }; },
  },
  {
    method: 'POST', path: '/api/snowluma/launch',
    async handle(ctx) {
      try {
        const result = await ctx.launchSnowluma();
        return { status: isRecord(result) && result.ok ? 200 : 400, body: result };
      } catch (error) { return { status: 500, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'GET', path: '/api/snowluma/logs',
    async handle(ctx) { return { status: 200, body: { logs: ctx.getSnowlumaLogs() } }; },
  },
  {
    method: 'POST', path: '/api/snowluma/stop',
    async handle(ctx) {
      try {
        const stopped = ctx.stopSnowluma();
        return { status: 200, body: { ok: true, stopped, ...ctx.snowlumaStatus() } };
      } catch (error) { return { status: 500, body: { ok: false, error: errorMessage(error) } }; }
    },
  },
  {
    method: 'POST', path: '/api/snowluma/open-folder',
    async handle(ctx) { return ctx.openSnowlumaFolder(); },
  },
  {
    method: 'POST', path: '/api/snowluma/open-webui',
    async handle(ctx) { return ctx.openSnowlumaWebui(); },
  },
  {
    method: 'GET', path: '/api/version',
    async handle() { return { status: 200, body: { version: localVersion() } }; },
  },
  {
    method: 'GET', path: '/api/models',
    async handle() {
      try { return { status: 200, body: { models: await listModels() } }; }
      catch (error) { return { status: 502, body: { error: errorMessage(error) } }; }
    },
  },
  {
    method: 'GET', path: '/api/onebot/groups',
    async handle(ctx) {
      try {
        const raw = await ctx.onebot.call('get_group_list');
        const data = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
        const groups = data.filter(isRecord).map((group) => ({
          id: String(group.group_id), name: String(group.group_name ?? group.group_id),
        }));
        return { status: 200, body: { groups } };
      } catch (error) { return { status: 502, body: { error: errorMessage(error) } }; }
    },
  },
  {
    method: 'GET', path: '/api/onebot/friends',
    async handle(ctx) {
      try {
        const raw = await ctx.onebot.call('get_friend_list');
        const data = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
        const friends = data.filter(isRecord).map((friend) => ({
          id: String(friend.user_id), name: String(friend.remark || friend.nickname || friend.user_id),
        }));
        return { status: 200, body: { friends } };
      } catch (error) { return { status: 502, body: { error: errorMessage(error) } }; }
    },
  },
  {
    method: 'GET', path: '/api/persona-templates',
    async handle(ctx) {
      const builtins = Object.entries(PERSONAS).map(([id, persona]) => ({ id, name: persona.name, text: persona.text, builtin: true }));
      const cfg = ctx.getConfig() as unknown as Record<string, unknown>;
      const rawCustoms = Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [];
      const customs = rawCustoms.filter(isRecord).map((persona, index) => ({
        id: `custom_${index}`, name: String(persona.name ?? ''), text: String(persona.text ?? ''),
        customRules: String(persona.customRules ?? ''), builtin: false,
      }));
      return { status: 200, body: { templates: [...builtins, ...customs] } };
    },
  },
  {
    method: 'POST', path: '/api/persona-templates',
    async handle(ctx, req) {
      const body = await readBody(req).catch(() => ({}));
      const record = isRecord(body) ? body : {};
      const name = String(record.name ?? '').trim().slice(0, 50);
      const text = String(record.text ?? '').trim();
      if (!name || !text) return { status: 400, body: { ok: false, error: '人设名称和角色设定都不能为空' } };
      const entry: { name: string; text: string; customRules?: string } = { name, text };
      const customRules = String(record.customRules ?? '').trim();
      if (customRules) entry.customRules = customRules;
      const cfg = ctx.getConfig() as unknown as Record<string, unknown>;
      const current = Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [];
      const next = [...current, entry];
      ctx.updateConfig({ customPersonas: next });
      return { status: 200, body: { ok: true, templates: next } };
    },
  },
  {
    method: 'DELETE', path: /^\/api\/persona-templates\/(custom_\d+)$/,
    async handle(ctx, _req, match) {
      const index = Number((match?.[1] ?? '').replace('custom_', ''));
      const cfg = ctx.getConfig() as unknown as Record<string, unknown>;
      const current = Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [];
      ctx.updateConfig({ customPersonas: current.filter((_item, itemIndex) => itemIndex !== index) });
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: 'POST', path: '/api/pause',
    async handle(ctx, req) {
      const raw = await readBody(req);
      const body = isRecord(raw) ? raw : {};
      const wasPaused = ctx.orchestrator.paused;
      ctx.orchestrator.setPaused(Boolean(body.paused));
      if (wasPaused && !ctx.orchestrator.paused && !body.skipBacklog) ctx.orchestrator.drainBacklogAfterResume();
      return { status: 200, body: { ok: true, paused: ctx.orchestrator.paused } };
    },
  },
  {
    method: 'DELETE', path: '/api/pause',
    async handle(ctx) {
      ctx.orchestrator.setPaused(false);
      const marked: Record<string, number> = {};
      for (const chatKey of ctx.store.listChats()) {
        const count = ctx.orchestrator.markChatSeen(chatKey);
        if (count > 0) marked[chatKey] = count;
      }
      ctx.emit(EVENTS.chatUpdate, '*');
      return { status: 200, body: { ok: true, paused: false, marked } };
    },
  },
];
