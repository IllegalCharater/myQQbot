// 百炼 · 千问图像生成的同步调用。
//
// 为什么用**同步**接口而不是文档里另给的异步（`X-DashScope-Async` + `GET /tasks/{id}`）：
// 与转写选极速版是同一条判断 —— 队列本来就是单并发，一条连接挂着等几十秒不占任何别的东西，
// 而异步要多养一个轮询状态机、两份请求体、两套错误面。同步一次省掉全部。
//
// 三件容易静默出错的都收在这里：
//   · **两层提示词只在 `withStyleLayer` 一处合并**（模型给的画面描述 + 管理员风格层）；
//   · `negative_prompt` 只在 3.0 系列出现（多传一个它不认的参数会让 2.1 系列直接 400）；
//   · **失败可能是 HTTP 200**：接口把错误放在响应体的 `code` 里，只看状态码会把
//     "API Key 无效"读成成功，然后卡在"没有返回图片"上，归因完全错。
import { ImageGenError, safeErrorCode, sanitizeCode } from './errors.js';
import { supportsNegativePrompt } from './config.js';
import type { EffectiveConfig } from './types.js';

const MIB = 1024 * 1024;
/** 响应体上限：正常响应只有几 KB（一个 URL + usage），2 MiB 是防网关返回一整页 HTML。 */
const MAX_RESPONSE_BYTES = 2 * MIB;

/** 同步调用的路径（异步那个是 `/api/v1/services/aigc/image-generation/generation`，别混）。 */
export const IMAGE_GEN_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 合并两层提示词：模型给的画面描述 + 管理员配的风格层。
 *
 * **风格层留空时逐字返回模型给的那段**（不是"拼一个空串"）—— 设置页留空就是"不注入"，
 * 这条对照必须有，否则"永远多一个换行"这种毛病看不出来。
 *
 * 风格层对模型**完全不可见**：它一旦出现在给模型看的指令里，模型就会自己把那句话
 * 也写进 prompt，同一句出现两遍（见 core/config.ts 的 imageGen.stylePrompt）。
 */
export function withStyleLayer(prompt: unknown, stylePrompt: unknown): string {
  const body = String(prompt ?? '').trim();
  const style = String(stylePrompt ?? '').trim();
  if (!style) return body;
  return `${body}\n画面风格要求：${style}`;
}

export interface ImageGenInput {
  /** 模型/命令给的画面描述（第一层）。 */
  prompt: string;
  /** 图生图参考图，`data:<mime>;base64,…`；空串 = 文生图。 */
  imageDataUrl?: string;
}

/**
 * 拼请求体。**纯函数**，出图链路的形状全在这里被钉住。
 *
 * 参数名与嵌套照官方文档：`input.messages[].content[]` 里图片在前、文字在后，
 * 其余全在 `parameters` 里平铺（这与 OpenAI 兼容模式"全平铺在顶层"不同，别混）。
 */
export function buildImageGenRequest(config: EffectiveConfig, { prompt, imageDataUrl = '' }: ImageGenInput) {
  const content: Array<Record<string, string>> = [];
  if (imageDataUrl) content.push({ image: imageDataUrl });
  content.push({ text: withStyleLayer(prompt, config.stylePrompt) });

  const parameters: Record<string, unknown> = {
    // 固定一张。额度按"一次调用 = 一张图"记账，模型想多要就多调几次（见 types.ts）。
    n: 1,
    prompt_extend: config.promptExtend,
    watermark: config.watermark
  };
  if (config.size) parameters.size = config.size;
  if (config.negativePrompt && supportsNegativePrompt(config.model)) {
    parameters.negative_prompt = config.negativePrompt;
  }
  return { model: config.model, input: { messages: [{ role: 'user', content }] }, parameters };
}

/** 接口地址 = 归一化过的 baseUrl + 固定路径。 */
export function imageGenEndpoint(baseUrl: unknown): string {
  return `${String(baseUrl ?? '').replace(/\/+$/, '')}${IMAGE_GEN_PATH}`;
}

/**
 * 失败文案：能指向下一步的就说下一步，说不清就只说事实，绝不编原因。
 *
 * 两套错误形状都要认（见 `generateImage` 里那段）：DashScope 协议在顶层给 `code`，
 * OpenAI 兼容协议把它嵌在 `error.code` 里，而**同一个 code 在两种形状下语义相同** ——
 * 所以判定按 code 先走一遍，再按 HTTP 状态兜底。不认 code 的话，一次鉴权失败会被
 * 说成"提示词或尺寸参数可能不合规"，排查方向直接错到底。
 */
