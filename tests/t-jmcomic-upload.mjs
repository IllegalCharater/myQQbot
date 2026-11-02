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
    },
    {
      // 协议端**明确拒绝**（retcode 非 0）：文件没有传上去，必须立刻按失败交代，
      // 不能等 4 轮核验（约 8.5 分钟）再说一句"未确认"。
      id: 'definitive-reject', key: 'u:555', comicId: '555', requesterId: 'u', kind: 'group',
      chatId: '555', chatKey: 'group:555', status: 'downloaded', downloadAttempts: 1,
      uploadAttempts: 0, pdfPath: PDF, lastError: '', nextAttemptAt: NOW - 1,
      createdAt: NOW - 1000, updatedAt: NOW - 1000
    },
    {
      // 上传超时之后，**取群文件列表本身一直失败**：这时我们什么也证明不了，
      // 最终那句话必须是"无法核验"，而不是"列表里没有"。
      // uploadVerifyAttempts=3 ⇒ 这次是第 4 次 ⇒ 直接走终局，不用在测试里推 4 个计时器。
      id: 'verify-broken', key: 'u:666', comicId: '666', requesterId: 'u', kind: 'group',
      chatId: '666', chatKey: 'group:666', status: 'upload_uncertain', downloadAttempts: 1,
      uploadAttempts: 1, pdfPath: PDF, lastError: 'The operation was aborted due to timeout',
      uploadError: 'The operation was aborted due to timeout', uploadVerifyAttempts: 3,
      nextAttemptAt: NOW - 1, createdAt: NOW - 2000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 1000
    },
    {
      // 上传超时之后，群文件列表**能查到**、但里面确实没有目标文件。
      id: 'verify-absent', key: 'u:777', comicId: '777', requesterId: 'u', kind: 'group',
      chatId: '777', chatKey: 'group:777', status: 'upload_uncertain', downloadAttempts: 1,
      uploadAttempts: 1, pdfPath: PDF, lastError: 'TimeoutError: timeout',
      uploadError: 'TimeoutError: timeout', uploadVerifyAttempts: 3,
      nextAttemptAt: NOW - 1, createdAt: NOW - 2000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 1000
    },
    {
      // 报过"未确认"、晚到观察窗也到期了：静默收尾，不再发第二条坏消息。
      id: 'late-expired', key: 'u:888', comicId: '888', requesterId: 'u', kind: 'group',
      chatId: '888', chatKey: 'group:888', status: 'upload_uncertain', downloadAttempts: 1,
      uploadAttempts: 1, pdfPath: PDF, lastError: '之前报过的未确认',
      uploadError: 'timeout', uploadVerifyAttempts: 4, terminalNotified: true,
      lateWatchUntil: NOW - 1, nextAttemptAt: NOW - 1,
      createdAt: NOW - 2000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 1000
    },
    {
      // 已经跑了 6 分钟还没结束：进度扫描应该发一条【任务进度】。
      // nextAttemptAt 排到一小时后，避免队列真的去执行它。
      id: 'progress-due', key: 'u:909', comicId: '909', requesterId: 'u', kind: 'group',
      chatId: '909', chatKey: 'group:909', status: 'upload_uncertain', downloadAttempts: 1,
      uploadAttempts: 1, pdfPath: PDF, lastError: '', uploadError: 'timeout',
      uploadVerifyAttempts: 0, terminalNotified: true, lateWatchUntil: NOW + 3_600_000,
      progressAnchorAt: NOW - 6 * 60_000, nextAttemptAt: NOW + 3_600_000,
      createdAt: NOW - 400_000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 400_000
    },
    {
      // 只跑了 1 分钟：不该发进度。
      id: 'progress-not-yet', key: 'u:910', comicId: '910', requesterId: 'u', kind: 'group',
      chatId: '910', chatKey: 'group:910', status: 'upload_uncertain', downloadAttempts: 1,
      uploadAttempts: 1, pdfPath: PDF, lastError: '', uploadError: 'timeout',
      uploadVerifyAttempts: 0, terminalNotified: true, lateWatchUntil: NOW + 3_600_000,
      progressAnchorAt: NOW - 60_000, nextAttemptAt: NOW + 3_600_000,
      createdAt: NOW - 100_000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 100_000
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
/** 终局时经回流端口交出去的结构化事实（用来断言"说了什么"，而不只是"状态对不对"）。 */
const completions = [];
/** 进度提示（5 分钟阈值）。 */
const progressEvents = [];
/** 出站媒体记账（`completeUpload` 写的 `我：[文件:…]`）。 */
const selfRecords = [];
/** 晚到文件是否已经出现在群文件列表里（由下面的用例打开）。 */
let lateAppeared = false;
const pdfSize = fs.statSync(PDF).size;
const runtime = {
  onebot: {
    call: async (action, params, timeoutMs) => {
      calls.push({ action, params, timeoutMs });
      if (action === 'upload_group_file') {
        // 555 是"协议端明确拒绝"，其余是"客户端没拿到响应"（超时）。
        if (String(params?.name) === '555.pdf') {
          throw new Error('OneBot upload_group_file 失败: retcode=1200 文件上传失败');
        }
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }
      if (action === 'get_group_root_files') {
        // 666 的协议端不支持取群文件列表（或一直失败）：这时候我们**什么也证明不了**。
        if (String(params?.group_id) === '666') {
          throw new Error('OneBot get_group_root_files 失败: retcode=1404 unsupported action');
        }
        const files = [
          { file_id: 'file-111', file_name: '111.pdf', file_size: pdfSize },
          { file_id: 'file-222', file_name: '222.pdf', file_size: pdfSize }
        ];
        // 999 用来验"晚到补记"：打开开关后它才出现。
        if (lateAppeared && String(params?.group_id) === '999') {
          files.push({ file_id: 'file-999', file_name: '999.pdf', file_size: pdfSize });
        }
        return { files, folders: [] };
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
  store: { appendSelf: (chatKey, input) => { selfRecords.push({ chatKey, ...input }); return {}; } },
  onCompleted: (input) => { completions.push(input); },
  onProgress: (input) => { progressEvents.push(input); }
};

let jmcomic;
try {
  jmcomic = await load('media/jmcomic/index.js');
  jmcomic.initJmcomicQueue(runtime);
  await flush();

  let saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')).jobs;
  const timedOut = saved.find((job) => job.id === 'fresh-timeout');
  const uploadsFor = (name) => calls.filter((call) => call.action === 'upload_group_file'
    && String(call.params?.name) === name);
  ok('上传超时后只调用一次 upload_group_file，不立即盲重传',
    uploadsFor('111.pdf').length === 1,
    JSON.stringify(calls));
  ok('大文件上传超时提高到 30 分钟',
    uploadsFor('111.pdf')[0]?.timeoutMs === 30 * 60_000,
    `实际 ${uploadsFor('111.pdf')[0]?.timeoutMs}`);
  ok('超时任务进入 upload_uncertain，并保留一次上传尝试',
    timedOut?.status === 'upload_uncertain' && timedOut?.uploadAttempts === 1,
    JSON.stringify(timedOut));

  // ── 明确拒绝 vs 结果未知 vs 核验失败：三种"没传上去"必须分开（2026-11-02） ──
  const rejected = saved.find((job) => job.id === 'definitive-reject');
  const rejectSink = completions.find((item) => item.comicId === '555');
  ok('★ 协议端明确拒绝（retcode）时立刻按失败交代，不再等 4 轮核验',
    rejected?.status === 'failed' && String(rejected?.uploadError).includes('retcode=1200')
    && rejectSink?.status === 'failed' && rejectSink?.stage === 'upload'
    && String(rejectSink?.reason).includes('retcode=1200')
    && !calls.some((call) => call.action === 'get_group_root_files' && String(call.params?.group_id) === '555'),
    JSON.stringify({ rejected, rejectSink }));

  const broken = saved.find((job) => job.id === 'verify-broken');
  const brokenSink = completions.find((item) => item.comicId === '666');
  ok('★ 取群文件列表一直失败 → 最终说"无法核验"，不许说成"列表里没有"',
    broken?.status === 'upload_uncertain' && broken?.verifyLooked === false
    && broken?.terminalNotified === true && Number(broken?.lateWatchUntil) > NOW
    && brokenSink?.status === 'unsent' && brokenSink?.stage === 'upload'
    && String(brokenSink?.reason).includes('无法核验上传结果')
    && !String(brokenSink?.reason).includes('没有找到')
    && String(brokenSink?.reason).includes('The operation was aborted due to timeout'),
    JSON.stringify({ broken, brokenSink }));

  const absent = saved.find((job) => job.id === 'verify-absent');
  const absentSink = completions.find((item) => item.comicId === '777');
  ok('★ 列表查得到、但确实没有目标文件 → 如实说"没找到"，并保留上传时的错误',
    absent?.status === 'upload_uncertain' && absent?.verifyLooked === true
    && absent?.terminalNotified === true
    && absentSink?.status === 'unsent'
    && String(absentSink?.reason).includes('没有找到 777.pdf')
    && String(absentSink?.reason).includes('上传时的错误')
    && String(absentSink?.reason).includes('timeout'),
    JSON.stringify({ absent, absentSink }));

  const expired = saved.find((job) => job.id === 'late-expired');
  ok('★ 晚到观察窗到期仍未找到 → 静默收尾，不再发第二条坏消息',
    expired?.status === 'failed'
    && !completions.some((item) => item.comicId === '888'),
    JSON.stringify({ expired, completions }));

  ok('★ 报过未确认后进入晚到观察（5 分钟后再看，最多 1 小时）',
    Number(absent?.nextAttemptAt) === NOW + 300_000
    && Number(absent?.lateWatchUntil) === NOW + 3_600_000,
    JSON.stringify({ next: absent?.nextAttemptAt, until: absent?.lateWatchUntil }));

  ok('★ 结果未知/明确拒绝都不重传（非幂等）：555 只传过一次，666/777 一次都没再传',
    uploadsFor('555.pdf').length === 1 && uploadsFor('666.pdf').length === 0
    && uploadsFor('777.pdf').length === 0,
    JSON.stringify(calls.filter((call) => call.action === 'upload_group_file')));

  // 晚到命中：直接调阶段函数（绕过队列计时器），验的是"观察窗找到文件 → 补记 + 再通知"。
  const { uploadUncertainStage } = await load('media/jmcomic/stages.js');
  const lateJob = {
    id: 'late-manual', key: 'u:999', comicId: '999', requesterId: 'u', kind: 'group',
    chatId: '999', chatKey: 'group:999', status: 'upload_uncertain',
    downloadAttempts: 1, uploadAttempts: 1, pdfPath: PDF, lastError: '之前报过的未确认',
    uploadError: 'timeout', uploadVerifyAttempts: 4, terminalNotified: true,
    lateWatchUntil: NOW + 3_600_000, nextAttemptAt: NOW,
    createdAt: NOW - 1000, updatedAt: NOW - 1000, uploadStartedAt: NOW - 1000
  };
  lateAppeared = true;
  await uploadUncertainStage(lateJob);
  await flush();
  const lateSink = completions.filter((item) => item.comicId === '999');
  ok('★ 晚到文件被观察窗找到 → 补记 + 再次通知（late:true）',
    lateJob.status === 'completed' && lateJob.completionSource === 'late-watch'
    && lateSink.length === 1 && lateSink[0].status === 'sent' && lateSink[0].late === true
    && selfRecords.some((record) => String(record.chatKey) === 'group:999'
      && String(record.text).includes('[文件:999.pdf]')),
    JSON.stringify({ lateJob, lateSink, selfRecords }));
  ok('晚到补记不重传', uploadsFor('999.pdf').length === 0,
    JSON.stringify(calls.filter((call) => call.action === 'upload_group_file')));

  // 5 分钟进度：扫描 interval 在 queue.ts，判定/文案在 media/task-progress.ts。
  const progressInterval = intervals.find((handle) => handle.ms === 60_000);
  ok('漫画队列起了 60 秒的进度扫描 interval', !!progressInterval,
    JSON.stringify(intervals.map((handle) => handle.ms)));
  progressInterval.fn();
  await flush();
  ok('★ 任务跑了 6 分钟仍未结束 → 发一条【任务进度】',
    progressEvents.length === 1 && progressEvents[0].comicId === '909'
    && progressEvents[0].stage === '核验上传结果'
    && String(progressEvents[0].text).includes('漫画 909 还在核验上传结果')
    && String(progressEvents[0].text).includes('完成后会再通知一次'),
    JSON.stringify(progressEvents));
  progressInterval.fn();
  await flush();
  ok('同一次任务只提醒一次（第二轮扫描不再发）', progressEvents.length === 1,
    JSON.stringify(progressEvents));
  ok('未满 5 分钟的任务不发进度', !progressEvents.some((item) => item.comicId === '910'),
    JSON.stringify(progressEvents));

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
      uploadsFor('111.pdf').length === 1,
    JSON.stringify({ verifiedFresh, calls }));
  ok('重启遗留的 uploading 只核验、不重传，命中后完成',
    verifiedRestart?.status === 'completed' && verifiedRestart?.uploadAttempts === 2 &&
      verifiedRestart?.completionSource === 'group-file-check' && verifiedRestart?.uploadedFileId === 'file-222',
    JSON.stringify(verifiedRestart));
  ok('核验暂未命中时继续保持 upload_uncertain，不执行 upload_group_file',
    absentRestart?.status === 'upload_uncertain' && absentRestart?.uploadVerifyAttempts === 1 &&
      absentRestart?.verifyLooked === true && uploadsFor('333.pdf').length === 0,
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
