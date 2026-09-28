import type { ImageSourceResult, ProviderResponse } from './types.js';

type FetchLike = typeof fetch;
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => Array.isArray(v) ? v.map(String).filter(Boolean).join(', ') : String(v ?? '').trim();
const first = (...values: unknown[]) => values.map(str).find(Boolean) || '';

export class SauceNaoProvider {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async search(buffer: Buffer, mime: string, apiKey: string, timeoutMs: number, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
    if (!apiKey.trim()) throw new Error('NOT_CONFIGURED');
    const form = new FormData();
    form.append('api_key', apiKey);
    form.append('output_type', '2'); form.append('db', '999'); form.append('numres', String(maxResults)); form.append('hide', '0');
    form.append('file', new Blob([buffer], { type: mime }), `image.${mime.split('/')[1] || 'jpg'}`);
    const response = await this.fetchImpl('https://saucenao.com/search.php', {
      method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
    if (response.status === 429) throw Object.assign(new Error('RATE_LIMIT'), { statusCode: 429 });
    if (!response.ok) throw Object.assign(new Error('HTTP_ERROR'), { statusCode: response.status });
    const payload = obj(await response.json()); const header = obj(payload.header);
    const status = Number(header.status ?? 0);
    if (status < 0) throw new Error(status === -3 || status === -4 ? 'QUOTA_EXHAUSTED' : 'API_ERROR');
    if (!Array.isArray(payload.results)) throw new Error('INVALID_RESPONSE');
    const results: ImageSourceResult[] = payload.results.slice(0, maxResults).map((raw) => {
      const row = obj(raw); const h = obj(row.header); const data = obj(row.data);
      const urls = Array.isArray(data.ext_urls) ? data.ext_urls.map(String) : [];
      const indexName = str(h.index_name).replace(/^Index #\d+:\s*/, '');
      return {
        provider: 'SauceNAO', kind: 'illustration', similarity: (Number(h.similarity) || 0) / 100,
        title: first(data.title, data.material, data.source, data.eng_name, data.jp_name) || '未命名作品',
        author: first(data.author_name, data.member_name, data.creator, data.author),
        source: first(indexName, data.source), indexName,
        characters: first(data.characters), url: urls[0], previewUrl: str(h.thumbnail) || undefined
      };
    });
    return {
      results, statusCode: response.status,
      quota: { shortRemaining: Number(header.short_remaining), longRemaining: Number(header.long_remaining) }
    };
  }

  async test(apiKey: string, timeoutMs: number): Promise<boolean> {
    if (!apiKey.trim()) return false;
    const form = new FormData();
    form.append('api_key', apiKey); form.append('output_type', '2'); form.append('testmode', '1'); form.append('db', '999');
    form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'test.png');
    const response = await this.fetchImpl('https://saucenao.com/search.php', { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const payload = obj(await response.json());
    return Number(obj(payload.header).status ?? -1) >= 0;
  }
}
