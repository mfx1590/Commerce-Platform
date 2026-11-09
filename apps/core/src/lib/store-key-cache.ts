// The publishable-key → store resolve cache (#742, the pool knee). Every Store API request resolved its key with one
// database round trip on its own pooled connection; a hit here skips it. POSITIVE entries only: an unknown, revoked
// or archived key is never cached, so it always reaches the database. Bounds (the manager's decision on #742):
//   - an entry lives CORE_STORE_KEY_CACHE_MS (default 10 000 ms; 0 = no cache);
//   - THIS process drops the entry when it revokes a key or updates a store (registry write paths, after commit);
//   - another process keeps serving a revoked key / an archived store for at most that TTL.
// At most MAX_ENTRIES keys; the oldest goes first. The cache holds the row only, never a client or a request field.

export interface CachedKeyRow {
  id: string;
  store_id: string;
  store_code: string;
  default_currency: string;
  sales_channel_id: string | null;
  type: 'publishable' | 'secret';
}

const MAX_ENTRIES = 10_000;
const entries = new Map<string, { row: CachedKeyRow; expiresAt: number }>();

export function storeKeyCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CORE_STORE_KEY_CACHE_MS;
  if (raw === undefined || raw.trim() === '') return 10_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
}

export const storeKeyCache = {
  get(keyHash: string, now = Date.now()): CachedKeyRow | undefined {
    const e = entries.get(keyHash);
    if (!e) return undefined;
    if (e.expiresAt <= now) {
      entries.delete(keyHash);
      return undefined;
    }
    return e.row;
  },
  set(keyHash: string, row: CachedKeyRow, now = Date.now()): void {
    const ttl = storeKeyCacheTtlMs();
    if (ttl === 0) return;
    entries.delete(keyHash);
    if (entries.size >= MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(keyHash, { row: { ...row }, expiresAt: now + ttl });
  },
  /** A key this process revoked. */
  invalidateKey(apiKeyId: string): void {
    for (const [hash, e] of entries) if (e.row.id === apiKeyId) entries.delete(hash);
  },
  /** A store this process updated (status, currency, …): every key of it. */
  invalidateStore(storeId: string): void {
    for (const [hash, e] of entries) if (e.row.store_id === storeId) entries.delete(hash);
  },
  clear(): void {
    entries.clear();
  },
  get size(): number {
    return entries.size;
  },
};
