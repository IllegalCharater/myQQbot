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
import type { OneBotEvent, OneBotSegment } from '../../qq/types.js';
import type { SendQueue } from '../../qq/sender.js';
import type { CommandDeps, CommandDispatcher } from './commands.js';
import type { ExtrasRuntime } from '../../extra/runtime.js';
import type { VideoTranscriptionQueue } from '../../media/transcription/index.js';
import type { ImageGenQueue } from '../../media/image-gen/index.js';
// ⚠️ 别名不是洁癖：`qq/onebot.js` 已经导出一个同名的 `extractMediaFromSegments`（那是
// **通用 OneBot 协议解析**：图片、表情、视频段本身），而这里要的是**平台卡片识别**
// （某某站的小程序卡片/分享卡里那个链接）。两者是不同的事、都由本文件调用，
// 直接同名 import 会撞车（实测 TS2300）。
import { mediaCandidateFromUrl, extractMediaFromSegments as extractCardMediaFromSegments } from '../../media/media-source/index.js';
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

/**
 * 把已解析的 card 媒体补成可定位的视频媒体。
 *
 * **通用实现**：平台知识全在 `media/media-source/` 的 provider 清单里，这里只做
 * "拿 media 里已有的 card url 去问一遍 provider"。加平台不用改这个文件。
 *
 * 为什么非补不可：`/转写` 与 `transcribe_video` 都靠 media 里的 `kind:'video'` 定位目标，
 * 只认通用卡片解析的 `jumpUrl` 时，B 站小程序卡片看着有链接、存档里却没有，
 * 两边都会报"没有视频链接"。
 *
 * 与 `addCardMediaFromSegments` 的分工：那个从**原始段报文**里补（覆盖通用解析认不出的
 * `qqdocurl` 与 `xml`），这个从**已解析的 media** 里补别名。两个都调、按 url 去重，顺序无关。
 */
function addVideoAliases(media: MediaEntry[]): void {
  const existing = new Set(media
    .filter((item) => item.kind === 'video' && typeof item.url === 'string')
    .map((item) => String(item.url)));
  for (const item of [...media]) {
    if (item.kind !== 'card' || typeof item.url !== 'string' || existing.has(item.url)) continue;
    const hit = mediaCandidateFromUrl(item.url);
    if (!hit) continue;
    media.push({ kind: hit.kind, url: hit.url, source: hit.source });
    existing.add(hit.url);
  }
}

/**
 * 直接从原始消息段里补媒体链接（**平台无关**）。
 *
 * 不经过通用卡片解析那一层，覆盖它认不出的形态：小程序卡片的链接在
 * `meta.detail_1.qqdocurl`（没有 `jumpUrl`）、部分协议端把分享卡下发成 `xml` 段。
 * 两者都由 provider 自己认领（见 `media/media-source/index.ts`）。
 */
function addCardMediaFromSegments(media: MediaEntry[], segments: unknown): void {
  const existing = new Set(media
    .filter((item) => item.kind === 'video' && typeof item.url === 'string')
    .map((item) => String(item.url)));
  for (const hit of extractCardMediaFromSegments(segments)) {
    if (existing.has(hit.url)) continue;
    media.push({ kind: hit.kind, url: hit.url, source: hit.source });
    existing.add(hit.url);
  }
}

export interface Ingest {
  /** `OneBotClient.onEvent` 的落点。内部已吞掉各自的分支，不需要调用方再 catch 分支错误。 */
  handle(event: OneBotEvent): Promise<void>;
}

/**
 * 命令判定用的文本里，**掐掉开头那串「@机器人自己」的段**。
 *
 * 群友很自然的输入是「先 @ 机器人、再敲命令」（`@bot /转写`），而协议端把 @ 段渲染成
 * **紧贴着**的 `@名字`（`segmentsToText` 用 `out.join('')`），于是拿到的文本是
 * `@Zarathustra /转写` —— 命令词不在开头，`startsWithWord` 认不出来。
 * **实测（2026-10-19 真机）**：`@bot /能力` 被当成普通消息进了 LLM，群里收到一句模型自己编的
 * 「？又发什么暗号」，白多花一次模型调用（`wakeEligible` 也跟着变 true），而**不报任何错**。
 *
 * ⚠️ **只掐指向机器人自己的那一串，不是"任何开头的 @"**：`@小明 /画 猫` 是在跟别人说话，
 * 顺手把命令执行掉是误伤（同 `startsWithWord` 那条"`@` 不算边界"的取舍，方向相反而已）。
 * `selfId` 为空（还没握手拿到自己的号）时原样返回 —— 认不出自己就退回改动前的行为，
 * 而不是猜。
 *
 * ⚠️ **引用段在协议端的报文里排在 @ 之前**（`[reply, at, text]`），所以要先跳过它 ——
 * 少了这一步，"引用一条消息 + @机器人 + 敲命令"这条最常见的形态一个都不会被掐掉。
 * 它本来就不出现在命令文本里（`includeReply:false`），跳过它不改变任何输出。
 *
 * 掐掉的只是**命令判定用的那一份**（`commandText`）：进存档的 `text` 仍带着 @，
 * 那是群友真正说的话。与「合并转发展开只替换 `text`、不替换 `commandText`」是同一条分工。
 */
