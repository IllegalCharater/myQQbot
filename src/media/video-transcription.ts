// 视频 URL 转写：单并发队列 → SSRF 安全流式代理 → FFmpeg → 腾讯云录音文件识别极速版。
//
// 用户 URL 从不交给 shell，也不直接交给 FFmpeg。FFmpeg 只访问本机临时代理；代理对原始
// URL 与每次重定向逐跳校验、固定已校验 DNS 结果并流式转发，因此既不落完整视频，也不会
// 因 FFmpeg 自己跟随重定向而绕过 SSRF 防护。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '../core/config.js';
import { isPrivateIp, openSafeStream, validateFetchUrl } from './safe-fetch.js';
import {
  BilibiliResolveError, resolveBilibiliMedia, type ResolvedMediaSource
} from './bilibili.js';

interface TranscriptionMedia extends Record<string, unknown> { kind: string; url?: string }
interface TranscriptionSender {
  sendTextBatch(chatKey: string, messages: unknown, options?: {
    replyToMessageId?: unknown; atUserId?: unknown; file?: string;
  }): Promise<unknown>;
}

export type TranscriptionStatus = 'queued' | 'extracting' | 'uploading' | 'recognizing' | 'done' | 'failed';
type FailureStage = 'validation' | 'extracting' | 'uploading' | 'recognizing';

