// 音轨提取：平台无关的媒体解析 → 本机安全代理 → FFmpeg 转 16k 单声道 mp3。
//
// **本文件不认识任何平台**：`resolveMediaSource` 把"分享页 → 可播放流"那段交给认领该地址的
// provider（见 `media/media-source/`），没有 provider 认领的直链原样返回。
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolveMediaSource } from '../media-source/index.js';
import { TranscriptionError, providerErrorCode } from './errors.js';
import { createMediaProxy } from './media-proxy.js';
import type { EffectiveConfig, FailureStage } from './types.js';

/**
 * 从 FFmpeg 的 `-progress pipe:2` 输出里取最后一个 `out_time`（毫秒）。
 *
 * 用进度而不是 `ffprobe`：多一个进程、多一次探测，而我们要的只是"有没有超时长"。
 */
export function progressDurationMs(stderr: string): number {
  let last = 0;
  for (const match of stderr.matchAll(/(?:^|\n)out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)) {
    last = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
  }
  return last;
}

/**
 * 把 `sourceUrl` 的音轨抽成 16k 单声道 mp3，返回字节数与时长。
 *
 * 用户 URL 从不交给 shell，也不直接交给 FFmpeg：命令是 `spawn` 的**参数数组**且显式
 * `shell: false`，FFmpeg 只看到本机代理地址。
 */
export async function extractAudio(
  sourceUrl: string,
  outputPath: string,
  config: EffectiveConfig,
  signal: AbortSignal
): Promise<{ bytes: number; durationMs: number }> {
  let source;
  try {
    // 平台无关：认领这个地址的 provider 自己解析（B 站展开短链挑音频流、别的平台各做各的）。
    // **没有 provider 认领时原样返回**，所以普通 .mp4 / .m4a 直链不会走进任何平台分支。
    source = await resolveMediaSource(sourceUrl, signal, config.maxDurationSeconds);
  } catch (error) {
    // provider 抛的错带可机检的 code，按 code 决定失败阶段（照原来 B 站那条的规矩：
    // 超长算"提取"阶段，其余算"校验"阶段）。换平台时这段不用改。
    const code = providerErrorCode(error);
    if (code) {
      const stage: FailureStage = code === 'VIDEO_TOO_LONG' ? 'extracting' : 'validation';
      throw new TranscriptionError(stage, code, error instanceof Error && error.message ? error.message : '无法解析媒体链接');
    }
    throw new TranscriptionError('validation', 'MEDIA_RESOLVE_FAILED', '无法解析媒体链接');
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
        // 这几条正则把"上游不可达"与"媒体本身没音轨"从 FFmpeg 的混合 stderr 里分出来 ——
        // 否则两者都会落进 FFMPEG_EXIT_N，而文案指向的是"音频提取失败"（归因错）。
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

/**
 * 启动前检查 FFmpeg 真的能跑。
 *
 * 用只读的 `-version` 而不是 `-help`：后者在部分构建上会写 stdout，而这里 `stdio: 'ignore'`。
 * 5 秒硬超时是必需的 —— 一个挂住的 `ffmpeg` 会让 `start()` 永远不返回，而那会把
 * `app.start()` 整个拖住。
 */
export async function checkFfmpegBinary(ffmpegPath: string): Promise<void> {
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
