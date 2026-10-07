// 转写的错误类型与"把任意异常翻译成用户看得懂的那句话"。
//
// `TranscriptionError.stage` 决定**失败阶段**（工具与回执文案按它分档），`code` 是**可机检**
// 的错误码（日志只记它、绝不记 URL 或识别文本），`userMessage` 才是发给群里的那句话。
import type { FailureStage } from './types.js';

/** 对外导出，供工具侧用 `instanceof` 区分"用户看得懂的原因"与真实内部错误。 */
export class TranscriptionError extends Error {
  constructor(public stage: FailureStage, public code: string, public userMessage: string) {
    super(userMessage);
    this.name = 'TranscriptionError';
  }
}

/** provider 抛出的错误里那个**可机检的 code**（形如 `BILIBILI_API_0` / `VIDEO_TOO_LONG`）。 */
export function providerErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as Record<string, unknown>).code;
  return typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) ? value : '';
}

/**
 * 任意异常 → 一个能进日志的错误码。
 *
 * **判据刻意宽松**（"对象上有个像 code 的字符串"）：不用 `instanceof BilibiliResolveError`
 * 那种写法，否则每加一个平台都要多一处 instanceof。与 `providerErrorCode` 同口径。
 */
export function safeErrorCode(error: unknown): string {
  if (error instanceof TranscriptionError) return error.code;
  if (error && typeof error === 'object') {
    const value = (error as Record<string, unknown>).code;
    if (typeof value === 'string' && /^[\w.-]{1,80}$/.test(value)) return value;
  }
  return error instanceof Error && /^[\w.-]{1,80}$/.test(error.name) ? error.name : 'UNKNOWN';
}

/** 任意异常 → 一条 `TranscriptionError`；已经是的话原样返回（不覆盖更准的 stage/code）。 */
export function userError(error: unknown): TranscriptionError {
  if (error instanceof TranscriptionError) return error;
  return new TranscriptionError('recognizing', safeErrorCode(error), '腾讯云识别失败');
}
