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
import type { JmcomicStatus, JmJob } from './types.js';

export async function downloadStage(job: JmJob) {
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
    // 禁止下载 / 超过单次上限这两类不可重试，其余是重试耗尽 —— 两种都交给模型去交代，
    // 原因原样带过去（正文里已经写着"禁止下载""超过单次下载上限"这些可转述的事实）。
    await reportTerminal(job, 'failed', message, forbidden || pageLimitExceeded ? `🚫 ${message}` : `❌ 下载失败：${message}`);
  }
}

function responseFileId(value: unknown): string {
  return isRecord(value) ? String(value.file_id ?? value.fileId ?? '') : '';
}

async function completeUpload(job: JmJob, source: 'response' | 'group-file-check' | 'private-history-check', fileId = '') {
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
    getRuntime()?.store.appendSelf(job.chatKey, { text: `[文件:${job.comicId}.pdf]`, ts: Date.now(), mid: null });
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
        status: 'sent'
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
  job: JmJob, status: Exclude<JmcomicStatus, 'sent'>, reason: string, fallbackText: string
): Promise<void> {
  const sink = getRuntime()?.onCompleted;
  if (sink) {
    try {
      await sink({
        chatKey: job.chatKey, comicId: job.comicId, cached: false,
        source: 'response', fileId: '', status, reason
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
  updateJob(job, {
    status: 'upload_uncertain', lastError: errorMessage(error), uploadVerifyAttempts: 0,
    nextAttemptAt: Date.now() + UPLOAD_VERIFY_RETRY_MS[0]
  });
  console.warn(`[jmcomic] 上传结果未知，将先核验而不是自动重传（${job.id}）:`, errorMessage(error));
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
    uploadVerifyAttempts: 0, lastError: ''
  });
  const kind = jobKind(job);
  const params = kind === 'group'
    ? { group_id: Number(job.chatId), file: pdfPath, name: `${job.comicId}.pdf` }
    : { user_id: Number(job.chatId), file: pdfPath, name: `${job.comicId}.pdf` };
  const action = kind === 'group' ? 'upload_group_file' : 'upload_private_file';
  try {
    const result = await getRuntime()?.onebot.call(action, params, UPLOAD_TIMEOUT_MS);
    await completeUpload(job, 'response', responseFileId(result));
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
      `❌ PDF 上传结果无法核验：${errorMessage(error)}`);
    return;
  }

  const verifyAttempt = Number(job.uploadVerifyAttempts || 0) + 1;
  const kind = jobKind(job);
  try {
    const result = kind === 'group'
      ? await getRuntime()?.onebot.call('get_group_root_files', { group_id: Number(job.chatId) })
      : await getRuntime()?.onebot.call('get_friend_msg_history', {
          user_id: Number(job.chatId), message_id: 0, count: 50, reverse_order: true
        });
    const found = kind === 'group'
      ? matchingGroupFile(result, job, pdfPath)
      : matchingPrivateFile(result, job, pdfPath);
    if (found) {
      await completeUpload(job, kind === 'group' ? 'group-file-check' : 'private-history-check', responseFileId(found));
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
  // ⚠️ 这条是 **`unsent`**：PDF 发出去了，只是没能确认 —— **很可能已经在群里**。
  // 说成"没下成"会让模型对群友说反话（同一个 PDF 就在他眼前）。
  await reportTerminal(job, 'unsent', `${message}（请自己看一眼${surface}里有没有 ${job.comicId}.pdf）`,
    `⚠️ ${message}，请检查${surface}后再决定是否重新提交。`);
}

