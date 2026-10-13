// 异步任务错误的**共同形状**与"把任意异常翻译成能进日志的码 / 用户看得懂的那句话"。
//
// 转写与出图各写过一份（连注释都一样，只有类名与兜底话术不同）。差别只剩两处，
// 都留在各自模块里：**类名**（`instanceof` 是各能力自己的契约）与**兜底文案**
// （转写说"腾讯云识别失败"，出图说"画图失败（<码>），稍后再试"）。
//
// `stage` 决定失败阶段（失败文案与日志按它分档），`code` 是**可机检**的错误码
// （日志只记它，绝不记 URL、画面描述或识别文本），`userMessage` 才是发给群里的那句话。
//
// ⚠️ **漫画还没接进来**：它的失败路径原本直接贴群（2026-10-10 改成回流），
// 但没有 stage/code 这一套。要接就是让 `reportTerminal` 也抛/携带 `TaskError`。

/** 共同基类。各能力的错误类 `extends` 它（并把自己的 `stage` 收窄回本能力的取值域）。 */
export class TaskError extends Error {
  constructor(public stage: string, public code: string, public userMessage: string) {
    super(userMessage);
    this.name = 'TaskError';
  }
}

/** 把任意外部字符串收紧成能安全进日志/错误码的形态。 */
export function sanitizeCode(value: unknown, fallback = 'UNKNOWN'): string {
  return String(value ?? '').replace(/[^\w.-]/g, '').slice(0, 60) || fallback;
}

/**
 * 任意异常 → 一个能进日志的错误码。
 *
 * **判据刻意宽松**（"对象上有个像 code 的字符串"）：不用 `instanceof XxxError` 那种写法，
 * 否则每加一个上游都要多一处 instanceof。`error.name` 是最后的兜底 —— 于是
 * `AbortSignal.timeout()` 抛的 `DOMException` 会记成 `TimeoutError`、裸 fs 异常记成 `ENOENT`。
 *
 * 裸 `new Error('HTTP 404')` 这类传输错误会被收成 `HTTP_404`：`safeFetchBinary` 抛的就是这个
 * 形状，而 `error.name` 恒为 `Error` —— 不认它的话"结果图 404"在日志里写成 `code=Error`，
 * 等于没有信息。
 */
export function safeErrorCode(error: unknown): string {
  if (error instanceof TaskError) return error.code;
  if (error && typeof error === 'object') {
    const value = (error as Record<string, unknown>).code;
    if (typeof value === 'string' && /^[\w.-]{1,80}$/.test(value)) return value;
  }
  if (error instanceof Error) {
    const http = /^HTTP (\d{3})$/.exec(error.message.trim());
    if (http) return `HTTP_${http[1]}`;
    if (/^[\w.-]{1,80}$/.test(error.name)) return error.name;
  }
  return 'UNKNOWN';
}

/**
 * 未分类异常的**可进日志**的细节。
 *
 * 为什么需要它：`safeErrorCode` 对裸 `Error` 只能给出 `Error` 这个字样（`error.name`），
 * 而那正是最需要知道"到底怎么了"的时候。细节来自底层/外部，所以**先洗一遍**：
 * 去掉 URL 与本机绝对路径再截断 —— 日志里不许出现这两样。
 *
 * 已知边界：只认 `http(s)://` 与 Windows 盘符路径两种形态，够用即可；这不是安全边界，
 * 是"别把整条链接和临时目录路径抄进日志"的卫生习惯。
 */
export function safeErrorDetail(error: unknown, max = 160): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z]:\\[^\s"']*/g, '[path]')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max) || 'UNKNOWN';
}

/**
 * 任意异常 → 本能力的错误对象；已经是 `TaskError` 的话**原样返回**（不覆盖更准的 stage/code）。
 *
 * `make` 是各能力自己的那一步：兜底的 `stage` 与那句给群友的文案都不同，所以只能由它给。
 * 传函数而不是参数，是为了让"哪一步失败"与"怎么措辞"留在**同一个文件**里。
 */
export function userError<T extends TaskError>(error: unknown, make: (code: string) => T): T {
  if (error instanceof TaskError) return error as T;
  return make(safeErrorCode(error));
}
