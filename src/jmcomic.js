import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT } from './config.js';

const DUPLICATE_WINDOW_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const RESULT_PREFIX = '__QQ_AGENT_RESULT__';
const SCRIPT_PATH = path.join(ROOT, 'python-tools', 'jmcomic_download.py');
const JM_DIR = path.join(DATA_DIR, 'jmcomic');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads', 'jmcomic');
const JOBS_FILE = path.join(JM_DIR, 'jobs.json');
const LOG_DIR = path.join(JM_DIR, 'logs');
const DOWNLOAD_RETRY_MS = [5_000, 30_000, 120_000];
const UPLOAD_RETRY_MS = [10_000, 60_000, 300_000, 900_000, 1_800_000];

let runtime = null;
let jobs = [];
let loaded = false;
let workerRunning = false;
let wakeTimer = null;

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

function loadJobs() {
  if (loaded) return;
  loaded = true;
  ensureDirs();
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[jmcomic] 任务文件读取失败，将使用空队列:', error?.message ?? error);
    jobs = [];
  }
  let changed = false;
  for (const job of jobs) {
    if (job.status === 'downloading') {
      job.status = 'queued';
      job.nextAttemptAt = Date.now();
      changed = true;
    } else if (job.status === 'uploading') {
      job.status = 'downloaded';
      job.nextAttemptAt = Date.now();
      changed = true;
    }
  }
  if (changed) saveJobs();
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
  saveJobs();
}

function cleanupCompletedJob(job) {
  const previous = jobs;
  jobs = jobs.filter((item) => item.id !== job.id);
  try {
    saveJobs();
  } catch (error) {
    jobs = previous;
    throw error;
  }
  try {
    fs.rmSync(path.join(LOG_DIR, `${job.id}.log`), { force: true });
  } catch (error) {
    // 任务记录已经成功清除，残留日志不应导致已上传文件被重复发送。
    console.warn(`[jmcomic] 已完成任务 ${job.id} 的日志删除失败:`, error?.message ?? error);
  }
}

function isPending(job) {
  return ['queued', 'downloading', 'downloaded', 'uploading', 'upload_failed'].includes(job.status);
}

function commandKey(requesterId, comicId) {
  return `${requesterId || 'unknown'}:${comicId}`;
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

function validatePdf(pdfPath) {
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

function runPython(job) {
  ensureDirs();
  const { command, prefix } = pythonCommand();
  const logFile = path.join(LOG_DIR, `${job.id}.log`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, SCRIPT_PATH, job.comicId, DOWNLOAD_DIR], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let hardTimer = null;
    let idleTimer = null;
    let lastPersistedHeartbeat = 0;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      fn(value);
    };
    const stop = (message) => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error(message));
    };
    const heartbeat = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('下载连续 5 分钟没有任何进度，已终止'), INACTIVITY_TIMEOUT_MS);
      const now = Date.now();
      if (now - lastPersistedHeartbeat >= 5_000) {
        lastPersistedHeartbeat = now;
        job.heartbeatAt = now;
        job.updatedAt = now;
        saveJobs();
      }
    };
    const appendLog = (chunk) => {
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
      let result = null;
      try { result = line ? JSON.parse(line.slice(RESULT_PREFIX.length)) : null; } catch { /* handled below */ }
      if (code !== 0 || !result?.ok) {
        finish(reject, new Error(result?.error || stderr.trim() || `Python 异常退出（${code}）`));
        return;
      }
      try {
        finish(resolve, { ...result, pdfPath: validatePdf(result.pdfPath) });
      } catch (error) {
        finish(reject, error);
      }
    });
    heartbeat();
    hardTimer = setTimeout(() => stop('下载超过 30 分钟，已终止'), DOWNLOAD_TIMEOUT_MS);
  });
}

async function sendStatus(job, message) {
  try {
    await runtime?.sender?.sendTextBatch(job.chatKey, [message]);
  } catch (error) {
    console.warn('[jmcomic] 状态消息发送失败:', error?.message ?? error);
  }
}