function failureText(status: number, code: string): string {
  if (/apikey|api_key|invalidapikey|authentication|unauthorized|accessdenied/i.test(code)) {
    return 'API Key 无效或无权访问这个模型（检查设置页的 API Key 与地域）';
  }
  if (/throttl|ratelimit|quota|arrears|balance/i.test(code)) return '画图接口限流或额度不足，稍后再试';
  if (status === 401 || status === 403) return 'API Key 无效或无权访问这个模型（检查设置页的 API Key 与地域）';
  if (status === 429) return '画图接口限流或额度不足，稍后再试';
  if (status === 400) return '画图接口不接受这次请求（提示词或尺寸参数可能不合规）';
  if (status >= 500) return '画图服务暂时不可用，稍后再试';
  return `画图接口返回错误（${code}）`;
}

/** 读响应体并限长。超限时抛自己的错误码，不冒充传输失败。 */
async function readBodyCapped(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ImageGenError('generating', 'RESPONSE_TOO_LARGE', '画图接口返回了异常大的响应');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // 只是放开锁，不影响已经读到的内容。**必须吞掉异常**：中止/超时会让流处于 error 态，
    // 这里抛出去会把"超时"替换成一个无意义的 TypeError，错误码就跟着错了。
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 调一次同步出图，返回结果图 URL（**24 小时后失效，必须立刻下载**）。
 *
 * `signal` 由队列给（关停时 abort）。超时是**内部**的一条：`config.timeoutMs` 到点就 abort，
 * 于是"超时"与"被关停"两条路径都不会挂着一个已经没人在等的请求。
 */
export async function generateImage(
  config: EffectiveConfig, input: ImageGenInput, signal: AbortSignal
): Promise<string> {
  let endpoint: string;
  try {
    endpoint = new URL(imageGenEndpoint(config.baseUrl)).toString();
  } catch {
    throw new ImageGenError('validation', 'INVALID_BASE_URL', '画图接口地址无效，请在设置页检查');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const relay = () => controller.abort();
  signal.addEventListener('abort', relay, { once: true });
  if (signal.aborted) controller.abort();

  /** 把 fetch/读流抛出来的东西翻成带阶段的错误；已经是 ImageGenError 的原样放行。 */
  const mapTransport = (error: unknown): ImageGenError => {
    if (error instanceof ImageGenError) return error;
    if (timedOut) {
      return new ImageGenError('generating', 'IMAGE_TIMEOUT',
        `画图超时（超过 ${Math.round(config.timeoutMs / 1000)} 秒），稍后再试`);
    }
    if (signal.aborted) return new ImageGenError('generating', 'CANCELLED', '任务已取消');
    return new ImageGenError('generating', safeErrorCode(error), '连不上画图接口（检查网络与接口地址）');
  };

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(buildImageGenRequest(config, input)),
        signal: controller.signal
      });
    } catch (error) {
      throw mapTransport(error);
    }

    let text = '';
    try {
      text = await readBodyCapped(response);
    } catch (error) {
      throw mapTransport(error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ImageGenError('generating', 'INVALID_RESPONSE',
        `画图接口返回了看不懂的内容（HTTP ${response.status}）`);
    }
    const body = isRecord(parsed) ? parsed : {};

    // ⚠️ 顺序：**先看 code 再看状态码**。接口在鉴权失败等情况下会给出 200 的响应体 + code，
    // 只判 `response.ok` 会把它当成成功，然后死在下面那句"没有返回图片"上 —— 归因完全错。
    // 两种错误形状都认：DashScope 协议在顶层给 `code`，OpenAI 兼容协议嵌在 `error.code` 里。
    // 上游那句 `message` **不进群里的话**：它是英文/接口味的，进不了群聊；它对应的信息量
    // 由 `DASHSCOPE_<code>` 这个可机检的错误码承载，落在日志里。
    const errorBody = isRecord(body.error) ? body.error : {};
    const code = sanitizeCode(body.code ?? errorBody.code ?? (response.ok ? '' : `HTTP_${response.status}`), '');
    if (code) {
      throw new ImageGenError('generating', `DASHSCOPE_${code}`, failureText(response.status, code));
    }
    if (!response.ok) {
      throw new ImageGenError('generating', `DASHSCOPE_HTTP_${response.status}`,
        failureText(response.status, `HTTP_${response.status}`));
    }

    const output = isRecord(body.output) ? body.output : {};
    const choices = Array.isArray(output.choices) ? output.choices : [];
    for (const choice of choices) {
      const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
      const parts = Array.isArray(message.content) ? message.content : [];
      for (const part of parts) {
        const image = isRecord(part) ? part.image : '';
        if (typeof image === 'string' && image.trim()) return image.trim();
      }
    }
    throw new ImageGenError('generating', 'NO_IMAGE_URL', '画图接口没有返回图片，稍后再试');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', relay);
  }
}
