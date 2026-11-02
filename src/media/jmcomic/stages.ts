// 三个阶段与投递：下载 → 上传 → （必要时）核验。
//
// 与转写/出图最大的不同：**这里的一次 `execute` 只是一个阶段**。正常返回可能意味着
// "回去排队等下一次重试"（`status: 'queued'` + `nextAttemptAt`），所以注册表的 `onSuccess`
// 是空实现、终局状态一律由本文件自己置。重试退避与"上传结果未知"的处置都在这里。

import fs from 'node:fs';
import { getRuntime } from './runtime.js';
import { updateJob, cleanupCompletedJob, jobKind } from './jobs.js';
import { runPython, validatePdf } from './python.js';
import { errorMessage, isRecord, DOWNLOAD_RETRY_MS, UPLOAD_TIMEOUT_MS, UPLOAD_VERIFY_RETRY_MS } from './shared.js';
import {
  uploadFile, matchGroupFile, matchPrivateHistory, responseFileId,
  LATE_WATCH_INTERVAL_MS, LATE_WATCH_TOTAL_MS
} from '../task-delivery.js';
import { outgoingMediaText } from '../../core/outgoing-media.js';
import type { OutgoingMedia } from '../../core/outgoing-media.js';
import type { JmcomicStatus, JmJob } from './types.js';

export async function downloadStage(job: JmJob) {
  const attempt = Number(job.downloadAttempts || 0) + 1;
  updateJob(job, {
    status: 'downloading', downloadAttempts: attempt, lastError: '', heartbeatAt: Date.now(),
    // 进度**从整个任务真正开始处理算起**，跨阶段不重置（用户等的是"这个任务还没好"）。
    progressAnchorAt: Number(job.progressAnchorAt) > 0 ? job.progressAnchorAt : Date.now()
  });
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
    // 禁止下载 / 超过单次上限这两类不可重试，其余是重试耗尽 —— 两种都交给模型去交代，
    // 原因原样带过去（正文里已经写着"禁止下载""超过单次下载上限"这些可转述的事实）。
    await reportTerminal(job, 'failed', message, forbidden || pageLimitExceeded ? `🚫 ${message}` : `❌ 下载失败：${message}`);
  }
}

/** 出站 PDF 的结构化留档：名字 + 大小（能算出来时）+ 协议端给的 id。 */
function outgoingFileMedia(job: JmJob, fileId = ''): OutgoingMedia {
  const name = `${job.comicId}.pdf`;
  let size = 0;
  try {
    size = fs.statSync(validatePdf(job.pdfPath)).size;
  } catch { /* 文件可能已被清理；记录名字与 id 仍然有价值 */ }
  return { kind: 'file', name, ...(size > 0 ? { size } : {}), ...(fileId ? { fileId } : {}) };
}

/**
 * 协议端**明确回了这次动作失败**（retcode 非 0 / HTTP 4xx）。
 *
 * 这与超时、断线、5xx 是两件事：那些"客户端没拿到响应"的情况不能证明文件没传上去，
 * 所以只能核验、绝不能重传；而明确失败是服务端自己说这次动作没成 —— **文件没有传上去**。
 * 判据沿用仓库既有口径（`chat-actions.ts` 的表情兜底也把 `retcode=` 当"明确拒绝"）。
 *
 * 分开的收益是具体的：不分开的话，一次"文件不存在 / 超过群文件上限"的明确拒绝要等
 * 4 轮核验（约 8.5 分钟）才落成一句"未确认"——而用户其实立刻就能知道真实原因。
 */
function isDefinitiveUploadRejection(message: string): boolean {
  return /retcode=\s*-?\d+/i.test(message) || /HTTP\s*4\d\d/i.test(message);
}

async function completeUpload(
  job: JmJob,
  source: 'response' | 'group-file-check' | 'private-history-check' | 'late-watch',
  fileId = '',
  { late = false }: { late?: boolean } = {}
) {
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
  if (late) console.info(`[jmcomic] 晚到文件已确认（${job.id}）`);
  try {
    getRuntime()?.store.appendSelf(job.chatKey, {
      text: outgoingMediaText({ kind: 'file', name: `${job.comicId}.pdf` }),
      ts: Date.now(),
      mid: null,
      media: [outgoingFileMedia(job, fileId)]
    });
  } catch (error) {
    console.warn(`[jmcomic] 文件已上传，但聊天存档写入失败（${job.id}）:`, errorMessage(error));
  }
  // 记录有意留着（去重靠它，见 cleanupCompletedJob 的说明），这里只删日志。
  cleanupCompletedJob(job);
  const sink = getRuntime()?.onCompleted;
  if (sink) {
    try {
      await sink({
        chatKey: job.chatKey,
        comicId: job.comicId,
        cached: job.cached === true,
        source,
        fileId,
        status: 'sent',
        ...(late ? { late: true } : {})
      });
    } catch (error) {
      // 文件已经上传成功，回流失败不能把 completed 任务重新放回非幂等的上传路径。
      console.warn(`[jmcomic] PDF 已上传，但完成回调失败（${job.id}）:`, errorMessage(error));
    }
  }
}