function stripLeadingSelfMentions(segments: OneBotSegment[], selfId: string): OneBotSegment[] {
  if (!selfId) return segments;
  const start = segments[0]?.type === 'reply' ? 1 : 0;
  let i = start;
  while (i < segments.length) {
    const seg = segments[i];
    const qq = isRecord(seg?.data) ? seg.data.qq : undefined;
    if (seg?.type !== 'at' || String(qq ?? '') !== selfId) break;
    i += 1;
  }
  // 一个都没掐掉时返回**原数组**：调用方按引用判断"要不要为存档那一份重算一次"。
  return i > start ? segments.slice(i) : segments;
}

export function createIngest({ onebot, store, sender, orchestrator, transcription, imageGen, jmcomic, commands, extras, emit, getConfig, log }: {
  onebot: OneBotClient;
  store: ChatStore;
  sender: Pick<SendQueue, 'sendTextBatch'>;
  /** 只用到 `onIncoming`——跨模块方法面走端口，不依赖 Orchestrator 具体类。 */
  orchestrator: AgentControlPort;
  transcription: Pick<VideoTranscriptionQueue, 'enqueue'>;
  imageGen: Pick<ImageGenQueue, 'enqueue'>;
  /** 斜杠命令层的漫画下载端口（`onebot/sender/store` 由装配根在绑定处补齐）。 */
  jmcomic: CommandDeps['jmcomic'];
  /**
   * 斜杠命令分发器。**由装配根建好递进来**，而不是这里 import 那两个模块级函数 ——
   * 命令表里现在还有扩展贡献的命令，而那张表要按装载状态现算（见 `commands.ts`）。
   */
  commands: CommandDispatcher;
  /**
   * 扩展的**入站拦截**端口（见 `ExtraRuntime.intercept`）。**只暴露这一个方法** ——
   * 与 `/漫画` 只拿 `enqueue` 同形：接入层不该认识整个扩展运行时。
   *
   * 装了它才有"扩展拦普通消息"这条路；不装（headless 测试）就是没有拦截，其余照常。
   */
  extras: Pick<ExtrasRuntime, 'intercept'>;
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
        addVideoAliases(media);
        addCardMediaFromSegments(media, msg.message);
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
    addVideoAliases(media);
    addCardMediaFromSegments(media, segments);

    let text;
    let commandText;
    // 这条消息有没有 @ 机器人自己。**必须从原始段算**：下面 `renderText` 出来的是文本，
    // 而开头那串 @ 已经被掐掉了 —— 命令层从 `text` 里看不出 @ 过（`/能力` 的装载/卸载
    // 在群里要靠这个判据，见 `CommandInput.mentionedSelf`）。
    let mentionedSelf = false;
    const repliedMedia: MediaEntry[] = [];
    // 引用在**这一层**解析，不交给 `segmentsToText`：那里拼出来的预览串没有 id，
    // 而被引用对象的 id 必须留下（见 ChatReply 的注释）。两条路径都走 `includeReply:false`，
    // 即引用段不进 text —— 预览由渲染层从 reply 里拼，位置在 `formatReplyPrefix`。
    //
    // `text` 与 `commandText` **起手是同一个串**，但下面合并转发展开会整份替换 `text`：
    // 于是 `commandText` 是"用户真正敲的那句话"（命令判定与 `parseTranscriptionCommand` 只认它），
    // `text` 是"进了存档、给模型看的那份"。别把它们并成一个变量 —— 那会让
    // "转发了一条记录、转发内容里恰好以 /转写 开头"变成一条真命令。
    // 另有一处**只动 `commandText`** 的规范化：开头那串「@机器人自己」的段要掐掉
    // （`@bot /转写` 是群里最自然的输入，见 `stripLeadingSelfMentions`）—— 存档里仍带着 @。
    let reply: ChatReply | null = null;
    if (segments) {
      const replySeg = segments.find((seg) => seg?.type === 'reply');
      const replyId = replySeg ? String((replySeg.data as Record<string, unknown> | undefined)?.id ?? '') : '';
      if (replyId) {
        const info = await resolveReply(replyId, { kind, id });
        reply = { mid: info.mid, sender: info.sender, text: info.text };
        if (info.media.length) repliedMedia.push(...info.media);
      }
      const selfId = String(onebot.selfId ?? '');
      const commandSegments = stripLeadingSelfMentions(segments, selfId);
      mentionedSelf = !!selfId && segments.some(
        (seg) => seg?.type === 'at' && String((isRecord(seg.data) ? seg.data.qq : '') ?? '') === selfId
      );
      const renderText = (segs: OneBotSegment[]) => segmentsToText(segs, {
        includeReply: false,
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : Promise.resolve(null)
      });
      commandText = await renderText(commandSegments);
      // 存档那一份**保留 @**（那是群友真正说的话），所以只在真掐掉过东西时才重算一遍 ——
      // 没掐掉时两者逐字相同，重算只会让 @ 名字白查一遍（查不到的名字**不进缓存**，
      // 于是每个 `@非本群成员` 的消息都要多打一次接口）。
      text = commandSegments === segments ? commandText : await renderText(segments);
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
    const replyToMessageId = typeof event.message_id === 'string' || typeof event.message_id === 'number'
      ? event.message_id : null;
    // 斜杠命令（`/转写`、`/画` …）是**确定性快路径**：不进 LLM、不占一次唤醒。
    // 判定、解析、入队与即时回执**全在 `web/onebot/commands.ts` 一处**（那张表是唯一事实源），
    // 这里只用同一个判据决定两件事：要不要并入引用附件、要不要落成已读历史。
    // 判据若在这里另写一份，漂移的表现是"命令没被认出来、消息进了 LLM"，不报任何错。
    const slashCommand = commands.isCommandEntry(commandText, chatKey);
    if (slashCommand && repliedMedia.length) {
      // 引用的那条消息里的附件要并进来：`/转写` 靠它取引用视频，`/画` 靠它取参考图（图生图）。
      media.push(...repliedMedia);
      addVideoAliases(media);
    }
    // ── 扩展拦消息：与斜杠命令并列的第二条确定性快路径 ──
    //
    // 区别是它**不需要群友敲斜杠**：纯工具能力（骰子、签到）可以直接认下一条普通消息并
    // 当场回话，**一整轮模型调用都不发生**（没有它的话，这类消息只能靠模型判"这看起来像
    // 骰子表达式"再调工具 —— 慢、要花钱，还受响应档位约束）。
    //
    // 只在**不是**主流程命令时问（命令优先，与命令表"内置在前、扩展在后"是同一条顺序）。
    // 判据同步、无 I/O 是硬要求（见 `extra/types.ts`：它跑在每一条入站消息上），
    // 抛错在运行时那层就吞掉并记日志了，不会打到这条入站链上。
    //
    // 收的是本条消息**自己的**媒体，**不含**它引用那条的：合并引用附件是给"附件型命令"
    // （转写/画）准备的，而拦截是纯文本判断 —— 并进来只会让存档多出"只在被拦下时才有"的形状。
    const intercepted = slashCommand ? null : extras.intercept(chatKey, {
      chatKey,
      // 用 `commandText` 而不是 `text`：后者可能已被合并转发展开整份替换过。
      text: commandText,
      media,
      senderId,
      replyToMessageId
    });

    // 条目要**当面交给**编排器（onIncoming 的第二个参数）：上下文窗口的入窗入口
    // 只有它一个，少传一次窗口与存档就会静默分叉。两条确定性快路径是仅有的例外：它们通过
    // wakeEligible:false 原子落成已读历史，窗口及其兜底同步都会明确排除它们。
    const entry = store.appendIncoming(chatKey, {
      mid: replyToMessageId,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]',
      reply,
      media,
      wakeEligible: !slashCommand && !intercepted
    });
    emit(EVENTS.chatUpdate, chatKey);

    // 命令消息到此为止：它已经作为**已读存档**留在会话里了，处理完就返回、不惊动模型。
    // 出图/转写这类要几十秒的活由各自的单并发后台队列接着干，不占住 OneBot 的入站处理链。
    if (slashCommand) {
      await commands.handleCommandEntry(
        {
          chatKey,
          // 用 `commandText` 而不是 `text`：后者可能已被合并转发展开整份替换过。
          text: commandText,
          // 从**原始段**算出来的（见上面那处赋值）：`commandText` 里开头那串 @ 已经被掐掉了。
          mentionedSelf,
          media,
          // `/漫画` 的去重键是"请求者 + 漫画 ID"，缺了它俩人就共用一个额度。
          senderId,
          replyToMessageId
        },
        { transcription, imageGen, jmcomic, sender, log }
      );
      return;
    }

    // 扩展接下了这条：**照常存档、照常上面板**（就在上面那两行），但落成**已读**历史 ——
    // 模型以后在【过去状态】里读得到，这一轮不惊动它。回话由**宿主**发（扩展碰不到 sender），
    // 发不出去只记日志：这条消息本身已经落档了，抛出去会污染入站回调。
    if (intercepted) {
      const receipt = intercepted.reply == null ? '' : String(intercepted.reply);
      if (receipt) {
        await sender.sendTextBatch(chatKey, receipt, { replyToMessageId })
          .catch((error) => log(`[ingest] 扩展拦消息的回执发送失败：${errorMessage(error)}`));
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
