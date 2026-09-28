import { setTimeout as delay } from 'node:timers/promises';
import { HOT_SEARCH_PLATFORMS } from './types.js';

const API_URL = 'https://v1.apizero.cn/api/hot-search';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;

interface HotSearchRequest {
  apiKey?: string;
  platformFilter?: string[];
  limit: number;
}

interface ClientOptions {
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<unknown>;
  log?: (...args: unknown[]) => void;
  /** 生产默认固定 8 秒；仅测试或受控调用可收紧。 */
  timeoutMs?: number;
}

class HotSearchHttpError extends Error {
  retryable: boolean;
  status?: number;

  constructor(message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'HotSearchHttpError';
    this.retryable = options.retryable === true;
    this.status = options.status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function responseItemCount(value: unknown): number {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.platforms)) return 0;
  let count = 0;
  for (const platform of Object.values(value.data.platforms)) {
    if (isRecord(platform) && Array.isArray(platform.items)) count += platform.items.length;
  }
  return count;
}

export function sanitizeHotSearchError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error || '未知错误');
  return raw
    .replace(/sk_(?:live|test|stag)_[A-Za-z0-9_-]+/gi, '[已脱敏]')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/authorization\s*[:=]\s*\S+/gi, 'Authorization: [已脱敏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240) || '未知错误';
}

function businessError(payload: unknown): HotSearchHttpError | null {
  if (!isRecord(payload)) return new HotSearchHttpError('接口返回不是 JSON 对象');
  const code = String(payload.code ?? '');
  if (code === '200') return null;
  const numericCode = Number(code);
  const message = String(payload.desc ?? payload.msg ?? `业务状态 ${code || '缺失'}`);
  return new HotSearchHttpError(`接口业务错误：${message}`, {
    retryable: numericCode === 429 || numericCode >= 500,
    status: Number.isFinite(numericCode) ? numericCode : undefined
  });
}

export async function fetchHotSearch(request: HotSearchRequest, options: ClientOptions = {}): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((ms: number) => delay(ms));
  const log = options.log ?? console.log;
  const allowed = new Set<string>(HOT_SEARCH_PLATFORMS);
  const selected = [...new Set((request.platformFilter ?? []).map(String).filter((id) => allowed.has(id)))];
  const query = new URLSearchParams({
    platform: selected.length ? selected.join(',') : 'all',
    limit: String(Math.min(50, Math.max(1, Math.round(Number(request.limit) || 10)))),
    timeout: '8'
  });
  const url = `${API_URL}?${query.toString()}`;
  const apiKey = String(request.apiKey ?? '').trim();

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new HotSearchHttpError(`HTTP ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500
        });
      }
      const text = await response.text();
      let payload: unknown;
      try { payload = JSON.parse(text); }
      catch { throw new HotSearchHttpError('接口返回了无效 JSON'); }
      const invalid = businessError(payload);
      if (invalid) throw invalid;
      const count = responseItemCount(payload);
      log(`[hot-search] 请求成功 status=${response.status} durationMs=${Date.now() - started} items=${count} auth=${apiKey ? 'api-key' : 'anonymous'}`);
      return payload;
    } catch (error) {
      const aborted = controller.signal.aborted;
      const normalized = aborted
        ? new HotSearchHttpError(`请求超时（${timeoutMs} 毫秒）`, { retryable: true })
        : error;
      lastError = normalized;
      const retryable = normalized instanceof HotSearchHttpError
        ? normalized.retryable
        : normalized instanceof TypeError;
      const status = normalized instanceof HotSearchHttpError ? normalized.status ?? '-' : '-';
      log(`[hot-search] 请求失败 status=${status} durationMs=${Date.now() - started} attempt=${attempt + 1}/${MAX_RETRIES + 1} error=${sanitizeHotSearchError(normalized)}`);
      if (!retryable || attempt >= MAX_RETRIES) break;
      await wait(500 * (2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(sanitizeHotSearchError(lastError));
}

export const HOT_SEARCH_API_URL = API_URL;
