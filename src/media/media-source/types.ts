// 音视频来源的**通用契约**：一个平台实现一个 `MediaSourceProvider`，接入层与转写层只认这个接口。
//
// ── 为什么要有这一层（**实测**踩过的形状）──
//
// 在它之前，"从消息里认出视频"这件事**写死在接入层**：`ingest.ts` 里两个函数
// （`addBilibiliVideoAliases` / `addBilibiliCardLinks`）直接调 B 站自己的三个解析函数。
// 于是**加一个平台要改接入层**，而接入层里那些"通用卡片解析认不出的形态"（小程序卡片、
// xml 分享卡）是 QQ/协议端的私有约定，本就不该让 `web/onebot/` 去认识 B 站。
//
// 同一件事在转写那一侧也是写死的：`video-transcription.ts` 直接 import
// `resolveBilibiliMedia`。两条路各写一次平台知识 = 加平台时必漏一处。
//
// ── 三层分工，别混 ──
//
//   1. **定位**（`extract`）—— 从消息段的原始报文里找出"可交给别人处理的媒体地址"。
//      纯函数、**不发任何网络请求**（接入层在消息收发的关键路径上，这里发请求会拖慢落库）。
//   2. **识别**（`matches`）—— 这个地址归不归本 provider 管。
//   3. **解析**（`resolve`）—— 把分享页地址变成**可直接播放的流地址**（可能要发请求）。
//      只有走 `/转写` 那条显式命令时才会被调用，所以它可以慢。
//
// 这样分层之后，接入层只做 1，转写层只做 2+3，两边共用同一份 provider 清单。

/** 可直接交给 FFmpeg / 识别服务的媒体源。 */
export interface MediaSource {
  url: string;
  /** 播放该地址所需的请求头（如 B 站 CDN 校验 Referer）。**必须是代码内固定值**，不接受卡片注入。 */
  headers?: Record<string, string>;
}

/**
 * 从消息里认出的一条媒体，**已归一**成存档里 `MediaEntry` 的形状。
 *
 * `kind` 是**给下游找它用的标签**，不是"文件的真实类型"：当前转写与 `/转写` 都按
 * `kind === 'video'` 定位（`video-transcription.ts` 与 `agent/tools/transcription.ts`），
 * 所以分享页/外链这类"还要再解析一次"的**定位**一律标 `'video'`。
 * `'audio'` 留给"本身就是音频流、不需要解析"的来源（如后续的语音识别）。
 */
export interface MediaCandidate {
  kind: string;
  url: string;
  /** 哪个 provider 认出来的（写进 media 条目的 `source`，便于排查"这个链接是谁找出来的"）。 */
  source: string;
}

/** `extract` 的入参：一条消息段。`type` 是 OneBot 段名（json / xml / text / …）。 */
export interface SegmentInput {
  type: string;
  /** 段的 `data`（已确认是对象；调用方负责过 `isRecord` 这道关）。 */
  data: Record<string, unknown>;
}

export interface MediaSourceProvider {
  /** provider 名，同时用作 media 条目的 `source`（形如 `bilibili`）。 */
  readonly name: string;
  /** 人读的说明，只用于日志与文档。 */
  readonly title: string;
  /**
   * 从一条消息段里找出媒体地址；不是本平台返回 `null`。
   *
   * **必须是纯函数**：不发请求、不写全局状态。它在接入层的串行摄取链里被调用，
   * 任何网络往返都会推迟所有后到的消息落库（见 `ingest.ts` 的 `enqueueIngest` 注释）。
   */
  extract(segment: SegmentInput): string | null;
  /**
   * 这个**裸地址**归不归本 provider。
   *
   * 与 `extract` 是两条入口，**不能互相替代**：`extract` 走的是"协议端报文形态"
   * （QQ 卡片字段名），这个走的是"已经拿到一个 URL、只问是不是我的"。通用卡片解析
   * 已经把链接放进 `media` 条目的 `url` 里时，只有这个能接上（拿那个 url 去伪造一段
   * card 报文是错的形状，且卡片字段名与目标 url 未必同形）。
   *
   * 纯函数。既是"能认领"也是"能解析"的判据 —— 认领了却解不了没有意义。
   */
  owns(raw: string): boolean;
  /**
   * 分享页地址 → 可直接播放的媒体源。
   *
   * 只在显式命令路径上调用，所以允许发请求。抛出的错误应当带**可机检的 code**
   * （照 `BilibiliResolveError` 的形状），转写层按 code 决定失败阶段。
   *
   * 没有这个方法 = `owns` 为真的地址**原样当媒体源用**（本身就是流地址的平台）。
   */
  resolve?(raw: string, signal: AbortSignal, maxDurationSeconds: number): Promise<MediaSource>;
}
