// 转写配置的解析与钳制。
import type { AppConfig } from '../../core/config.js';
import { boundedInt, envString } from './primitives.js';
import type { EffectiveConfig } from './types.js';

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
    resultMaxChars: boundedInt(raw.resultMaxChars, 3500, 200, 4000),
    // 模型自主调用的成本闸门；钳制归属地就是这里（transcription 没有独立的 normalizeConfigShape 分支）。
    maxCallsPerChatPerHour: boundedInt(raw.maxCallsPerChatPerHour, 3, 1, 60),
    maxCallsPerDay: boundedInt(raw.maxCallsPerDay, 10, 1, 1000)
  };
}
