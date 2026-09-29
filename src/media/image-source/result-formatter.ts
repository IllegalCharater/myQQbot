import type { ImageSourceResult } from './types.js';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mmss = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * 置信度那一行：**引擎报了才印**。
 *
 * 判据是"字段在不在"，不是"值是否非零" —— 与上面 `time` 那个 `00:00` 是同一条规矩。网页类引擎
 * （百度识图那条兜底路）**根本不返回置信度**，若照旧无条件插值，`pct(undefined)` 会算出
 * `NaN%`：群里看到的是一行像模像样的"相似度 NaN%"，比不印更糟。而 `0` 是合法值（真有一条 0%
 * 的结果），所以判据不能写成 `result.similarity || ''`。
 */
const scoreLine = (label: string, result: ImageSourceResult) =>
  result.similarity != null && Number.isFinite(result.similarity) ? `${label}：${pct(result.similarity)}` : '';

/**
 * 展示层兜底：`title` 现在是可选字段（数据层不再编造名字，见 `types.ts`），
 * 而这里把它直接插进模板串 —— 不兜就会给群里印出字面量 `undefined`。
 *
 * 兜底放在**展示层**而不是数据层，是为了让"接口没给名字"这件事在存档与日志里保持
 * 可分辨：编出来的名字一旦写进数据，事后没人分得清它是不是真的。
 */
export function formatImageSourceResult(result: ImageSourceResult | null): string {
  if (!result) return '没找到可靠图源，可能是裁剪图、二次编辑图，或者不在当前索引库里。';
  return result.kind === 'anime' ? formatAnime(result) : formatIllustration(result);
}

/**
 * **模型的输入文本由这里唯一决定**，这是它作为"展示层"的全部职责：`ImageSourceResult` 的
 * 字段无论由哪个引擎、经由哪一层填出来，到这里都只剩这几行字。上层（工具与模型）**不感知**
 * 引擎差异、Python 字段名、原始响应形状——所以新增引擎时正确做法是让它的字段落进
 * `ImageSourceResult` 已有的槽位，而不是在这里长一个 `if (provider === …)`。
 *
 * ⚠️ 动画分支的"第几集"与"第几分几秒"是两条**独立**信息，不能合并成一条无条件输出：
 * 上一个版本写死 `Math.max(0, Math.floor(result.time || 0))` 并总是打印它，于是**没有时间戳
 * 的结果会印出 `00:00`** —— 一个凭空出现的"第 0 分 0 秒"，与"接口没给"在群里长得一模一样。
 * 判据是"字段在不在"（`!= null`），不是"值是否非零"：`time === 0` 是合法值（正好是片头）。
 */
function formatAnime(result: ImageSourceResult): string {
  const at = result.time != null && Number.isFinite(result.time) ? mmss(Math.max(0, Math.floor(result.time))) : '';
  const when = result.episode ? (at ? `第 ${result.episode} 集，${at}` : `第 ${result.episode} 集`) : at;
  return [
    `可能是《${result.title || '未知作品'}》`,
    when,
    scoreLine('匹配度', result),
    result.url ? `链接：${result.url}` : ''
  ].filter(Boolean).join('\n');
}

function formatIllustration(result: ImageSourceResult): string {
  return [
    `可能来源：${result.title || '未知来源'}`,
    result.author ? `画师：${result.author}` : '',
    result.source ? `来源：${result.source}` : '',
    scoreLine('相似度', result),
    result.url ? `链接：${result.url}` : ''
  ].filter(Boolean).join('\n');
}
