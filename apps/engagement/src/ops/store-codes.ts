import type { ScopedClient } from '@platform/db';

/**
 * store_id (uuid) → `store.code`, so an alert says `brand-a` instead of a uuid (#553: "store code").
 *
 * Cached for the life of the process: a store's code does not change, and a new store appears rarely enough
 * that one miss per store is the whole cost. A miss re-queries once and then falls back to the uuid — an alert
 * must never be dropped because a lookup failed.
 *
 * Needs an ORGANIZATION-scoped client: a consumer reads events of every store of its organization.
 */
export interface StoreCodes {
  codeFor(storeId: string | null | undefined): Promise<string>;
  /** Pre-load every store of the organization in one query (the consumer does this at start). */
  warm(): Promise<void>;
}

export function createStoreCodes(hq: ScopedClient): StoreCodes {
  const cache = new Map<string, string>();
  let warmed = false;

  async function loadAll(): Promise<void> {
    const r = await hq.query('SELECT id, code FROM store');
    for (const row of r.rows as { id: string; code: string }[]) cache.set(row.id, row.code);
    warmed = true;
  }

  return {
    async warm() {
      await loadAll();
    },
    async codeFor(storeId) {
      // An organization-scope event (no store_id) belongs to the organization, not to a store.
      if (!storeId) return 'organization';
      const hit = cache.get(storeId);
      if (hit) return hit;
      if (!warmed) {
        await loadAll();
        const after = cache.get(storeId);
        if (after) return after;
      }
      const r = await hq.query('SELECT code FROM store WHERE id = $1', [storeId]);
      const code = (r.rows[0] as { code: string } | undefined)?.code;
      if (code) {
        cache.set(storeId, code);
        return code;
      }
      return storeId;
    },
  };
}
