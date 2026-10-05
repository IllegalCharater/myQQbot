import { EVENTS } from '../../core/events.js';
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { enqueueJmcomicDownload, searchJmcomic } from '../../media/jmcomic.js';
import { err, errorMessage, ok } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

/** 向控制台上报模型反馈的工具。 */
function feedbackTools(): ToolDefinition[] {
  return [
    {
      name: 'report_feedback',
      description: TOOL_PROMPT_TEXT.report_feedback.description,
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const rawLevel = String(args.level ?? '');
        const level = ['info', 'warning', 'error'].includes(rawLevel) ? rawLevel : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit(EVENTS.feedback, { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    }
  ];
}

/** 漫画下载与显式结束会话的工具。 */
function completionTools(): ToolDefinition[] {
  return [
    {
      name: 'search_jmcomic',
      description: TOOL_PROMPT_TEXT.search_jmcomic.description,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: TOOL_PROMPT_TEXT.search_jmcomic.query },
          mode: {
            type: 'string',
            enum: ['keyword', 'tag', 'author', 'work', 'actor'],
            description: TOOL_PROMPT_TEXT.search_jmcomic.mode
          },
          orderBy: {
            type: 'string',
            enum: ['latest', 'view', 'picture', 'like', 'score', 'comment'],
            description: TOOL_PROMPT_TEXT.search_jmcomic.orderBy
          },
          page: { type: 'integer', minimum: 1, description: TOOL_PROMPT_TEXT.search_jmcomic.page },
          limit: { type: 'integer', minimum: 1, maximum: 40, description: TOOL_PROMPT_TEXT.search_jmcomic.limit }
        },
        required: ['query'],
        additionalProperties: false
      },
      async execute(_ctx, args) {
        try {
          const result = await searchJmcomic({
            query: args.query, mode: args.mode, orderBy: args.orderBy, page: args.page, limit: args.limit
          });
          if (!result.items.length) {
            // **"没搜到"和"搜索坏了"必须分开说**：都返回空列表的话模型会以为搜索结果就是空的，
            // 而实际可能是查询词不对（换词就行）或分页越界（回去第 1 页就行）。
            return ok({
              ...result,
              note: result.total > 0
                ? `第 ${result.page} 页没有条目（共 ${result.total} 条）。换更常见的词，或把 page 调回前几页。`
                : `没有搜到与「${result.query}」相关的漫画。可以换个更常见的词，或改用 tag:标签名 试试。`
            });
          }
          return ok({
            ...result,
            // 明确重申不下载：模型很容易把"搜到了"当成"那就下载吧"。
            note: `以上只是搜索结果，**不会自动下载**。把候选告诉用户，等对方指定要哪一本（或给出 ID）再调 download_jmcomic。`
          });
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    },
    {
      name: 'download_jmcomic',
      description: TOOL_PROMPT_TEXT.download_jmcomic.description,
      parameters: {
        type: 'object',
        properties: {
          comicId: { type: 'string', pattern: '^\\d{1,20}$', description: TOOL_PROMPT_TEXT.download_jmcomic.comicId }
        },
        required: ['comicId'],
        additionalProperties: false
      },
      async execute(ctx, args) {
        try {
          const result = enqueueJmcomicDownload(ctx, args.comicId);
          return ok({ ...result, note: `已加入下载队列，当前位置：${result.position}。完成后会自动发送 PDF。` });
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    },
    {
      name: 'finish',
      description: TOOL_PROMPT_TEXT.finish.description,
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: TOOL_PROMPT_TEXT.finish.summary } },
        required: ['summary']
      },
      async execute(ctx, args) {
        ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
        return ok({ finished: true });
      }
    }
  ];
}






export function adminTools(): ToolDefinition[] {
  return [...feedbackTools(), ...completionTools()];
}
