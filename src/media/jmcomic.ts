import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT } from '../core/config.js';

const DUPLICATE_WINDOW_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const UPLOAD_TIMEOUT_MS = 30 * 60_000;
const INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const RESULT_PREFIX = '__QQ_AGENT_RESULT__';
const SCRIPT_PATH = path.join(ROOT, 'python-tools', 'jmcomic_download.py');
const JM_DIR = path.join(DATA_DIR, 'jmcomic');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads', 'jmcomic');
const JOBS_FILE = path.join(JM_DIR, 'jobs.json');
const LOG_DIR = path.join(JM_DIR, 'logs');
const CLEANUP_STATE_FILE = path.join(JM_DIR, 'cleanup-state.json');
const CACHE_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
const CACHE_CLEANUP_CHECK_MS = 60 * 60_000;
const DOWNLOAD_RETRY_MS = [5_000, 30_000, 120_000];
// 上传请求一旦发出，超时/断线只表示“客户端没拿到结果”，不表示 QQ 没收到文件。
// 首次核验前等 30 秒，随后逐步拉长；整个过程只查群文件列表，绝不盲目重传。
const UPLOAD_VERIFY_RETRY_MS = [30_000, 60_000, 120_000, 300_000];

type JobStatus = 'queued' | 'downloading' | 'downloaded' | 'uploading' | 'upload_uncertain' | 'upload_failed' | 'failed' | 'completed';

