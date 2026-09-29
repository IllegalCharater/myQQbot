import { getConfig } from '../../core/config.js';
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { EVENTS } from '../../core/events.js';
import { ReverseImageSourceService, formatImageSourceResult } from '../../media/image-source/index.js';
import { SlidingWindowBudget } from '../../media/call-budget.js';
import type { SearchIntent } from '../../media/image-source/index.js';
import type { ToolDefinition } from '../shared/types.js';

const service = new ReverseImageSourceService({
  getConfig: () => getConfig().imageSource,
  log: (message) => console.log(message)
});

// 成本闸门：只限次数，不判断"该不该搜"（那是模型结合上下文的事，见工具 description）。
const budget = new SlidingWindowBudget({
  getLimits: () => {
    const cfg = getConfig().imageSource;
    return { perChatPerHour: cfg.maxCallsPerChatPerHour, perDay: cfg.maxCallsPerDay };
  }
});

function intentOf(value: unknown): SearchIntent {
  return value === 'anime' || value === 'illustration' ? value : 'unknown';
}

export function imageSourceTools(): ToolDefinition[] {
  return [{
    name: 'reverse_image_source',
    description: TOOL_PROMPT_TEXT.reverse_image_source.description,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.reverse_image_source.messageId },
        intent: { type: 'string', enum: ['anime', 'illustration', 'unknown'], description: TOOL_PROMPT_TEXT.reverse_image_source.intent }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      const cfg = getConfig().imageSource;
      if (!cfg.enabled) return { content: '错误：图片来源识别未启用', isError: true };
      const id = String(args.messageId ?? '');
      const entry = (ctx.triggerEntries || []).find((m) => String(m.mid) === id) || ctx.store.findByMid(ctx.chatKey, args.messageId);
      const image = entry?.media?.find((m) => m.kind === 'image' && m.url);
      if (!image?.url) return { content: '错误：指定消息里没有可识别的图片', isError: true };
      // 限频排在占位回复之前：否则会先发一句"稍等"再立刻拒绝。
      try {
        budget.take(ctx.chatKey);
      } catch (error) {
        if (error instanceof Error && error.message === 'RATE_LIMITED') {
          return { content: `错误：本群找图太频繁（每小时最多 ${cfg.maxCallsPerChatPerHour} 次），稍后再试。`, isError: true };
        }
        throw error;
      }
      try {
        const sent = await ctx.sender.sendTextBatch(ctx.chatKey, '在找图源，稍等', { replyToMessageId: args.messageId });
        ctx.session.sent.push(...sent.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
        ctx.emit(EVENTS.sessionUpdate, { sessionId: ctx.session.id });
        const output = await service.search(String(image.url), intentOf(args.intent));
        return { content: formatImageSourceResult(output.result) };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code === 'QUEUE_FULL') return { content: '当前找图任务太多，请稍后再试。', isError: true };
        if (code === 'IMAGE_TOO_LARGE') return { content: '图片太大，无法识别。', isError: true };
        return { content: '这次图源识别没成功，晚点再试试。', isError: true };
      }
    }
  }];
}
