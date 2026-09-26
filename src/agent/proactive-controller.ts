import { getConfig } from '../core/config.js';
import { randInt } from '../core/util.js';
import type { ChatStore } from '../chat/store.js';
import type { ContextWindowRegistry } from './context-window.js';

export interface ProactiveControllerDependencies {
  store: ChatStore;
  windows: ContextWindowRegistry;
  runningChats: Set<string>;
  isPaused(): boolean;
  isAborted(): boolean;
  wake(chatKey: string): Promise<void>;
}

export class ProactiveController {
  timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ProactiveControllerDependencies) {}

  start(): void {
    this.stop();
    const tick = async (): Promise<void> => {
      const config = getConfig();
      const next = randInt(
        Math.max(60000, Number(config.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(config.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.timer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.deps.isAborted() || this.deps.isPaused() || config.proactive?.enabled !== true) return;
      if (this.deps.runningChats.size >= Math.max(1, Number(config.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(config.proactive?.probability) || 0.25)) return;
      const candidates = this.candidates(config);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      this.deps.wake(chatKey).catch((error: unknown) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.timer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private candidates(config: ReturnType<typeof getConfig>): string[] {
    const idleMs = Math.max(300000, Number(config.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (config.allow?.groups ?? []).map(String);
    const candidates: string[] = [];
    for (const chatKey of this.deps.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !config.allowAllWhenEmpty) continue;
      if (this.deps.windows.pending(chatKey).length > 0) continue;
      if (Date.now() - this.deps.store.getChatMeta(chatKey).lastTs < idleMs) continue;
      if (this.deps.runningChats.has(chatKey)) continue;
      candidates.push(chatKey);
    }
    return candidates;
  }
}
