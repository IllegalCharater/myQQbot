import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AppConfig } from '../core/config.js';
import type { ChatStore } from '../chat/store.js';
import type { MemoryStore } from '../chat/memory.js';
import type { SessionRegistry } from '../chat/sessions.js';
import type { OneBotClient } from '../qq/onebot.js';
import type { SendQueue } from '../qq/sender.js';
import type { StickerManager } from '../stickers/sticker-manager.js';
import type { AgentControlPort } from '../agent/runtime/control-port.js';
import type { AppEmit } from '../core/events.js';
import type { HotSearchAdminActions } from '../media/hot-search/admin-actions.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type JsonHeaders = Record<string, string>;

export interface JsonReply { kind?: 'json'; status: number; body: unknown; headers?: JsonHeaders }
export interface BinaryReply { kind: 'binary'; status: number; body: Uint8Array; headers?: JsonHeaders }
export interface EmptyReply { kind: 'empty'; status: number; headers?: JsonHeaders }
export type Reply = JsonReply | BinaryReply | EmptyReply;

export interface SnowlumaStatus { embedded: boolean; pid: number | null }
export interface CreateAppOptions { log?: (...args: unknown[]) => void }

export interface AppContext {
  store: ChatStore;
  memory: MemoryStore;
  sessions: SessionRegistry;
  onebot: OneBotClient;
  sender: SendQueue;
  stickers: StickerManager;
  orchestrator: AgentControlPort;
  emit: AppEmit;
  hotSearch: HotSearchAdminActions;
  getConfig(): AppConfig;
  updateConfig(patch: Record<string, unknown>): AppConfig;
  launchSnowluma(): Promise<unknown>;
  stopSnowluma(): boolean;
  snowlumaStatus(): SnowlumaStatus;
  buildStatus(): Promise<unknown>;
  getSnowlumaLogs(): unknown[];
  openSnowlumaFolder(): Reply;
  openSnowlumaWebui(): Reply;
  buildUsageStats(options?: { range?: string }): Record<string, unknown>;
  buildUsageBreakdown(options?: { range?: string; dim?: string; key?: string; by?: string }): Record<string, unknown>;
  sanitizeConfig(config: AppConfig): unknown;
  applyConfigPatch(patch: unknown): AppConfig;
}

export interface Route {
  method: HttpMethod;
  path: string | RegExp;
  handle(ctx: AppContext, req: IncomingMessage, match: RegExpMatchArray | null, url: URL): Promise<Reply>;
}

export interface RouteMatch { route: Route; match: RegExpMatchArray | null }

export interface AppHandle {
  server: Server;
  onebot: OneBotClient;
  store: ChatStore;
  memory: MemoryStore;
  stickers: StickerManager;
  sender: SendQueue;
  sessions: SessionRegistry;
  orchestrator: AgentControlPort;
  start(): Promise<number>;
  stop(): Promise<void>;
  emit: AppEmit;
  getConfig(): AppConfig;
  updateConfig(patch: Record<string, unknown>): AppConfig;
  /** 配置生效的唯一出口（HTTP `POST /api/config` 与测试都走它，S11b 起在 handle 上也暴露一份）。 */
  applyConfigPatch(patch: unknown): AppConfig;
  launchSnowluma(): Promise<unknown>;
  stopSnowluma(): boolean;
  snowlumaStatus(): SnowlumaStatus;
}

export interface ResponseWriter { (res: ServerResponse, reply: Reply): void }
