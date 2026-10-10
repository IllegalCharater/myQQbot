// 任务的数据层：形状归一化、落盘、以及"这条任务算不算待办"那几个判据。
//
// **不含注册表**（那在 `queue.ts`）：本文件里的函数只接受/返回单个任务对象。
// 唯一一处例外是 `updateJob` 要落盘，而落盘需要完整任务表 —— 用一次性绑定
// （`bindPersist`，与 `runtime.ts` 同一手法）把环断开。

import fs from 'node:fs';
import path from 'node:path';
import {
  errorCode, errorMessage, isRecord,
  DUPLICATE_WINDOW_MS, JM_DIR, LOG_DIR, DOWNLOAD_DIR, CLEANUP_STATE_FILE
} from './shared.js';
import type { JmJob, JobStatus } from './types.js';

/**
 * 落盘回调。由 `queue.ts` 在装载时绑一次 —— 只有它知道完整任务表（注册表在那边）。
 * 绑之前是空操作：**没装载过就不许落盘**，否则会用空表覆盖真文件。
 */
let persist: () => void = () => {};
export function bindPersist(fn: () => void): void { persist = fn; }

/** 立刻落盘一次（子进程心跳这类"不改状态但要留痕"的地方用）。 */
export function persistNow(): void { persist(); }

export function normalizeJob(value: unknown): JmJob | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.comicId !== 'string') return null;
  const status = String(value.status ?? 'queued') as JobStatus;
  return {
    id: value.id,
    key: String(value.key ?? ''), comicId: value.comicId, requesterId: String(value.requesterId ?? ''),
    kind: String(value.kind ?? ''), chatId: String(value.chatId ?? ''), chatKey: String(value.chatKey ?? ''), status,
    downloadAttempts: Number(value.downloadAttempts ?? 0), uploadAttempts: Number(value.uploadAttempts ?? 0),
    pdfPath: String(value.pdfPath ?? ''), lastError: String(value.lastError ?? ''),
    nextAttemptAt: value.nextAttemptAt === null ? null : Number(value.nextAttemptAt ?? 0),
    createdAt: Number(value.createdAt ?? 0), updatedAt: Number(value.updatedAt ?? 0),
    ...(typeof value.heartbeatAt === 'number' ? { heartbeatAt: value.heartbeatAt } : {}),
    ...(typeof value.downloadedAt === 'number' ? { downloadedAt: value.downloadedAt } : {}),
    ...(typeof value.failedAt === 'number' ? { failedAt: value.failedAt } : {}),
    ...(typeof value.uploadedAt === 'number' ? { uploadedAt: value.uploadedAt } : {}),
    ...(typeof value.cached === 'boolean' ? { cached: value.cached } : {}),
    ...(typeof value.uploadStartedAt === 'number' ? { uploadStartedAt: value.uploadStartedAt } : {}),
    ...(typeof value.uploadVerifyAttempts === 'number' ? { uploadVerifyAttempts: value.uploadVerifyAttempts } : {}),
    ...(typeof value.uploadedFileId === 'string' ? { uploadedFileId: value.uploadedFileId } : {}),
    ...(value.completionSource === 'response' || value.completionSource === 'group-file-check' || value.completionSource === 'private-history-check'
      ? { completionSource: value.completionSource } : {})
  };
}

export function ensureDirs() {
  fs.mkdirSync(JM_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}


export function lastCleanupAt(): number {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(CLEANUP_STATE_FILE, 'utf8'));
    return isRecord(value) ? Number(value.lastCleanupAt || 0) : 0;
  } catch {
    return 0;
  }
}

export function saveCleanupAt(timestamp: number) {
  ensureDirs();
  const tmp = `${CLEANUP_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ lastCleanupAt: timestamp }, null, 2), 'utf8');
  fs.renameSync(tmp, CLEANUP_STATE_FILE);
}


export function updateJob(job: JmJob, patch: Partial<JmJob>) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  persist();
}

/**
 * 已完成任务的收尾：**只删日志，不把记录从 `jobs` 里摘掉**。
 *
 * 记录必须留着，否则去重对"下载成功过"的漫画等于不存在：`enqueueJmcomicDownload` 的两道闸门
 * 都以 `jobs` 为数据源，成功即摘记录的话，用户拿到 PDF 后立刻再说一次就会建出第二条任务 ——
 * Python 命中本地缓存后很快再上传一次 PDF，可以反复刷。记录改由每日清理
 * （`cleanupDownloadCacheIfDue` 里的 `jobs = []`）统一收走。
 *
 * 已完成状态留在磁盘上是安全的：`loadJobs()` 只把 `downloading`/`uploading` 复位成待跑，
 * `completed` 原样保留，重启后不会被重新上传。
 */
export function cleanupCompletedJob(job: JmJob) {
  try {
    fs.rmSync(path.join(LOG_DIR, `${job.id}.log`), { force: true });
  } catch (error) {
    // completed 状态已经在盘上，残留日志不会导致已上传文件被重复发送。
    console.warn(`[jmcomic] 已完成任务 ${job.id} 的日志删除失败:`, errorMessage(error));
  }
}

export function isPending(job: JmJob): boolean {
  return ['queued', 'downloading', 'downloaded', 'uploading', 'upload_uncertain', 'upload_failed'].includes(job.status);
}

export function commandKey(requesterId: unknown, comicId: string): string {
  return `${requesterId || 'unknown'}:${comicId}`;
}

export function jobKind(job: JmJob): 'group' | 'private' {
  const fromKey = String(job.chatKey || '').split(':', 1)[0];
  if (fromKey === 'group' || fromKey === 'private') return fromKey;
  return job.kind === 'group' ? 'group' : 'private';
}

/**
 * 去重窗口的计时起点：已完成的任务从**上传完成时刻**算起，其余从创建时刻算起。
 * 只看 `createdAt` 的话，一次"下载 + 上传"耗时超过窗口的任务在上传完成的当刻就已经过期，
 * 防重对最常发生的那一类重复（刚拿到 PDF 又提交一次）形同虚设。
 */
export function duplicateAnchorAt(job: JmJob): number {
  return Number(job.uploadedAt || job.createdAt || 0);
}

