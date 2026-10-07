import { getConfig } from '../../core/config.js';
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { SlidingWindowBudget } from '../../media/call-budget.js';
import { TranscriptionError, resolveTranscriptionConfig } from '../../media/transcription/index.js';
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
        // 两种失败分开报：id 打错/消息已不在存档里，与"消息里确实没有视频"是两回事，
        // 混成一句会让模型（和排查的人）都以为是后者。顺带列出**实际看到的附件种类**——
        // 卡片链接没被解析出来时，这条信息就是唯一能看出"卡片在、链接不在"的地方。
        if (!entry) return { content: `错误：没找到消息 ${id}（id 可能不对，或它已经不在存档里了）`, isError: true };
        // 分享卡片/视频段在接入层入库**之前**就被补成了 kind:'video' 别名（web/onebot/ingest.ts），
        // 语音段则是 kind:'audio'（本身就带 url，不需要再解析）。**两种都要认** ——
        // 只认 video 的话语音消息会报"没有视频链接"，而它明明就在 media 里。
        // 判据与 `media/transcription/commands.ts` 的 `findTranscriptionMedia` 一致（那边是 `/转写` 那条路），
        // 两处不能各写一份：一边放宽另一边没放，表现就是"命令能跑、工具说没有"。
        const video = entry.media?.find((m) => (m.kind === 'video' || m.kind === 'audio') && m.url);
        if (!video?.url) {
          const kinds = [...new Set((entry.media || []).map((m) => String(m.kind)).filter(Boolean))];
          return {
            content: `错误：这条消息里没有可转写的音视频链接（只看到：${kinds.length ? kinds.join('、') : '没有附件'}）。也可以直接把视频 URL 或 BV 号发我。`,
            isError: true
          };
        }
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
        //
        // **刻意不接 job.id、也不把它写进工具结果**：任务号对模型毫无用处（它没法用这个 id
        // 做任何事），却是"任务已派上（任务 xxxx）"这句话的全部原料。去掉原料比事后禁令可靠。
        queue.enqueue({
          chatKey: ctx.chatKey,
          url,
          replyToMessageId: typeof messageId === 'string' || typeof messageId === 'number' ? messageId : null,
          // assisted：结果不直接贴进群，而是作为一条【转写结果】进入上下文，由模型决定说什么。
          mode: 'assisted'
        });
        // 工具**自己不发任何消息**：入队后要不要先说一句（例如"我先看看"）是模型在这一次运行里
        // 自己的决定 —— 想说就接着调发送类工具，不想说就直接结束。所以这里既不代发回执，也不写
        // ctx.session.sent（那是"我这轮真的发了什么"的账，代发会让账目对不上）。
        //
        // 代价要知道：模型选择沉默时，群里在结果到达前没有任何提示。这是刻意的取舍 —— 定死一句
        // 回执会和模型自己的发言重复，而结果到达的那一次运行本来就必须开口（见 toolProtocol 第 7 条）。
        //
        // 结果串（receipt）整句都在 prompt-catalog：它没有动态成分，且是在**诱导模型说哪句话**，
        // 属于"模型可见的固定指令"，不是这条路返回的数据。
        return { content: TOOL_PROMPT_TEXT.transcribe_video.receipt };
      } catch (error) {
        // TranscriptionError 携带的 message 本来就是中文用户文案（与 `/转写` 命令路径同源）。
        if (error instanceof TranscriptionError) return { content: `错误：${error.message}`, isError: true };
        return { content: '错误：转写任务创建失败，稍后再试。', isError: true };
      }
    }
  }];
}
