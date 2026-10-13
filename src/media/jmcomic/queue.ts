// 队列本体：注册表（`media/task-queue.ts`）、任务表落盘、缓存清理、唤醒调度与三个入口。
//
// 队列的机械部分（单并发、登记、中止与关停语义）在 `media/task-queue.ts`，三个能力共用。
// 这里给的是**这条路自己的**三件东西：
//   · `execute` —— 按 `job.status` 分发到三个阶段（与旧 `runWorker` 的循环体逐字同义）；
//   · `next` / `nextDelay` —— 按 `nextAttemptAt` **时间门控**（这是漫画与转写/出图最大的不同：
//     那两个是"立刻排空"，这里是"到点再来"），并且在这里表达"已停就不再取活"；
//   · `onChange` → `saveJobs()` —— 任务一有变化就落盘（持久化是这条路独有的）。
//
// `onSuccess` 是**空实现**，这是刻意的：`execute` 只跑**一个阶段**，正常返回可能意味着
// "回去排队等下一次重试"，绝不能被核心记成完成（默认实现会置 `done`）。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from '../../core/config.js';
import { TaskQueue } from '../task-queue.js';
import { setRuntime, getRuntime, isLoaded, markLoaded } from './runtime.js';
import {
  bindPersist, updateJob, isPending, commandKey, duplicateAnchorAt, normalizeJob,
  lastCleanupAt, saveCleanupAt, ensureDirs
} from './jobs.js';
import { downloadStage, uploadStage, uploadUncertainStage } from './stages.js';
import {
  errorCode, errorMessage, isRecord, UPLOAD_VERIFY_RETRY_MS, CACHE_CLEANUP_CHECK_MS, CACHE_CLEANUP_INTERVAL_MS,
  JM_DIR, LOG_DIR, DOWNLOAD_DIR, JOBS_FILE, CLEANUP_STATE_FILE, DUPLICATE_WINDOW_MS
} from './shared.js';
import type { JmContext, JmJob, JmRuntime } from './types.js';

/**
 * 队列的机械部分（单并发、登记、中止与关停语义）在 `media/task-queue.ts`，三个能力共用。
 * 这里给的是**这条路自己的**三件东西：
 *   · `execute` —— 按 `job.status` 分发到三个阶段（与旧 `runWorker` 的循环体逐字同义）；
 *   · `next` / `nextDelay` —— 按 `nextAttemptAt` **时间门控**（这是漫画与转写/出图最大的不同：
 *     那两个是"立刻排空"，这里是"到点再来"），并且在这里表达"已停就不再取活"；
 *   · `onChange` → `saveJobs()` —— 任务一有变化就落盘（持久化是这条路独有的）。
 *
 * `onSuccess` 是**空实现**，这是刻意的：`execute` 只跑**一个阶段**，正常返回可能意味着
 * "回去排队等下一次重试"，绝不能被核心记成完成（默认实现会置 `done`）。
 */
const taskQueue = new TaskQueue<JmJob, void>({
  getConfig,
  resolveConfig: () => undefined,
  execute: async (job) => {
    if (job.status === 'queued' || job.status === 'downloading') await downloadStage(job);
    else if (job.status === 'upload_uncertain' || job.status === 'upload_failed') await uploadUncertainStage(job);
    else await uploadStage(job);
  },
  // 三个阶段**自己不抛**（失败在阶段内部就落成终局状态 + 回流了），所以这里到不了。
  onError: (job, error) => { console.warn(`[jmcomic] 任务 ${job.id} 出错:`, errorMessage(error)); },
  onSuccess: () => {},
  onChange: () => { if (isLoaded()) saveJobs(); },
  next: (jobs) => (
    // `runtime` 是"停之后就不要再取活"的第二道闸门：stop 发生在某个任务中途时，
    // 光靠时间门控会把后面所有**已经可跑**的任务接着做完，stop 等于打折。
    // ⚠️ 这道闸门**没有守护**（`tests/t-timers.mjs` 覆盖不到，已实测）：要观察到它的差别
    //    需要夹具里同时有"可跑的任务 A（在它的上传回调里停队列）"和"可跑的任务 B"，
    //    而夹具任务会留在内存里过继给套件的后面几段（会去碰真 onebot）。所以这里保持
    //    "对的写法"，改它不会有测试变红。
    getRuntime()
      ? jobs.find((job) => isPending(job) && job.nextAttemptAt !== null && Number(job.nextAttemptAt || 0) <= Date.now())
      : undefined
  ),
  nextDelay: (jobs) => {
    const times = jobs.filter(isPending)
      .map((job) => Number(job.nextAttemptAt || 0))
      .filter((time) => time > Date.now());
    return times.length ? Math.max(100, Math.min(...times) - Date.now()) : null;
  },
  // 漫画没有对外任务视图（面板不读它），但核心要一个 —— 给最小的一份。
  projectView: ({ id, comicId, chatKey, status, createdAt, updatedAt }) =>
    ({ id, comicId, chatKey, status, createdAt, updatedAt })
});