interface OneBotFileClient {
  call(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

interface EffectiveConfig {
  enabled: boolean;
  appId: string;
  secretId: string;
  secretKey: string;
  engineType: string;
  ffmpegPath: string;
  ffmpegTimeoutMs: number;
  flashTimeoutMs: number;
  maxDurationSeconds: number;
  maxAudioBytes: number;
  maxSourceBytes: number;
  resultMaxChars: number;
}

interface InternalJob {
  id: string;
  chatKey: string;
  sourceUrl: string;
  replyToMessageId: string | number | null;
  status: TranscriptionStatus;
  failedStage?: FailureStage;
  createdAt: number;
  updatedAt: number;
  audioBytes?: number;
  elapsedMs?: number;
  errorCode?: string;
}

export interface TranscriptionJobView {
  id: string;
  chatKey: string;
  status: TranscriptionStatus;
  failedStage?: FailureStage;
  createdAt: number;
  updatedAt: number;
  audioBytes?: number;
  elapsedMs?: number;
  errorCode?: string;
}

class TranscriptionError extends Error {
  constructor(public stage: FailureStage, public code: string, public userMessage: string) {
    super(userMessage);
    this.name = 'TranscriptionError';
  }
}

interface QueueOperations {
  checkFfmpeg?: (ffmpegPath: string) => Promise<void>;
  runTask?: (
    job: Readonly<InternalJob>,
    signal: AbortSignal,
    setStatus: (status: TranscriptionStatus, extra?: Partial<InternalJob>) => void,
    config: EffectiveConfig
  ) => Promise<string>;
  deliver?: (job: Readonly<InternalJob>, text: string, config: EffectiveConfig) => Promise<void>;
}

function envString(name: string): string {
  return String(process.env[name] || '').trim();
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** 配置值优先、环境变量回退，与现有搜索 API Key 的读取方式一致。 */
export function resolveTranscriptionConfig(config: AppConfig): EffectiveConfig {
  const raw = config.transcription;
  const envEnabled = envString('QQ_AGENT_TRANSCRIPTION_ENABLED').toLowerCase();
  return {
    enabled: envEnabled ? ['1', 'true', 'yes', 'on'].includes(envEnabled) : raw.enabled === true,
    appId: String(raw.appId || envString('TENCENTCLOUD_APP_ID')).trim(),
    secretId: String(raw.secretId || envString('TENCENTCLOUD_SECRET_ID')).trim(),
    secretKey: String(raw.secretKey || envString('TENCENTCLOUD_SECRET_KEY')).trim(),
    engineType: String(raw.engineType || '16k_zh').trim(),
    ffmpegPath: String(raw.ffmpegPath || envString('FFMPEG_PATH') || 'ffmpeg').trim(),
    ffmpegTimeoutMs: boundedInt(raw.ffmpegTimeoutMs, 15 * 60_000, 10_000, 3 * 60 * 60_000),
    flashTimeoutMs: boundedInt(raw.flashTimeoutMs, 5 * 60_000, 10_000, 30 * 60_000),
    // 录音文件识别极速版的官方硬上限为 2 小时与 100 MiB，配置只能进一步收紧。
    maxDurationSeconds: boundedInt(raw.maxDurationSeconds, 2 * 60 * 60, 1, 2 * 60 * 60),
    maxAudioBytes: boundedInt(raw.maxAudioBytes, 100 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024),
    maxSourceBytes: boundedInt(raw.maxSourceBytes, 256 * 1024 * 1024, 1 * 1024 * 1024, 1024 * 1024 * 1024),
    resultMaxChars: boundedInt(raw.resultMaxChars, 3500, 200, 4000)
  };
}

/** 只做无需 DNS 的快速校验；worker 访问时还会做逐跳 DNS/重定向校验。 */
export function normalizeTranscriptionUrl(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new TranscriptionError('validation', 'INVALID_URL', '无法访问链接：URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TranscriptionError('validation', 'INVALID_PROTOCOL', '无法访问链接：仅支持 http/https');
  }
  if (url.username || url.password) {
    throw new TranscriptionError('validation', 'URL_CREDENTIALS', '无法访问链接：URL 不能包含凭据');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateIp(host)) {
    throw new TranscriptionError('validation', 'PRIVATE_ADDRESS', '无法访问链接：禁止内网或本机地址');
  }
  return url.toString();
}

export function parseTranscriptionCommand(text: unknown, media: TranscriptionMedia[] = []): string | null {
  // OneBot 的 video 段会被通用文本化逻辑渲染成尾部 `[视频]`；命令解析时去掉这个占位符，
  // 这样“文字 /转写 + 同条视频段”也能从 media.url 取地址。
  const value = String(text ?? '').trim().replace(/(?:\[视频\])+$/u, '').trim();
  const match = /^\/转写(?:\s+(.+))?$/su.exec(value);
  if (!match) return null;
  const explicit = String(match[1] || '').trim();
  if (explicit) return normalizeTranscriptionUrl(explicit);
  const video = media.find((item) => item?.kind === 'video' && typeof item.url === 'string' && item.url.trim());
  if (video?.url) return normalizeTranscriptionUrl(video.url);
  throw new TranscriptionError('validation', 'MISSING_URL', '用法：/转写 <视频URL>');
}

function safeErrorCode(error: unknown): string {
  if (error instanceof TranscriptionError) return error.code;
  if (error && typeof error === 'object') {
    const value = (error as Record<string, unknown>).code;
    if (typeof value === 'string' && /^[\w.-]{1,80}$/.test(value)) return value;
  }
  return error instanceof Error && /^[\w.-]{1,80}$/.test(error.name) ? error.name : 'UNKNOWN';
}

function userError(error: unknown): TranscriptionError {
  if (error instanceof TranscriptionError) return error;
  return new TranscriptionError('recognizing', safeErrorCode(error), '腾讯云识别失败');
}

async function checkFfmpegBinary(ffmpegPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-version'], { stdio: 'ignore', windowsHide: true, shell: false });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('FFMPEG_CHECK_TIMEOUT'));
    }, 5000);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('FFMPEG_CHECK_FAILED'));
    });
  });
}

interface MediaProxy {
  url: string;
  close(): Promise<void>;
}

async function createMediaProxy(source: ResolvedMediaSource, signal: AbortSignal, maxBytes: number): Promise<MediaProxy> {
  // 启动监听前先完成一次 DNS 校验，让明显不可访问/内网目标尽早失败。
  await validateFetchUrl(source.url);
  const token = randomUUID();
  let transferred = 0;
  const active = new Set<http.IncomingMessage>();
  const server = http.createServer(async (req, res) => {
    if (req.url !== `/${token}` || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const forwarded: Record<string, string> = { ...(source.headers || {}) };
      if (typeof req.headers.range === 'string') forwarded.range = req.headers.range;
      if (typeof req.headers['if-range'] === 'string') forwarded['if-range'] = req.headers['if-range'];
      const opened = await openSafeStream(source.url, {
        method: req.method as 'GET' | 'HEAD', headers: forwarded, signal
      });
      const upstream = opened.response;
      active.add(upstream);
      const responseHeaders: Record<string, string | number> = {};
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
        const value = upstream.headers[name];
        if (typeof value === 'string') responseHeaders[name] = value;
      }
      res.writeHead(upstream.statusCode || 200, responseHeaders);
      if (req.method === 'HEAD') {
        upstream.resume();
        res.end();
      } else {
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            transferred += chunk.length;
            if (transferred > maxBytes) callback(new Error('SOURCE_TOO_LARGE'));
            else callback(null, chunk);
          }
        });
        await pipeline(upstream, limiter, res);
      }
      active.delete(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end('upstream unavailable');
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PROXY_LISTEN_FAILED');
  return {
    url: `http://127.0.0.1:${address.port}/${token}`,
    close: () => new Promise<void>((resolve) => {
      for (const response of active) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    })
  };
}

