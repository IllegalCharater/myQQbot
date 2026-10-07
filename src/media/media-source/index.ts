// provider 清单与两个分发函数：接入层只调 `extractMediaFrom*`，转写层只调 `resolveMediaSource`。
// **平台知识不在这里**，它各自在 `providers/` 下。
//
// 清单**逐行写明**（照 `image-source` 的 `ENGINE_ROWS` / `ORDER` 那条规矩）：顺序即语义，
// 不该由"按 name 排序"这类现成规则替加 provider 的人做决定。
import type { MediaCandidate, MediaSource, MediaSourceProvider, SegmentInput } from './types.js';
import { bilibiliMediaProvider } from './providers/bilibili.js';

/**
 * 全部 provider，**顺序即认领优先级**。
 *
 * 加一个平台 = 加一个 `providers/<x>.ts` + 在下面加一行。顺序在平台互斥时不影响结果
 * （各自判自己的域名），但**同一个地址被两个 provider 都认领时必须先到先得**，
 * 所以别用"按名字排序"来生成这张表。
 */
export const MEDIA_SOURCE_PROVIDERS: readonly MediaSourceProvider[] = [
  bilibiliMediaProvider
];

/** 认领一个**裸地址**的 provider（没有则 `null`）。纯函数、不发请求。 */
export function mediaSourceProviderFor(raw: unknown): MediaSourceProvider | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  for (const provider of MEDIA_SOURCE_PROVIDERS) {
    try {
      if (provider.owns(value)) return provider;
    } catch {
      // provider 是第三方地址的判定器，畸形输入不该让整条消息落不了库。
      continue;
    }
  }
  return null;
}

/**
 * 把一个**已经在手边的地址**归一成 media 条目；不归任何 provider 时返回 `null`。
 *
 * 用于"通用卡片解析已经把链接放进 media.url，但下游只认 `kind:'video'`"这条缝
 * （见 `ingest.ts` 的 `addVideoAliases`）。
 */
export function mediaCandidateFromUrl(raw: unknown): MediaCandidate | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const provider = mediaSourceProviderFor(value);
  if (!provider) return null;
  return { kind: 'video', url: value, source: provider.name };
}

/**
 * 从一条消息段里认出媒体；认不出返回 `null`。
 *
 * **纯函数、不发请求**：调用方在接入层的串行摄取链上（见 `ingest.ts` 的 `enqueueIngest`），
 * 任何网络往返都会推迟所有后到消息的落库。
 *
 * 第一个认领的 provider 胜出。只处理 json / xml 段 —— 别的段由
 * `extractMediaFromSegments` 那条通用解析管，不该在这里重复。
 */
export function extractMediaFromSegment(segment: SegmentInput): MediaCandidate | null {
  if (segment.type !== 'json' && segment.type !== 'xml') return null;
  for (const provider of MEDIA_SOURCE_PROVIDERS) {
    let url: string | null = null;
    try {
      url = provider.extract(segment);
    } catch {
      continue;
    }
    if (url) return { kind: 'video', url, source: provider.name };
  }
  return null;
}

/** 从一串消息段里认出所有媒体（按 url 去重）。 */
export function extractMediaFromSegments(segments: unknown): MediaCandidate[] {
  const out: MediaCandidate[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(segments) ? segments : []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    if (typeof raw.type !== 'string') continue;
    if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) continue;
    const hit = extractMediaFromSegment({ type: raw.type, data: raw.data as Record<string, unknown> });
    if (!hit || seen.has(hit.url)) continue;
    seen.add(hit.url);
    out.push(hit);
  }
  return out;
}

/**
 * 把媒体地址变成**可直接播放的流地址**。
 *
 * 没有 provider 认领时**原样返回**（`{ url }`）—— 这是本函数与 provider 的 `resolve`
 * 的分工：直接指向媒体文件的地址（.mp4 / .m4a）本来就不需要解析，逼它先过一个 provider
 * 只会让"普通视频链接"也走一遍没必要的分支。
 *
 * 只在显式命令路径（`/转写`）上调用，所以允许发请求。provider 的报错**不在这里 catch**：
 * 它带可机检的 code，转写层要按 code 分失败阶段。
 */
export async function resolveMediaSource(
  raw: string,
  signal: AbortSignal,
  maxDurationSeconds: number
): Promise<MediaSource> {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('媒体地址为空');
  const provider = mediaSourceProviderFor(value);
  if (!provider?.resolve) return { url: value };
  return provider.resolve(value, signal, maxDurationSeconds);
}

export * from './types.js';