/**
 * **终局失败的唯一出口**：交给回流端口，由模型自己开口 —— 不再往群里贴 ❌/🚫/⚠️ 的机器文案。
 *
 * 为什么（与出图那条同一条理由，2026-10-10 统一）：模型刚对群友说过"我去下了"，
 * 失败该由它自己交代。队列代说，它就会以为"群里已经说过了"而不再开口
 * （转写的"任务被代发伪装成已收尾"是同一个病）。
 *
 * 退路只有一条，且**只在这种时候**才用：没有回流端口（测试夹具 / 装配缺件）。
 * 那时群友什么都等不到，所以退回贴一句 —— "只有确定有人接的时候才闭嘴"。
 * 端口**抛错**时不退：那种情况下条目可能已经落库了，再贴一句就是重复发言。
 */
async function reportTerminal(
  job: JmJob, status: Exclude<JmcomicStatus, 'sent'>, reason: string, fallbackText: string,
  stage: 'download' | 'upload' = 'download'
): Promise<void> {
  const sink = getRuntime()?.onCompleted;
  if (sink) {
    try {
      await sink({
        chatKey: job.chatKey, comicId: job.comicId, cached: false,
        source: 'response', fileId: '', status, reason, stage
      });
      return;
    } catch (error) {
      console.warn(`[jmcomic] 回流失败（${job.id}）:`, errorMessage(error));
      return;
    }
  }
  console.warn(`[jmcomic] 没有回流端口，失败只能直接贴群（${job.id}）`);
  try {
    await getRuntime()?.sender?.sendTextBatch(job.chatKey, [fallbackText]);
  } catch (error) {
    console.warn('[jmcomic] 状态消息发送失败:', errorMessage(error));
  }
}

function deferUploadVerification(job: JmJob, error: unknown) {
  const message = errorMessage(error);
  updateJob(job, {
    status: 'upload_uncertain', lastError: message,
    // 上传失败原因单独留一份：核验阶段会反复覆盖 `lastError`，覆盖掉就查不出
    // "为什么没传上去"了。
    uploadError: message, uploadVerifyAttempts: 0, verifyLooked: false, verifyError: '',
    nextAttemptAt: Date.now() + UPLOAD_VERIFY_RETRY_MS[0]
  });
  console.warn(`[jmcomic] 上传结果未知，将先核验而不是自动重传（${job.id}）:`, message);
}

export async function uploadStage(job: JmJob) {
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
    uploadVerifyAttempts: 0, lastError: '',
    // 同下载阶段：进度锚点跨阶段保留，5 分钟是"整个任务"的阈值，不是每一段的。
    progressAnchorAt: Number(job.progressAnchorAt) > 0 ? job.progressAnchorAt : Date.now()
  });
  const kind = jobKind(job);
  const onebot = getRuntime()?.onebot;
  if (!onebot) throw new Error('漫画队列未初始化（没有 OneBot 端口）');
  try {
    const result = await uploadFile(onebot, {
      kind, chatId: job.chatId, file: pdfPath, name: `${job.comicId}.pdf`, timeoutMs: UPLOAD_TIMEOUT_MS
    });
    await completeUpload(job, 'response', responseFileId(result));
  } catch (error) {
    const message = errorMessage(error);
    // 协议端**明确拒绝**（retcode / HTTP 4xx）：文件没有被传上去，没有"可能已经发出"
    // 这回事。立刻按失败交代 —— 否则用户要等 4 轮核验（约 8.5 分钟）才收到一句
    // "未确认"，而真实原因（文件不存在 / 超过上限 / 无权限）被埋在日志里。
    if (isDefinitiveUploadRejection(message)) {
      updateJob(job, {
        status: 'failed', lastError: message, uploadError: message,
        uploadVerifyAttempts: 0, failedAt: Date.now(), nextAttemptAt: null
      });
      await reportTerminal(job, 'failed', message, `❌ PDF 上传失败：${message}`, 'upload');
      return;
    }
    // 超时、断线、5xx、响应不可解析：`upload_*_file` 是非幂等动作，这些情况都不能证明
    // 服务端没有继续执行 —— 统一进入"结果未知"，后续只核验，不重复发送。
    deferUploadVerification(job, error);
  }
}