interface JmJob {
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

interface JmRuntime {
  onebot: { call(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> };
  sender: { sendTextBatch(chatKey: string, messages: unknown[]): Promise<unknown> };
  store: { appendSelf(chatKey: string, input: { text: unknown; ts?: number; mid?: string | number | null }): unknown };
}

interface JmContext extends JmRuntime {
  requesterId: string | number;
  kind: string;
  chatId: string | number;
  chatKey: string;
}

interface PythonResult {
  ok: true;
  pdfPath: string;
  cached?: boolean;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return isRecord(error) ? String(error.code ?? '') : '';
}

function normalizeJob(value: unknown): JmJob | null {
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

let runtime: JmRuntime | null = null;
let jobs: JmJob[] = [];
let loaded = false;
let workerRunning = false;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureDirs() {
  fs.mkdirSync(JM_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function saveJobs() {
  ensureDirs();
  const tmp = `${JOBS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs }, null, 2), 'utf8');
  fs.renameSync(tmp, JOBS_FILE);
}

function lastCleanupAt(): number {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(CLEANUP_STATE_FILE, 'utf8'));
    return isRecord(value) ? Number(value.lastCleanupAt || 0) : 0;
  } catch {
    return 0;
  }
}

function saveCleanupAt(timestamp: number) {
  ensureDirs();
  const tmp = `${CLEANUP_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ lastCleanupAt: timestamp }, null, 2), 'utf8');
  fs.renameSync(tmp, CLEANUP_STATE_FILE);
}

function cleanupDownloadCacheIfDue() {
  const now = Date.now();
  if (now - lastCleanupAt() < CACHE_CLEANUP_INTERVAL_MS) return;
  // 下载和上传共用 DOWNLOAD_DIR；只在整个队列空闲时清理，避免删除正在使用的文件。
  if (workerRunning || jobs.some(isPending)) return;

  try {
    fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
    fs.rmSync(LOG_DIR, { recursive: true, force: true });
    jobs = [];
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
  if (loaded) return;
  loaded = true;
  ensureDirs();
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(raw);
    jobs = isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs.map(normalizeJob).filter((job): job is JmJob => job !== null) : [];
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') console.warn('[jmcomic] 任务文件读取失败，将使用空队列:', errorMessage(error));
    jobs = [];
  }
  let changed = false;
  for (const job of jobs) {
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
  if (changed) saveJobs();
}

function updateJob(job: JmJob, patch: Partial<JmJob>) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  saveJobs();
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
function cleanupCompletedJob(job: JmJob) {
  try {
    fs.rmSync(path.join(LOG_DIR, `${job.id}.log`), { force: true });
  } catch (error) {
    // completed 状态已经在盘上，残留日志不会导致已上传文件被重复发送。
    console.warn(`[jmcomic] 已完成任务 ${job.id} 的日志删除失败:`, errorMessage(error));
  }
}

function isPending(job: JmJob): boolean {
  return ['queued', 'downloading', 'downloaded', 'uploading', 'upload_uncertain', 'upload_failed'].includes(job.status);
}

function commandKey(requesterId: unknown, comicId: string): string {
  return `${requesterId || 'unknown'}:${comicId}`;
}

function jobKind(job: JmJob): 'group' | 'private' {
  const fromKey = String(job.chatKey || '').split(':', 1)[0];
  if (fromKey === 'group' || fromKey === 'private') return fromKey;
  return job.kind === 'group' ? 'group' : 'private';
}

/**
 * 去重窗口的计时起点：已完成的任务从**上传完成时刻**算起，其余从创建时刻算起。
 * 只看 `createdAt` 的话，一次"下载 + 上传"耗时超过窗口的任务在上传完成的当刻就已经过期，
 * 防重对最常发生的那一类重复（刚拿到 PDF 又提交一次）形同虚设。
 */
function duplicateAnchorAt(job: JmJob): number {
  return Number(job.uploadedAt || job.createdAt || 0);
}

function pythonCommand() {
  if (process.env.JMCOMIC_PYTHON) return { command: process.env.JMCOMIC_PYTHON, prefix: [] };
  if (process.platform === 'win32') {
    const direct = 'E:\\anaconda\\envs\\my_bot\\python.exe';
    if (fs.existsSync(direct)) return { command: direct, prefix: [] };
    return { command: 'conda.exe', prefix: ['run', '--no-capture-output', '-n', 'my_bot', 'python'] };
  }
  return { command: 'conda', prefix: ['run', '--no-capture-output', '-n', 'my_bot', 'python'] };
}

function validatePdf(pdfPath: unknown): string {
  const resolved = path.resolve(String(pdfPath || ''));
  const root = path.resolve(DOWNLOAD_DIR) + path.sep;
  if (!resolved.startsWith(root)) throw new Error('Python 返回的 PDF 路径越界');
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size < 1024) throw new Error('PDF 文件为空或不完整');
  const fd = fs.openSync(resolved, 'r');
  try {
    const header = Buffer.alloc(5);
    fs.readSync(fd, header, 0, 5, 0);
    if (header.toString('ascii') !== '%PDF-') throw new Error('生成文件不是有效 PDF');
  } finally {
    fs.closeSync(fd);
  }
  return resolved;
}

function runPython(job: JmJob): Promise<PythonResult> {
  ensureDirs();
  const { command, prefix } = pythonCommand();
  const logFile = path.join(LOG_DIR, `${job.id}.log`);
  return new Promise<PythonResult>((resolve, reject) => {
    const child = spawn(command, [...prefix, SCRIPT_PATH, job.comicId, DOWNLOAD_DIR], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPersistedHeartbeat = 0;

    const finish = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      fn(value);
    };
    const stop = (message: string) => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error(message));
    };
    const heartbeat = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('下载连续 5 分钟没有任何进度，已终止'), INACTIVITY_TIMEOUT_MS);
      const now = Date.now();
      if (now - lastPersistedHeartbeat >= 5_000) {
        lastPersistedHeartbeat = now;
        job.heartbeatAt = now;
        job.updatedAt = now;
        saveJobs();
      }
    };
    const appendLog = (chunk: Buffer) => {
      try { fs.appendFileSync(logFile, chunk); } catch { /* ignore */ }
      heartbeat();
    };

