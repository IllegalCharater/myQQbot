// 腾讯云「录音文件识别极速版」：一次 POST 把整段音频送上去，同步拿回文本。
//
// 为什么用极速版而不是异步的录音文件识别：后者要走"提交 → 轮询 → 取结果"三步，
// 而这里每段音频最多两小时、且原本就串行单并发，同步一次省掉整个状态机与临时存储。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { safeErrorCode, TranscriptionError } from './errors.js';
import type { EffectiveConfig, FailureStage, InternalJob, TranscriptionStatus } from './types.js';

interface FlashRecognitionResponse {
  code?: number;
  flash_result?: Array<{ text?: string }>;
}

/** 生成极速版要求的排序查询串与 HMAC-SHA1 签名；返回值不得写入日志。 */
export function buildFlashRecognitionRequest(input: {
  appId: string;
  secretId: string;
  secretKey: string;
  engineType: string;
  timestamp: number;
}): { hostname: string; path: string; authorization: string } {
  const hostname = 'asr.cloud.tencent.com';
  const pathname = `/asr/flash/v1/${input.appId}`;
  const params: Record<string, string> = {
    convert_num_mode: '1',
    engine_type: input.engineType,
    filter_dirty: '0',
    filter_modal: '0',
    filter_punc: '0',
    first_channel_only: '1',
    secretid: input.secretId,
    speaker_diarization: '0',
    timestamp: String(input.timestamp),
    voice_format: 'mp3',
    word_info: '0'
  };
  // 参数名必须**排序**后再拼：签名的原文是这条查询串本身，顺序变了签名就对不上。
  const query = Object.keys(params).sort().map((key) =>
    `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
  ).join('&');
  const source = `POST${hostname}${pathname}?${query}`;
  return {
    hostname,
    path: `${pathname}?${query}`,
    authorization: createHmac('sha1', input.secretKey).update(source).digest('base64')
  };
}

/** 云配置缺项时抛出**可执行**的提示（点名缺哪个环境变量）。 */
export function requireCloudConfig(config: EffectiveConfig): void {
  const missing: string[] = [];
  if (!config.appId) missing.push('TENCENTCLOUD_APP_ID');
  if (!config.secretId) missing.push('TENCENTCLOUD_SECRET_ID');
  if (!config.secretKey) missing.push('TENCENTCLOUD_SECRET_KEY');
  if (missing.length) {
    throw new TranscriptionError('validation', 'CONFIG_MISSING', `转写服务未配置：缺少 ${missing.join('、')}`);
  }
  if (!/^\d+$/.test(config.appId)) {
    throw new TranscriptionError('validation', 'INVALID_APP_ID', '转写服务配置无效：TENCENTCLOUD_APP_ID 必须为数字');
  }
}

/** 把音频文件 POST 给极速版接口，返回识别文本（可能为空串）。 */
export async function recognizeFlash(
  audioPath: string, config: EffectiveConfig, signal: AbortSignal,
  setStatus: (status: TranscriptionStatus, extra?: Partial<InternalJob>) => void
): Promise<string> {
  requireCloudConfig(config);
  const stat = await fsp.stat(audioPath);
  const target = buildFlashRecognitionRequest({
    appId: config.appId,
    secretId: config.secretId,
    secretKey: config.secretKey,
    engineType: config.engineType,
    timestamp: Math.floor(Date.now() / 1000)
  });
  setStatus('uploading');

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    // 阶段随请求推进：同一段代码在"还没发完"与"已经发完等响应"时报的错不同
    //（`音频上传超时` vs `腾讯云识别超时`），归因才不会指错方向。
    let phase: FailureStage = 'uploading';
    let source: fs.ReadStream | null = null;
    const finish = (error?: unknown, result?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      source?.destroy();
      if (error) reject(error);
      else resolve(result || '');
    };
    const request = https.request({
      hostname: target.hostname,
      port: 443,
      method: 'POST',
      path: target.path,
      headers: {
        Authorization: target.authorization,
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size
      }
    }, (response) => {
      phase = 'recognizing';
      setStatus('recognizing');
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      response.on('data', (chunk: Buffer) => {
        responseBytes += chunk.length;
        // 上限防的是"上游返回了一个巨大页面（如网关错误页）"把内存吃掉。
        if (responseBytes > 8 * 1024 * 1024) {
          response.destroy(new TranscriptionError('recognizing', 'ASR_RESPONSE_TOO_LARGE', '腾讯云识别失败'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', (error) => finish(
        error instanceof TranscriptionError
          ? error
          : new TranscriptionError('recognizing', safeErrorCode(error), '腾讯云识别失败')
      ));
      response.once('end', () => {
        const statusCode = response.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          finish(new TranscriptionError('recognizing', `ASR_HTTP_${statusCode}`, '腾讯云识别失败'));
          return;
        }
        let parsed: FlashRecognitionResponse;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as FlashRecognitionResponse;
        } catch {
          finish(new TranscriptionError('recognizing', 'ASR_INVALID_RESPONSE', '腾讯云识别失败'));
          return;
        }
        if (parsed.code !== 0) {
          // 错误码进日志要**先洗一遍**：它来自上游，直接拼进去等于让外部数据控制日志格式。
          const code = String(parsed.code ?? 'UNKNOWN').replace(/[^\w.-]/g, '').slice(0, 60) || 'UNKNOWN';
          finish(new TranscriptionError('recognizing', `TENCENT_${code}`, '腾讯云识别失败'));
          return;
        }
        const text = Array.isArray(parsed.flash_result)
          ? parsed.flash_result.map((item) => String(item?.text || '').trim()).filter(Boolean).join('\n')
          : '';
        finish(undefined, text);
      });
    });
    const abort = () => request.destroy(
      new TranscriptionError(phase, 'CANCELLED', '转写任务已取消')
    );
    const timer = setTimeout(() => request.destroy(
      new TranscriptionError(phase, 'ASR_TIMEOUT', phase === 'uploading' ? '音频上传超时' : '腾讯云识别超时')
    ), config.flashTimeoutMs);
    request.once('finish', () => {
      if (phase === 'uploading') {
        phase = 'recognizing';
        setStatus('recognizing');
      }
    });
    request.once('error', (error) => finish(
      error instanceof TranscriptionError
        ? error
        : new TranscriptionError(phase, safeErrorCode(error), phase === 'uploading' ? '音频上传失败' : '腾讯云识别失败')
    ));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    source = fs.createReadStream(audioPath);
    source.once('error', (error) => request.destroy(
      new TranscriptionError('uploading', safeErrorCode(error), '音频上传失败')
    ));
    source.pipe(request);
  });
}
