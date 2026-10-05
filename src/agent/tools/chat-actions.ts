import { EVENTS } from '../../core/events.js';
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { normalizeMessageList, unquoteJsonString } from '../../core/util.js';
import { cachedDataUrl, isCacheFile, sendTarget } from '../../stickers/sticker-cache.js';
import { validateImageUrl } from '../../media/safe-fetch.js';
import { downloadImageAsDataUrl, err, errorMessage, imageParts, isRecord, midHint, memberHint, ok } from './shared.js';
import type { ToolDefinition } from '../shared/types.js';

/** 发送消息、表情和拍一拍等会话动作。 */
export function chatActionTools(): ToolDefinition[] {
  return [
    {
      name: 'send_message',
      description: TOOL_PROMPT_TEXT.send_message.description,
      parameters: {
        type: 'object',
        properties: {
          messages: { description: TOOL_PROMPT_TEXT.send_message.messages, oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.send_message.replyToMessageId },
          atUserId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.send_message.atUserId }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
          ctx.emit(EVENTS.sessionUpdate, { sessionId: ctx.session.id });
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    },
    {
      name: 'send_sticker',
      description: TOOL_PROMPT_TEXT.send_sticker.description,
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: TOOL_PROMPT_TEXT.send_sticker.stickerId },
          replyToMessageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.send_sticker.replyToMessageId },
          atUserId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.send_sticker.atUserId }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const ref = unquoteJsonString(args.stickerId);
          // 与 sticker_note 用同一个解析器：一个标签在那儿认得出，在这里就必须同样认得出
          const { entry: sticker, ambiguous } = await ctx.stickers.resolve(ref);
          if (!sticker && ambiguous?.length) {
            const ids = ambiguous.slice(0, 5).map((e) => e.id).join('、');
            return err(`"${ref}" 对应 ${ambiguous.length} 个表情，说不清是哪个，请改用 id 指定：${ids}${ambiguous.length > 5 ? ' …' : ''}（id 用 list_stickers 查）`);
          }
          if (!sticker) return err(`找不到表情 ${ref}，请先用 list_stickers 获取有效 id；已经标注过的表情也可以直接填它的备注/标签。`);
          // 发送目标：bot 自己收藏的优先给本机缓存文件（收藏那一刻就落盘了，不再依赖会过期的
          // 图床链接）；QQ 收藏、以及还没有缓存的，退回原始 url。
          const target = await sendTarget(sticker);
          if (!target) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
          // 本地文件不走 URL 校验（它根本不是 URL），但也不是"就信了"：
          // isCacheFile 断言它确实落在 data/sticker-cache/ 里且存在。
          const local = isCacheFile(target);
          if (!local) {
            try {
              await validateImageUrl(target); // 只允许公网 http(s)，防止本地库被污染后诱导 OneBot 抓内网
            } catch (error) {
          return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${errorMessage(error)}`);
            }
          }
          const options = {
            file: target,
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          };
          let result;
          try {
            result = await ctx.sender.sendSticker(ctx.chatKey, sticker, options);
          } catch (error) {
            // 本地路径是"协议端认不认"这件事唯一没法在本机验证的地方，所以留一步兜底：
            // 只有在协议端**明确拒绝**（错误里带 retcode=）时才退回原链接重发。
            // 超时那类错误说不清消息到底发出去没有，重发就可能是刷屏 —— 不冒这个险。
            const refused = /retcode=/.test(errorMessage(error));
            if (!local || !refused || !sticker.url) throw error;
            console.warn(`[tools] 本机图片路径被协议端拒绝，退回原链接重发：${sticker.id}`);
            result = await ctx.sender.sendSticker(ctx.chatKey, sticker, { ...options, file: sticker.url });
          }
          ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit(EVENTS.sessionUpdate, { sessionId: ctx.session.id });
          return ok({ sent: true, messageId: isRecord(result) ? result.message_id ?? null : null, note: '表情已发送。' });
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    },
    {
      name: 'list_stickers',
      description: TOOL_PROMPT_TEXT.list_stickers.description,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: TOOL_PROMPT_TEXT.list_stickers.query },
          limit: { type: 'integer', description: TOOL_PROMPT_TEXT.list_stickers.limit }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          return ok(result);
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    },
    {
      name: 'get_sticker_image',
      description: TOOL_PROMPT_TEXT.get_sticker_image.description,
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: TOOL_PROMPT_TEXT.get_sticker_image.stickerId } },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const ref = unquoteJsonString(args.stickerId);
          const { entry: sticker, ambiguous } = await ctx.stickers.resolve(ref);
          if (!sticker && ambiguous?.length) {
            const ids = ambiguous.slice(0, 5).map((e) => e.id).join('、');
            return err(`"${ref}" 对应 ${ambiguous.length} 个表情，说不清是哪个，请改用 id 指定：${ids}${ambiguous.length > 5 ? ' …' : ''}（id 用 list_stickers 查）`);
          }
          if (!sticker) return err(`找不到表情 ${ref}，请先用 list_stickers 获取有效 id；已经标注过的表情也可以直接填它的备注/标签。`);
          // 有本地缓存就直接读盘：少一次图床请求，也绕开那些会过期的签名链接
          const cached = await cachedDataUrl(sticker);
          const dataUrl = cached || (sticker.url ? await downloadImageAsDataUrl(sticker.url) : '');
          if (!dataUrl) return err('该表情既没有本地缓存图片，也没有可下载的图片地址');
          return { content: imageParts(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）：`, [dataUrl]) };
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    },
    {
      name: 'sticker_note',
      description: TOOL_PROMPT_TEXT.sticker_note.description,
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: TOOL_PROMPT_TEXT.sticker_note.stickerId },
          note: { type: 'string', description: TOOL_PROMPT_TEXT.sticker_note.note },
          tags: { type: 'array', items: { type: 'string' }, description: TOOL_PROMPT_TEXT.sticker_note.tags },
          usage: { type: 'string', description: TOOL_PROMPT_TEXT.sticker_note.usage }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const ref = unquoteJsonString(args.stickerId);
          const result = ctx.stickers.noteVerbose(String(ref), { note: args.note, tags: args.tags, usage: args.usage });
          if (!result.entry && result.ambiguous?.length) {
            const ids = result.ambiguous.slice(0, 5).map((e) => e.id).join('、');
            return err(`"${ref}" 对应 ${result.ambiguous.length} 个表情，说不清是哪个，请改用 id 指定：${ids}${result.ambiguous.length > 5 ? ' …' : ''}（id 用 list_stickers 查）`);
          }
          if (!result.entry) return err(`找不到表情 ${ref}，请先用 list_stickers 获取有效 id。也可以直接填【可用表情包】或 list_stickers 里那个表情的备注/标签。`);
          return ok({ updated: true, id: result.entry.id, localNote: result.entry.localNote, tags: result.entry.tags });
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    },
    {
      name: 'collect_sticker',
      description: TOOL_PROMPT_TEXT.collect_sticker.description,
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.collect_sticker.messageId },
          note: { type: 'string', description: TOOL_PROMPT_TEXT.collect_sticker.note }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && m.url);
          if (!imageMedia) return err('该消息没有可收藏的图片');
          const saved = await ctx.stickers.collect(args.messageId, { url: imageMedia.url, note: String(args.note ?? '') });
          if (!saved) throw new Error('收藏表情失败');
          // 上限淘汰是真删数据，必须在回执里说出来 —— 静默删收藏是最吓人的那种行为
          const dropped = ctx.stickers.lastEvicted || [];
          const droppedTip = dropped.length
            ? `另外：收藏已到上限，删掉了 ${dropped.length} 个用得最少、收得最早的（${dropped.slice(0, 3).map((e) => e.desc || e.localNote || e.id).join('、')}${dropped.length > 3 ? ' …' : ''}），它们在本地的图片也一并删了。`
            : '';
          // hint 不能叫 note —— note 这个键已经被上面那条备注占了
          return ok({
            collected: true,
            id: saved.id,
            note: saved.localNote,
            hint: `顺手用 sticker_note 给这个表情补一句标签和适用场景（内容/什么场合发），以后才选得准。${droppedTip}`
          });
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    },
    {
      name: 'send_poke',
      description: TOOL_PROMPT_TEXT.send_poke.description,
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.send_poke.targetUserId } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          const rawTarget = args.targetUserId;
          if (rawTarget !== undefined && rawTarget !== null && String(rawTarget).trim() !== '') {
            const target = Number(rawTarget);
            if (!Number.isInteger(target) || target <= 0) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            await ctx.sender.poke(ctx.chatKey, target);
          } else {
            await ctx.sender.poke(ctx.chatKey, null);
          }
          return ok({ poked: true });
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    }
  ];
}
