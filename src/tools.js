// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import { getConfig } from './config.js';
import { normalizeMessageList, unquoteJsonString, formatShortTime } from './util.js';
import { formatStickerList } from './stickers.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';
import { webSearch, webFetch } from './web-search.js';
import { expandForwardNodes, forwardIdFromData } from './onebot.js';
import { enqueueJmcomicDownload } from './jmcomic.js';
import { cachedDataUrl, isCacheFile, sendTarget } from './sticker-cache.js';

async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// 按魔数判图片类型的实现搬到了 safe-fetch.js（那边没有依赖，sticker-cache.js 也要用）。
// 这里原样转出：app.js 等既有调用点一行都不用改。
export { detectMime } from './safe-fetch.js';

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// read_group_notice 一次返回的正文总预算。单条上限在 onebot.js 的 NOTICE_TEXT_MAX，
// 但 10 条叠起来照样能吃掉大块上下文，这里再兜一层。
const NOTICE_BATCH_CHARS = 6000;

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

/** 从存档的 media 里取转发 res_id（入库时 extractMediaFromSegments 存下的）。 */
function forwardResIdFromMedia(entry) {
  const hit = (entry?.media || []).find((x) => x && x.kind === 'forward' && x.id);
  return hit ? String(hit.id) : '';
}

