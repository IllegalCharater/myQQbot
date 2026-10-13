// 图像生成的两条取图路径：进来的参考图（图生图入参）与出去的结果图（要发进群的那张）。
//
// 放同一个文件是因为它们**只有一个共同点、也只有这一个共同点值得写一遍**：把一张网络图片
// 安全地取回本机 —— SSRF 校验、大小上限、格式识别。差别只在编码方向（data URL / 落盘）。
//
// ⚠️ **`safeFetchBinary` 到量就截断，它不抛**。截断出来的 PNG 是一张坏图（QQ 那边会显示
// 破图，看起来像"模型画坏了"），所以必须靠"读满了"这一件事把它认出来 —— 这就是
// `maxBytes + 1` 的来由。`media/image-source/image-loader.ts` 用的是同一手法；
// 这里另写一份而不是 import 它，是因为 `media/` 内部的约定是"功能目录之间不互相依赖，
// 只横向引用共享的平铺助手"（safe-fetch / call-budget / media-source）。
import fsp from 'node:fs/promises';
import { detectMime, safeFetchBinary } from '../safe-fetch.js';
import { ImageGenError, safeErrorCode } from './errors.js';
import type { FailureStage } from './types.js';

const MIB = 1024 * 1024;

/** 下载一张图并校验大小与格式。失败一律转成带阶段的 `ImageGenError`。 */
async function fetchImageBuffer(
  url: unknown, maxBytes: number, stage: FailureStage,
  { failText, tooLargeText, emptyText }: { failText: string; tooLargeText: string; emptyText: string },
  signal: AbortSignal
): Promise<Buffer> {
  let buffer: Buffer;
  try {
    // `+1`：见文件头。多读一个字节才能区分"正好这么大"与"被截断了"。
    ({ buffer } = await safeFetchBinary(url, maxBytes + 1, signal));
  } catch (error) {
    // 取消优先于一切：关停是**我们**主动做的，不该报成"下载失败"（与转写同一取舍）。
    if (signal.aborted) throw new ImageGenError(stage, 'CANCELLED', '任务已取消');
    throw new ImageGenError(stage, safeErrorCode(error), failText);
  }
  if (signal.aborted) throw new ImageGenError(stage, 'CANCELLED', '任务已取消');
  if (buffer.length > maxBytes) {
    throw new ImageGenError(stage, 'IMAGE_TOO_LARGE', `${tooLargeText}（超过 ${Math.round(maxBytes / MIB)}MB）`);
  }
  if (!buffer.length) throw new ImageGenError(stage, 'IMAGE_EMPTY', emptyText);
  if (!detectMime(buffer)) throw new ImageGenError(stage, 'IMAGE_FORMAT', '图片格式认不出来，这次没画成');
  return buffer;
}

/**
 * 取回参考图并转成 `data:<mime>;base64,…`（图生图的入参格式）。
 *
 * 判据与 `safeFetchBinary` 一致：公网 http(s)、拒内网（`security.allowPrivateImageHosts`
 * 为 true 时放行，仅供本地测试与自建图床）。
 */
export async function fetchReferenceImage(url: unknown, maxBytes: number, signal: AbortSignal): Promise<string> {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  const buffer = await fetchImageBuffer(raw, maxBytes, 'fetching', {
    failText: '参考图下载失败（链接可能已失效，让群友重发一次）',
    tooLargeText: '参考图太大',
    emptyText: '参考图内容为空'
  }, signal);
  const mime = detectMime(buffer) || 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 把生成的图片下载到本机文件，返回字节数。
 *
 * **必须落盘再发**：结果 URL 只有 24 小时有效期，而 QQ 的图片段收本机路径 ——
 * 直接把 URL 交给协议端，等于把"能不能发出去"押在一条会过期的链接上。
 * （协议端明确拒绝本机路径时仍有一步退回该 URL 的兜底，见 `queue.ts` 的 `#deliver`。）
 */
export async function downloadImageToFile(
  url: unknown, maxBytes: number, signal: AbortSignal, filePath: string
): Promise<number> {
  const buffer = await fetchImageBuffer(url, maxBytes, 'downloading', {
    failText: '生成的图片下载失败（结果链接可能已失效）',
    tooLargeText: '生成的图片太大，发不出去',
    emptyText: '生成的图片内容为空'
  }, signal);
  try {
    await fsp.writeFile(filePath, buffer);
  } catch (error) {
    // ⚠️ 必须包成 `ImageGenError`：裸的 fs 异常会一路穿到 `#drain` 的兜底文案，
    // 于是"写不进临时文件"被说成"画图失败，稍后再试"，**阶段与原因一起丢掉**
    // （真机实测踩到过这一支）。码取自 errno（`ENOENT` / `EACCES` / `ENOSPC`…）。
    throw new ImageGenError('downloading', safeErrorCode(error), `图片写不进临时文件（${safeErrorCode(error)}）`);
  }
  return buffer.length;
}
