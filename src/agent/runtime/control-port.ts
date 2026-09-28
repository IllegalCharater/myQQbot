// Orchestrator 的跨模块端口（S8）：`web/` 与 Electron 主进程只依赖这个接口，不依赖具体类。
// 设计见 docs/global-registry-design.md §5.3。
//
// 为什么是"端口"而不是"注册表"：本仓库仅有的三处字符串键分发（工具分发、OneBot `call`、
// HTTP 路由）全是**外部契约**，必须原样保留；为业务方法建字符串注册表恰好是路线图明令
// 禁止的事（§5.2、§5.4）。这里只做一件事：把 `Orchestrator` 对外的跨模块面写成一个显式
// 接口，用 `implements`（类）在编译期检查，运行期零代价。
//
// ⚠️ 不得引入任何 `instanceof` 检查、`Symbol` 品牌或运行期校验——那会当场打碎
// `tests/t-orch.mjs` / `t-vision-log.mjs` 的构造策略（§5.5：它们用普通对象字面量
// 充当 onebot/memory/stickers 依赖，不是任何类的实例）。
//
// 为什么状态字段也在端口里：`web/` 读 `paused` / `pauseReason` / `compacting` /
// `consolidating` 做展示（`routes/system.ts:136`、`routes/chats.ts:75`、`routes/memory.ts:17`），
// 而 `electron/main.js:85` 也读 `paused`。它们是跨模块面的一部分，漏掉的话 web 就只能
// 继续依赖具体类，端口等于白建。写成 `readonly` 是**对读方的约束**：改状态一律走
// `setPaused` / `abortAll`，不许从 web 直写（`consolidating` 的 `.add()`/`.delete()`
// 是 Set 内容操作，readonly 属性不影响它，那是 `routes/memory.ts` 有意的乐观占位）。
import type { ChatMessage } from '../../chat/types.js';
import type { ChatRuntimeState } from '../shared/types.js';

/**
 * `compactChat` 的结果。**只声明读方真正读的字段**（`routes/chats.ts:17` 读
 * `ok`/`note`，然后把整个对象当响应体回给 UI），实现返回的对象可以更宽——
 * `implements` 只要求"实现能赋给这里"，宽出来的字段不会报错。
 * 声明一个实现里**不存在**的字段才会编译不过，这正是这里要的护栏方向。
 */
export interface CompactChatResult {
  ok: boolean;
  note?: string;
}

/**
 * `consolidateMemoryForChat` 的结果。`routes/memory.ts:84` 把它**整体展开**进
 * `memory-update` 的 `consolidate-done` 载荷，字段名与 `MemoryUpdatePayload`
 * 的对应项一致（那是同一份数据的两个投影）。`results`/`skipped`/`failed` 里是
 * 整理器的领域对象，这里只记成 `unknown[]`。
 */
export interface ConsolidateMemoryResult {
  ok: boolean;
  note?: string;
  changed?: number;
  results?: unknown[];
  skipped?: unknown[];
  failed?: unknown[];
}

export interface AgentControlPort {
  // ── 入站、唤醒与窗口 ──
  onIncoming(chatKey: string, entry: ChatMessage | null): void;
  forceWake(chatKey: string): boolean;
  markChatSeen(chatKey: string): number;
  chatState(chatKey: string): ChatRuntimeState | null;
  reloadWindow(chatKey: string): void;
  drainBacklogAfterResume(): void;

  // ── 维护任务（手动触发；自动巡检走各自的 start/stop）──
  compactChat(chatKey: string, options?: { force?: boolean }): Promise<CompactChatResult>;
  consolidateMemoryForChat(
    chatKey: string,
    options?: { userIds?: unknown[] | null; force?: boolean }
  ): Promise<ConsolidateMemoryResult>;
  getChatName(groupId: string | number): Promise<string>;
  startProactiveLoop(): void;
  stopProactiveLoop(): void;
  startCompactLoop(): void;
  stopCompactLoop(): void;

