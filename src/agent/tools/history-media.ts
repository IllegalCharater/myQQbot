import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { formatShortTime } from '../../core/util.js';
import { expandForwardNodes, extractMediaFromSegments, forwardIdFromData } from '../../qq/onebot.js';
import { downloadImageAsDataUrl, err, errorMessage, forwardHint, forwardResIdFromMedia, imageParts, isRecord, midHint, noticeHint, NOTICE_BATCH_CHARS, ok, senderNameFor } from './shared.js';
import type { ChatMessage } from '../../chat/types.js';
import type { ToolDefinition } from '../shared/types.js';

/** 读取消息、转发、公告和媒体的工具。 */
export function historyMediaTools(): ToolDefinition[] {
  return [
    {
      name: 'get_recent_messages',
      description: TOOL_PROMPT_TEXT.get_recent_messages.description,
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: TOOL_PROMPT_TEXT.get_recent_messages.limit },
          offset: { type: 'integer', description: TOOL_PROMPT_TEXT.get_recent_messages.offset }
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
      description: TOOL_PROMPT_TEXT.read_forward.description,
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.read_forward.messageId }
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
          let resId: string | null = forwardResIdFromMedia(entry) || null;
          if (!resId) {
            let msg = null;
            try { msg = await ctx.onebot.getMsg(entry.mid); } catch { /* 老消息可能已超出服务端保留范围 */ }
            if (isRecord(msg)) {
              const segs = Array.isArray(msg.message) ? msg.message.filter(isRecord) : null;
              const fwdSeg = segs ? segs.find((segment) => segment.type === 'forward') : null;
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
          const media = (ex.media || []).map((item) => ({ ...item, kind: String(item.kind ?? '') }));
          ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: media });
          return ok({ messageId: entry.mid, text: ex.text, images: (ex.media || []).length });
        } catch (error) {
          return err(`展开失败：${errorMessage(error)}`);
        }
      }
    },
    {
      name: 'read_group_notice',
      description: TOOL_PROMPT_TEXT.read_group_notice.description,
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: TOOL_PROMPT_TEXT.read_group_notice.limit } }
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
      description: TOOL_PROMPT_TEXT.get_active_members.description,
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: TOOL_PROMPT_TEXT.get_active_members.limit } }
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
      description: TOOL_PROMPT_TEXT.get_message_detail.description,
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.get_message_detail.messageId } },
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
      description: TOOL_PROMPT_TEXT.get_message_images.description,
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.get_message_images.messageId } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const target = String(args.messageId);
          // 本轮快照优先：模型作出工具决定前可能已经思考/下载了很久，实时存档可能
          // 因容量裁剪、面板删除或压缩而失去这条消息。触发批是模型实际看见的事实源；
          // 查询历史图片时再回落到实时存档。
          const findEntry = (mid: unknown) => (ctx.triggerEntries || []).find((message) => String(message.mid) === String(mid))
            ?? ctx.store.findByMid(ctx.chatKey, mid);
          const imageUrlsOf = (m: ChatMessage) => (m.media || [])
            .filter((item) => item.kind === 'image' && item.url).map((item) => String(item.url));
          const entry = findEntry(target);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          // 没有图片但有引用 → 顺着 `reply.mid` 去取被引用那条的图。
          // **这不是猜**：`reply.mid` 是入站时就记死的关联（见 chat/types.ts 的 ChatReply），
          // 被引用的那条消息本身可能才是图片所在。典型场景就是本轮修的 bug：
          // A 发了图、B 引用 A 的图问"这是什么"，模型填的是 **B 那条的 id**
          // （自然语言里"B 那条消息里有那张图"说得通）。真正被引用的 id 现在会印在
          // 提示词的引用预览里，模型本该直接用它；这条回退只负责在它没这么做时救回来。
          let source = entry;
          let viaReply = false;
          let urls = imageUrlsOf(entry);
          const quotedMid = String(isRecord(entry.reply) ? (entry.reply.mid ?? '') : '');
          if (!urls.length && quotedMid) {
            const quoted = findEntry(quotedMid);
            const quotedUrls = quoted ? imageUrlsOf(quoted) : [];
            if (quoted && quotedUrls.length) { source = quoted; urls = quotedUrls; viaReply = true; }
          }
          if (!urls.length) return ok(`消息 ${args.messageId} 没有可查看的图片${quotedMid ? `（它引用的 #${quotedMid} 也没有）` : ''}`);
          // 下载与刷新都针对**真正的来源**（source），不是模型问的那条：刷新走
          // `source.mid` 才能拿到新鲜 rkey，替换也只改 source 的媒体。
          const downloadAll = async (targets: string[]) => {
            const dataUrls: string[] = [];
            const failed: string[] = [];
            for (const url of targets) {
              try { dataUrls.push(await downloadImageAsDataUrl(url)); } catch (error) { failed.push(errorMessage(error)); }
            }
            return { dataUrls, failed };
          };

          let { dataUrls, failed } = await downloadAll(urls);
          // QQ 图片地址常带短期 rkey。入库 URL 失效时向协议端重新取一次消息，
          // 用新鲜段替换存档图片并重试；只刷新一次，避免协议端异常时形成循环。
          if (failed.length) {
            try {
              const latest = await ctx.onebot.getMsg(source.mid);
              const segments = isRecord(latest) && Array.isArray(latest.message) ? latest.message : [];
              const freshMedia = extractMediaFromSegments(segments)
                .filter((m) => m.kind === 'image' && m.url)
                .map((m) => ({ ...m, kind: 'image', url: String(m.url) }));
              const freshUrls = [...new Set(freshMedia.map((m) => String(m.url)))];
              if (freshUrls.length && freshUrls.some((url, index) => url !== urls[index])) {
                ctx.store.updateByMid(ctx.chatKey, source.mid, { replaceImageMedia: freshMedia });
                urls = freshUrls;
                ({ dataUrls, failed } = await downloadAll(urls));
              }
            } catch (refreshError) {
              failed.push(`刷新图片地址失败：${errorMessage(refreshError)}`);
            }
          }
          if (!dataUrls.length) return err(`图片获取失败：${failed.join('；')}`);
          const note = failed.length ? `（另有 ${failed.length} 张获取失败）` : '';
          // ── 标签里必须带**发送者**，不能只给 id ──
          //
          // **实测反馈**：群友甲发了图、群友乙也发了图，模型连着读了这两张，然后把它做的
          // 吐槽算到了**乙**头上 —— 因为原来这里只印 `消息 -1135000659 的图片内容`，
          // **id 对模型没有"这是谁发的"含义**。它只看到两条长得几乎一样的句子 + 两张图，
          // 于是把"图"和"先说话的那个人"配了对。
          //
          // 这跟下面那段"走回退时必须说清图是从哪条消息取的"是**同一个病**：那条修的是
          // "把图归到被引用者名下"，这条修的是"把图归到错误的发送者名下"。两处都要点名。
          const who = `${source.senderName || source.senderId || '未知'} 发的`;
          const label = viaReply
            ? `消息 ${args.messageId} 引用的是消息 #${source.mid}（${who}）的图片内容`
            : `消息 ${args.messageId}（${who}）的图片内容`;
          return { content: imageParts(`${label}${note}：`, dataUrls) };
        } catch (error) {
          return err(errorMessage(error));
        }
      }
    }
  ];
}
