// A Map that cannot grow without bound: entries expire after a TTL and the oldest are dropped once the map is
// full. Every in-process index in this module (quoted rates, bought labels, resolved providers, the rate cache)
// uses it — a long-running core process must not accumulate one entry per quote for the life of the pod.

export interface BoundedTtlMapOptions {
  /** Hard cap on live entries. Inserting past it evicts the oldest insertion first. */
  maxEntries: number;
  /** Milliseconds after insertion an entry stops being served. `Infinity` = no expiry, cap only. */
  ttlMs: number;
  /** Injected in tests so expiry is deterministic. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class BoundedTtlMap<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: BoundedTtlMapOptions) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    // Re-inserting moves the key to the end of the insertion order, so a refreshed entry is evicted last.
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: this.ttlMs === Infinity ? Infinity : this.now() + this.ttlMs,
    });
    this.evict();
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Live entries, expired ones excluded. Tests and diagnostics only. */
  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  /** Values in insertion order, expired ones excluded. */
  values(): V[] {
    this.sweep();
    return [...this.entries.values()].map((entry) => entry.value);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    this.sweep();
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