// 模型指错 id 时（典型：拿了"引用了某条转发"的那条普通消息的 id），把当前会话里确实
// 是合并转发的消息列出来，让它下一轮能改对 —— 只报一句"失败"模型只会换着 id 瞎试。
function forwardHint(ctx) {
  const ids = ctx.store.recent(ctx.chatKey, { limit: 200 })
    .filter((m) => m.mid !== null && m.mid !== undefined && String(m.mid) !== '')
    .filter((m) => /\[合并转发|\[转发消息/.test(String(m.text || '')) || forwardResIdFromMedia(m))
    .map((m) => String(m.mid));
  const uniq = [...new Set(ids)].slice(-5);
  return uniq.length
    ? `当前会话里确实是合并转发的消息 id：${uniq.join(' ')}，请用其中之一重试`
    : '当前会话里没有合并转发消息（可能还没收到过，或那条已被撤回）';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

/**
 * 公告发布者的显示名：先看群友备注，再在最近的聊天记录里找同名 QQ 号。
 * 找不到就返回 ''（调用方回退成 QQ 号）—— 公告常常是很久以前发的，
 * 那个人的消息早滚出视野了，这很正常。
 */
function senderNameFor(ctx, userId) {
  const uid = String(userId || '');
  if (!uid) return '';
  const noted = (getConfig().memberNotes || {})[uid];
  if (noted) return String(noted);
  const hit = ctx.store.recent(ctx.chatKey, { limit: 500 }).find((m) => String(m.senderId) === uid);
  return hit ? String(hit.senderName || '') : '';
}

/** 群公告取不到时的提示：区分"协议端没这个接口"、"结构不认识"和"这次请求失败"，都要给出下一步。 */
function noticeHint(error) {
  const msg = String(error?.message ?? error);
  const tail = '如实告诉群友你读不到公告就行，不要编内容。';
  if (/无法识别的结构/.test(msg)) {
    return `协议端返回的群公告结构不认识（${msg}）。多半是协议端版本差异导致的字段不同，${tail}`;
  }
  if (/HTTP 404|unsupported|unknown action|not (found|implemented)|retcode=1404/i.test(msg)) {
    return `协议端没有群公告接口（${msg}）。可能是 SnowLuma / NapCat 版本较旧，或该协议端没实现 get_group_notice。${tail}`;
  }
  return `读群公告失败：${msg}。可以稍后再试一次；再失败就${tail}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 */
export function buildToolDefs() {
  return [
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）。没有 #数字 的消息（如 [拍一拍]）引用不了，别硬填，宁可不引用也不要拿别的消息的 id 凑' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' }
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
          ctx.emit('session-update', ctx.session.id);
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 填【可用表情包】或 list_stickers 给出的 id；已经标注过的表情也可以直接填它的备注/标签（唯一命中时才作数）。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id，或该表情的备注/标签（如"蕾米的凝"）；来自【可用表情包】或 list_stickers' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
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
              return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
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
            const refused = /retcode=/.test(String(error?.message || ''));
            if (!local || !refused || !sticker.url) throw error;
            console.warn(`[tools] 本机图片路径被协议端拒绝，退回原链接重发：${sticker.id}`);
            result = await ctx.sender.sendSticker(ctx.chatKey, sticker, { ...options, file: sticker.url });
          }
          ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'list_stickers',
      description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
          limit: { type: 'integer', description: '最多返回条数，默认 24' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_sticker_image',
      description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。stickerId 填 id，也可以填备注/标签（唯一命中时）。',
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: '表情 id，或该表情的备注/标签（唯一命中时）' } },
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
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sticker_note',
      description: '给一个表情记下你的理解（含义/用法/标签），以后选得更准。stickerId 可以填 list_stickers 给出的 id，也可以直接填【可用表情包】里那个表情的备注/标签（唯一命中时）。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id，或该表情的备注/标签（如"蕾米的凝"）；来自 list_stickers 或【可用表情包】' },
          note: { type: 'string', description: '你的理解/含义' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
          usage: { type: 'string', description: '适用场景（可选）' }
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
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
          note: { type: 'string', description: '一句简短备注（帮未来的你识别）' }
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
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          let target = args.targetUserId;
          if (target !== undefined && target !== null && String(target).trim() !== '') {
            target = Number(target);
            if (!Number.isInteger(target) || target <= 0) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            await ctx.sender.poke(ctx.chatKey, target);
          } else {
            await ctx.sender.poke(ctx.chatKey, null);
          }
          return ok({ poked: true });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 read_forward 展开看内容；出现 [群公告] 时，用 read_group_notice 读公告正文。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
        return ok({
          count: messages.length,
          messages: messages.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            // 摘要/人工备注不是群友：不给 sender 就会渲染成"一条没有发送者的消息"，
            // 模型只能瞎猜是谁说的。显式标出来，与提示词里 formatEntry 的口径一致。
            sender: m.kind === 'digest' ? '历史摘要' : (m.kind === 'note' ? '人工备注' : (m.self ? '我' : m.senderName)),
            text: m.text
          }))
        });
      }
    },
    {
      name: 'read_forward',
      description: '展开查看合并转发的聊天记录。消息文本出现 [合并转发聊天记录] 或 [转发消息 …] 占位符时用。参数 messageId 填**那条转发消息自己**前面的 #数字 —— 不要填"引用了这条转发"的别的消息的 id，也不要自己编。展开结果会写回存档，以后再看就是展开的文本，不用重复调。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
          if (String(entry.text || '').startsWith('[合并转发 共')) {
            return ok({ messageId: entry.mid, text: entry.text, note: '该转发已展开（读的是存档）' });
          }
          // res_id 优先取入库时存下的（省一次 get_msg）；老存档没存就问协议端要 ——
          // 顺便用它确认这条到底是不是转发，模型指错 id 时能给出可执行的提示。
          let resId = forwardResIdFromMedia(entry);
          if (!resId) {
            let msg = null;
            try { msg = await ctx.onebot.getMsg(entry.mid); } catch { /* 老消息可能已超出服务端保留范围 */ }
            if (msg) {
              const segs = Array.isArray(msg.message) ? msg.message : null;
              const fwdSeg = segs ? segs.find((s) => s?.type === 'forward') : null;
              if (!fwdSeg) {
                const preview = String(entry.text || '').replace(/\s+/g, ' ').slice(0, 60);
                return err(`消息 ${args.messageId} 不是合并转发，是一条普通消息（内容：${preview}）。${forwardHint(ctx)}`);
              }
              resId = forwardIdFromData(fwdSeg.data ?? {});
            }
            if (!resId) {
              return err(`取不到消息 ${args.messageId} 的转发 id（可能已被撤回，或超出服务端保留范围）。${forwardHint(ctx)}`);
            }
          }
          const nodes = await ctx.onebot.getForwardNodes({ resId, messageId: entry.mid });
          const ex = await expandForwardNodes(nodes);
          if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
          // 写回存档：一次展开，永久升级这条记录（模型/存档页都受益）
          ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: ex.media || [] });
          return ok({ messageId: entry.mid, text: ex.text, images: (ex.media || []).length });
        } catch (error) {
          return err(`展开失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'read_group_notice',
      description: '读取当前群的群公告正文（群规、活动、约定通常都写在里面）。消息里出现 [群公告] 时用 —— 那种卡片本身不含正文，只有这个工具能拿到。返回的是该群当前全部公告，按发布时间从新到旧排；群友问"公告写了啥""群规是什么"时先读再答，别凭印象编。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '最多返回几条，默认 3，最大 10（按发布时间从新到旧）' } }
      },
      async execute(ctx, args) {
        if (ctx.kind !== 'group') return err('群公告只在群聊里有，私聊没有公告可读。');
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 3));
        try {
          const notices = await ctx.onebot.getGroupNotice(ctx.chatId);
          if (!notices.length) return ok({ count: 0, note: '这个群还没发过群公告' });
          const sorted = notices.slice().sort((a, b) => (b.publishTime || 0) - (a.publishTime || 0));
          // 整批预算：单条已在 getGroupNotice 里截到 NOTICE_TEXT_MAX，但 10 条 ×1500
          // 仍能吃掉一大块上下文。超预算的条目直接不返回，用 note 说明，别静默丢。
          const picked = [];
          let budget = NOTICE_BATCH_CHARS;
          for (const n of sorted.slice(0, limit)) {
            if (n.text.length > budget) break;
            budget -= n.text.length;
            picked.push(n);
          }
          const dropped = Math.min(sorted.length, limit) - picked.length;
          return ok({
            count: picked.length,
            total: sorted.length,
            note: dropped > 0 ? `内容太长，省略了更早的 ${dropped} 条；需要的话缩小 limit 或让我只说最新那条` : undefined,
            notices: picked.map((n) => ({
              time: n.publishTime ? formatShortTime(n.publishTime) : '',
              sender: senderNameFor(ctx, n.senderId) || n.senderId || '',
              senderId: n.senderId || undefined,
              text: n.text,
              images: n.imageCount || undefined
            }))
          });
        } catch (error) {
          return err(noticeHint(error));
        }
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : entry.senderName,
          senderId: entry.senderId,
          text: entry.text,
          reply: entry.reply
        });
      }
    },
    {
      name: 'get_message_images',
      description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。id 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
          if (!urls.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
          const dataUrls = [];
          const failed = [];
          for (const url of urls) {
            try { dataUrls.push(await downloadImageAsDataUrl(url)); } catch (e) { failed.push(String(e?.message ?? e)); }
          }
          if (!dataUrls.length) return err(`图片获取失败：${failed.join('；')}`);
          const note = failed.length ? `（另有 ${failed.length} 张获取失败）` : '';
          return { content: imageParts(`消息 ${args.messageId} 的图片内容${note}：`, dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_append',
      description: '记一条对群友的长期印象（下次运行会自动看到）。只记"以后和这个人打交道时用得上"的稳定印象：他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题、别踩的坑。太临时的事情不要记。userId 必须填对方的 QQ 号（不知道就先调 get_active_members / get_recent_messages 查）；target 填备注名/群名片/昵称，用于展示。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（数字）' },
          target: { type: 'string', description: '对方名字（备注名/群名片/昵称）' },
          content: { type: 'string', description: '印象内容（≤120字，稳定、可跨多次聊天使用）' }
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
      description: '查看当前会话里你对群友的长期印象。不传 userId 返回全部；传 userId 只看某一个人。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' }
        }
      },
      async execute(ctx, args) {
        const mem = ctx.memory.query(ctx.chatKey);
        const userId = String(args.userId ?? '').trim();
        const list = userId
          ? mem.memberImpression.filter((e) => String(e.userId) === userId)
          : mem.memberImpression;
        return ok({ memberImpression: list });
      }
    },
    {
      name: 'memory_remove',
      description: '删除一条过时/不再准确的对群友印象。userId 优先按 QQ 号删；target 按名字删；两者都不传则删全部印象。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
          target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
          content: { type: 'string', description: '可选：只删这条内容' }
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
    },
    {
      name: 'report_feedback',
      description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    },
    {
      name: 'web_search',
      description: '联网搜索（Bing），返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const result = await webSearch(String(args.query ?? ''));
          if (!result.results.length) {
            return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          return ok(result);
        } catch (error) {
          return err(`搜索失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const result = await webFetch(String(args.url ?? ''));
          const body = String(result.body || '');
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated || body.length > 20000,
            content: body.slice(0, 20000)
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'download_jmcomic',
      description: '把指定数字漫画 ID 加入 PDF 下载队列；完成后会自动把 PDF 上传到当前群聊或私聊。仅在用户明确要求下载并给出 ID 时调用，不要猜测 ID或重复提交。',
      parameters: {
        type: 'object',
        properties: {
          comicId: { type: 'string', pattern: '^\\d{1,20}$', description: '1 至 20 位数字漫画 ID，例如 12345' }
        },
        required: ['comicId'],
        additionalProperties: false
      },
      async execute(ctx, args) {
        try {
          const result = enqueueJmcomicDownload(ctx, args.comicId);
          return ok({ ...result, note: `已加入下载队列，当前位置：${result.position}。完成后会自动发送 PDF。` });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'finish',
      description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）' } },
        required: ['summary']
      },
      async execute(ctx, args) {
        ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
        return ok({ finished: true });
      }
    }
  ];
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