    child.stdout.on('data', (chunk) => {
      appendLog(chunk);
      stdout = (stdout + chunk.toString('utf8')).slice(-300_000);
    });
    child.stderr.on('data', (chunk) => {
      appendLog(chunk);
      stderr = (stderr + chunk.toString('utf8')).slice(-50_000);
    });
    child.on('error', (error) => finish(reject, new Error(`无法启动 my_bot Python：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      const line = stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(RESULT_PREFIX));
      let result: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = line ? JSON.parse(line.slice(RESULT_PREFIX.length)) : null;
        result = isRecord(parsed) ? parsed : null;
      } catch { /* handled below */ }
      if (code !== 0 || result?.ok !== true) {
        finish(reject, new Error(String(result?.error || stderr.trim() || `Python 异常退出（${code}）`)));
        return;
      }
      try {
        finish(resolve, { ...result, ok: true, pdfPath: validatePdf(result.pdfPath) });
      } catch (error) {
        finish(reject, error);
      }
    });
    heartbeat();
    hardTimer = setTimeout(() => stop('下载超过 30 分钟，已终止'), DOWNLOAD_TIMEOUT_MS);
  });
}

async function sendStatus(job: JmJob, message: string) {
  try {
    await runtime?.sender?.sendTextBatch(job.chatKey, [message]);
  } catch (error) {
    console.warn('[jmcomic] 状态消息发送失败:', errorMessage(error));
  }
}

async function downloadStage(job: JmJob) {
  const attempt = Number(job.downloadAttempts || 0) + 1;
  updateJob(job, { status: 'downloading', downloadAttempts: attempt, lastError: '', heartbeatAt: Date.now() });
  try {
    const result = await runPython(job);
    updateJob(job, {
      status: 'downloaded', pdfPath: result.pdfPath, cached: !!result.cached,
      downloadedAt: Date.now(), nextAttemptAt: Date.now(), lastError: ''
    });
  } catch (error) {
    const message = errorMessage(error);
    const forbidden = message.includes('禁止下载');
    const pageLimitExceeded = message.includes('超过单次下载上限');
    if (!forbidden && !pageLimitExceeded && attempt < DOWNLOAD_RETRY_MS.length) {
      updateJob(job, { status: 'queued', lastError: message, nextAttemptAt: Date.now() + DOWNLOAD_RETRY_MS[attempt - 1] });
      return;
    }
    updateJob(job, { status: 'failed', lastError: message, failedAt: Date.now(), nextAttemptAt: null });
    await sendStatus(job, forbidden || pageLimitExceeded ? `🚫 ${message}` : `❌ 下载失败：${message}`);
  }
}

function responseFileId(value: unknown): string {
  return isRecord(value) ? String(value.file_id ?? value.fileId ?? '') : '';
}

function completeUpload(job: JmJob, source: 'response' | 'group-file-check' | 'private-history-check', fileId = '') {
  // 从这里开始 OneBot 已明确返回成功，或群文件列表已经证明目标文件存在。
  // 任何本地收尾失败都不能再把任务放回上传路径。
  try {
    updateJob(job, {
      status: 'completed', uploadedAt: Date.now(), lastError: '', nextAttemptAt: null,
      completionSource: source, ...(fileId ? { uploadedFileId: fileId } : {})
    });
  } catch (error) {
    console.warn(`[jmcomic] 文件已上传，但完成状态写入失败（${job.id}）:`, errorMessage(error));
    return;
  }
  try {
    runtime?.store.appendSelf(job.chatKey, { text: `[文件:${job.comicId}.pdf]`, ts: Date.now(), mid: null });
  } catch (error) {
    console.warn(`[jmcomic] 文件已上传，但聊天存档写入失败（${job.id}）:`, errorMessage(error));
  }
  // 记录有意留着（去重靠它，见 cleanupCompletedJob 的说明），这里只删日志。
  cleanupCompletedJob(job);
}

function deferUploadVerification(job: JmJob, error: unknown) {
  updateJob(job, {
    status: 'upload_uncertain', lastError: errorMessage(error), uploadVerifyAttempts: 0,
    nextAttemptAt: Date.now() + UPLOAD_VERIFY_RETRY_MS[0]
  });
  console.warn(`[jmcomic] 上传结果未知，将先核验而不是自动重传（${job.id}）:`, errorMessage(error));
}

async function uploadStage(job: JmJob) {
  let pdfPath;
  try {
    pdfPath = validatePdf(job.pdfPath);
  } catch (error) {
    updateJob(job, { status: 'queued', pdfPath: '', downloadAttempts: 0, lastError: errorMessage(error), nextAttemptAt: Date.now() });
    return;
  }
  const attempt = Number(job.uploadAttempts || 0) + 1;
  updateJob(job, {
    status: 'uploading', uploadAttempts: attempt, uploadStartedAt: Date.now(),
    uploadVerifyAttempts: 0, lastError: ''
  });
  const kind = jobKind(job);
  const params = kind === 'group'
    ? { group_id: Number(job.chatId), file: pdfPath, name: `${job.comicId}.pdf` }
    : { user_id: Number(job.chatId), file: pdfPath, name: `${job.comicId}.pdf` };
  const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file';
  try {
    const result = await runtime?.onebot.call(action, params, UPLOAD_TIMEOUT_MS);
    completeUpload(job, 'response', responseFileId(result));
  } catch (error) {
    // upload_*_file 是非幂等动作。AbortError、断线乃至 HTTP 错误都不能证明服务端
    // 没有继续执行；统一进入“结果未知”，后续只核验，不重复发送。
    deferUploadVerification(job, error);
  }
}

function matchingGroupFile(value: unknown, job: JmJob, pdfPath: string): Record<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.files)) throw new Error('群文件列表返回格式无效');
  const expectedName = `${job.comicId}.pdf`;
  const expectedSize = fs.statSync(pdfPath).size;
  for (const item of value.files) {
    if (!isRecord(item)) continue;
    const name = String(item.file_name ?? item.fileName ?? '');
    const size = Number(item.file_size ?? item.fileSize ?? -1);
    if (name === expectedName && size === expectedSize) return item;
  }
  return null;
}

function matchingPrivateFile(value: unknown, job: JmJob, pdfPath: string): Record<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error('好友消息历史返回格式无效');
  const expectedName = `${job.comicId}.pdf`;
  const expectedSize = fs.statSync(pdfPath).size;
  for (const message of value.messages) {
    if (!isRecord(message) || !Array.isArray(message.message)) continue;
    for (const segment of message.message) {
      if (!isRecord(segment) || segment.type !== 'file' || !isRecord(segment.data)) continue;
      const data = segment.data;
      const name = String(data.name ?? data.file_name ?? data.fileName ?? data.file ?? '');
      const size = Number(data.file_size ?? data.fileSize ?? data.size ?? -1);
      if (name === expectedName && size === expectedSize) return data;
    }
  }
  return null;
}

async function uploadUncertainStage(job: JmJob) {
  let pdfPath: string;
  try {
    pdfPath = validatePdf(job.pdfPath);
  } catch (error) {
    updateJob(job, {
      status: 'failed', lastError: `无法核验已上传文件：${errorMessage(error)}`,
      failedAt: Date.now(), nextAttemptAt: null
    });
    await sendStatus(job, `❌ PDF 上传结果无法核验：${errorMessage(error)}`);
    return;
  }

  const verifyAttempt = Number(job.uploadVerifyAttempts || 0) + 1;
  const kind = jobKind(job);
  try {
    const result = kind === 'group'
      ? await runtime?.onebot.call('get_group_root_files', { group_id: Number(job.chatId) })
      : await runtime?.onebot.call('get_friend_msg_history', {
          user_id: Number(job.chatId), message_id: 0, count: 50, reverse_order: true
        });
    const found = kind === 'group'
      ? matchingGroupFile(result, job, pdfPath)
      : matchingPrivateFile(result, job, pdfPath);
    if (found) {
      completeUpload(job, kind === 'group' ? 'group-file-check' : 'private-history-check', responseFileId(found));
      console.info(`[jmcomic] 已通过${kind === 'group' ? '群文件列表' : '好友消息历史'}确认上传完成（${job.id}）`);
      return;
    }
  } catch (error) {
    console.warn(`[jmcomic] 第 ${verifyAttempt} 次核验群文件失败（${job.id}）:`, errorMessage(error));
  }

  const nextDelay = UPLOAD_VERIFY_RETRY_MS[verifyAttempt];
  if (nextDelay !== undefined) {
    updateJob(job, {
      status: 'upload_uncertain', uploadVerifyAttempts: verifyAttempt,
      nextAttemptAt: Date.now() + nextDelay
    });
    return;
  }

  const surface = kind === 'group' ? '群文件' : '私聊历史';
  const message = `连续 ${verifyAttempt} 次未在${surface}中确认到 ${job.comicId}.pdf；为避免重复发送，未自动重传`;
  updateJob(job, { status: 'failed', uploadVerifyAttempts: verifyAttempt, lastError: message, failedAt: Date.now(), nextAttemptAt: null });
  await sendStatus(job, `⚠️ ${message}，请检查${surface}后再决定是否重新提交。`);
}

function nextRunnableJob() {
  const now = Date.now();
  return jobs.find((job) => isPending(job) && job.nextAttemptAt !== null && Number(job.nextAttemptAt || 0) <= now) || null;
}

function scheduleNextWake() {
  // 队列已停（stopJmcomicQueue 把 runtime 置空）：不许再排新的唤醒。
  // 这条守卫是"停得住"的关键 —— runWorker 的 finally 会调到这里，
  // 下载途中停队列时它本来会立刻排一个新 timer 把队列自己复活。
  if (!runtime) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  const times = jobs.filter(isPending).map((job) => Number(job.nextAttemptAt || 0)).filter((time) => time > Date.now());
  if (!times.length) return;
  wakeTimer = setTimeout(() => void runWorker(), Math.max(100, Math.min(...times) - Date.now()));
}

async function runWorker() {
  if (workerRunning || !runtime) return;
  workerRunning = true;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  try {
    let job;
    // `runtime &&` 是"停之后就不要再取活"的第二道闸门：stop 发生在某个任务中途时，
    // 光靠 `nextRunnableJob()` 会把后面所有**已经可跑**的任务接着做完，stop 等于打折。
    // ⚠️ 这道闸门**没有守护**（`tests/t-timers.mjs` 覆盖不到，已实测）：要观察到它的差别
    //    需要夹具里同时有"可跑的任务 A（在它的上传回调里停队列）"和"可跑的任务 B"，
    //    而夹具任务会留在内存里过继给套件的后面几段（会去碰真 onebot）。所以这里保持
    //    "对的写法"，改它不会有测试变红。
    while (runtime && (job = nextRunnableJob())) {
      if (job.status === 'queued' || job.status === 'downloading') await downloadStage(job);
      else if (job.status === 'upload_uncertain' || job.status === 'upload_failed') await uploadUncertainStage(job);
      else await uploadStage(job);
    }
  } finally {
    workerRunning = false;
    scheduleNextWake();
  }
}

/** 绑定运行时依赖，并恢复上次退出时未完成的任务。可重复调用。 */
export function initJmcomicQueue({ onebot, sender, store }: JmRuntime) {
  runtime = { onebot, sender, store };
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
 *     模块外拿不到。`runtime` 置空后它在收尾阶段会退化成空操作（各处都是 `runtime?.`），
 *     本次下载的结果因此不会被发送出去。
 */
export function stopJmcomicQueue() {
  runtime = null;
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
  if (wakeTimer) { clearTimeout(wakeTimer); wakeTimer = null; }
}

export function enqueueJmcomicDownload(ctx: JmContext, comicId: unknown) {
  loadJobs();
  if (!runtime) initJmcomicQueue({ onebot: ctx.onebot, sender: ctx.sender, store: ctx.store });
  const id = String(comicId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('漫画ID必须是 1 至 20 位数字');

  const now = Date.now();
  const key = commandKey(ctx.requesterId, id);
  if (jobs.find((job) => job.key === key && isPending(job))) throw new Error(`漫画 ${id} 已在队列中或正在处理，请等待完成`);
  // 已完成的任务**仍然在 `jobs` 里**（见 cleanupCompletedJob），所以这条窗口也管得住
  // "刚拿到 PDF 又提交一次"——那正是最常发生的重复。
  const recent = [...jobs].reverse().find((job) => job.key === key);
  const elapsed = recent ? now - duplicateAnchorAt(recent) : Number.POSITIVE_INFINITY;
  if (elapsed < DUPLICATE_WINDOW_MS) {
    const seconds = Math.ceil((DUPLICATE_WINDOW_MS - elapsed) / 1000);
    throw new Error(`同一用户短时间内不能重复提交漫画 ${id}，请 ${seconds} 秒后再试`);
  }

  const waitingBefore = jobs.filter((job) => isPending(job)).length;
  const job: JmJob = {
    id: `jm_${id}_${now}_${Math.random().toString(36).slice(2, 8)}`,
    key, comicId: id, requesterId: String(ctx.requesterId || ''), kind: ctx.kind,
    chatId: String(ctx.chatId), chatKey: ctx.chatKey, status: 'queued',
    downloadAttempts: 0, uploadAttempts: 0, pdfPath: '', lastError: '',
    nextAttemptAt: now, createdAt: now, updatedAt: now
  };
  jobs.push(job);
  saveJobs();
  void runWorker();
  return { queued: true, jobId: job.id, comicId: id, position: waitingBefore + 1 };
}
