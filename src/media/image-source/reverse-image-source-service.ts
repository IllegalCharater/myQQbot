import { createHash, randomUUID } from 'node:crypto';
import { LruTtlCache } from './cache.js';
import { loadSafeImage } from './image-loader.js';
import { AsyncSingleQueue } from './queue.js';
import { SauceNaoProvider } from './saucenao-provider.js';
import { TraceMoeProvider } from './trace-moe-provider.js';
import type { ImageSourceConfig, ImageSourceResult, SearchIntent } from './types.js';

export interface SearchOutput { result: ImageSourceResult | null; cached: boolean; failures: string[] }
export class ReverseImageSourceService {
  readonly #queue = new AsyncSingleQueue();
  readonly #cache = new LruTtlCache<SearchOutput>(100);
  constructor(private readonly deps: {
    getConfig: () => ImageSourceConfig;
    trace?: TraceMoeProvider;
    sauce?: SauceNaoProvider;
    log?: (message: string) => void;
  }) {}

  search(url: string, intent: SearchIntent): Promise<SearchOutput> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) return Promise.reject(new Error('DISABLED'));
    return this.#queue.enqueue(cfg.maxQueueLength, () => this.#run(url, intent, cfg));
  }

  async #run(url: string, intent: SearchIntent, cfg: ImageSourceConfig): Promise<SearchOutput> {
    const taskId = randomUUID(); const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#perform(url, intent, cfg, taskId, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('TOTAL_TIMEOUT')); }, cfg.totalTimeoutMs); timer.unref?.(); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.deps.log?.(`[image-source] task=${taskId} durationMs=${Date.now() - started} done`);
    }
  }

  async #perform(url: string, intent: SearchIntent, cfg: ImageSourceConfig, taskId: string, signal: AbortSignal): Promise<SearchOutput> {
    const { buffer, mime } = await loadSafeImage(url, cfg.maxImageBytes);
    const key = createHash('sha256').update(buffer).digest('hex');
    if (cfg.cacheEnabled) { const hit = this.#cache.get(key); if (hit) { this.deps.log?.(`[image-source] task=${taskId} bytes=${buffer.length} cache=hit`); return { ...hit, cached: true }; } }
    const trace = this.deps.trace || new TraceMoeProvider(); const sauce = this.deps.sauce || new SauceNaoProvider();
    const order = intent === 'illustration' ? ['sauce', 'trace'] as const : ['trace', 'sauce'] as const;
    const failures: string[] = []; let result: ImageSourceResult | null = null;
    for (const provider of order) {
      try {
        if (provider === 'trace') {
          if (!cfg.traceMoe.enabled) continue;
          const response = await trace.search(buffer, mime, cfg.traceMoe.timeoutMs, cfg.traceMoe.maxResults, signal);
          result = response.results.find((x) => x.similarity >= cfg.traceMoe.minSimilarity) || null;
          this.deps.log?.(`[image-source] task=${taskId} provider=trace.moe bytes=${buffer.length} status=${response.statusCode}`);
          if (result) break;
        } else {
          if (!cfg.sauceNao.enabled || !cfg.sauceNao.apiKey) continue;
          const response = await sauce.search(buffer, mime, cfg.sauceNao.apiKey, cfg.sauceNao.timeoutMs, cfg.sauceNao.maxResults, signal);
          result = response.results.find((x) => x.similarity >= cfg.sauceNao.minSimilarity) || null;
          this.deps.log?.(`[image-source] task=${taskId} provider=SauceNAO bytes=${buffer.length} status=${response.statusCode}`);
          if (result) break;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'UNKNOWN'; failures.push(`${provider}:${reason}`);
        this.deps.log?.(`[image-source] task=${taskId} provider=${provider} bytes=${buffer.length} failure=${reason}`);
      }
    }
    const output = { result, cached: false, failures };
    if (cfg.cacheEnabled) this.#cache.set(key, output, cfg.cacheTtlMs);
    return output;
  }
}