function progressDurationMs(stderr: string): number {
  let last = 0;
  for (const match of stderr.matchAll(/(?:^|\n)out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)) {
    last = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
  }
  return last;
}

async function extractAudio(sourceUrl: string, outputPath: string, config: EffectiveConfig, signal: AbortSignal) {
  let source: ResolvedMediaSource;
  try {
    source = await resolveBilibiliMedia(sourceUrl, signal, config.maxDurationSeconds);
  } catch (error) {
    if (error instanceof BilibiliResolveError) {
      const stage: FailureStage = error.code === 'VIDEO_TOO_LONG' ? 'extracting' : 'validation';
      throw new TranscriptionError(stage, error.code, error.message);
    }
    throw new TranscriptionError('validation', 'BILIBILI_RESOLVE_FAILED', '无法解析 B 站视频');
  }
  const proxy = await createMediaProxy(source, signal, config.maxSourceBytes).catch(() => {
    throw new TranscriptionError('validation', 'URL_UNREACHABLE', '无法访问链接');
  });
  try {
    let stderr = '';
    const durationLimit = config.maxDurationSeconds + 0.5;
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', proxy.url,
      '-map', '0:a:0', '-t', String(durationLimit), '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '48k', '-fs', String(config.maxAudioBytes + 1),
      '-progress', 'pipe:2', outputPath
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
      let settled = false;
      let timedOut = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => {
        child.kill('SIGKILL');
        finish(new TranscriptionError('extracting', 'CANCELLED', '转写任务已取消'));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, config.ffmpegTimeoutMs);
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8').slice(0, 64 * 1024 - stderr.length);
      });
      child.once('error', () => finish(new TranscriptionError('extracting', 'FFMPEG_START_FAILED', 'FFmpeg 启动失败')));
      child.once('exit', (code) => {
        if (timedOut) return finish(new TranscriptionError('extracting', 'FFMPEG_TIMEOUT', '转码超时'));
        if (code === 0) return finish();
        if (/HTTP error 4\d\d|HTTP error 5\d\d|Server returned [45]\d\d|upstream unavailable|Connection reset/i.test(stderr)) {
          return finish(new TranscriptionError('validation', 'URL_UNREACHABLE', '无法访问链接'));
        }
        if (/matches no streams|does not contain any stream|audio.*not found/i.test(stderr)) {
          return finish(new TranscriptionError('extracting', 'NO_AUDIO', '视频没有音轨'));
        }
        return finish(new TranscriptionError('extracting', `FFMPEG_EXIT_${code ?? 'UNKNOWN'}`, '音频提取失败'));
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const stat = await fsp.stat(outputPath).catch(() => null);
    if (!stat || stat.size <= 0) throw new TranscriptionError('extracting', 'EMPTY_AUDIO', '视频没有音轨');
    if (stat.size > config.maxAudioBytes) {
      throw new TranscriptionError('extracting', 'AUDIO_TOO_LARGE', '临时音频超过大小限制');
    }
    const durationMs = progressDurationMs(stderr);
    if (durationMs > config.maxDurationSeconds * 1000 + 250) {
      throw new TranscriptionError('extracting', 'VIDEO_TOO_LONG', `视频超过 ${config.maxDurationSeconds} 秒限制`);
    }
    return { bytes: stat.size, durationMs };
  } finally {
    await proxy.close();
  }
}