async function downloadStage(job) {
  const attempt = Number(job.downloadAttempts || 0) + 1;
  updateJob(job, { status: 'downloading', downloadAttempts: attempt, lastError: '', heartbeatAt: Date.now() });
  try {
    const result = await runPython(job);
    updateJob(job, {
      status: 'downloaded', pdfPath: result.pdfPath, cached: !!result.cached,
      downloadedAt: Date.now(), nextAttemptAt: Date.now(), lastError: ''
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    const forbidden = message.includes('禁止下载');
    if (!forbidden && attempt < DOWNLOAD_RETRY_MS.length) {
      updateJob(job, { status: 'queued', lastError: message, nextAttemptAt: Date.now() + DOWNLOAD_RETRY_MS[attempt - 1] });
      return;
    }
    updateJob(job, { status: 'failed', lastError: message, failedAt: Date.now(), nextAttemptAt: null });
    await sendStatus(job, forbidden ? `🚫 ${message}` : `❌ 下载失败：${message}`);
  }
}

async function uploadStage(job) {
  let pdfPath;
  try {
    pdfPath = validatePdf(job.pdfPath);
  } catch (error) {
    updateJob(job, { status: 'queued', pdfPath: '', downloadAttempts: 0, lastError: String(error?.message ?? error), nextAttemptAt: Date.now() });
    return;
  }
  const attempt = Number(job.uploadAttempts || 0) + 1;
  updateJob(job, { status: 'uploading', uploadAttempts: attempt, lastError: '' });
  const params = job.kind === 'group'
    ? { group_id: Number(job.chatId), file: pdfPath, name: `${job.comicId}.pdf` }
    : { user_id: Number(job.chatId), file: pdfPath, name: `${job.comicId}.pdf` };
  const action = job.kind === 'group' ? 'upload_group_file' : 'upload_private_file';
  try {
    await runtime.onebot.call(action, params, 180_000);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (attempt < UPLOAD_RETRY_MS.length) {
      updateJob(job, { status: 'upload_failed', lastError: message, nextAttemptAt: Date.now() + UPLOAD_RETRY_MS[attempt - 1] });
      return;
    }
    updateJob(job, { status: 'failed', lastError: `上传失败：${message}`, failedAt: Date.now(), nextAttemptAt: null });
    await sendStatus(job, `❌ PDF 已生成，但上传失败：${message}`);
    return;
  }

  // 从这里开始 OneBot 已明确返回成功，任何本地收尾失败都不能再触发上传重试。
  try {
    updateJob(job, { status: 'completed', uploadedAt: Date.now(), lastError: '', nextAttemptAt: null });
  } catch (error) {
    console.warn(`[jmcomic] 文件已上传，但完成状态写入失败（${job.id}）:`, error?.message ?? error);
    return;
  }
  try {
    runtime.store.appendSelf(job.chatKey, { text: `[文件:${job.comicId}.pdf]`, ts: Date.now(), mid: null });
  } catch (error) {
    console.warn(`[jmcomic] 文件已上传，但聊天存档写入失败（${job.id}）:`, error?.message ?? error);
  }
  try {
    cleanupCompletedJob(job);
  } catch (error) {
    // completed 状态仍保留在磁盘中，启动恢复不会重复上传；以后可人工清理。
    console.warn(`[jmcomic] 已完成任务 ${job.id} 的缓存清理失败:`, error?.message ?? error);
  }
}

function nextRunnableJob() {
  const now = Date.now();
  return jobs.find((job) => isPending(job) && Number(job.nextAttemptAt || 0) <= now) || null;
}

function scheduleNextWake() {
  clearTimeout(wakeTimer);
  wakeTimer = null;
  const times = jobs.filter(isPending).map((job) => Number(job.nextAttemptAt || 0)).filter((time) => time > Date.now());
  if (!times.length) return;
  wakeTimer = setTimeout(() => void runWorker(), Math.max(100, Math.min(...times) - Date.now()));
}

async function runWorker() {
  if (workerRunning || !runtime) return;
  workerRunning = true;
  clearTimeout(wakeTimer);
  wakeTimer = null;
  try {
    let job;
    while ((job = nextRunnableJob())) {
      if (job.status === 'queued' || job.status === 'downloading') await downloadStage(job);
      else await uploadStage(job);
    }
  } finally {
    workerRunning = false;
    scheduleNextWake();
  }
}

/** 绑定运行时依赖，并恢复上次退出时未完成的任务。可重复调用。 */
export function initializeJmcomicQueue({ onebot, sender, store }) {
  runtime = { onebot, sender, store };
  loadJobs();
  void runWorker();
}

export function enqueueJmcomicDownload(ctx, comicId) {
  loadJobs();
  if (!runtime) initializeJmcomicQueue({ onebot: ctx.onebot, sender: ctx.sender, store: ctx.store });
  const id = String(comicId ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('漫画ID必须是 1 至 20 位数字');

  const now = Date.now();
  const key = commandKey(ctx.requesterId, id);
  if (jobs.find((job) => job.key === key && isPending(job))) throw new Error(`漫画 ${id} 已在队列中或正在处理，请等待完成`);
  const recent = [...jobs].reverse().find((job) => job.key === key);
  if (recent && now - Number(recent.createdAt || 0) < DUPLICATE_WINDOW_MS) {
    const seconds = Math.ceil((DUPLICATE_WINDOW_MS - (now - recent.createdAt)) / 1000);
    throw new Error(`同一用户短时间内不能重复提交漫画 ${id}，请 ${seconds} 秒后再试`);
  }

  const waitingBefore = jobs.filter((job) => isPending(job)).length;
  const job = {
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
