import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { ImageGenError } from '../../media/image-gen/index.js';
import { err, midHint } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

/**
 * 模型自主调用的出图工具。
 *
 * 它**只负责入队**：不代模型发言（要不要先说一句是模型自己的决定），也不在这里扣额度
 * —— 成本闸门在 `ImageGenQueue.enqueue` 里，模型工具与 `/画` 命令共用同一本账
 * （见 `media/image-gen/queue.ts` 顶部注释）。
 */
export function imageGenTools(): ToolDefinition[] {
  return [{
    name: 'generate_image',
    description: TOOL_PROMPT_TEXT.generate_image.description,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: TOOL_PROMPT_TEXT.generate_image.prompt },
        messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.generate_image.messageId }
      },
      // prompt 必填：没有描述就没有图，而"让模型先随便画一张"没有意义。
      required: ['prompt']
    },
    async execute(ctx, args) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) return err('需要 prompt：给画图模型看的画面描述');

      // 参考图（图生图）：只把**地址**递进队列，下载与 base64 都在 media 层（见 reference 那条注释）。
      let referenceUrl = '';
      const messageId = args.messageId ?? null;
      if (messageId !== null && String(messageId).trim() !== '') {
        const id = String(messageId);
        const entry = (ctx.triggerEntries || []).find((m) => String(m.mid) === id)
          || ctx.store.findByMid(ctx.chatKey, messageId);
        // 两种失败分开报：id 打错/消息已不在存档里，与"消息里确实没有图片"是两回事。
        if (!entry) return err(`没找到消息 ${id}（id 可能不对，或它已经不在存档里了）${midHint(ctx)}`);
        const image = (entry.media || []).find((m) => m.kind === 'image' && m.url);
        if (!image?.url) {
          // 顺带列出**实际看到的附件种类**：图片段没被解析出来时，这条信息是唯一能看出
          // "卡片在、链接不在"的地方（同 transcribe_video 那条实测教训）。
          const kinds = [...new Set((entry.media || []).map((m) => String(m.kind)).filter(Boolean))];
          return err(`消息 ${id} 里没有可当参考图的图片（只看到：${kinds.length ? kinds.join('、') : '没有附件'}）。`
            + '换一条带图的消息，或者不传 messageId，直接按文字画一张。');
        }
        referenceUrl = String(image.url);
      }

      const queue = ctx.imageGen;
      if (!queue) return err('图像生成功能未启用');
      try {
        // enqueue 自己会做全部闸门（未启用/缺 Key/描述为空或超长/地址无效/限频），
        // 这里不重复实现任何一道，也不碰返回的任务号。
        //
        // **刻意不接 job.id、也不把它写进工具结果**：任务号对模型毫无用处，却是
        // "任务已派上（任务 xxxx）"这句话的全部原料。去掉原料比事后禁令可靠。
        queue.enqueue({
          chatKey: ctx.chatKey,
          prompt,
          imageUrl: referenceUrl,
          replyToMessageId: typeof messageId === 'string' || typeof messageId === 'number' ? messageId : null,
          // assisted：图由队列自己发进群，发完再回流一次，由模型决定要不要补一句话。
          mode: 'assisted'
        });
        // 工具**自己不发任何消息**（与 transcribe_video / reverse_image_source 同一契约）：
        // 代发会写进 ctx.session.sent 把这一轮撑成 done，模型本该说的那句交代就永远不说了。
        // 结果串（receipt）整句都在 prompt-catalog：它没有动态成分，且是在诱导模型说哪句话。
        return { content: TOOL_PROMPT_TEXT.generate_image.receipt };
      } catch (error) {
        // ImageGenError 携带的 message 本来就是中文用户文案（与 `/画` 命令路径同源）。
        if (error instanceof ImageGenError) return err(error.message);
        return err('画图任务创建失败，稍后再试。');
      }
    }
  }];
}
