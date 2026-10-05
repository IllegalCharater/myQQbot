// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import { getConfig } from '../../core/config.js';
import { validateImageUrl, safeFetchBinary, detectMime } from '../../media/safe-fetch.js';
import { SlidingWindowBudget } from '../../media/call-budget.js';
import type { ChatMessage } from '../../chat/types.js';
import type { ToolArguments, ToolContentPart, ToolContext, ToolDefinition, ToolResult } from '../shared/types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function downloadImageAsDataUrl(url: unknown, timeoutMs = 30000): Promise<string> {
  const safeUrl = await validateImageUrl(url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

// ── 联网调用的成本闸门 ──
//
// 三个工具共用一个实例，所以 **web_search 与 web_fetch 是同一份额度**：两者都是"发一次
// 外部网络请求"，分开记两本账只会让用户以为各有限额，实际却按两份算。这与
// `agent-runner.ts` 把两者计进同一个 `webSearchCount` 的口径一致。
//
// 模块级单例是**有意的**：滑动窗口的状态必须跨调用累积，放进 `execute` 里每次新建就等于
// 没有闸门。限额本身每次调用现读配置（`getLimits` 是回调），所以改完设置即时生效。
const webBudget = new SlidingWindowBudget({
  getLimits: () => {
    const cfg = getConfig().webSearch;
    return { perChatPerHour: cfg?.maxCallsPerChatPerHour, perDay: cfg?.maxCallsPerDay };
  }
});

/**
 * 在真正联网**之前**领一次额度；超限返回给模型看的一句话，未超限返回 null。
 *
 * 排在联网之前是刻意的（与 image-source 同一条）：被拒绝的调用不该真去发请求，也不该占额度。
 * 返回文案而不是抛错，是因为这两个工具的既有约定就是"失败原因作为结果交回模型，
 * 由模型决定怎么向群友交代"——工具**不替模型发言**。
 */
export function takeWebBudget(chatKey: string): string | null {
  try {
    webBudget.take(chatKey);
    return null;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'RATE_LIMITED') throw error;
    const cfg = getConfig().webSearch;
    return `联网调用太频繁（本会话每小时最多 ${cfg?.maxCallsPerChatPerHour ?? 20} 次、全部会话每天最多 ${cfg?.maxCallsPerDay ?? 200} 次），稍后再试。`;
  }
}

// 按魔数判图片类型的实现搬到了 safe-fetch.js（那边没有依赖，sticker-cache.js 也要用）。
// 这里原样转出：app.js 等既有调用点一行都不用改。
// ⚠️ 必须**同时 import 进来**（见上面那行 import）：`export { x } from '…'` 只转出、不在本模块
// 建立绑定，光有它的话本文件里用 detectMime 会 ReferenceError（2026-09-24 就是这么炸的：
// get_message_images 整条读图路径全灭，报 `detectMime is not defined`）。
export { detectMime };

export function ok(payload: unknown): ToolResult {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

export function err(message: unknown): ToolResult {
  return { content: `错误：${message}`, isError: true };
}

// read_group_notice 一次返回的正文总预算。单条上限在 onebot.js 的 NOTICE_TEXT_MAX，
// 但 10 条叠起来照样能吃掉大块上下文，这里再兜一层。
export const NOTICE_BATCH_CHARS = 6000;

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
export function midHint(ctx: ToolContext): string {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

/** 从存档的 media 里取转发 res_id（入库时 extractMediaFromSegments 存下的）。 */
export function forwardResIdFromMedia(entry: ChatMessage | null | undefined): string {
  const hit = (entry?.media || []).find((x) => x && x.kind === 'forward' && x.id);
  return hit ? String(hit.id) : '';
}

// 模型指错 id 时（典型：拿了"引用了某条转发"的那条普通消息的 id），把当前会话里确实
// 是合并转发的消息列出来，让它下一轮能改对 —— 只报一句"失败"模型只会换着 id 瞎试。
export function forwardHint(ctx: ToolContext): string {
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
export function memberHint(ctx: ToolContext): string {
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
export function senderNameFor(ctx: ToolContext, userId: unknown): string {
  const uid = String(userId || '');
  if (!uid) return '';
  const noted = (getConfig().memberNotes || {})[uid];
  if (noted) return String(noted);
  const hit = ctx.store.recent(ctx.chatKey, { limit: 500 }).find((m) => String(m.senderId) === uid);
  return hit ? String(hit.senderName || '') : '';
}

/** 群公告取不到时的提示：区分"协议端没这个接口"、"结构不认识"和"这次请求失败"，都要给出下一步。 */
export function noticeHint(error: unknown): string {
  const msg = errorMessage(error);
  const tail = '如实告诉群友你读不到公告就行，不要编内容。';
  if (/无法识别的结构/.test(msg)) {
    return `协议端返回的群公告结构不认识（${msg}）。多半是协议端版本差异导致的字段不同，${tail}`;
  }
  if (/HTTP 404|unsupported|unknown action|not (found|implemented)|retcode=1404/i.test(msg)) {
    return `协议端没有群公告接口（${msg}）。可能是 SnowLuma / NapCat 版本较旧，或该协议端没实现 get_group_notice。${tail}`;
  }
  return `读群公告失败：${msg}。可以稍后再试一次；再失败就${tail}`;
}

export function imageParts(text: string, dataUrls: string[]): ToolContentPart[] {
  const parts: ToolContentPart[] = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs: ToolDefinition[]): Array<Record<string, unknown>> {
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
export async function executeTool(defs: ToolDefinition[], ctx: ToolContext, name: string, argsJson: unknown): Promise<ToolResult> {
  const def = defs.find((d) => d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args: ToolArguments = {};
  const raw = argsJson ?? '{}';
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    args = isRecord(parsed) ? parsed : {};
  } catch {
    // 最常见的成因是字符串值里有**没转义的英文双引号**（模型写中文时习惯直接敲 "），而
    // 转义与否是模型自己的事，我们不做猜测式修复：JSON 修错了会把改动过的文本真的发到群里，
    // 比发不出去更糟。所以只把原文回给模型，外加它能自己执行的下一步。
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}（常见原因是字符串值里有没转义的英文双引号 —— 需要引号时改用中文引号「」或“”，改好后重新调用一次）`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${errorMessage(error)}`, isError: true };
  }
}
