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
import type { MediaEntry } from '../../chat/types.js';
import type { ChatStore } from '../../chat/store.js';
import type { AgentControlPort } from '../../agent/runtime/control-port.js';
import {
  segmentsToText, extractMediaFromSegments, expandForwardNodes, forwardIdFromData
} from '../../qq/onebot.js';
import type { OneBotClient } from '../../qq/onebot.js';
import type { OneBotEvent } from '../../qq/types.js';
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

export interface Ingest {
  /** `OneBotClient.onEvent` 的落点。内部已吞掉各自的分支，不需要调用方再 catch 分支错误。 */
  handle(event: OneBotEvent): Promise<void>;
}

export function createIngest({ onebot, store, orchestrator, emit, getConfig, log }: {
  onebot: OneBotClient;
  store: ChatStore;
  /** 只用到 `onIncoming`——跨模块方法面走端口，不依赖 Orchestrator 具体类。 */
  orchestrator: AgentControlPort;
  emit: AppEmit;
  getConfig: () => AppConfig;
  log: (...args: unknown[]) => void;
}): Ingest {
  const atNameCache = new Map<string, string>(); // groupId:userId -> name
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
   * 解析被引用消息的原文。
   * ctx 传当前会话的 kind/id：QQ 里引用只可能发生在同一个会话内，所以被引用消息里的
   * @ 就是本群成员，能正常解析成群名片（与主消息路径的行为保持一致）。
   */
  async function resolveReply(messageId: unknown, { kind = '', id = '' }: { kind?: string; id?: string } = {}) {
    try {
      const msg = await onebot.getMsg(messageId);
      const sender = isRecord(msg) && isRecord(msg.sender) ? msg.sender : {};
      const senderName = sender.card || sender.nickname || '';
      let text = '';
      if (isRecord(msg) && Array.isArray(msg.message)) {
        // 必须复用 segmentsToText，不能自己拼。被引用的消息可能是 json 卡片 /
        // 合并转发 / 图片，自己拼只会得到 "[json]" "[forward]" 这类原始英文段名，
        // 模型完全读不懂 —— 曾经这里就是这样把"引用了一张卡片"变成四个无用字符。
        // includeReply:false：引用里再套引用只展开一层，防递归。
        // 注意这里不展开合并转发（只留占位符），展开是模型用 read_forward 主动做的事。
        text = await segmentsToText(msg.message, {
          includeReply: false,
          resolveAtName: (qq) => (kind === 'group' ? resolveAtName(id, qq) : Promise.resolve(null))
        });
      } else if (isRecord(msg) && typeof msg.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), text: String(text).slice(0, REPLY_PREVIEW_MAX) };
    } catch {
      return null;
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

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid, { kind, id }),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : Promise.resolve(null)
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
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
    // 条目要**当面交给**编排器（onIncoming 的第二个参数）：上下文窗口的入窗入口
    // 只有它一个，少传一次窗口与存档就会静默分叉（那条消息永远不会被回应）。
    const entry = store.appendIncoming(`${kind}:${id}`, {
      mid: typeof event.message_id === 'string' || typeof event.message_id === 'number' ? event.message_id : null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]',
      media
    });
    emit(EVENTS.chatUpdate, `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`, entry);
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

  async function handle(event: OneBotEvent) {
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

  return { handle };
}
