// 出图的错误类型。共同形状与三个助手（判码 / 洗日志细节 / 翻译异常）在 `media/task-error.ts`，
// 三个能力共用；这里只剩**出图自己的两件事**：类名（工具侧 `instanceof` 的契约）与兜底话术。
import { TaskError, userError as makeTaskError } from '../task-error.js';
import type { FailureStage } from './types.js';

export { safeErrorCode, sanitizeCode, safeErrorDetail } from '../task-error.js';

/** 对外导出，供工具侧用 `instanceof` 区分"用户看得懂的原因"与真实内部错误。 */
export class ImageGenError extends TaskError {
  /** 收窄回本能力的阶段取值域（基类是 `string`）。`declare` 不产生运行期字段。 */
  declare stage: FailureStage;

  constructor(stage: FailureStage, code: string, userMessage: string) {
    super(stage, code, userMessage);
    this.name = 'ImageGenError';
  }
}

/** 任意异常 → 一条 `ImageGenError`；已经是的话原样返回（不覆盖更准的 stage/code）。 */
export function userError(error: unknown): ImageGenError {
  // ⚠️ 兜底文案**必须带上码**。原先这里是一句无条件的"画图失败，稍后再试"，
  // 真机实测就落在这一支上（链路上没被包装的异常），结果群里那句话既不能排查也不能向群友
  // 解释 —— 是哪一步、什么原因全丢了，只能靠再复现一次定位。宁可难看也不能说不出话。
  return makeTaskError(error, (code) => new ImageGenError('generating', code, `画图失败（${code}），稍后再试`));
}
