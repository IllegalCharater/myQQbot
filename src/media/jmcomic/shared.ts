// 漫画能力的常量表与三个小助手。
//
// 常量全部写在这里而不是散在用时的地方：它们是**这条路自己的调节旋钮**（重试退避、超时、
// 缓存清理节奏、去重窗口），改任何一条都等于改行为，集中在眼皮底下才好比对。
//
// `isRecord` / `errorMessage` / `errorCode` 是三个三行助手 —— 与仓库其它模块的处理一致
// （`qq/onebot.ts` 里那个同名 `isRecord` 也没有导出，需要它的模块自己写三行）。

import path from 'node:path';
import { DATA_DIR } from '../../core/config.js';

export const DUPLICATE_WINDOW_MS = 10 * 60_000;
export const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
export const UPLOAD_TIMEOUT_MS = 30 * 60_000;
export const INACTIVITY_TIMEOUT_MS = 5 * 60_000;
export const RESULT_PREFIX = '__QQ_AGENT_RESULT__';
export const JM_DIR = path.join(DATA_DIR, 'jmcomic');
export const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads', 'jmcomic');
export const JOBS_FILE = path.join(JM_DIR, 'jobs.json');
export const LOG_DIR = path.join(JM_DIR, 'logs');
export const CLEANUP_STATE_FILE = path.join(JM_DIR, 'cleanup-state.json');
export const CACHE_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
export const CACHE_CLEANUP_CHECK_MS = 60 * 60_000;
export const DOWNLOAD_RETRY_MS = [5_000, 30_000, 120_000];
// 上传请求一旦发出，超时/断线只表示“客户端没拿到结果”，不表示 QQ 没收到文件。
// 首次核验前等 30 秒，随后逐步拉长；整个过程只查群文件列表，绝不盲目重传。
export const UPLOAD_VERIFY_RETRY_MS = [30_000, 60_000, 120_000, 300_000];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string {
  return isRecord(error) ? String(error.code ?? '') : '';
}
