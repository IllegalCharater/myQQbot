// 漫画能力的共享类型。
//
// 这一层**不 import 本模块任何文件**（同 transcription/image-gen 的 types.ts）：它是所有别的
// 文件的公共依赖，一旦反向依赖就会成环。常量表在 `shared.ts`，不在这里。

import type { spawn } from 'node:child_process';

export type JobStatus = 'queued' | 'downloading' | 'downloaded' | 'uploading' | 'upload_uncertain' | 'upload_failed' | 'failed' | 'completed';

export interface JmJob {
  id: string;
  key: string;
  comicId: string;
  requesterId: string;
  kind: string;
  chatId: string;
  chatKey: string;
  status: JobStatus;
  downloadAttempts: number;
  uploadAttempts: number;
  pdfPath: string;
  lastError: string;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  heartbeatAt?: number;
  downloadedAt?: number;
  failedAt?: number;
  uploadedAt?: number;
  cached?: boolean;
  uploadStartedAt?: number;
  uploadVerifyAttempts?: number;
  uploadedFileId?: string;
  completionSource?: 'response' | 'group-file-check' | 'private-history-check';
}

export interface JmRuntime {
  onebot: { call(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };
  sender: { sendTextBatch(chatKey: string, messages: unknown[]): Promise<unknown> };
  store: { appendSelf(chatKey: string, input: { text: unknown; ts?: number; mid?: string | number | null }): unknown };
  /** 测试可注入假子进程；生产环境缺省使用 node:child_process.spawn。 */
  spawnProcess?: typeof spawn;
  /** PDF 已被 OneBot 明确接收后，把完成事实回流给 Agent。 */
  onCompleted?: JmcomicCompletionSink;
}

export interface JmContext extends JmRuntime {
  requesterId: string | number;
  kind: string;
  chatId: string | number;
  chatKey: string;
}

export interface PythonResult {
  ok: true;
  pdfPath: string;
  cached?: boolean;
  [key: string]: unknown;
}

export interface JmcomicCompletion {
  chatKey: string;
  comicId: string;
  cached: boolean;
  source: 'response' | 'group-file-check' | 'private-history-check';
  /** 成功路径才有（失败时没有文件 ID）。 */
  fileId?: string;
  /**
   * 三态结局（与出图那条**逐字同值**，见 `chat/types.ts` 的 `AsyncResultStatus`）：
   * `sent` = PDF 已上传并被确认；`unsent` = 发出去了但**没能确认**（**可能已经在群里**）；
   * `failed` = 没下成。
   *
   * ⚠️ **失败也走同一条回流通道**（2026-10-10 统一）：队列不再代模型往群里贴 ❌/⚠️ 文案，
   * 而是让模型自己交代 —— 它才是刚对群友说过"我去下了"的那个人（同出图那条的理由）。
   */
  status?: JmcomicStatus;
  /** `failed` / `unsent` 时给模型看的原因（一句话）。 */
  reason?: string;
}

/** 漫画下载结果的三态。**取值与 `chat/types.ts` 的 `AsyncResultStatus` 逐字一致**（跨层不能互相 import）。 */
export type JmcomicStatus = 'sent' | 'unsent' | 'failed';

export type JmcomicCompletionSink = (input: JmcomicCompletion) => void | Promise<void>;

export type JmSearchMode = 'keyword' | 'tag' | 'author' | 'work' | 'actor';

/** 排序方式。与 Python 侧 `ORDER_BY_CHOICES` 的键一一对应（**不是**直接透传库的魔法值）。 */
export type JmSearchOrder = 'latest' | 'view' | 'picture' | 'like' | 'score' | 'comment';

export interface JmSearchItem {
  comicId: string;
  title: string;
  tags: string[];
}

export interface JmSearchOutput {
  mode: JmSearchMode;
  query: string;
  orderBy: JmSearchOrder;
  page: number;
  total: number;
  items: JmSearchItem[];
}
