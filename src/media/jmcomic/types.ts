// 漫画能力的共享类型。
//
// 这一层**不 import 本模块任何文件**（同 transcription/image-gen 的 types.ts）：它是所有别的
// 文件的公共依赖，一旦反向依赖就会成环。常量表在 `shared.ts`，不在这里。

import type { spawn } from 'node:child_process';
import type { OutgoingMedia } from '../../core/outgoing-media.js';

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
  /** 当前阶段真正开始的时刻（进度提示的锚点，不含排队时间）。 */
  progressAnchorAt?: number;
  /** 已经发过进度提示的时刻；有值表示这次任务不再发第二条。 */
  progressNotifiedAt?: number;
  /** 晚到文件观察窗的截止时刻；缺省 = 没在观察。 */
  lateWatchUntil?: number;
  /** 是否已经向模型报过"未确认"（晚到完成时用它决定文案是补记还是首次）。 */
  terminalNotified?: boolean;
  /**
   * 上传那一次失败的原因（`upload_*_file` 抛出来的原文）。
   *
   * ⚠️ 它必须与 `lastError` 分开存：核验阶段会把 `lastError` 更新成"没确认到"，
   * 而调查"为什么没传上去"要看的正是这里 —— 覆盖掉之后，管理员与模型都只剩一句
   * "未确认"，真实原因（retcode / 超时 / 文件不存在）就永久丢了。
   */
  uploadError?: string;
  /**
   * 是否**至少成功取到过一次**核验列表。
   *
   * 它决定最终那句话怎么说：`true` = "查过了，列表里没有"；`false` = "根本没法查
   * （协议端取列表失败）"。两者不能压成同一句 —— 那正是仓库里"没搜到 vs 搜索坏了"
   * 那条教训。
   */
  verifyLooked?: boolean;
  /** 最近一次取核验列表失败的原因（成功取到后清空）。 */
  verifyError?: string;
  uploadedFileId?: string;
  completionSource?: 'response' | 'group-file-check' | 'private-history-check' | 'late-watch';
}

export interface JmRuntime {
  onebot: { call(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };
  sender: { sendTextBatch(chatKey: string, messages: unknown[]): Promise<unknown> };
  store: { appendSelf(chatKey: string, input: { text: unknown; ts?: number; mid?: string | number | null; media?: OutgoingMedia[] }): unknown };
  /** 测试可注入假子进程；生产环境缺省使用 node:child_process.spawn。 */
  spawnProcess?: typeof spawn;
  /** PDF 已被 OneBot 明确接收后，把完成事实回流给 Agent。 */
  onCompleted?: JmcomicCompletionSink;
  /**
   * 长任务进度（5 分钟仍未结束）：把一条**未读机器条目**送进会话，由模型决定要不要说。
   * 缺省 = 不发（测试/未接线宿主）。宿主必须自己兜住异常 —— 进度是旁路，不能影响任务。
   */
  onProgress?: JmcomicProgressSink;
}

/** 一次进度提示的结构化事实。`text` 已由队列按阶段拼好，宿主只负责落库/入窗。 */
export interface JmcomicProgress {
  chatKey: string;
  comicId: string;
  /** 人话阶段：下载中 / 上传中 / 核验上传结果。 */
  stage: string;
  elapsedMs: number;
  text: string;
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
  source: 'response' | 'group-file-check' | 'private-history-check' | 'late-watch';
  /** 成功路径才有（失败时没有文件 ID）。 */
  fileId?: string;
  /**
   * 只有 `sent` 用它：这条是**晚到补记**（之前报过未确认，现在在群文件里找到了）。
   * 文案要说清是补记，否则模型会与上一句"未确认"矛盾。
   */
  late?: boolean;
  /**
   * 三态结局（与出图那条**逐字同值**，见 `chat/types.ts` 的 `AsyncResultStatus`）：
   * `sent` = PDF 已上传并被确认；`unsent` = 上传结果**未确认**（可能没发出去，也可能
   * 已经在群里）；`failed` = 没完成（`stage` 说明是下载还是上传）。
   *
   * ⚠️ **失败也走同一条回流通道**（2026-10-10 统一）：队列不再代模型往群里贴 ❌/⚠️ 文案，
   * 而是让模型自己交代 —— 它才是刚对群友说过"我去下了"的那个人（同出图那条的理由）。
   */
  status?: JmcomicStatus;
  /**
   * 只有 `failed` 用它：区分"没下成"与"下载好了、但上传失败"。
   *
   * 缺省 `download`（旧调用点与旧存档都按它解释）。
   */
  stage?: 'download' | 'upload';
  /** `failed` / `unsent` 时给模型看的原因（一句话）。 */
  reason?: string;
}

/** 漫画下载结果的三态。**取值与 `chat/types.ts` 的 `AsyncResultStatus` 逐字一致**（跨层不能互相 import）。 */
export type JmcomicStatus = 'sent' | 'unsent' | 'failed';

export type JmcomicCompletionSink = (input: JmcomicCompletion) => void | Promise<void>;
export type JmcomicProgressSink = (input: JmcomicProgress) => void | Promise<void>;

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
