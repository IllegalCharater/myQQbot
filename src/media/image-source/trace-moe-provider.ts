import type { ImageSourceResult, ProviderResponse } from './types.js';

type FetchLike = typeof fetch;
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';

export class TraceMoeProvider {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async search(buffer: Buffer, mime: string, timeoutMs: number, maxResults: number, signal?: AbortSignal): Promise<ProviderResponse> {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mime }), `image.${mime.split('/')[1] || 'jpg'}`);
    const response = await this.fetchImpl('https://api.trace.moe/search?anilistInfo', {
      method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw Object.assign(new Error(response.status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR'), { statusCode: response.status });
    const payload = obj(await response.json());
    if (!Array.isArray(payload.result)) throw new Error('INVALID_RESPONSE');
    const results: ImageSourceResult[] = payload.result.slice(0, maxResults).map((raw) => {
      const row = obj(raw); const anilist = obj(row.anilist); const title = obj(anilist.title);
      const id = Number(anilist.id || row.anilist) || 0;
      return {
        provider: 'trace.moe', kind: 'anime', similarity: Number(row.similarity) || 0,
        title: text(title.chinese) || text(title.native) || text(title.romaji) || text(title.english) || `AniList ${id}`,
        episode: row.episode == null ? undefined : String(row.episode),
        time: Number(row.from) || 0,
        url: id ? `https://anilist.co/anime/${id}` : undefined,
        previewUrl: text(row.image) || undefined
      };
    });
    return { results, statusCode: response.status };
  }

  async test(timeoutMs: number): Promise<boolean> {
    const response = await this.fetchImpl('https://api.trace.moe/me', { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  }
}
