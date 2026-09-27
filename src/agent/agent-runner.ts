import { getConfig } from '../core/config.js';
import { vendorOfConfig } from '../llm/model-prices.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { chatCompletionWithRetry, addUsage } from '../llm/llm.js';
import { toOpenAiTools, executeTool } from './tools.js';
import { modelImageVerdict } from '../llm/vision-scan.js';
import { parseInlineToolCalls } from './inline-tool-parser.js';
import { isRecord, safeParse } from './json-parse.js';
import type { ChatMessage, SessionRecord } from '../chat/types.js';
import type { ChatStore } from '../chat/store.js';
import type { MemoryStore } from '../chat/memory.js';
import type { StickerManager } from '../stickers/sticker-manager.js';
import type { SendQueue } from '../qq/sender.js';
import type { SessionRegistry } from '../chat/sessions.js';
import type { OneBotClient } from '../qq/onebot.js';
import type { ContextWindowRegistry } from './context-window.js';
import type { ContextTierResult, ToolDefinition } from './types.js';
import type { InlineToolCall } from './inline-tool-parser.js';
import type { ChatRequestMessage } from '../llm/types.js';
import type { StickerEntry } from '../stickers/types.js';

export interface AgentRunOptions {
  kind: string;
  chatId: string;
  chatKey: string;
  triggerEntries: ChatMessage[];
  proactive: boolean;
  seq: number;
  historyLimit?: number | null;
  windowEntryIds?: number[];
  tierInfo?: ContextTierResult | null;
  foldedAway?: number;
}

export interface AgentRunnerHost {
  store: ChatStore;
  memory: MemoryStore;
  stickers: StickerManager;
  sender: SendQueue;
  sessions: SessionRegistry;
  onebot: OneBotClient;
  windows: ContextWindowRegistry;
  toolDefs: ToolDefinition[];
  aborted: boolean;
  emit(event: string, payload?: unknown): unknown;
  getChatName(groupId: string | number): Promise<string>;
}

/** 兼容 OpenAI 字符串 content 与部分兼容端点返回的文本 parts 数组。 */
function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

export async function runAgent(host: AgentRunnerHost, session: SessionRecord, { kind, chatId, chatKey, triggerEntries, proactive, seq, historyLimit = null, windowEntryIds = [], tierInfo = null, foldedAway = 0 }: AgentRunOptions): Promise<void> {
    const cfg = getConfig();
    const chatName = kind === 'group' ? await host.getChatName(chatId) : '';
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || host.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = host.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = host.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = host.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 表情库快照（提示词用）
    let stickerEntries: StickerEntry[] = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await host.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // 工具集与系统提示共用同一份能力判定，避免提示说“能看图”但工具已被移除。
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    const searchEnabled = cfg.webSearch?.enabled !== false;

    // 组装提示词（无 LLM 历史）
    const systemPrompt = buildSystemPrompt({
      persona: cfg.persona,
      capabilities: { vision: visionEnabled, search: searchEnabled }
    });
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: host.store,
      memory: host.memory,
      stickerEntries,
      selfNickname,
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      // 从窗口取（口径与判定/消费一致）。⚠️ 提示词侧没有任何消费者读它，
      //    属既有的死负载 —— 顺带记一笔，本次不动它的语义。
      moreUnreadDuringRun: host.windows.pending(chatKey).length > 0,
      proactive,
      historyLimit,
      windowEntryIds,
      tierInfo,
      foldedAway
    });

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length;
    session.model = cfg.api.model;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.historyLimit = tierInfo.historyCount;
      // 旧会话面板/历史 JSON 的兼容字段。
      session.contextLimit = tierInfo.historyCount;
      session.contextReason = tierInfo.reason || '';
    }
    host.sessions.update(session.id);
    host.emit('session-update', session.id);

    const messages: ChatRequestMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    // JSON 模式需要看到输入给模型的完整 messages（去工具之前）
    session.inputMessages = structuredClone(messages.map((m) => ({ role: m.role, content: m.content })));
    host.sessions.update(session.id);

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const toolDefs = host.toolDefs.filter((d) => {
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      return true;
    });
    const openAiTools = toOpenAiTools(toolDefs);

    const ctx = {
      chatKey, kind, chatId,
      requesterId: String([...triggerEntries].reverse().find((m) => !m.self)?.senderId || ''),
      selfId: host.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: host.onebot,
      store: host.store,
      memory: host.memory,
      stickers: host.stickers,
      sender: host.sender,
      session,
      emit: (type: string, payload?: unknown) => host.emit(type, payload)
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    let webSearchCount = 0;
    // 刚往会话记录里压过一条「N 张图片已作为图像输入注入模型」时，记下它的下标。
    // 模型对这张图的解读在**下一轮**的响应里，而那一轮如果只调工具、没输出文本，
    // 会话记录会整条跳过它（ui 的 continue）—— 排查"图裂了看不见"那类事故时，
    // 用户看到的就只有"图片已注入"，看不到模型到底看见了什么。所以下一轮拿到响应后
    // 把那段话回填到这条记录上（见下面 slot.toolImages.reply）。
    let pendingImageEntry = -1;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity: unknown) => {
      session.activity = String(activity ?? '');
      host.sessions.update(session.id);
      host.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      if (host.aborted) { host.sessions.finish(session.id, 'aborted'); return; }
      markActivity('正在思考…');
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      const response = await chatCompletionWithRetry({ messages, tools: openAiTools });
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalText = assistantText(finalContent);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const assistantEntry = {
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        raw: response.raw ?? null
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      // 上一轮刚注入过图片 → 这一轮模型的输出就是它的"读图结论"，回填到那条记录上。
      // 只挂最后一批：同一轮注入过多批时（多个读图工具）模型看的是同一个响应，
      // 同一句话挂两遍只会刷屏。标记 imageReply 让 ui 跳过这条 assistant 气泡 ——
      // 那段话已经在卡片里显示了，再冒一个"思考（不发送）"就是同一句话出现两次、
      // 还看不出跟哪次读图有关。
      if (pendingImageEntry >= 0) {
        const slot = session.messages[pendingImageEntry];
        const toolImages = isRecord(slot?.toolImages) ? slot.toolImages : null;
        if (toolImages) {
          toolImages.reply = {
            text: finalText,
            calls: (Array.isArray(finalToolCalls) ? finalToolCalls : []).map((c) => ({
              name: c?.function?.name ?? '',
              args: safeParse(c?.function?.arguments ?? '{}')
            }))
          };
          session.messages[session.messages.length - 1].imageReply = true;
        }
        pendingImageEntry = -1;
      }
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls: InlineToolCall[] = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = host.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        host.sessions.update(session.id);
        host.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        break;
      }

      const toolResults: Array<ChatRequestMessage & { tool_call_id?: string; name?: string; isError?: boolean }> = [];
      const imageUserMessages: ChatRequestMessage[] = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = host.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        const result = await executeTool(toolDefs, ctx, name, argsRaw);
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images: Array<Record<string, unknown>> = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
          // 等下一轮把模型的读图结论回填到这条上（见循环开头 pendingImageEntry 那段）
          pendingImageEntry = session.messages.length - 1;
        }
        host.sessions.update(session.id);
        host.emit('session-update', session.id);
        if (name === 'finish') finish = true;
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    host.sessions.finish(session.id, status);
    host.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
}
