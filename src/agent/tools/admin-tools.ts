import { EVENTS } from '../../core/events.js';
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { enqueueJmcomicDownload } from '../../media/jmcomic.js';
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
