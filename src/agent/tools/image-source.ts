import { getConfig } from '../../core/config.js';
import { TOOL_PROMPT_TEXT } from '../../core/prompt-catalog.js';
import { EVENTS } from '../../core/events.js';
import { ReverseImageSourceService, formatImageSourceResult } from '../../media/image-source/index.js';
import { SlidingWindowBudget } from '../../media/call-budget.js';
import type { SearchIntent } from '../../media/image-source/index.js';
import type { ToolDefinition } from '../shared/types.js';

const service = new ReverseImageSourceService({
  getConfig: () => getConfig().imageSource,
  log: (message) => console.log(message)
});

// 成本闸门：只限次数，不判断"该不该搜"（那是模型结合上下文的事，见工具 description）。
const budget = new SlidingWindowBudget({
  getLimits: () => {
    const cfg = getConfig().imageSource;
    return { perChatPerHour: cfg.maxCallsPerChatPerHour, perDay: cfg.maxCallsPerDay };
  }
});

function intentOf(value: unknown): SearchIntent {
  return value === 'anime' || value === 'illustration' ? value : 'unknown';
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

// 已知原因码 → 模型可转述的一句话。
const FAILURE_TEXT: Record<string, string> = {
  DISABLED: '图片来源识别未启用。',
  QUEUE_FULL: '当前找图任务太多，请稍后再试。',
  IMAGE_TOO_LARGE: '图片太大，无法识别。',
  IMAGE_EMPTY: '图片没下载到内容（链接多半已失效），让群友重新发一次。',
  IMAGE_FORMAT: '这张图的格式认不出来（只支持 PNG/JPEG/GIF/WebP）。',
  TOTAL_TIMEOUT: '图源接口响应太慢，这次查询超时了，稍后再试。'
};

/**
 * 原因码 → 给模型看的一句话；**未知原因必须带上原始码**。
 *
 * 抽成纯函数是为了能在不联网的情况下逐条钉住这张映射表（工具本身要真下载图片才能走到这些分支）。
 * 曾经的兜底文案把"提示发不出去"、"图片下载失败"、"接口超时"全说成同一句「这次图源识别没成功」——
 * 对着这句话既没法排查也没法向群友解释，而这个工具恰恰是问题最多的一条链路。
 */
export function imageSourceFailureText(code: string): string {
  return FAILURE_TEXT[code] || `图源识别失败（${code || '未知原因'}），稍后再试。`;
}

export function imageSourceTools(): ToolDefinition[] {
  return [{
    name: 'reverse_image_source',
    description: TOOL_PROMPT_TEXT.reverse_image_source.description,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: TOOL_PROMPT_TEXT.reverse_image_source.messageId },
        intent: { type: 'string', enum: ['anime', 'illustration', 'unknown'], description: TOOL_PROMPT_TEXT.reverse_image_source.intent }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      const cfg = getConfig().imageSource;
      if (!cfg.enabled) return { content: '错误：图片来源识别未启用', isError: true };
      const id = String(args.messageId ?? '');
      const entry = (ctx.triggerEntries || []).find((m) => String(m.mid) === id) || ctx.store.findByMid(ctx.chatKey, args.messageId);
      const image = entry?.media?.find((m) => m.kind === 'image' && m.url);
      if (!image?.url) return { content: '错误：指定消息里没有可识别的图片', isError: true };
      // 限频排在占位回复之前：否则会先发一句"稍等"再立刻拒绝。
      try {
        budget.take(ctx.chatKey);
      } catch (error) {
        if (error instanceof Error && error.message === 'RATE_LIMITED') {
          return { content: `错误：本群找图太频繁（每小时最多 ${cfg.maxCallsPerChatPerHour} 次），稍后再试。`, isError: true };
        }
        throw error;
      }
      // 占位提示与真正的查询**分开捕获**。
      //
      // `SendQueue.sendTextBatch` 在限频、内容为空、协议端全败时都会抛错
      // （src/qq/sender.ts 的 `#checkRate` 与"全部失败"分支），原先两者共用同一个 try，
      // 于是"客套话没发出去"被报成"图源识别失败"——而且**真正的查询根本没跑**。
      // 提示只是礼貌，它失败最多留一条日志。
      try {
        const sent = await ctx.sender.sendTextBatch(ctx.chatKey, '在找图源，稍等', { replyToMessageId: args.messageId });
        ctx.session.sent.push(...sent.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
        ctx.emit(EVENTS.sessionUpdate, { sessionId: ctx.session.id });
      } catch (error) {
        console.warn(`[image-source] 占位提示发送失败（继续找图）：${reasonOf(error)}`);
      }
      try {
        const output = await service.search(String(image.url), intentOf(args.intent));
        // 服务层把第三方报错收进 failures 而**不抛**（见 reverse-image-source-service.ts），
        // 于是"接口全挂了"与"图确实没匹配上"在结果里长得一模一样。全空结果配上非空 failures
        // 说明是前者，不能按后者说——那会把排查引向图片本身。
        if (!output.result && output.failures.length) {
          console.warn(`[image-source] 图源接口这次没返回结果：${output.failures.join('；')}`);
          return { content: `错误：图源接口这次没返回结果（${output.failures.join('；')}），稍后再试。`, isError: true };
        }
        return { content: formatImageSourceResult(output.result) };
      } catch (error) {
        const code = reasonOf(error);
        // 真实原因必须落地：这是唯一能区分"下载失败/超时/队列满"的地方。
        console.warn(`[image-source] 查询失败：${code}`);
        return { content: `错误：${imageSourceFailureText(code)}`, isError: true };
      }
    }
  }];
}
