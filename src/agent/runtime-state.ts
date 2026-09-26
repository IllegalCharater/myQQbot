import type { SendQueue } from '../qq/sender.js';
import type { ChatRuntimeState } from './types.js';

export class RuntimeStateRegistry {
  readonly states = new Map<string, ChatRuntimeState>();

  constructor(private readonly sender: SendQueue) {}

  get(chatKey: string): ChatRuntimeState | null {
    return this.states.get(chatKey) || null;
  }

  ensure(chatKey: string): ChatRuntimeState {
    let state = this.states.get(chatKey);
    if (!state) {
      state = { state: 'silent', phase: '', since: 0, batchStartedAt: 0, roll: null, waitingSessionId: null };
      this.states.set(chatKey, state);
    }
    return state;
  }

  enterReplying(
    chatKey: string,
    { phase, waitingSessionId }: {
      phase?: ChatRuntimeState['phase'];
      waitingSessionId?: string | null;
    } = {}
  ): void {
    const state = this.ensure(chatKey);
    if (state.state !== 'replying') {
      state.state = 'replying';
      state.since = Date.now();
    }
    if (phase !== undefined) state.phase = phase;
    if (waitingSessionId !== undefined) state.waitingSessionId = waitingSessionId;
    this.sender.setReplying?.(chatKey, true);
  }

  exitReplying(chatKey: string): void {
    const state = this.states.get(chatKey);
    if (!state) return;
    this.states.delete(chatKey);
    if (state.state === 'replying') this.sender.setReplying?.(chatKey, false);
  }

  startBatch(chatKey: string, timestamp = Date.now()): ChatRuntimeState {
    const state = this.ensure(chatKey);
    state.batchStartedAt = timestamp;
    state.roll = null;
    return state;
  }

  roll(chatKey: string): number {
    const state = this.ensure(chatKey);
    if (state.roll === null || state.roll === undefined) state.roll = Math.random() * 100;
    return state.roll;
  }

  clear(): void {
    for (const chatKey of this.states.keys()) this.exitReplying(chatKey);
  }
}
