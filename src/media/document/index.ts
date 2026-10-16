// 文档抽取能力的入口：一段字节 → 文本。
//
// ── 这一层只管什么 ──
//
// 它**只管"字节 → 文本"**，不负责把文件弄到手（下载）。这是刻意的：两条调用路径要的上限与
// 超时完全不同 —— 模型工具读网页直链、跑团命令读群文件、将来别的东西还有别的约束 ——
// 而"下载"各自只有几行（`safeFetchBinary(url, 上限, signal)`），把它们收进这里反而要
// 给一个函数开三个参数。"取字节"与"解字节"是两件事，分开放。
//
// ── 格式判断为什么在这一层之外 ──
//
// 它**不在这一层**：字节是什么格式由 Python 嗅探（魔数 + NUL），Node 侧只把 Python 说的
// 那个答案转出来。这样做的好处是"这是不是 pdf"只有一个判据 —— 后缀是用户打的，
// 而按后缀分派会让"同一个文件改个后缀就从能读变成不能读"，且没有任何报错。
import { DocumentError } from './types.js';
import { extractWithPython } from './python.js';
import type { DocumentFormat, DocumentText } from './types.js';
import type { DocumentSpawnLike } from './python.js';

// 桶文件照例把领域类型转出去 —— 消费方只 import 这一个入口（同 `transcription/` / `image-gen/`）。
export { DocumentError } from './types.js';
export type { DocumentFormat, DocumentText } from './types.js';

/**
 * 交给抽取器的字节上限。**这条是"别把内存吃光"，不是"限制正文"**（正文由 `maxChars` 管）。
 *
 * 32MB 够装一份几百页、带图的 PDF；而一份纯文本剧本通常只有几十 KB。
 */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/**
 * 默认交给模型的正文上限（字符）。
 *
 * 与 `webSearch.fetchTextMaxChars` 的出厂值同量级（20000），但**刻意不做成配置项**：
 * `web_fetch` 那个旋钮是用户明确要求加的（他要拿它当资料检索），而这里是"读一份文件"，
 * 超限时的做法是**把"共 N 字"说出来**（见工具侧），模型据此知道自己只看到开头。
 */
export const MAX_DOCUMENT_CHARS = 20_000;

const FORMATS: readonly DocumentFormat[] = ['pdf', 'docx', 'text'];

/** 格式的中文名。给工具结果里的表头用 —— 模型看到"PDF，12 页"比看到 `pdf` 更有用。 */
export const FORMAT_LABEL: Record<DocumentFormat, string> = {
  pdf: 'PDF',
  docx: 'Word 文档',
  text: '文本'
};

export interface ExtractOptions {
  maxChars?: number;
  /** 注入点，只给套件用（生产路径不传）。 */
  spawn?: DocumentSpawnLike;
  timeoutMs?: number;
}

/**
 * 把一段字节抽成文本。**失败一律抛 `DocumentError`**（带 code）：
 *   • `MISSING_PDF_LIB` —— 没装 pypdf，**装完就能读**（文案里带怎么装）；
 *   • 其余 —— 这份文件本身读不了（加密 / 扫描件 / 不是支持的格式…）。
 * 两者必须分得开，否则用户会拿着一个本来能读的 PDF 反复重传。
 */
export async function extractDocumentText(buffer: Buffer, options: ExtractOptions = {}): Promise<DocumentText> {
  const maxChars = Math.max(1, Math.round(Number(options.maxChars) || MAX_DOCUMENT_CHARS));
  if (!buffer.length) throw new DocumentError('EMPTY', '这个文件是空的');

  const frame = await extractWithPython(buffer, {
    maxChars,
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });

  const format = frame.format as DocumentFormat;
  if (!FORMATS.includes(format)) {
    // Python 只吐那三种；吐了别的说明两边版本对不上（升级时漏了一处）。
    // **不能**猜一个默认格式糊过去 —— 那会让"格式对不对"这件事从此没人能发现。
    throw new DocumentError('BAD_FRAME', `抽取器返回了不认识的格式「${frame.format}」（Node 与 Python 两侧版本可能对不上）`);
  }

  return {
    format,
    text: frame.text,
    chars: frame.chars,
    truncated: frame.truncated,
    ...(frame.pages === undefined ? {} : { pages: frame.pages }),
    ...(frame.encoding === undefined ? {} : { encoding: frame.encoding })
  };
}
