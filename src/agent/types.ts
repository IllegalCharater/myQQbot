import type { ChatMessage } from '../chat/types.js';

export interface ToolContext extends Record<string, unknown> {
  chatKey?: string;
  triggerEntries?: ChatMessage[];
}

export interface ToolResult extends Record<string, unknown> {
  isError?: boolean;
  text?: string;
}

export type AgentPhase = 'waiting' | 'running';
export interface AgentEventMap {
  state: Record<string, unknown>;
  session: Record<string, unknown>;
  [event: string]: unknown;
}
