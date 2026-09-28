import type { Route } from '../types.js';
import { usageRoutes } from './usage.js';
import { sessionRoutes } from './sessions.js';
import { configRoutes } from './config.js';
import { systemRoutes } from './system.js';
import { providerRoutes } from './providers.js';
import { chatRoutes } from './chats.js';
import { memoryRoutes } from './memory.js';
import { stickerRoutes } from './stickers.js';
import { hotSearchRoutes } from './hot-search.js';

// 顺序就是匹配优先级；新增正则路由时必须把更具体的路径放在前面。
export const routes: readonly Route[] = [
  ...hotSearchRoutes,
  ...usageRoutes,
  ...sessionRoutes,
  ...configRoutes,
  ...systemRoutes,
  ...providerRoutes,
  ...chatRoutes,
  ...memoryRoutes,
  ...stickerRoutes,
];
