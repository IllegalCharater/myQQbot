// OneBot 接入侧 · 入站事件摄取
//
// 入站只有一个入口：`OneBotClient` 收到 WS 帧后回调 `onEvent`，落到这里的 `handle()`，
// 按 `post_type` 分派到「普通消息」与「拍一拍」两条路。两件事都做同一套动作：
// 白名单/屏蔽名单过滤 → 解析成文本与媒体 → `store.appendIncoming` 存下来 →
// **当面交给编排器**（`orchestrator.onIncoming`）。
//
// 原先这五件事（外加白名单判断）是 `app.ts` 里 `createApp()` 内部的闭包（约 190 行）。
// 搬出来只为一件事：`atNameCache` 与引用预览上限是这台摄取器自己的状态，组装根不需要
// 知道它们。**行为逐行保持不变**——`app.ts` 那边仍是同样的入口，只把
// `handleOneBotEvent(event)` 换成 `ingest.handle(event)`。
import { EVENTS } from '../../core/events.js';
import type { AppEmit } from '../../core/events.js';
import type { AppConfig } from '../../core/config.js';
import type { ChatReply, MediaEntry } from '../../chat/types.js';
import type { ChatStore } from '../../chat/store.js';
import type { AgentControlPort } from '../../agent/runtime/control-port.js';
import {
  segmentsToText, extractMediaFromSegments, expandForwardNodes, forwardIdFromData
} from '../../qq/onebot.js';
import type { OneBotClient } from '../../qq/onebot.js';
import type { OneBotEvent } from '../../qq/types.js';
import type { SendQueue } from '../../qq/sender.js';
import { parseTranscriptionCommand } from '../../media/video-transcription.js';
import type { VideoTranscriptionQueue } from '../../media/video-transcription.js';
import { isBilibiliUrl, bilibiliUrlFromCardData, bilibiliUrlFromXml } from '../../media/bilibili.js';
import { errorMessage, isRecord } from '../http/http.js';

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind: 'group' | 'private', id: unknown, cfg: AppConfig) {
  const s = String(id);
  const key = kind === 'group' ? 'groups' : 'private';
  const denyList = cfg.deny?.[key] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[key] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

/** 在接入层把 B 站卡片补成可定位的视频媒体；通用 OneBot 协议解析保持平台无关。 */
function addBilibiliVideoAliases(media: MediaEntry[]): void {
  const existing = new Set(media
    .filter((item) => item.kind === 'video' && typeof item.url === 'string')
    .map((item) => String(item.url)));
  for (const item of [...media]) {
    if (item.kind !== 'card' || typeof item.url !== 'string' || !isBilibiliUrl(item.url) || existing.has(item.url)) continue;
    media.push({ kind: 'video', url: item.url, source: 'bilibili-card' });
    existing.add(item.url);
  }
}

/**
 * 直接从原始消息段里补卡片链接。
 *
 * 与 `addBilibiliVideoAliases` 的分工：那个从**已解析的** card 媒体里补别名，只能覆盖
 * 通用卡片解析认得的字段；这个不经过那一层，覆盖它认不出的形态——
 * **B 站 App 分享出来的小程序卡片（链接在 `meta.detail_1.qqdocurl`，没有 `jumpUrl`）**
 * 和部分协议端下发成 `xml` 段的分享卡。两者都调，按 url 去重，顺序无关。
 *
 * 为什么非补不可：`/转写` 与 `transcribe_video` 都靠 media 里的 `kind:'video'` 定位目标，
 * 只认 jumpUrl 时卡片看着有链接、存档里却没有，两边都会报"没有视频链接"。
 */
function addBilibiliCardLinks(media: MediaEntry[], segments: unknown): void {
  const existing = new Set(media
    .filter((item) => item.kind === 'video' && typeof item.url === 'string')
    .map((item) => String(item.url)));
  for (const value of Array.isArray(segments) ? segments : []) {
    if (!isRecord(value)) continue;
    const type = value.type;
    if (type !== 'json' && type !== 'xml') continue;
    const data = isRecord(value.data) ? value.data : {};
    const url = type === 'json'
      ? bilibiliUrlFromCardData(data)
      : bilibiliUrlFromXml(data.data ?? data.string);
    if (!url || existing.has(url)) continue;
    media.push({ kind: 'video', url, source: 'bilibili-card' });
    existing.add(url);
  }
}

export interface Ingest {
  /** `OneBotClient.onEvent` 的落点。内部已吞掉各自的分支，不需要调用方再 catch 分支错误。 */
  handle(event: OneBotEvent): Promise<void>;
}

export function createIngest({ onebot, store, sender, orchestrator, transcription, emit, getConfig, log }: {
  onebot: OneBotClient;
  store: ChatStore;
  sender: Pick<SendQueue, 'sendTextBatch'>;
  /** 只用到 `onIncoming`——跨模块方法面走端口，不依赖 Orchestrator 具体类。 */
  orchestrator: AgentControlPort;
  transcription: Pick<VideoTranscriptionQueue, 'enqueue'>;
  emit: AppEmit;
  getConfig: () => AppConfig;
  log: (...args: unknown[]) => void;
}): Ingest {
  const atNameCache = new Map<string, string>(); // groupId:userId -> name
  // OneBot 的 message 回调不会等待异步摄取完成；引用解析、@ 名片查询和合并转发展开
  // 一旦让出事件循环，后到的简单消息就可能先落库。按 chatKey 串行即可保住本地 id、
  // 动态窗口与真实到达顺序的一致性，同时不会让一个慢群阻塞其它聊天。
  const ingestTails = new Map<string, Promise<void>>();

  function enqueueIngest(chatKey: string, task: () => Promise<void>): Promise<void> {
    const previous = ingestTails.get(chatKey) ?? Promise.resolve();
    // 前一条失败不能毒死整条链；它自己的 rejected promise 仍返回给调用方记录日志。
    const current = previous.catch(() => {}).then(task);
    ingestTails.set(chatKey, current);
    return current.finally(() => {
      // 旧任务完成时，不能误删后来已经接到 Map 末尾的新任务。
      if (ingestTails.get(chatKey) === current) ingestTails.delete(chatKey);
    });
  }

  async function resolveAtName(groupId: unknown, userId: unknown): Promise<string | null> {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key) ?? null;
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = isRecord(info) ? info.card || info.nickname || null : null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  // 引用预览的长度上限。原先是 120：卡片解析出的文本最长 300，被截到 120 会丢内容。
  const REPLY_PREVIEW_MAX = 300;

  /**
   * 解析被引用消息：**正文、发送者与它自己的 id 一起取出来**。
   *
   * `mid` 必须回传：调用方要把它结构化地存进 `ChatMessage.reply`。少了它，模型就只看得见
   * `[引用 清三：[图片]]` —— `[图片]` 是所有图片共用的占位符，而 `get_message_images` 只认
   * 消息 id，于是模型只能在提示词里可见的 id 里瞎挑（实测踩到：挑中同一发送者的另一张图）。
   *
   * ctx 传当前会话的 kind/id：QQ 里引用只可能发生在同一个会话内，所以被引用消息里的
   * @ 就是本群成员，能正常解析成群名片（与主消息路径的行为保持一致）。
   */
  async function resolveReply(messageId: unknown, { kind = '', id = '' }: { kind?: string; id?: string } = {}) {
    const mid = String(messageId ?? '');
    try {
      const msg = await onebot.getMsg(messageId);
      const sender = isRecord(msg) && isRecord(msg.sender) ? msg.sender : {};
      const senderName = sender.card || sender.nickname || '';
      let text = '';
      let media: MediaEntry[] = [];
      if (isRecord(msg) && Array.isArray(msg.message)) {
        // 必须复用 segmentsToText，不能自己拼。被引用的消息可能是 json 卡片 /
        // 合并转发 / 图片，自己拼只会得到 "[json]" "[forward]" 这类原始英文段名，
        // 模型完全读不懂 —— 曾经这里就是这样把"引用了一张卡片"变成四个无用字符。
        // 注意这里不展开合并转发（只留占位符），展开是模型用 read_forward 主动做的事。
        text = await segmentsToText(msg.message, {
          includeReply: false,
          resolveAtName: (qq) => (kind === 'group' ? resolveAtName(id, qq) : Promise.resolve(null))
        });
        media = extractMediaFromSegments(msg.message)
          .filter((item): item is Record<string, unknown> & { kind: string } => typeof item.kind === 'string')
          .map((item) => ({ ...item, kind: item.kind }));
        addBilibiliVideoAliases(media);
        addBilibiliCardLinks(media, msg.message);
      } else if (isRecord(msg) && typeof msg.message === 'string') {
        text = msg.message;
      }
      return { mid, sender: String(senderName), text: String(text).slice(0, REPLY_PREVIEW_MAX), media };
    } catch {
      // 取不到正文不等于"没有引用"：id 本身仍然可寻址（模型可以拿它去看图/看详情），
      // 所以回一个只有 id 的对象，而不是 null —— 丢掉 id 就退回了改动前的病。
      return { mid, sender: '', text: '', media: [] as MediaEntry[] };
    }
  }

  async function ingestMessage(kind: 'group' | 'private', id: string, event: OneBotEvent) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const eventSender = isRecord(event.sender) ? event.sender : {};
    const senderId = String(eventSender.user_id ?? event.user_id ?? '');
    const senderName = String(eventSender.card || eventSender.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    const blocklist = cfgNow.blocklist as Record<string, unknown[]>;
    if (kind === 'group' && senderId && (blocklist[id] || []).map(String).includes(senderId)) return;
    const media: MediaEntry[] = (segments ? extractMediaFromSegments(segments) : [])
      .filter((item): item is Record<string, unknown> & { kind: string } => typeof item.kind === 'string')
      .map((item) => ({ ...item, kind: item.kind }));
    // 不改 `src/qq` 的通用入站解析：视频只在接入层补成媒体定位信息，供显式 `/转写`
    // 命令取 URL。file 只有本身就是 http(s) URL 时才可作为回退，不把本地路径当 URL。
    for (const segment of segments || []) {
      if (!isRecord(segment) || segment.type !== 'video' || !isRecord(segment.data)) continue;
      const candidate = String(segment.data.url || segment.data.file || '').trim();
      media.push({ kind: 'video', ...(candidate ? { url: candidate } : {}), file: String(segment.data.file || '') });
    }
    addBilibiliVideoAliases(media);
    addBilibiliCardLinks(media, segments);

    let text;
    let commandText;
    const repliedMedia: MediaEntry[] = [];
    // 引用在**这一层**解析，不交给 `segmentsToText`：那里拼出来的预览串没有 id，
    // 而被引用对象的 id 必须留下（见 ChatReply 的注释）。两条路径都走 `includeReply:false`，
    // 即引用段不进 text —— 预览由渲染层从 reply 里拼，位置在 `formatReplyPrefix`。
    //
    // `text` 与 `commandText` **起手是同一个串**，但下面合并转发展开会整份替换 `text`：
    // 于是 `commandText` 是"用户真正敲的那句话"（命令判定与 `parseTranscriptionCommand` 只认它），
    // `text` 是"进了存档、给模型看的那份"。别把它们并成一个变量 —— 那会让
    // "转发了一条记录、转发内容里恰好以 /转写 开头"变成一条真命令。
    let reply: ChatReply | null = null;
    if (segments) {
      const replySeg = segments.find((seg) => seg?.type === 'reply');
      const replyId = replySeg ? String((replySeg.data as Record<string, unknown> | undefined)?.id ?? '') : '';
      if (replyId) {
        const info = await resolveReply(replyId, { kind, id });
        reply = { mid: info.mid, sender: info.sender, text: info.text };
        if (info.media.length) repliedMedia.push(...info.media);
      }
      commandText = await segmentsToText(segments, {
        includeReply: false,
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : Promise.resolve(null)
      });
      text = commandText;
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
      commandText = text;
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 用转发段自带的 res_id 展开 —— 实测（2026-09-22，SnowLuma）get_forward_msg 认 res_id、
    // 不认 message_id（传后者报 retcode=100 "download forward message payload is empty"）。
    // 旧注释把结论记反成"只认 message_id、res_id 会过期"，照它写的这行代码从来没成功过：
    // 每条收到的合并转发都只留下占位符，正文永远进不了存档。
    // 媒体里的 url 此时是新鲜的，一并收进 media（模型看图/存档页展示都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    const fwdSeg = segments ? segments.find((s) => s?.type === 'forward') : null;
    if (fwdSeg || text.includes('[合并转发') || text.includes('[转发消息')) {
      try {
        const nodes = await onebot.getForwardNodes({
          resId: forwardIdFromData(fwdSeg?.data ?? {}),
          messageId: event.message_id
        });
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) {
            media.push(...ex.media
              .filter((item): item is Record<string, unknown> & { kind: string } => typeof item.kind === 'string')
              .map((item) => ({ ...item, kind: item.kind })));
          }
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${errorMessage(e)}`);
      }
    }

    if (!text && !media.length) return;
    const chatKey = `${kind}:${id}`;
    const isTranscriptionCommand = /^\/转写(?:\s|\[视频\]|$)/u.test(String(commandText || '').trim());
    if (isTranscriptionCommand && repliedMedia.length) {
      media.push(...repliedMedia);
      addBilibiliVideoAliases(media);
    }
    // 条目要**当面交给**编排器（onIncoming 的第二个参数）：上下文窗口的入窗入口
    // 只有它一个，少传一次窗口与存档就会静默分叉。确定性命令是唯一例外：它通过
    // wakeEligible:false 原子落成已读历史，窗口及其兜底同步都会明确排除它。
    const entry = store.appendIncoming(chatKey, {
      mid: typeof event.message_id === 'string' || typeof event.message_id === 'number' ? event.message_id : null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]',
      reply,
      media,
      wakeEligible: !isTranscriptionCommand
    });
    emit(EVENTS.chatUpdate, chatKey);

    // `/转写` 是确定性命令，不进入 LLM。先把它作为已读存档保留，再只做校验、入队和即时回执；
    // FFmpeg 与 ASR 极速版请求全部在单并发后台 worker 里运行，不占住 OneBot 入站处理链。
    if (isTranscriptionCommand) {
      try {
        const url = parseTranscriptionCommand(commandText, media);
        if (!url) return;
        const job = transcription.enqueue({
          chatKey,
          url,
          replyToMessageId: typeof event.message_id === 'string' || typeof event.message_id === 'number'
            ? event.message_id : null
        });
        await sender.sendTextBatch(chatKey, `已开始处理（任务 ${job.id.slice(0, 8)}）`, {
          replyToMessageId: event.message_id
        });
      } catch (error) {
        await sender.sendTextBatch(chatKey, error instanceof Error ? error.message : '转写任务创建失败', {
          replyToMessageId: event.message_id
        }).catch(() => log('[transcribe] task=unassigned code=ONEBOT_SEND_FAILED'));
      }
      return;
    }

    orchestrator.onIncoming(chatKey, entry);
  }

  async function ingestPoke(event: OneBotEvent) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）
    const blocklist = cfgNow.blocklist as Record<string, unknown[]>;
    if (isGroup && operatorId && (blocklist[id] || []).map(String).includes(operatorId)) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"317183522 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    let text;
    if (String(targetId) === String(selfId)) {
      text = `[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorName}）`;
    } else {
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
    }
    const entry = store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: []
    });
    emit(EVENTS.chatUpdate, chatKeyNow);
    orchestrator.onIncoming(chatKeyNow, entry);
  }

  async function dispatch(event: OneBotEvent) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      const sender = isRecord(event.sender) ? event.sender : {};
      if (String(event.user_id ?? sender.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  function handle(event: OneBotEvent): Promise<void> {
    if (!event || typeof event !== 'object') return Promise.resolve();
    if ((event.post_type === 'message' || event.post_type === 'message_sent')
      && event.message_type === 'group' && event.group_id != null) {
      const id = String(event.group_id);
      return enqueueIngest(`group:${id}`, () => dispatch(event));
    }
    if ((event.post_type === 'message' || event.post_type === 'message_sent')
      && event.message_type === 'private' && event.user_id != null) {
      const id = String(event.user_id);
      return enqueueIngest(`private:${id}`, () => dispatch(event));
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      const isGroup = event.group_id != null;
      const id = isGroup ? String(event.group_id) : String(event.user_id ?? '');
      return enqueueIngest(`${isGroup ? 'group' : 'private'}:${id}`, () => dispatch(event));
    }
    return dispatch(event);
  }

  return { handle };
}
