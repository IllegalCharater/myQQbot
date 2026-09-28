// SSE 事件投影：把内部事件翻译成发给浏览器的 SSE 帧。
//
// 为什么单独成模块：这段逻辑原来藏在 src/web/app.ts 的 emit 闭包里，只能靠
// 端到端套件（t-smoke）间接覆盖，出问题只能看到"面板不更新"。抽成纯函数后
// 可以直接单测（详见 tests/t-sse-project.mjs 与 docs/global-registry-design.md 的 S1）。
//
// 本模块只做"事件 → 文本"，不碰事件总线、不持有状态、不做 IO，唯一的读取依赖是
// SessionRegistry.peek（结构化依赖，测试里传对象字面量即可）。
import type { ServerResponse } from 'node:http';
import { EVENTS } from '../core/events.js';
import { isRecord } from '../agent/shared/json-parse.js';

/**
 * 投影只读这些字段，全部可选且为 unknown —— 这样测试可以只给关心的几个字段，
 * 而真实的 SessionRecord（字段齐全）也天然满足。
 */
export interface SessionUpdateSource {
  id?: unknown;
  chatKey?: unknown;
  startedAt?: unknown;
  status?: unknown;
  waitUntil?: unknown;
  activity?: unknown;
  webSearchCount?: unknown;
  rounds?: unknown;
  usage?: unknown;
  triggerSummary?: unknown;
  messages?: unknown;
  sent?: unknown;
  finishReason?: unknown;
  error?: unknown;
  endedAt?: unknown;
}

/** 投影需要的唯一能力：按 id 只读一个会话。 */
export interface SessionPeekSource {
  peek(id: string): SessionUpdateSource | null | undefined;
}

export interface ProjectDeps {
  /**
   * 组装根在 emit 被调用时它一定已构造完成；这里仍保留可空写法，
   * 与原闭包里的 `sessions?.peek(...)` 保持一致（拿不到就退回原样 payload）。
   */
  sessions?: SessionPeekSource | null;
}

/**
 * session-update 的富对象投影，返回序列化后的 JSON；返回 null 表示"没有可投影的会话"，
 * 调用方应退回原样 payload。
 *
 * ✅ S7 起这条分支是真的会被走到了：12 个生产者改发 `{ sessionId }`，入口条件
 * （见 projectSse）首次成立。此前它们发的是裸字符串 id，条件永远不成立——这条富帧
 * 分支**自初始提交到 S6 为止一次都没执行过**（旧版 JS 是 `payload?.sessionId`，
 * 对字符串同样取不到值）。
 *
 * 退回原样 payload 那条路今天是**理论兜底**：12 个发射点都在会话还活着（或已落盘）时
 * 触发，而 `sessions.peek()` 在内存里找不到时会回读会话文件，所以实际取不到会话的
 * 场景只剩"会话被 discard 删档"。但真走到那儿也不是裸串了——帧会是
 * `{"sessionId":"x"}`，UI（`ui/js/main.js:246-266`）照样当 patch 合并，
 * 用 `undefined` 覆盖面板那一行，直到 4s 轮询拉回来。见设计文档 §10 第 2 条。
 */
export function projectSessionUpdate(sessionId: string, sessions?: SessionPeekSource | null): string | null {
  try {
    // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
    // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
    const s = sessions?.peek(sessionId);
    if (!s) return null;
    return JSON.stringify({
      sessionId: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      status: s.status,
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      rounds: s.rounds ?? 0,
      usage: s.usage ?? null,
      trigger: s.triggerSummary ?? '',
      triggerSummary: s.triggerSummary ?? '',
      messages: s.messages ?? [],
      // sent/finishReason/error/endedAt 必须随 SSE 推下去：
      // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
      // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
      // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
      sent: s.sent ?? [],
      finishReason: s.finishReason ?? null,
      error: s.error ?? null,
      endedAt: s.endedAt ?? null
    });
  } catch {
    return null;   // 失败就退回原 payload
  }
}

/**
 * 把一条内部事件投影成完整的 SSE 帧（含 `event:` / `data:` / 结尾空行）。
 *
 * 只有 session-update 需要特殊投影；其余事件一律原样 JSON 序列化。
 * 注意 `payload ?? {}`：undefined 载荷要发成 `{}` 而不是 `undefined`（不是合法 JSON）。
 */
export function projectSse(type: string, payload: unknown, deps: ProjectDeps = {}): string {
  let line: string | null = null;
  if (type === EVENTS.sessionUpdate && isRecord(payload) && payload.sessionId) {
    const rich = projectSessionUpdate(String(payload.sessionId), deps.sessions);
    if (rich) line = `event: ${type}\ndata: ${rich}\n\n`;
  }
  return line ?? `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
}

/** 逐个 SSE 客户端写帧：单个客户端写失败不影响其余客户端（断开会由 close 清理）。 */
export function writeSse(clients: Iterable<ServerResponse>, line: string): void {
  for (const res of clients) {
    try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
  }
}
