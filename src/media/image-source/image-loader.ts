import { safeFetchBinary, detectMime } from '../safe-fetch.js';

export async function loadSafeImage(url: unknown, maxBytes: number): Promise<{ buffer: Buffer; mime: string }> {
  const { buffer } = await safeFetchBinary(url, maxBytes + 1);
  if (buffer.length > maxBytes) throw new Error('IMAGE_TOO_LARGE');
  if (!buffer.length) throw new Error('IMAGE_EMPTY');
  const mime = detectMime(buffer);
  if (!mime) throw new Error('IMAGE_FORMAT');
  return { buffer, mime };
}