export async function uploadUncertainStage(job: JmJob) {
  let pdfPath: string;
  try {
    pdfPath = validatePdf(job.pdfPath);
  } catch (error) {
    updateJob(job, {
      status: 'failed', lastError: `无法核验已上传文件：${errorMessage(error)}`,
      failedAt: Date.now(), nextAttemptAt: null
    });
    await reportTerminal(job, 'failed', `无法核验已上传文件：${errorMessage(error)}`,
      `❌ PDF 上传结果无法核验：${errorMessage(error)}`, 'upload');
    return;
  }

  const verifyAttempt = Number(job.uploadVerifyAttempts || 0) + 1;
  const kind = jobKind(job);
  const surface = kind === 'group' ? '群文件' : '私聊历史';
  const name = `${job.comicId}.pdf`;
  const size = fs.statSync(pdfPath).size;
  let fetched = false;
  let lastVerifyError = String(job.verifyError || '');
  try {
    const result = kind === 'group'
      ? await getRuntime()?.onebot.call('get_group_root_files', { group_id: Number(job.chatId) })
      : await getRuntime()?.onebot.call('get_friend_msg_history', {
          user_id: Number(job.chatId), message_id: 0, count: 50, reverse_order: true
        });
    const match = kind === 'group'
      ? matchGroupFile(result, { name, size })
      : { found: matchPrivateHistory(result, { name, size }), sameName: null, total: 0, expectedSize: size };
    fetched = true;
    lastVerifyError = '';
    if (match.found) {
      // 已经向模型报过"未确认"的，是**晚到补记**：文案要说清是补记，别与上一句矛盾。
      const late = job.terminalNotified === true;
      await completeUpload(
        job,
        late ? 'late-watch' : (kind === 'group' ? 'group-file-check' : 'private-history-check'),
        responseFileId(match.found),
        { late }
      );
      console.info(`[jmcomic] 已通过${kind === 'group' ? '群文件列表' : '好友消息历史'}确认上传完成（${job.id}）`);
      return;
    }
    if (kind === 'group') {
      console.info(`[jmcomic] 第 ${verifyAttempt} 次核验：群文件根目录共 ${match.total} 项，未见 ${name}（${job.id}）`);
      // 同名但大小不符 = 可能是一次假阴性（协议端没给 file_size / 报的口径不同）。
      // 不把它当作"这次传的"（那会把没成功的上传记成 sent），但必须留痕，
      // 否则"其实在群里"与"确实没传上去"在日志里长得一模一样。
      if (match.sameName) {
        const actual = Number(match.sameName.file_size ?? match.sameName.fileSize ?? -1);
        console.warn(`[jmcomic] 群文件里有同名 ${name} 但大小不符（期望 ${match.expectedSize}，实际 ${actual}），不当作已上传（${job.id}）`);
      }
    }
  } catch (error) {
    lastVerifyError = errorMessage(error);
    console.warn(`[jmcomic] 第 ${verifyAttempt} 次核验${surface}失败（${job.id}）:`, lastVerifyError);
  }

  // "查过了没有"与"根本没法查"必须分开：前者是独立的证据，后者什么也证明不了。
  const looked = job.verifyLooked === true || fetched;
  const nextDelay = UPLOAD_VERIFY_RETRY_MS[verifyAttempt];
  if (nextDelay !== undefined) {
    updateJob(job, {
      status: 'upload_uncertain', uploadVerifyAttempts: verifyAttempt,
      verifyLooked: looked, verifyError: lastVerifyError,
      nextAttemptAt: Date.now() + nextDelay
    });
    return;
  }

  const now = Date.now();
  // 已经报过"未确认"：进入**晚到观察**（非幂等上传可能比客户端死线更晚完成）。
  // 找到 → 上面那条 `completeUpload(..., { late: true })` 会补记 + 再通知一次；
  // 没找到 → 到点静默收尾（不再发第二条坏消息）。
  if (job.terminalNotified === true) {
    if (Number(job.lateWatchUntil) > now) {
      updateJob(job, {
        status: 'upload_uncertain', uploadVerifyAttempts: verifyAttempt,
        verifyLooked: looked, verifyError: lastVerifyError,
        nextAttemptAt: now + LATE_WATCH_INTERVAL_MS
      });
      return;
    }
    updateJob(job, {
      status: 'failed', uploadVerifyAttempts: verifyAttempt,
      verifyLooked: looked, verifyError: lastVerifyError,
      failedAt: now, nextAttemptAt: null
    });
    return;
  }

  const uploadError = String(job.uploadError || '').trim();
  const outcome = looked
    ? `已查询${surface}列表，但没有找到 ${name}（共核验 ${verifyAttempt} 次）`
    : `无法核验上传结果：取${surface}列表失败（${lastVerifyError || '原因未知'}）`;
  const message = [
    uploadError ? `上传时的错误：${uploadError}` : '',
    outcome,
    '为避免重复发送，未自动重传；会继续留意是否晚到，确认到会再补一条'
  ].filter(Boolean).join('；');
  // ⚠️ 先记终局已通知 + 晚到观察窗，再发条目：条目抛错也不能让下一轮重复报。
  updateJob(job, {
    status: 'upload_uncertain', uploadVerifyAttempts: verifyAttempt,
    verifyLooked: looked, verifyError: lastVerifyError,
    terminalNotified: true, lateWatchUntil: now + LATE_WATCH_TOTAL_MS,
    lastError: message, nextAttemptAt: now + LATE_WATCH_INTERVAL_MS
  });
  // ⚠️ 这条是 **`unsent`**：上传结果**未确认** —— 可能没发出去，也可能已经在群里。
  // 文案不许断言"发出去了"：`upload_*_file` 抛错只说明客户端没拿到结果，如今有大量
  // 实测情形（协议端明确拒绝、文件读不到）其实一条都没传上去。
  await reportTerminal(job, 'unsent', `${message}（请自己看一眼${surface}里有没有 ${name}）`,
    `⚠️ 漫画 ${job.comicId} 的 PDF 上传结果未确认：${message}`, 'upload');
}

