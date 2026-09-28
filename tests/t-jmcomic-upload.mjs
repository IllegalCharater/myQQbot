// 漫画上传的“结果未知”状态机：upload_*_file 是非幂等动作，超时或重启恢复后只能核验，
// 不能把“客户端没拿到响应”误判成“QQ 没收到”而自动重传。
import fs from 'node:fs';
import path from 'node:path';
import { checker, dataDir } from './lib/harness.mjs';
import { load } from './lib/src.mjs';

const DATA = dataDir('qqagent-jmcomic-upload-');
const { ok, done } = checker();
const NOW = 1_790_600_000_000;
const JM_DIR = path.join(DATA, 'jmcomic');
const DOWNLOADS = path.join(DATA, 'downloads', 'jmcomic');
const PDF = path.join(DOWNLOADS, 'fixture.pdf');
const JOBS_FILE = path.join(JM_DIR, 'jobs.json');

fs.mkdirSync(JM_DIR, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.writeFileSync(PDF, Buffer.concat([Buffer.from('%PDF-1.4\n', 'ascii'), Buffer.alloc(1200, 0x20)]));
fs.writeFileSync(path.join(JM_DIR, 'cleanup-state.json'), JSON.stringify({ lastCleanupAt: NOW }), 'utf8');
fs.writeFileSync(JOBS_FILE, JSON.stringify({
  version: 1,
  jobs: [
    {
      id: 'fresh-timeout', key: 'u:111', comicId: '111', requesterId: 'u', kind: 'group',
      chatId: '123', chatKey: 'group:123', status: 'downloaded', downloadAttempts: 1,
      uploadAttempts: 0, pdfPath: PDF, lastError: '', nextAttemptAt: NOW - 1,
      createdAt: NOW - 1000, updatedAt: NOW - 1000
    },
    {
      id: 'restart-found', key: 'u:222', comicId: '222', requesterId: 'u', kind: 'group',
      chatId: '123', chatKey: 'group:123', status: 'uploading', downloadAttempts: 1,
      uploadAttempts: 2, pdfPath: PDF, lastError: '', nextAttemptAt: NOW - 1,
      createdAt: NOW - 2000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 1000
    },
    {
      id: 'restart-absent', key: 'u:333', comicId: '333', requesterId: 'u', kind: 'group',
      chatId: '123', chatKey: 'group:123', status: 'uploading', downloadAttempts: 1,
      uploadAttempts: 1, pdfPath: PDF, lastError: '', nextAttemptAt: NOW - 1,
      createdAt: NOW - 2000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 1000
    },
    {
      id: 'private-found', key: 'u:444', comicId: '444', requesterId: 'u', kind: 'private',
      chatId: '456', chatKey: 'private:456', status: 'uploading', downloadAttempts: 1,
      uploadAttempts: 1, pdfPath: PDF, lastError: '', nextAttemptAt: NOW - 1,
      createdAt: NOW - 2000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 1000
    }
  ]
}, null, 2), 'utf8');

const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
let now = NOW;
let nextHandle = 1;
const timers = [];
const intervals = [];
Date.now = () => now;
globalThis.setTimeout = (fn, ms) => {
  const handle = { id: nextHandle++, fn, ms, active: true };
  timers.push(handle);
  return handle;
};
globalThis.clearTimeout = (handle) => { if (handle) handle.active = false; };
globalThis.setInterval = (fn, ms) => {
  const handle = { id: nextHandle++, fn, ms, active: true, unref() {} };
  intervals.push(handle);
  return handle;
};
globalThis.clearInterval = (handle) => { if (handle) handle.active = false; };

async function flush(times = 16) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

const calls = [];
const pdfSize = fs.statSync(PDF).size;
const runtime = {
  onebot: {
    call: async (action, params, timeoutMs) => {
      calls.push({ action, params, timeoutMs });
      if (action === 'upload_group_file') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (action === 'get_group_root_files') {
        return {
          files: [
            { file_id: 'file-111', file_name: '111.pdf', file_size: pdfSize },
            { file_id: 'file-222', file_name: '222.pdf', file_size: pdfSize }
          ],
          folders: []
        };
      }
      if (action === 'get_friend_msg_history') {
        return {
          messages: [{
            message_type: 'private',
            message: [{ type: 'file', data: { file_id: 'file-444', name: '444.pdf', file_size: pdfSize } }]
          }]
        };
      }
      throw new Error(`unexpected action: ${action}`);
    }
  },
  sender: { sendTextBatch: async () => ({}) },
  store: { appendSelf: () => ({}) }
};

let jmcomic;
try {
  jmcomic = await load('media/jmcomic.js');
  jmcomic.initJmcomicQueue(runtime);
  await flush();

  let saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs;
  const timedOut = saved.find((job) => job.id === 'fresh-timeout');
  ok('上传超时后只调用一次 upload_group_file，不立即盲重传',
    calls.filter((call) => call.action === 'upload_group_file').length === 1,
    JSON.stringify(calls));
  ok('大文件上传超时提高到 30 分钟',
    calls.find((call) => call.action === 'upload_group_file')?.timeoutMs === 30 * 60_000,
    `实际 ${calls.find((call) => call.action === 'upload_group_file')?.timeoutMs}`);
  ok('超时任务进入 upload_uncertain，并保留一次上传尝试',
    timedOut?.status === 'upload_uncertain' && timedOut?.uploadAttempts === 1,
    JSON.stringify(timedOut));

  const firstWake = timers.find((timer) => timer.active);
  ok('首次核验延迟 30 秒，给仍在 SnowLuma 内执行的旧请求留出收尾时间',
    firstWake?.ms === 30_000, `实际 ${firstWake?.ms}`);
  now += 30_000;
  firstWake.active = false;
  firstWake.fn();
  await flush();

  saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs;
  const verifiedFresh = saved.find((job) => job.id === 'fresh-timeout');
  const verifiedRestart = saved.find((job) => job.id === 'restart-found');
  const absentRestart = saved.find((job) => job.id === 'restart-absent');
  const verifiedPrivate = saved.find((job) => job.id === 'private-found');
  ok('超时任务在群文件列表命中后完成，且没有第二次上传',
    verifiedFresh?.status === 'completed' && verifiedFresh?.completionSource === 'group-file-check' &&
      verifiedFresh?.uploadedFileId === 'file-111' &&
      calls.filter((call) => call.action === 'upload_group_file').length === 1,
    JSON.stringify({ verifiedFresh, calls }));
  ok('重启遗留的 uploading 只核验、不重传，命中后完成',
    verifiedRestart?.status === 'completed' && verifiedRestart?.uploadAttempts === 2 &&
      verifiedRestart?.completionSource === 'group-file-check' && verifiedRestart?.uploadedFileId === 'file-222',
    JSON.stringify(verifiedRestart));
  ok('核验暂未命中时继续保持 upload_uncertain，不执行 upload_group_file',
    absentRestart?.status === 'upload_uncertain' && absentRestart?.uploadVerifyAttempts === 1 &&
      calls.filter((call) => call.action === 'upload_group_file').length === 1,
    JSON.stringify(absentRestart));
  ok('私聊上传结果未知时查询好友历史，命中文件段后完成而不是发送误报警告',
    verifiedPrivate?.status === 'completed' && verifiedPrivate?.completionSource === 'private-history-check' &&
      verifiedPrivate?.uploadedFileId === 'file-444' &&
      calls.filter((call) => call.action === 'get_friend_msg_history').length === 1,
    JSON.stringify({ verifiedPrivate, calls }));
  ok('第二轮核验按 60 秒退避排定',
    timers.some((timer) => timer.active && timer.ms === 60_000),
    `timers=${JSON.stringify(timers.map(({ ms, active }) => ({ ms, active })))}`);
} finally {
  jmcomic?.stopJmcomicQueue();
  Date.now = realNow;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
}

process.exit(done() ? 0 : 1);