  // ── 控制与状态 ──
  setPaused(paused: boolean, reason?: string): void;
  abortAll(): Promise<void>;
  statusSummary(): Record<string, unknown>;

  // ── 只读运行状态（要改就走 setPaused / abortAll）──
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly compacting: Set<string>;
  readonly consolidating: Set<string>;
}

/**
 * 端口里的**行为**成员（不含只读状态字段）——从接口本身推导，不手工维护第二份名单。
 * `METHOD_CATALOG` 用它做键集约束，所以"往端口加一个方法却忘了登记表"编译不过。
 *
 * 注意这个推导的失败模式是**响亮**的：若某个方法没被这条条件类型识别出来，
 * `AgentControlMethod` 会缺键（甚至是 `never`），下面的 `satisfies` 会当场把
 * `METHOD_CATALOG` 的对应条目报成多余属性——不会静默漏掉。
 */
export type AgentControlMethod = {
  [K in keyof AgentControlPort]: AgentControlPort[K] extends (...args: never[]) => unknown ? K : never;
}[keyof AgentControlPort];

/**
 * 方法名录：**只作文档、遥测与测试引用，不参与任何运行时分发**。
 * 禁止写 `METHOD_CATALOG[name]?.()` 这类字符串式调用——那正是路线图禁止的注册表
 * （`tests/t-ports.mjs` 有一条断言扫 `src/` 钉住这点）。
 *
 * `owner` 写实际实现该方法的下层模块，不是门面所在文件：Orchestrator 是薄门面，
 * 绝大多数方法只是转调。`tests/t-ports.mjs` 会断言每个 owner 都是真实存在的文件。
 */
export const METHOD_CATALOG = {
  onIncoming: { owner: 'src/agent/runtime/wake-scheduler.ts', description: '入站消息进入上下文窗口并安排唤醒' },
  forceWake: { owner: 'src/agent/runtime/wake-scheduler.ts', description: '忽略等待窗口，立刻唤醒一次' },
  markChatSeen: { owner: 'src/agent/runtime/wake-scheduler.ts', description: '把某会话窗口里的未读标为已读，返回条数' },
  chatState: { owner: 'src/agent/runtime/wake-scheduler.ts', description: '读某会话的静默态/回复态' },
  reloadWindow: { owner: 'src/agent/runtime/wake-scheduler.ts', description: '按存档重播某会话的上下文窗口' },
  drainBacklogAfterResume: { owner: 'src/agent/runtime/wake-scheduler.ts', description: '恢复后补处理积压消息' },
  compactChat: { owner: 'src/agent/maintenance/history-compactor.ts', description: '压缩指定会话的历史（摘要入档 + 原文冷归档）' },
  consolidateMemoryForChat: { owner: 'src/agent/maintenance/memory-consolidator.ts', description: '整理指定会话的成员长期印象' },
  getChatName: { owner: 'src/agent/runtime/orchestrator.ts', description: '取群名（带缓存），拿不到返回空串' },
  startProactiveLoop: { owner: 'src/agent/maintenance/proactive-controller.ts', description: '启动主动冒泡巡检' },
  stopProactiveLoop: { owner: 'src/agent/maintenance/proactive-controller.ts', description: '停止主动冒泡巡检' },
  startCompactLoop: { owner: 'src/agent/maintenance/history-compactor.ts', description: '启动历史压缩巡检' },
  stopCompactLoop: { owner: 'src/agent/maintenance/history-compactor.ts', description: '停止历史压缩巡检' },
  setPaused: { owner: 'src/agent/runtime/orchestrator.ts', description: '暂停/恢复整个编排器，并广播 orchestrator-pause' },
  abortAll: { owner: 'src/agent/runtime/orchestrator.ts', description: '中止全部在跑会话并停掉两个巡检（进程退出前调用）' },
  statusSummary: { owner: 'src/agent/runtime/orchestrator.ts', description: '汇总运行状态供 /api/status 展示' }
} as const satisfies Record<AgentControlMethod, { owner: string; description: string }>;
