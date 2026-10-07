// B 站的 provider：把 `parsers/bilibili.ts` 那套平台知识接进通用契约。
//
// 这个文件**刻意很薄** —— 真正的解析（短链展开、API 调用、挑音频流、CDN Referer）全在
// `parsers/bilibili.ts` 里，且它有完整的套件覆盖（`t-transcription.mjs`）。这里只做两件事：
//   ① 把"json / xml 卡片报文"这种**协议端形态**翻译成 B 站自己的两个提取函数；
//   ② 把 `resolveBilibiliMedia` 的返回贴上 provider 的名字。
//
// ⚠️ **协议端形态与平台实现必须分家**（`providers/` 与 `parsers/`）：QQ 小程序的字段名
// （`qqdocurl` / `jumpUrl`）跟着**协议端**变，而接口与选择器跟着**站点改版**变。
// 合成一个文件时"加一个平台"会变成"在一个文件里同时改两件事"，而它们的改动理由完全不同。
import {
  isBilibiliUrl,
  bilibiliUrlFromCandidates,
  resolveBilibiliMedia,
  type ResolvedMediaSource
} from '../parsers/bilibili.js';
import { cardPayloadCandidates, xmlPayloadCandidates } from './card-payload.js';
import type { MediaSource, MediaSourceProvider, SegmentInput } from '../types.js';

/**
 * 已知卡片字段名，按命中优先级排列。
 *
 * `qqdocurl` 排第一：**B 站 App 分享出来的小程序卡片只有它**（没有 `jumpUrl`，
 * 那是老式 news 卡片的字段）。只认 jumpUrl 的后果是"卡片看着有链接、存档里却没有"——
 * `/转写` 与 `transcribe_video` 都靠 media 里的地址定位目标，于是两者都报"没有视频链接"。
 *
 * ⚠️ 这份表是**协议端知识**，所以它在本文件（适配器）而不在 `parsers/`；
 * 而"把报文摊平成候选"那件事在 `qq/card-payload.ts`（更靠协议端那一侧）。
 */
const CARD_URL_FIELDS = ['qqdocurl', 'jumpUrl', 'url'] as const;

export const bilibiliMediaProvider: MediaSourceProvider = {
  name: 'bilibili',
  title: 'B 站分享卡片 / 视频页',

  /**
   * 从 json 或 xml 卡片里取 B 站链接。
   *
   * **两条路都要走**，因为覆盖的形态不同：json 那条认得通用卡片解析认不出的
   * `meta.detail_1.qqdocurl`；xml 那条认得部分协议端下发成 `xml` 段的分享卡
   * （通用解析层完全不认这个段、不产生任何 media）。两者都是纯函数、不发请求。
   */
  extract(segment: SegmentInput): string | null {
    const payload = segment.type === 'json'
      ? cardPayloadCandidates(segment.data)
      : xmlPayloadCandidates(segment.data.data ?? segment.data.string);
    return bilibiliUrlFromCandidates(payload, CARD_URL_FIELDS) || null;
  },

  owns(raw: string): boolean {
    return isBilibiliUrl(raw);
  },

  async resolve(raw: string, signal: AbortSignal, maxDurationSeconds: number): Promise<MediaSource> {
    const resolved: ResolvedMediaSource = await resolveBilibiliMedia(raw, signal, maxDurationSeconds);
    return { url: resolved.url, ...(resolved.headers ? { headers: resolved.headers } : {}) };
  }
};
