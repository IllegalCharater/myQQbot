// 转写的错误类型。共同形状与三个助手（判码 / 洗日志细节 / 翻译异常）在 `media/task-error.ts`，
// 三个能力共用；这里只剩**转写自己的两件事**：类名（工具侧 `instanceof` 的契约）与兜底话术。
import { TaskError, userError as makeTaskError } from '../task-error.js';
import type { FailureStage } from './types.js';

export { safeErrorCode, sanitizeCode, safeErrorDetail } from '../task-error.js';

/** 对外导出，供工具侧用 `instanceof` 区分"用户看得懂的原因"与真实内部错误。 */
export class TranscriptionError extends TaskError {
  /** 收窄回本能力的阶段取值域（基类是 `string`）。`declare` 不产生运行期字段。 */
  declare stage: FailureStage;

  constructor(stage: FailureStage, code: string, userMessage: string) {
    super(stage, code, userMessage);
    this.name = 'TranscriptionError';
  }
}

/** provider 抛出的错误里那个**可机检的 code**（形如 `BILIBILI_API_0` / `VIDEO_TOO_LONG`）。 */
export function providerErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = (error as Record<string, unknown>).code;
  return typeof value === 'string' && /^[\w.-]{1,80}$/.test(value) ? value : '';
}

/** 任意异常 → 一条 `TranscriptionError`；已经是的话原样返回（不覆盖更准的 stage/code）。 */
export function userError(error: unknown): TranscriptionError {
  return makeTaskError(error, (code) => new TranscriptionError('recognizing', code, '腾讯云识别失败'));
}
