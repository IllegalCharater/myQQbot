// 图像生成的错误类型与"把任意异常翻译成用户看得懂的那句话"。
//
// `ImageGenError.stage` 决定**失败阶段**（失败文案按它分档），`code` 是**可机检**的错误码
// （日志只记它，绝不记 API Key、prompt 正文或图片地址），`userMessage` 才是发给群里的那句话。
// 与 `media/transcription/errors.ts` 同形 —— 两个模块各留一份而不是互相 import：
// 它们是同层的两个独立能力，`media/` 内部只横向引用共享的平铺助手（safe-fetch / call-budget），
// 功能目录之间不互相依赖。
import type { FailureStage } from './types.js';

/** 对外导出，供工具侧用 `instanceof` 区分"用户看得懂的原因"与真实内部错误。 */
export class ImageGenError extends Error {
  constructor(public stage: FailureStage, public code: string, public userMessage: string) {
    super(userMessage);
    this.name = 'ImageGenError';
  }
}

/**
 * 任意异常 → 一个能进日志的错误码。
 *
 * 判据刻意宽松（"对象上有个像 code 的字符串"），与转写的 `safeErrorCode` 同口径。
 * **上游字符串必须先洗一遍**：它来自外部，直接拼进日志等于让外部数据控制日志格式。
 *
 * 与转写那份唯一的不同：`new Error('HTTP 404')` 这类裸传输错误会被收成 `HTTP_404`。
 * `safeFetchBinary` 抛的就是这个形状，而 `error.name` 恒为 `Error` —— 不认它的话，
 * "结果图 404"与"参考图 404"在日志里都会写成 `code=Error`，等于没有信息。
 */
export function safeErrorCode(error: unknown): string {
  if (error instanceof ImageGenError) return error.code;
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

/** 把任意外部字符串收紧成能安全进日志/错误码的形态。 */
export function sanitizeCode(value: unknown, fallback = 'UNKNOWN'): string {
  return String(value ?? '').replace(/[^\w.-]/g, '').slice(0, 60) || fallback;
}

/** 任意异常 → 一条 `ImageGenError`；已经是的话原样返回（不覆盖更准的 stage/code）。 */
export function userError(error: unknown): ImageGenError {
  if (error instanceof ImageGenError) return error;
  const code = safeErrorCode(error);
  // ⚠️ 兜底文案**必须带上码**。原先这里是一句无条件的"画图失败，稍后再试"，
  // 真机实测就落在这一支上（链路上没被包装的异常），结果群里那句话既不能排查也不能向群友
  // 解释 —— 是哪一步、什么原因全丢了，只能靠再复现一次定位。宁可难看也不能说不出话。
  return new ImageGenError('generating', code, `画图失败（${code}），稍后再试`);
}

/**
 * 未分类异常的**可进日志**的细节。
 *
 * 为什么需要它：`safeErrorCode` 对裸 `Error` 只能给出 `Error` 这个字样（`error.name`），
 * 而那正是最需要知道"到底怎么了"的时候。细节来自底层/外部，所以**先洗一遍**：
 * 去掉 URL 与本机绝对路径再截断 —— 日志里不许出现这两样（与"错误码进日志前先洗"同一条规矩）。
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
