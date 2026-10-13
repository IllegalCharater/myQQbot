import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { asyncTaskTool } from './async-task.js';
import type { ToolDefinition } from '../shared/types.js';

// 闸门**不在这里**：转写的额度检查在 `media/transcription/queue.ts` 的 `enqueue` 里，
// 与出图同形 —— 两条入口（工具与 `/转写` 命令）共用同一本账。2026-10-10 之前它在本文件里，
// 于是 `/转写` 命令不受限、而 `/画` 受；统一到队列是有意的行为变更。
export function transcriptionTools(): ToolDefinition[] {
  return [asyncTaskTool({
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
    async run(ctx, args) {
      // 顺序与 reverse_image_source 一致：先解析出目标（取不到时零成本返回）→ 才建任务。
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
      // enqueue 自己会做全部闸门：URL 安全校验（协议/凭据/内网）、云凭证检查、**调用额度**。
      // 这里不重复实现任何一道 —— 重复实现的那一份必然与队列里那份漂移。
      queue.enqueue({
        chatKey: ctx.chatKey,
        url,
        replyToMessageId: typeof messageId === 'string' || typeof messageId === 'number' ? messageId : null,
        // assisted：结果不直接贴进群，而是作为一条【转写结果】进入上下文，由模型决定说什么。
        mode: 'assisted'
      });
      // 工具**自己不发任何消息**：入队后要不要先说一句（例如"我先看看"）是模型在这一次运行里
      // 自己的决定 —— 想说就接着调发送类工具，不想说就直接结束。
      //
      // 代价要知道：模型选择沉默时，群里在结果到达前没有任何提示。这是刻意的取舍 —— 定死一句
      // 回执会和模型自己的发言重复，而结果到达的那一次运行本来就必须开口（见 toolProtocol 第 8 条）。
      //
      // 回执整句在 prompt-catalog：它没有动态成分，且是在**诱导模型说哪句话**，
      // 属于"模型可见的固定指令"，不是这条路返回的数据。
      return TOOL_PROMPT_TEXT.transcribe_video.receipt;
    }
  })];
}
