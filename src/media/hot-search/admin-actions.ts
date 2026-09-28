import type { HotSearchScheduler } from './scheduler.js';

export interface HotSearchAdminActions {
  status(): ReturnType<HotSearchScheduler['status']>;
  preview(): ReturnType<HotSearchScheduler['preview']>;
  broadcast(): ReturnType<HotSearchScheduler['broadcast']>;
}

export function createHotSearchAdminActions(scheduler: HotSearchScheduler): HotSearchAdminActions {
  return {
    status: () => scheduler.status(),
    preview: () => scheduler.preview(),
    broadcast: () => scheduler.broadcast('manual')
  };
}
