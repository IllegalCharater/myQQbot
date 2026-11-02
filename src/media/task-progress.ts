// 长任务**进度通知**的纯判定与文案。
//
// 三个 async 能力共用同一套"到点了吗、该说什么"，但**计时器仍留在各能力自己的
// queue 里**：`TaskQueue` 明确规定不持有计时器（`LONG_TERM_TASKS.owner` 的语义是
// "实际持有这些计时器的模块"，`tests/t-tasks.mjs` 按它反查调度调用）。这里只有纯函数，
// 谁在自己的 interval 里调用都行。
//
// 判据只有一条：**从任务真正开始处理算起**（不含排队），超过 `PROGRESS_NOTIFY_MS`
// 仍未结束，就提醒**一次**。一次任务最多一条 —— 进度提示会唤醒一轮模型运行，
// 每 5 分钟一条既贵又吵。

/** 默认阈值：5 分钟。 */
export const PROGRESS_NOTIFY_MS = 5 * 60_000;

/** 任务上需要持久化的两个时间点（各能力的 job 字段名保持一致）。 */
export interface ProgressStamp {
  /** 当前这一段真正开始的时刻；0/缺省 = 还没开始处理。 */
  progressAnchorAt?: number;
  /** 已经发过进度提示的时刻；有值 = 不再发。 */
  progressNotifiedAt?: number;
}

/** 到点了吗：开始了、还没提醒过、已经超过阈值。 */
export function progressDue(stamp: ProgressStamp, now = Date.now(), thresholdMs = PROGRESS_NOTIFY_MS): boolean {
  const anchor = Number(stamp.progressAnchorAt);
  if (!Number.isFinite(anchor) || anchor <= 0) return false;
  if (Number(stamp.progressNotifiedAt) > 0) return false;
  return now - anchor >= Math.max(0, Number(thresholdMs) || 0);
}

/** 已经处理了多久（给文案用）。 */
export function progressElapsedMs(stamp: ProgressStamp, now = Date.now()): number {
  const anchor = Number(stamp.progressAnchorAt);
  if (!Number.isFinite(anchor) || anchor <= 0) return 0;
  return Math.max(0, now - anchor);
}

/**
 * 进度条目的正文。
 *
 * 只说**能确定的事实**（谁、在哪个阶段、已经多久），并明确"完成后会再通知一次"——
 * 让模型知道这不是结局，不要据此宣布完成。具体能力名由 `label` 带进来（如「漫画 123」）。
 */
export function progressText(label: string, stage: string, elapsedMs: number): string {
  const minutes = Math.max(1, Math.round(Math.max(0, Number(elapsedMs) || 0) / 60_000));
  return `${label} 还在${stage}（已 ${minutes} 分钟）；完成后会再通知一次。`;
}
