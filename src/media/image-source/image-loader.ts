import { safeFetchBinary, detectMime } from '../safe-fetch.js';

/**
 * 安全下载一张图：SSRF 防护、大小上限、格式识别都在这儿。
 *
 * `signal` **可选**：其它调用方（比如工具侧先探一下图能不能用）不传它，行为与从前逐字相同。
 * 搜图服务层会传 —— 它要能撤掉一次已经没预算的下载（否则"下载慢"会拖到整轮死线，报出来的是
 * `TOTAL_TIMEOUT`，而文案写的是"图源接口响应太慢"，归因是错的）。
 *
 * 它**不负责超时**：预算是服务层的概念，这里只在收到 abort 时停手。所以下载超时由服务层抛
 * `IMAGE_TIMEOUT`（见 `reverse-image-source-service.ts` 的 `#loadImage`）。
 */
export async function loadSafeImage(url: unknown, maxBytes: number, signal?: AbortSignal): Promise<{ buffer: Buffer; mime: string }> {
  const { buffer } = await safeFetchBinary(url, maxBytes + 1, signal);
  if (buffer.length > maxBytes) throw new Error('IMAGE_TOO_LARGE');
  if (!buffer.length) throw new Error('IMAGE_EMPTY');
  const mime = detectMime(buffer);
  if (!mime) throw new Error('IMAGE_FORMAT');
  return { buffer, mime };
}
