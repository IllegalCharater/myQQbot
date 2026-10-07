// 协议端**卡片报文**的通用摊平：把卡片摊成"白名单字段 + 全部候选链接"，供平台 provider 挑。
//
// ── 为什么它在 `media-source/providers/` 而不是 `qq/` ──
//
// 直觉上"卡片字段名"属于协议端（`src/qq/`），但**跨不过去**：`check-layers.mjs` 的 T1 白名单
// 是空的，`media/` 横向 import `qq/` 会被直接打回（实测：`media/media-source/providers/bilibili.ts
// -> qq/card-payload.js: T1 领域间引用未登记精确白名单`）。这不是可以绕的障碍，而是一条**刻意的
// 边界**：`media/` 是"给 Bot 用的可选能力"，它不该依赖某个协议端的实现。
//
// 所以分层按"**改动理由**"切，而不是按"字面上谁属于谁"：
//   · 本文件 —— 纯数据摊平，**完全不认识任何平台**（判据只有"是 http(s) 且长度合规"）；
//   · `providers/<平台>.ts` —— 知道**协议端字段名**（`qqdocurl` / `jumpUrl`）与该平台的域名。
//   · `parsers/<平台>.ts`  —— 平台自己的接口与解析，**判据里不许出现卡片字段名**。
//
// 这与 `qq/onebot.ts` 里已有的 `parseCardSegment` 是两件事：那个产出**给人看的文本 + 通用媒体**
// （只认 `jumpUrl`，老式 news 卡片的字段）。本文件产出**给平台层用的候选链接**，因此还要覆盖
// 它认不出的形态：小程序卡片（链接只在 `qqdocurl`）与 xml 分享卡（通用解析完全不认这个段）。

/** 报文长度上限：卡片 JSON 常见几百字节，32KB 已宽到不可能误伤。 */
const CARD_PAYLOAD_MAX = 32 * 1024;
/** 单个候选链接的长度上限。 */
const CARD_URL_MAX = 300;
/**
 * 下探边界。字段名穷举不完（真实卡片 `com.tencent.miniapp_01` 的
 * `view_8C8E89B49BE609866298ADDFF2DBABA4` 就是白名单之外的形态），所以要有兜底扫描。
 * 扫不出链接的代价是"卡片看着有链接、机器人说没有"，所以宁可多扫一层 ——
 * 扫描不改任何状态、不发任何请求。
 */
const CARD_SCAN_MAX_DEPTH = 4;
const CARD_SCAN_MAX_NODES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 摊平的产物：白名单字段名 → 值，外加所有像 http(s) 地址的字符串（兜底召回）。 */
export interface CardPayload {
  fields: Record<string, string>;
  urls: string[];
}

const EMPTY: CardPayload = { fields: {}, urls: [] };

/**
 * 摊平一张 json 卡片报文。
 *
 * 顶层与 `meta` 的每个子对象都收一遍（卡片正文常在 `meta.detail_1` / `meta.news` /
 * `meta.miniapp` 里），只认顶层会漏掉小程序卡片。返回值**不含任何平台判定**。
 */
export function cardPayloadCandidates(value: unknown): CardPayload {
  const fields: Record<string, string> = {};
  const urls: string[] = [];
  const data = isRecord(value) ? value : {};
  const raw = data.data;
  let payload: Record<string, unknown> | null = null;
  if (isRecord(raw)) {
    payload = raw;   // 有的协议端直接给已解析好的对象
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s.length > CARD_PAYLOAD_MAX) return EMPTY;
    try {
      const parsed: unknown = JSON.parse(s);
      if (isRecord(parsed)) payload = parsed;
    } catch { return EMPTY; }
  }
  if (!payload) return EMPTY;

  const bodies: Array<Record<string, unknown>> = [payload];
  const meta = payload.meta;
  if (isRecord(meta)) {
    for (const key of Object.keys(meta)) {
      const child = meta[key];
      if (isRecord(child)) bodies.push(child);
    }
  }
  for (const body of bodies) {
    for (const [key, item] of Object.entries(body)) {
      const text = httpishField(item);
      if (!text) continue;
      if (!(key in fields)) fields[key] = text;
    }
  }
  scanForUrls(payload, urls);
  return { fields, urls: [...new Set(urls)] };
}

/**
 * 摊平一张 xml 分享卡。
 *
 * 不解析 XML 结构，只把 `http(s)://…` 逐个挑出来：xml 卡片的正文同样是协议端的私有约定，
 * 按标签名取值只会更脆。`&amp;` 先还原，否则带参数的链接会被当成另一个地址。
 */
export function xmlPayloadCandidates(value: unknown): CardPayload {
  const xml = typeof value === 'string' ? value : '';
  if (!xml || xml.length > CARD_PAYLOAD_MAX) return EMPTY;
  const decoded = xml.replace(/&amp;/g, '&');
  const urls: string[] = [];
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
    const hit = httpishField(match[0]);
    if (hit) urls.push(hit);
  }
  return { fields: {}, urls: [...new Set(urls)] };
}

/** 只收 http(s)、长度合规的值；其余（`mqqapi://` 之类）一律丢弃。 */
function httpishField(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const s = String(value).trim().slice(0, CARD_URL_MAX);
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

/** 定深扫描所有字符串值，收 http(s) 地址。 */
function scanForUrls(value: unknown, out: string[], depth = 0, budget = { nodes: CARD_SCAN_MAX_NODES }): void {
  if (depth > CARD_SCAN_MAX_DEPTH || budget.nodes <= 0) return;
  budget.nodes -= 1;
  const leaf = httpishField(value);
  if (leaf) { out.push(leaf); return; }
  if (Array.isArray(value)) {
    for (const item of value) scanForUrls(item, out, depth + 1, budget);
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) scanForUrls(value[key], out, depth + 1, budget);
  }
}
