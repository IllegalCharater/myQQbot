// 图像生成配置的解析与钳制。
//
// **钳制只在这一处**（转写同样没有 `normalizeConfigShape` 分支）：设置页侧另有一份同口径的
// 钳制，两处必须一起改 —— 漂移的表现是"我填了 5000 却按别的数走"，没人会去比两边源码。
import type { AppConfig } from '../../core/config.js';
import type { EffectiveConfig } from './types.js';

/** 文档列出的四个模型（**只用于设置页下拉与默认值**，解析时不设白名单）。 */
export const IMAGE_GEN_MODELS = [
  'qwen-image-2.1-turbo',
  'qwen-image-2.1-pro',
  'qwen-image-3.0',
  'qwen-image-3.0-pro'
] as const;

export const DEFAULT_IMAGE_GEN_MODEL = 'qwen-image-2.1-turbo';
export const DEFAULT_IMAGE_GEN_BASE_URL = 'https://dashscope.aliyuncs.com';

const MIB = 1024 * 1024;

function envString(name: string): string {
  return String(process.env[name] || '').trim();
}

/** 读一个整数配置：非法值回落 `fallback`，否则钳进 `[min, max]`。 */
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/**
 * 这个模型支不支持 `negative_prompt`。
 *
 * 官方文档写明"仅 qwen-image-3.0 系列支持此参数"，而多传一个它不认的参数会被判 400 ——
 * 于是**一条与模型无关的配置项能让 2.1 系列直接出不了图**。所以这一条不是风格偏好，
 * 是把"参数与该模型是否匹配"收在一个地方（`client.ts` 只调它，不自己判前缀）。
 */
export function supportsNegativePrompt(model: unknown): boolean {
  return String(model ?? '').trim().toLowerCase().startsWith('qwen-image-3.0');
}

/**
 * 归一化接口地址。
 *
 * 用户可能照文档把**整条 endpoint** 粘进来（`https://x.maas.aliyuncs.com/api/v1/services/…`），
 * 也可能只填域名 —— 两种都要能用，所以在 `/api/v1/` / `/compatible-mode/` 处截断并去掉尾斜杠。
 * 这里**不校验协议**：那一步在 `enqueue`（一次 `new URL`），失败时给的是可执行的那句话，
 * 而不是让 `fetch` 抛一句 `Failed to parse URL`。
 */
export function normalizeBaseUrl(raw: unknown): string {
  let value = String(raw ?? '').trim();
  if (!value) return DEFAULT_IMAGE_GEN_BASE_URL;
  const cut = value.search(/\/(?:api\/v1|compatible-mode)\b/i);
  if (cut > 0) value = value.slice(0, cut);
  value = value.replace(/\/+$/, '');
  return value || DEFAULT_IMAGE_GEN_BASE_URL;
}

/**
 * 归一化尺寸。
 *
 * 官方文档专门警告过两套协议的**分隔符不同**：DashScope 用星号（`1024*1024`），OpenAI 兼容
 * 用字母 x（`1024x1024`）。用户从别处抄一个 `1024x1024` 进来是很自然的事，所以这里把
 * `x`/`X`/`×` 一律换成星号 —— 不换的话每张图都 400，而设置页看起来完全正常。
 *
 * 认不出格式（或填了 `auto`）→ 返回空串，含义是"不传这个参数"，与 `auto` 等价。
 * 像素范围（512²~2048²）刻意**不由我们拦**：越界的表现是接口返回一条明确的 400，
 * 比我们悄悄改成 auto、用户以为设置生效了要好。
 */
export function normalizeSize(raw: unknown): string {
  const value = String(raw ?? '').trim();
  if (!value || value.toLowerCase() === 'auto') return '';
  const normalized = value.replace(/[xX×*]/g, '*');
  return /^\d{1,4}\*\d{1,4}$/.test(normalized) ? normalized : '';
}

/** 配置值优先、环境变量回退（与转写、搜图 API Key 的读取方式一致）。 */
export function resolveImageGenConfig(config: AppConfig): EffectiveConfig {
  const raw = config.imageGen || ({} as NonNullable<AppConfig['imageGen']>);
  const maxStyleChars = boundedInt(raw.maxStyleChars, 200, 0, 500);
  const stylePrompt = String(raw.stylePrompt ?? '').trim().slice(0, maxStyleChars);
  return {
    enabled: raw.enabled === true,
    // 环境变量名与官方文档示例同名；控制台配置响应里会被通用脱敏成 hasApiKey。
    apiKey: String(raw.apiKey || envString('DASHSCOPE_API_KEY')).trim(),
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    model: String(raw.model || '').trim() || DEFAULT_IMAGE_GEN_MODEL,
    size: normalizeSize(raw.size),
    // 两个布尔都是"默认开/默认关"的显式表达，不用真值判断（`"false"` 这种畸形值不该把水印打开）。
    promptExtend: raw.promptExtend !== false,
    watermark: raw.watermark === true,
    negativePrompt: String(raw.negativePrompt ?? '').trim().slice(0, 500),
    stylePrompt,
    timeoutMs: boundedInt(raw.timeoutMs, 300_000, 30_000, 900_000),
    maxPromptChars: boundedInt(raw.maxPromptChars, 1200, 50, 4000),
    maxStyleChars,
    // 参考图上限顶到 10 MiB：官方要求单张不超过 10MB，配置只能进一步收紧。
    maxRefImageBytes: boundedInt(raw.maxRefImageBytes, 8 * MIB, 1 * MIB, 10 * MIB),
    // 结果图是 PNG，2048×2048 的照片类内容实测能到十几 MB，默认给 20 MiB。
    maxDownloadBytes: boundedInt(raw.maxDownloadBytes, 20 * MIB, 1 * MIB, 64 * MIB),
    // 模型自主调用与 `/画` 命令**共用**这两个上限（见 queue.ts 的 enqueue）。出图按张计费，
    // 默认值比搜图（5/30）紧、与转写（3/10）同档。
    maxCallsPerChatPerHour: boundedInt(raw.maxCallsPerChatPerHour, 3, 1, 60),
    maxCallsPerDay: boundedInt(raw.maxCallsPerDay, 20, 1, 1000)
  };
}
