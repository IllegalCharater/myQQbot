import type { ChatMessage } from '../../chat/types.js';
import type { SessionRecord } from '../../chat/types.js';
import type { ChatStore } from '../../chat/store.js';
import type { MemoryStore } from '../../chat/memory.js';
import type { StickerManager } from '../../stickers/sticker-manager.js';
import type { StickerEntry } from '../../stickers/types.js';
import type { SendQueue } from '../../qq/sender.js';
import type { OneBotClient } from '../../qq/onebot.js';
import type { SessionRegistry } from '../../chat/sessions.js';
import type { ContextWindowRegistry } from '../context/context-window.js';
import type { AppEmit } from '../../core/events.js';
import type { VideoTranscriptionQueue } from '../../media/transcription/index.js';
import type { ImageGenQueue } from '../../media/image-gen/index.js';
import type { HotSearchScheduler } from '../../media/hot-search/scheduler.js';

export type ToolArguments = Record<string, unknown>;
export interface ToolContentPart extends Record<string, unknown> { type: string }

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(ctx: ToolContext, args: ToolArguments): Promise<ToolResult>;
}

export interface ToolContext extends Record<string, unknown> {
  chatKey: string;
  kind: string;
  chatId: string | number;
  selfId: string | number;
  selfNickname: string;
  botName: string;
  requesterId: string | number;
  onebot: OneBotClient;
  store: ChatStore;
  memory: MemoryStore;
  stickers: StickerManager;
  sender: SendQueue;
  session: SessionRecord & { sent: unknown[]; feedbacks: unknown[] };
  emit: AppEmit;
  triggerEntries?: ChatMessage[];
  /**
   * 能力型工具依赖，**可选**：只有 app.ts 装配的那条链路会传，测试里的部分字面量不必跟着补。
   * 工具侧一律按"可能没有"处理，缺了返回友好错误而不是抛。
   */
  transcription?: Pick<VideoTranscriptionQueue, 'enqueue'>;
  imageGen?: Pick<ImageGenQueue, 'enqueue'>;
  hotSearch?: Pick<HotSearchScheduler, 'readTopics'>;
}

export interface ToolResult extends Record<string, unknown> {
  content: string | ToolContentPart[];
  isError?: boolean;
}

export interface TriggerContext {
  selfNickname?: string;
  botName?: string;
  selfId?: string | number;
}

export interface ResponseDecision { responseTier: number; reason: string; shouldRespond: boolean }
export interface HistoryPolicyResult { historyCount: number }
export interface SelectedDigest { entry: ChatMessage; text: string; chars: number; truncated: boolean }
export interface DigestSelection {
  picked: SelectedDigest[];
  dropped: ChatMessage[];
  chars: number;
  budget: number;
  total: number;
  totalChars: number;
  truncated: boolean;
}
export interface PastStateResult { text: string; count: number; messages: ChatMessage[] }

export interface ChatRuntimeState {
  state: 'silent' | 'replying';
  phase: '' | 'waiting' | 'running';
  since: number;
  batchStartedAt: number;
  roll: number | null;
  waitingSessionId: string | null;
}

export interface OrchestratorDependencies {
  store: ChatStore;
  memory: MemoryStore;
  stickers: StickerManager;
  sender: SendQueue;
  sessions: SessionRegistry;
  onebot: OneBotClient;
  // S10d 起 **必填**：以前 Orchestrator 会在缺省时兜底建一个 createEventBus()，
  // 于是"忘了传 emit"的调用点静默拿到一个只有自己的空总线——发出的帧没人收，
  // 而 `tsc` 管不到（tests/ 不在 tsconfig 的 include 里）。现在缺了直接编译不过，
  // 测试侧由 tests/t-ports.mjs 第 1c 段的文本扫描守（见那里的注释）。
  emit: AppEmit;
  windows?: ContextWindowRegistry | null;
  // 能力型工具依赖，可选：透传给 WakeScheduler（它才是 `AgentRunnerHost`），见 ToolContext 的说明。
  transcription?: Pick<VideoTranscriptionQueue, 'enqueue'>;
  imageGen?: Pick<ImageGenQueue, 'enqueue'>;
  hotSearch?: Pick<HotSearchScheduler, 'readTopics'>;
}

export interface PromptContext extends TriggerContext, Record<string, unknown> {
  chatKey: string;
  kind: string;
  chatId: string | number;
  chatName?: string;
  triggerEntries: ChatMessage[];
  proactive?: boolean;
  historyLimit?: number | null;
  /** 当前窗口最早一条消息的本地 id；历史只能从它之前读取。 */
  historyBeforeId?: number | null;
  foldedAway?: number;
  lastMessageAt?: number;
  recentCount?: number;
  selfLastMessageAt?: number;
  store: ChatStore;
  memory: MemoryStore;
  session?: SessionRecord;
  stickerEntries?: StickerEntry[];
}
