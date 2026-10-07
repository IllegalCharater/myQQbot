// `/转写` 命令的解析与目标媒体的定位。
//
// 这一层是**只读、无副作用**的：把一句话解析成一个 URL，或者抛出一条可执行的用法提示。
// 真正的取值/识别在 `extract.ts` 与 `recognize.ts`。
import { TranscriptionError } from './errors.js';
import { isPrivateIp } from '../safe-fetch.js';
import type { TranscriptionMedia } from './types.js';

/** 只做无需 DNS 的快速校验；worker 访问时还会做逐跳 DNS/重定向校验。 */
export function normalizeTranscriptionUrl(raw: unknown): string {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new TranscriptionError('validation', 'INVALID_URL', '无法访问链接：URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TranscriptionError('validation', 'INVALID_PROTOCOL', '无法访问链接：仅支持 http/https');
  }
  if (url.username || url.password) {
    throw new TranscriptionError('validation', 'URL_CREDENTIALS', '无法访问链接：URL 不能包含凭据');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateIp(host)) {
    throw new TranscriptionError('validation', 'PRIVATE_ADDRESS', '无法访问链接：禁止内网或本机地址');
  }
  return url.toString();
}

/**
 * 从 media 里挑出可以被转写的那一条。
 *
 * 认**两种** kind，缺一种就会有一整类消息报"没有视频链接"：
 *   · `'video'` —— 视频段，以及**分享卡片补出来的定位**（B 站分享页也不是流地址，要再解析）；
 *   · `'audio'` —— 语音段（本身就带 url，不需要解析）。
 *
 * ⚠️ 判据必须与 `agent/tools/transcription.ts` 里那一处**同形**：两处是同一个问题的两个入口
 * （`/转写` 命令与模型自主调用的 `transcribe_video`），一边放宽另一边没放，
 * 表现就是"命令能跑、工具说没有" —— 那种不一致没人会去核对。
 */
export function findTranscriptionMedia(media: TranscriptionMedia[] = []): string {
  const hit = media.find((item) => (item?.kind === 'video' || item?.kind === 'audio')
    && typeof item.url === 'string' && item.url.trim());
  return hit?.url ? hit.url : '';
}

/**
 * 解析 `/转写` 命令：返回要转写的 URL，**不是这条命令**时返回 `null`。
 *
 * 显式 URL 优先；没写 URL 时从同一条消息的 media 里取（`[视频]` 占位符先剥掉 ——
 * OneBot 的 video 段会被通用文本化逻辑渲染成尾部 `[视频]`，不剥的话查询词里会带上它）。
 */
export function parseTranscriptionCommand(text: unknown, media: TranscriptionMedia[] = []): string | null {
  const value = String(text ?? '').trim().replace(/(?:\[视频\])+$/u, '').trim();
  const match = /^\/转写(?:\s+(.+))?$/su.exec(value);
  if (!match) return null;
  const explicit = String(match[1] || '').trim();
  if (explicit) return normalizeTranscriptionUrl(explicit);
  const target = findTranscriptionMedia(media);
  if (target) return normalizeTranscriptionUrl(target);
  throw new TranscriptionError('validation', 'MISSING_URL', '用法：/转写 <视频URL>');
}
