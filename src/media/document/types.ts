// 文档抽取（pdf / docx / txt / md）的**对外形状**。
//
// ⚠️ 本文件**不 import 本模块的任何文件**（同 `media/transcription/types.ts`、
// `media/jmcomic/types.ts` 的规矩）：它被 python / index 同时依赖，反向依赖就成环。

/**
 * 认出来的格式。**由 Python 嗅探字节得出，不是文件名**（后缀是用户打的，字节是文件自己的）。
 *
 * 只有三种取值：`text` 覆盖 `.txt` 与 `.md`（它们是同一件事 —— 一段 UTF-8/GBK 的字符流，
 * 没有任何结构）。分成两种只会让"这个后缀归谁"多一份知识，而两份必然漂移。
 */
export type DocumentFormat = 'pdf' | 'docx' | 'text';

/** 一次抽取的结果。 */
export interface DocumentText {
  format: DocumentFormat;
  /** 抽出来的正文（已按 `maxChars` 截断）。 */
  text: string;
  /** **原文**总字符数（截断前）。截断提示里要印它 —— 模型得知道后面还有多少。 */
  chars: number;
  /** `text` 是不是只是开头一段。 */
  truncated: boolean;
  /** PDF 的页数。别的格式没有这一项。 */
  pages?: number;
  /** `text` 格式实际用的编码（`utf-8` / `gbk`）。别的格式没有这一项。 */
  encoding?: string;
}

/**
 * 抽取失败。**带 `code`**：`message` 是给模型/群友看的中文（可执行的那种），
 * `code` 是给日志看的。
 *
 * `MISSING_PDF_LIB` 单列一档，因为它与"这份文件读不了"是**完全不同的两件事**：
 * 一个是"你还没装依赖，装完就能读"，另一个是"换一份文件吧"。合成一档的话，
 * 用户会拿着一个本来能读的 PDF 反复重传。形状照 `media/task-error.ts` 的先例。
 */
export class DocumentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
  }
}
