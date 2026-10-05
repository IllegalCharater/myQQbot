import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { err, isRecord, ok } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

/** 成员长期记忆的读写工具。 */
export function memoryTools(): ToolDefinition[] {
  return [
    {
      name: 'memory_append',
      description: TOOL_PROMPT_TEXT.memory_append.description,
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.memory_append.userId },
          target: { type: 'string', description: TOOL_PROMPT_TEXT.memory_append.target },
          content: { type: 'string', description: TOOL_PROMPT_TEXT.memory_append.content }
        },
        required: ['category', 'userId', 'content']
      },
      async execute(ctx, args) {
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。先用 get_active_members 查准确 QQ 号再记。`);
        }
        const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', String(args.content ?? ''), {
          userId,
          target: String(args.target ?? '').trim()
        });
        return ok({ saved: true, entry });
      }
    },
    {
      name: 'memory_query',
      description: TOOL_PROMPT_TEXT.memory_query.description,
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.memory_query.userId }
        },
        required: ['userId']
      },
      async execute(ctx, args) {
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。先用 get_active_members / get_recent_messages 查准确 QQ 号再查询。`);
        }
        const mem = ctx.memory.query(ctx.chatKey);
        const impressions = Array.isArray(mem.memberImpression) ? mem.memberImpression : [];
        const list = impressions.filter((entry) => isRecord(entry) && String(entry.userId) === userId);
        return ok({ memberImpression: list });
      }
    },
    {
      name: 'memory_remove',
      description: TOOL_PROMPT_TEXT.memory_remove.description,
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.memory_remove.userId },
          target: { type: 'string', description: TOOL_PROMPT_TEXT.memory_remove.target },
          content: { type: 'string', description: TOOL_PROMPT_TEXT.memory_remove.content }
        },
        required: ['category']
      },
      async execute(ctx, args) {
        const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
          userId: String(args.userId ?? '').trim(),
          target: String(args.target ?? '').trim(),
          content: String(args.content ?? '').trim()
        });
        return ok({ removed });
      }
    }
  ];
}
