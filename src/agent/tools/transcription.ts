import { getConfig } from '../../core/config.js';
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { SlidingWindowBudget } from '../../media/call-budget.js';
import { TranscriptionError, resolveTranscriptionConfig } from '../../media/video-transcription.js';
import type { ToolDefinition } from '../shared/types.js';

// 成本闸门：转写按次向腾讯云计费、单次成本远高于一次搜图，所以默认上限（3/10）比搜图（5/30）更紧。
// 只限次数，不判断"该不该转"（那是模型结合上下文的事，见工具 description）。
// 上限从 resolveTranscriptionConfig 取，钳制与 enabled 判定都归它一处管。
const budget = new SlidingWindowBudget({
  getLimits: () => {
    const cfg = resolveTranscriptionConfig(getConfig());
    return { perChatPerHour: cfg.maxCallsPerChatPerHour, perDay: cfg.maxCallsPerDay };
  }
});

export function transcriptionTools(): ToolDefinition[] {
  return [{
    name: 'transcribe_video',
    description: TOOL_PROMPT_TEXT.transcribe_video.description,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: TOOL_PROMPT_TEXT.transcribe_video.url },
        messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.transcribe_video.messageId }
      },
      required: []
    },
    async execute(ctx, args) {
      // 顺序与 reverse_image_source 一致：先解析出目标（取不到时零成本返回）→ 占额度 → 才建任务。
      const explicit = typeof args.url === 'string' ? args.url.trim() : '';
      const messageId = args.messageId ?? null;
      let url = explicit;
      if (!url) {
        if (messageId === null) return { content: '错误：需要提供 url 或 messageId', isError: true };
        const id = String(messageId);
        const entry = (ctx.triggerEntries || []).find((m) => String(m.mid) === id)
          || ctx.store.findByMid(ctx.chatKey, messageId);
        // B 站视频卡片在接入层入库**之前**就被补成了 kind:'video' 别名（web/onebot/ingest.ts），
        // 所以读存档时只认 video 一种 kind 就够，不需要在这里重做卡片解析。
        const video = entry?.media?.find((m) => m.kind === 'video' && m.url);
        if (!video?.url) return { content: '错误：指定消息里没有可转写的视频链接（B 站视频卡片也可以）', isError: true };
        url = String(video.url);
      }
      const queue = ctx.transcription;
      if (!queue) return { content: '错误：转写功能未启用', isError: true };
      // 限频排在建任务之前：被拒绝的调用不该进队列，也不该占额度。
      try {
        budget.take(ctx.chatKey);
      } catch (error) {
        if (error instanceof Error && error.message === 'RATE_LIMITED') {
          const cfg = resolveTranscriptionConfig(getConfig());
          return { content: `错误：本群转写太频繁（每小时最多 ${cfg.maxCallsPerChatPerHour} 次），稍后再试。`, isError: true };
        }
        throw error;
      }
      try {
        // enqueue 自己会做 URL 安全校验（协议/凭据/内网）、云凭证检查与任务去重前置判断，
        // 这里不重复实现任何一道闸门。
        const job = queue.enqueue({
          chatKey: ctx.chatKey,
          url,
          replyToMessageId: typeof messageId === 'string' || typeof messageId === 'number' ? messageId : null
        });
        // 刻意不在这里发消息：完成后队列会把结果直接投递回本会话（video-transcription.ts 的 #deliver），
        // 工具再发一条"稍等"只会和模型自己的回复重复。
        return { content: `已加入转写队列（任务 ${job.id.slice(0, 8)}），完成后识别文本会自动发到本会话。` };
      } catch (error) {
        // TranscriptionError 携带的 message 本来就是中文用户文案（与 `/转写` 命令路径同源）。
        if (error instanceof TranscriptionError) return { content: `错误：${error.message}`, isError: true };
        return { content: '错误：转写任务创建失败，稍后再试。', isError: true };
      }
    }
  }];
}