function requireCloudConfig(config: EffectiveConfig): void {
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

async function recognizeFlash(
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

export class VideoTranscriptionQueue {
  #sender: TranscriptionSender;
  #onebot: OneBotFileClient;
  #getConfig: () => AppConfig;
  #log: (...args: unknown[]) => void;
  #operations: QueueOperations;
  #jobs = new Map<string, InternalJob>();
  #pending: InternalJob[] = [];
  #wake: ReturnType<typeof setTimeout> | null = null;
  #drainPromise: Promise<void> | null = null;
  #currentAbort: AbortController | null = null;
  #started = false;
  #stopping = false;
  #ffmpegError = '';

  constructor({ sender, onebot, getConfig, log = console.log, operations = {} }: {
    sender: TranscriptionSender;
    onebot: OneBotFileClient;
    getConfig: () => AppConfig;
    log?: (...args: unknown[]) => void;
    operations?: QueueOperations;
  }) {
    this.#sender = sender;
    this.#onebot = onebot;
    this.#getConfig = getConfig;
    this.#log = log;
    this.#operations = operations;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#ffmpegError = '';
    const config = resolveTranscriptionConfig(this.#getConfig());
    try {
      await (this.#operations.checkFfmpeg || checkFfmpegBinary)(config.ffmpegPath);
    } catch {
      this.#ffmpegError = 'FFMPEG_UNAVAILABLE';
      this.#log('[transcribe] code=FFMPEG_UNAVAILABLE');
    }
    this.#started = true;
    if (this.#pending.length) this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#wake) clearTimeout(this.#wake);
    this.#wake = null;
    for (const job of this.#pending.splice(0)) {
      this.#setStatus(job, 'failed', { failedStage: 'extracting', errorCode: 'SHUTDOWN' });
    }
    this.#currentAbort?.abort();
    await this.#drainPromise?.catch(() => {});
    this.#started = false;
  }

  enqueue({ chatKey, url, replyToMessageId = null }: {
    chatKey: string;
    url: unknown;
    replyToMessageId?: string | number | null;
  }): TranscriptionJobView {
    if (!this.#started) throw new TranscriptionError('validation', 'NOT_STARTED', '转写服务尚未启动');
    if (this.#stopping) throw new TranscriptionError('validation', 'STOPPING', '转写服务正在关闭');
    if (this.#ffmpegError) throw new TranscriptionError('validation', this.#ffmpegError, '转写不可用：未检测到 FFmpeg');
    const config = resolveTranscriptionConfig(this.#getConfig());
    if (!config.enabled) throw new TranscriptionError('validation', 'DISABLED', '转写服务未启用');
    requireCloudConfig(config);
    const sourceUrl = normalizeTranscriptionUrl(url);
    const now = Date.now();
    const job: InternalJob = {
      id: randomUUID(), chatKey, sourceUrl, replyToMessageId,
      status: 'queued', createdAt: now, updatedAt: now
    };
    this.#jobs.set(job.id, job);
    this.#pending.push(job);
    while (this.#jobs.size > 100) this.#jobs.delete(this.#jobs.keys().next().value as string);
    this.#log(`[transcribe] task=${job.id}`);
    this.#schedule();
    return this.#view(job);
  }

  get(taskId: string): TranscriptionJobView | null {
    const job = this.#jobs.get(taskId);
    return job ? this.#view(job) : null;
  }

  #view(job: InternalJob): TranscriptionJobView {
    const { id, chatKey, status, failedStage, createdAt, updatedAt, audioBytes, elapsedMs, errorCode } = job;
    return { id, chatKey, status, failedStage, createdAt, updatedAt, audioBytes, elapsedMs, errorCode };
  }

  #setStatus(job: InternalJob, status: TranscriptionStatus, extra: Partial<InternalJob> = {}): void {
    Object.assign(job, extra, { status, updatedAt: Date.now() });
    const fields = [`[transcribe] task=${job.id}`];
    if (job.audioBytes != null) fields.push(`bytes=${job.audioBytes}`);
    if (job.elapsedMs != null) fields.push(`elapsedMs=${job.elapsedMs}`);
    if (job.errorCode) fields.push(`code=${job.errorCode}`);
    if (fields.length > 1) this.#log(fields.join(' '));
  }

  #schedule(): void {
    if (this.#wake || this.#drainPromise || this.#stopping) return;
    this.#wake = setTimeout(() => {
      this.#wake = null;
      void this.#drain();
    }, 0);
  }

  async #drain(): Promise<void> {
    if (this.#drainPromise || this.#stopping) return;
    this.#drainPromise = (async () => {
      while (!this.#stopping) {
        const job = this.#pending.shift();
        if (!job) break;
        const startedAt = Date.now();
        const controller = new AbortController();
        this.#currentAbort = controller;
        const config = resolveTranscriptionConfig(this.#getConfig());
        try {
          const run = this.#operations.runTask || ((target, signal, setStatus, current) =>
            this.#runProduction(target, signal, setStatus, current));
          const result = await run(job, controller.signal, (status, extra) => this.#setStatus(job, status, extra), config);
          // 即使关停与远端响应同时发生，也不得交付迟到结果。
          if (controller.signal.aborted || this.#stopping) {
            throw new TranscriptionError('extracting', 'CANCELLED', '转写任务已取消');
          }
          const deliver = this.#operations.deliver || ((target, text, current) => this.#deliver(target, text, current));
          await deliver(job, result, config);
          this.#setStatus(job, 'done', { elapsedMs: Date.now() - startedAt });
        } catch (error) {
          const safe = userError(error);
          this.#setStatus(job, 'failed', {
            failedStage: safe.stage, errorCode: safe.code, elapsedMs: Date.now() - startedAt
          });
          if (!this.#stopping) {
            await this.#sender.sendTextBatch(job.chatKey, `转写失败（${safe.stage}）：${safe.userMessage}`, {
              replyToMessageId: job.replyToMessageId
            }).catch((sendError) => {
              this.#log(`[transcribe] task=${job.id} code=${safeErrorCode(sendError)}`);
            });
          }
        } finally {
          this.#currentAbort = null;
        }
      }
    })();
    try {
      await this.#drainPromise;
    } finally {
      this.#drainPromise = null;
      if (this.#pending.length && !this.#stopping) this.#schedule();
    }
  }

  async #runProduction(
    job: Readonly<InternalJob>, signal: AbortSignal,
    setStatus: (status: TranscriptionStatus, extra?: Partial<InternalJob>) => void,
    config: EffectiveConfig
  ): Promise<string> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-agent-transcription-'));
    const audioPath = path.join(tempDir, `${job.id}.mp3`);
    try {
      setStatus('extracting');
      const extracted = await extractAudio(job.sourceUrl, audioPath, config, signal);
      setStatus('extracting', { audioBytes: extracted.bytes });
      return await recognizeFlash(audioPath, config, signal, setStatus);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #deliver(job: Readonly<InternalJob>, result: string, config: EffectiveConfig): Promise<void> {
    const text = result || '（未识别到有效语音）';
    const prefix = '转写结果：\n';
    const limit = Math.max(200, config.resultMaxChars - prefix.length - 20);
    if (text.length <= limit) {
      await this.#sender.sendTextBatch(job.chatKey, prefix + text, { replyToMessageId: job.replyToMessageId });
      return;
    }

    await this.#sender.sendTextBatch(
      job.chatKey,
      `${prefix}${Array.from(text).slice(0, limit).join('')}\n\n文本过长，已截断；完整内容将作为 UTF-8 文本文件发送。`,
      { replyToMessageId: job.replyToMessageId }
    );
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qq-agent-transcript-'));
    const filePath = path.join(tempDir, `transcription-${job.id}.txt`);
    try {
      await fsp.writeFile(filePath, text, 'utf8');
      const [kind, id] = job.chatKey.split(':');
      const params = kind === 'group'
        ? { group_id: Number(id), file: filePath, name: path.basename(filePath) }
        : { user_id: Number(id), file: filePath, name: path.basename(filePath) };
      await this.#onebot.call(kind === 'group' ? 'upload_group_file' : 'upload_private_file', params, 120_000);
    } catch (error) {
      this.#log(`[transcribe] task=${job.id} code=${safeErrorCode(error)}`);
      await this.#sender.sendTextBatch(job.chatKey, '完整文本文件发送失败；上方为截断结果。').catch(() => {});
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
