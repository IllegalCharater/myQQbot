import type { ChatMessage } from '../chat/types.js';
import type { SessionRecord } from '../chat/types.js';
import type { ChatStore } from '../chat/store.js';
import type { MemoryStore } from '../chat/memory.js';
import type { StickerManager } from '../stickers/sticker-manager.js';
import type { StickerEntry } from '../stickers/types.js';
import type { SendQueue } from '../qq/sender.js';
import type { OneBotClient } from '../qq/onebot.js';
import type { SessionRegistry } from '../chat/sessions.js';
import type { ContextWindowRegistry } from './context-window.js';

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
  emit(event: string, payload?: unknown): unknown;
  triggerEntries?: ChatMessage[];
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

export interface ContextTierResult { tier: number; historyCount: number; reason: string; shouldRespond: boolean }
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
  emit?: ((event: string, payload?: unknown) => unknown) | null;
  windows?: ContextWindowRegistry | null;
}

export interface PromptContext extends TriggerContext, Record<string, unknown> {
  chatKey: string;
  kind: string;
  chatId: string | number;
  chatName?: string;
  triggerEntries: ChatMessage[];
  proactive?: boolean;
  historyLimit?: number | null;
  /** @deprecated 使用 historyLimit。仅保留给旧调用方兼容。 */
  contextLimit?: number | null;
  windowEntryIds?: number[];
  foldedAway?: number;
  lastMessageAt?: number;
  recentCount?: number;
  selfLastMessageAt?: number;
  store: ChatStore;
  memory: MemoryStore;
  session?: SessionRecord;
  stickerEntries?: StickerEntry[];
}

export type AgentPhase = 'waiting' | 'running';
export interface AgentEventMap {
  state: Record<string, unknown>;
  session: Record<string, unknown>;
  [event: string]: unknown;
}
