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
