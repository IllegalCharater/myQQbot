// 历史策略只决定读取长度，不接收当前消息、窗口、响应原因或随机数。
import type { HistoryPolicyResult } from './types.js';

export function resolveHistoryPolicy({ historyCount }: { historyCount: unknown }): HistoryPolicyResult {
  return { historyCount: Math.max(0, Number(historyCount) || 0) };
}
