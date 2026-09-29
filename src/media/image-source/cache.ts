/**
 * 带 LRU 上限与 TTL 的内存缓存。**它对键的构成一无所知** —— 键由调用方（今天只有
 * `reverse-image-source-service.ts`）拼好传进来，这里只按字符串比对。
 *
 * ⚠️ **键的契约写在调用方**（`reverse-image-source-service.ts` 的 `cacheKey`）：键里必须能
 * 区分"问的是哪个引擎、哪张图、要几条"。谁往这里塞第二个调用方，就得自己保证它的键与搜图的
 * 键**不会撞** —— 这张表是共用的一个 Map，跨模块撞键的表现是"另一个模块拿到搜图的结果"，
 * 不报错、只是数据悄悄错。
 *
 * `structuredClone` 双向拷贝：存进取出都不与调用方共享引用，所以调用方**改返回值不会污染
 * 缓存**（缓存里存的是引擎响应，里面有数组）。
 */
export class LruTtlCache<T> {
  readonly #map = new Map<string, { value: T; expiresAt: number }>();
  constructor(private readonly maxEntries = 100) {}

  get(key: string): T | undefined {
    const hit = this.#map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) { this.#map.delete(key); return undefined; }
    this.#map.delete(key);
    this.#map.set(key, hit);
    return structuredClone(hit.value);
  }

  set(key: string, value: T, ttlMs: number): void {
    this.#map.delete(key);
    this.#map.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttlMs });
    while (this.#map.size > this.maxEntries) this.#map.delete(this.#map.keys().next().value!);
  }

  clear(): void { this.#map.clear(); }
}
