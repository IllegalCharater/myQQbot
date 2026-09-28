import { getConfig } from '../../core/config.js';
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { EVENTS } from '../../core/events.js';
import { ReverseImageSourceService, formatImageSourceResult } from '../../media/image-source/index.js';
import type { SearchIntent } from '../../media/image-source/index.js';
import type { ToolDefinition } from '../shared/types.js';

const service = new ReverseImageSourceService({
  getConfig: () => getConfig().imageSource,
  log: (message) => console.log(message)
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
      const requestText = (ctx.triggerEntries || []).filter((m) => !m.self).map((m) => String(m.text || '')).join('\n');
      if (!/(什么番|哪(?:部|个)?(?:动画|番)|第几集|出自哪里|出处|求图源|找图源|搜图源|查(?:一下)?(?:作者|出处|画师)|谁画的|插画|画师|pixiv)/i.test(requestText)) {
        return { content: '错误：只有群友明确要求查动画、集数、作者或图源时才能调用此工具', isError: true };
      }
      const id = String(args.messageId ?? '');
      const entry = (ctx.triggerEntries || []).find((m) => String(m.mid) === id) || ctx.store.findByMid(ctx.chatKey, args.messageId);
      const image = entry?.media?.find((m) => m.kind === 'image' && m.url);
      if (!image?.url) return { content: '错误：指定消息里没有可识别的图片', isError: true };
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