let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function saveJobs() {
  ensureDirs();
  const tmp = `${JOBS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs: taskQueue.all() }, null, 2), 'utf8');
  fs.renameSync(tmp, JOBS_FILE);
}

// **必须绑**：数据层的 updateJob 靠它落盘（见 jobs.ts 的 bindPersist）。少了这一行，
// 任务状态照改不误、jobs.json 却永远不更新 —— 重启后一切回到最后一次真落盘的样子，
// 而且不会有任何报错（t-jmcomic 那些读盘断言就是为了让它不会静默）。
bindPersist(saveJobs);


function cleanupDownloadCacheIfDue() {
  const now = Date.now();
  if (now - lastCleanupAt() < CACHE_CLEANUP_INTERVAL_MS) return;
  // 下载和上传共用 DOWNLOAD_DIR；只在整个队列空闲时清理，避免删除正在使用的文件。
  if (taskQueue.draining || taskQueue.all().some(isPending)) return;

  try {
    fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    taskQueue.clear();
    ensureDirs();
    saveJobs();
    saveCleanupAt(now);
    console.info('[jmcomic] 已定时清空全部漫画文件、任务记录和任务日志');
  } catch (error) {
    console.warn('[jmcomic] 定时清理漫画缓存失败:', errorMessage(error));
  }
}

function startCleanupTimer() {
  if (cleanupTimer) return;
  cleanupDownloadCacheIfDue();
  cleanupTimer = setInterval(cleanupDownloadCacheIfDue, CACHE_CLEANUP_CHECK_MS);
  cleanupTimer.unref?.();
}

function loadJobs() {
  if (isLoaded()) return;
  markLoaded();
  ensureDirs();
  let restored: JmJob[] = [];
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(raw);
    restored = isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs.map(normalizeJob).filter((job): job is JmJob => job !== null) : [];
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') console.warn('[jmcomic] 任务文件读取失败，将使用空队列:', errorMessage(error));
  }
  let changed = false;
  for (const job of restored) {
    if (job.status === 'downloading') {
      job.status = 'queued';
      job.nextAttemptAt = Date.now();
      changed = true;
    } else if (job.status === 'uploading' || job.status === 'upload_failed') {
      // 进程退出或旧版自动重试留下的上传状态都是“结果未知”：QQ/SnowLuma 可能已经
      // 收到文件。恢复后只能核验，不能重新执行非幂等的 upload_*_file。
      job.status = 'upload_uncertain';
      job.uploadVerifyAttempts = Number(job.uploadVerifyAttempts || 0);
      job.nextAttemptAt = Date.now() + UPLOAD_VERIFY_RETRY_MS[0];
      changed = true;
    }
  }
  // 登记进核心（`add` 会触发 onChange → saveJobs；`loaded` 已置真，所以是一次真落盘）。
  for (const job of restored) taskQueue.add(job);
  if (changed) saveJobs();
}


function scheduleNextWake() {
  // 队列已停（stopJmcomicQueue 把 runtime 置空）：不许再排新的唤醒。
  // 这条守卫是"停得住"的关键 —— `runWorker` 的收尾会调到这里，
  // 下载途中停队列时它本来会立刻排一个新 timer 把队列自己复活。
  if (!getRuntime()) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  const delay = taskQueue.idleDelay();
  if (delay === null) return;
  wakeTimer = setTimeout(() => void runWorker(), delay);
}

async function runWorker() {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  // 计时器归本文件（见 `scheduleNextWake`）：核心只回答"有没有活、下一次等多久"。
  await taskQueue.drain(() => !getRuntime());
  scheduleNextWake();
}

/** 绑定运行时依赖，并恢复上次退出时未完成的任务。可重复调用。 */
export function initJmcomicQueue({ onebot, sender, store, spawnProcess, onCompleted }: JmRuntime) {
  setRuntime({ onebot, sender, store, ...(spawnProcess ? { spawnProcess } : {}), ...(onCompleted ? { onCompleted } : {}) });
  loadJobs();
  startCleanupTimer();
  void runWorker();
}

/**
 * 停止队列：解绑运行时依赖并清掉两个计时器。幂等。
 *
 * 由 `app.stop()` 在 `onebot.close()` **之前**调用（上传阶段还要用 onebot.call）。
 *
 * 语义说明（三处都不是随手的选择）：
 *   - **只置空 `runtime`，不新增 `stopped` 标志位**。`runtime` 早就是"队列挂在活着的
 *     app 上"的既有语义（`runWorker` 的 `!runtime`、`enqueueJmcomicDownload` 的懒初始化
 *     都在判它），只是此前从没人把它置回 null。用标志位的话，stop 之后的一次 enqueue
 *     会"只入库不干活"——工具回复"已加入队列"而队列永远不动，直到下次重启；
 *     置空 runtime 则保留既有不变量：stop 之后再来一次 enqueue 会重新拉起队列
 *     （工具至少说的是真话）。代价是"stop 可被一次 enqueue 撤销"——而 stop 只在退出
 *     路径上被调用，那时 `abortAll()` 已跑完、不会再产生新的模型轮次，现实中到不了。
 *   - **不清 `jobs`**：队列是持久化的，清了会丢掉用户已提交的下载任务。
 *   - **不中断正在跑的那一次下载**：Python 子进程句柄是 `runPython` 的 promise 局部变量，
 *     模块外拿不到。`runtime` 置空后它在收尾阶段会退化成空操作（各处都是 `getRuntime()?.`），
 *     本次下载的结果因此不会被发送出去。
 */
export function stopJmcomicQueue() {
  setRuntime(null);
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
  if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
}

export function enqueueJmcomicDownload(ctx: JmContext, comicId: unknown) {
  loadJobs();
  if (!getRuntime()) initJmcomicQueue({ onebot: ctx.onebot, sender: ctx.sender, store: ctx.store });
  const id = String(comicId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('漫画ID必须是 1 至 20 位数字');

  const now = Date.now();
  const key = commandKey(ctx.requesterId, id);
  if (taskQueue.all().find((job) => job.key === key && isPending(job))) throw new Error(`漫画 ${id} 已在队列中或正在处理，请等待完成`);
  // 已完成的任务**仍然在 `jobs` 里**（见 cleanupCompletedJob），所以这条窗口也管得住
  // "刚拿到 PDF 又提交一次"——那正是最常发生的重复。
  const recent = [...taskQueue.all()].reverse().find((job) => job.key === key);
  const elapsed = recent ? now - duplicateAnchorAt(recent) : Number.POSITIVE_INFINITY;
  if (elapsed < DUPLICATE_WINDOW_MS) {
    const seconds = Math.ceil((DUPLICATE_WINDOW_MS - elapsed) / 1000);
    throw new Error(`同一用户短时间内不能重复提交漫画 ${id}，请 ${seconds} 秒后再试`);
  }

  const waitingBefore = taskQueue.all().filter((job) => isPending(job)).length;
  const job: JmJob = {
    id: `jm_${id}_${now}_${Math.random().toString(36).slice(2, 8)}`,
    key, comicId: id, requesterId: String(ctx.requesterId || ''), kind: ctx.kind,
    chatId: String(ctx.chatId), chatKey: ctx.chatKey, status: 'queued',
    downloadAttempts: 0, uploadAttempts: 0, pdfPath: '', lastError: '',
    nextAttemptAt: now, createdAt: now, updatedAt: now
  };
  taskQueue.add(job);
  saveJobs();
  void runWorker();
  return { queued: true, jobId: job.id, comicId: id, position: waitingBefore + 1 };
}

// ── 按关键词 / tag 搜索漫画（只搜索，不下载）────────────────────────────────
//
// **为什么是一个独立函数而不是给下载加参数**：搜索是廉价的只读操作，下载要过页数检查、
// 拉全部图片、导出 PDF、上传群文件（30 分钟超时、不可撤销）。合成一个动作就等于
// "模型猜一个关键词"触发一次完整下载。这里**只返回条目**，要不要下载由模型看过结果后
// 再单独调 `enqueueJmcomicDownload` 决定 —— 与"工具不得代模型发言"是同一条取舍：
// 工具只提供事实，动作由模型在这一次运行里自己选。

/**
 * 解析 `/漫画 <漫画ID>` 命令：返回漫画 ID，**不是这条命令**时返回 `null`。
 *
 * 与 `/转写`、`/画` 同一个分工：**命令自己的语法留在领域模块里**，接入层的命令表
 * （`web/onebot/slash-commands.ts`）只负责"认出是哪条命令、按什么顺序处理、回不回执"。
 * 认命令要求 `/漫画` 后面跟空白或直接结束（`/漫画xx` 不是这条命令）。
 *
 * 只做"有没有写 ID"这一层；**ID 的格式校验仍在 `enqueueJmcomicDownload` 里**
 * （`^\d{1,20}$`）—— 那条判据只有一处，免得两处各写一份、日后漂移。
 */
