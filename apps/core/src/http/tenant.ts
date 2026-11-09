// Store API tenant context (ADR 0001): `X-Publishable-Key` → `store_api_key.key_hash` → the one store the request
// may act on. Mounted on `/store` in src/server.ts AHEAD of Medusa. Requests without a resolvable store context
// are refused with 401 `{ code: "unauthorized" }`; nothing downstream ever sees them.
import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { ScopedClient } from '@platform/db';
import type { Actor } from '../lib/audit';
import { SEED_IDS } from '@platform/db';
import { organizationClient, tenantClient } from '../lib/db';
import { AppError } from '../lib/errors';
import { storeKeyCache, type CachedKeyRow } from '../lib/store-key-cache';
import { CONTRACT_PUBLISHABLE_KEY_HEADER } from './publishable-key-alias';
import { requestIdOf } from './request-id';

export interface StoreContext {
  organizationId: string;
  storeId: string;
  storeCode: string;
  /** Store default currency = the cart currency in Phase 1 (prices in Store API responses). */
  defaultCurrency: string;
  salesChannelId: string | null;
  apiKeyId: string;
  apiKeyType: 'publishable' | 'secret';
  /** Store-scoped client: RLS lets this request see exactly this store's rows. */
  client: ScopedClient;
  /** Storefront requests act as an (anonymous) customer until customer auth lands (window 13). */
  actor: Actor;
  requestId: string;
}

const unauthorized = (message: string) => new AppError('unauthorized', message);

/**
 * The organization the key lookup runs under. `store_api_key` is itself under RLS, so the lookup needs an
 * organization context before any context is known. Phases 1–3 have exactly one organization (HQ); it comes
 * from CORE_ORGANIZATION_ID, defaulting to the seeded one. Multi-organization resolution (by hostname) is a
 * Phase 3+ concern.
 */
export function coreOrganizationId(): string {
  return process.env.CORE_ORGANIZATION_ID ?? SEED_IDS.organization;
}

interface KeyRow {
  id: string;
  store_id: string;
  store_code: string;
  store_status: string;
  default_currency: string;
  sales_channel_id: string | null;
  type: 'publishable' | 'secret';
  revoked_at: Date | null;
}

/**
 * The key's row: from the positive cache (#742, src/lib/store-key-cache.ts — at most CORE_STORE_KEY_CACHE_MS old,
 * dropped in this process on a revoke or a store update), else from the database. Only a usable key is cached: an
 * unknown, revoked or archived one is answered by the database every time.
 */
async function loadKeyRow(
  organizationId: string,
  keyHash: string,
  fresh: boolean,
): Promise<CachedKeyRow> {
  const cacheKey = `${organizationId}:${keyHash}`;
  const cached = fresh ? undefined : storeKeyCache.get(cacheKey);
  if (cached) return cached;
  const hq = organizationClient({ organizationId });
  const r = await hq.query<KeyRow>(
    `SELECT k.id, k.store_id, s.code AS store_code, s.status AS store_status, s.default_currency, k.sales_channel_id, k.type, k.revoked_at
     FROM store_api_key k JOIN store s ON s.id = k.store_id
     WHERE k.key_hash = $1`,
    [keyHash],
  );
  const row = r.rows[0];
  if (!row || row.revoked_at) throw unauthorized('invalid or revoked publishable key');
  if (row.store_status === 'archived') throw unauthorized('store is archived');
  const usable: CachedKeyRow = {
    id: row.id,
    store_id: row.store_id,
    store_code: row.store_code,
    default_currency: row.default_currency,
    sales_channel_id: row.sales_channel_id,
    type: row.type,
  };
  storeKeyCache.set(cacheKey, usable);
  return usable;
}

/**
 * Resolves the store context for a plain key, or throws 401. `fresh` skips the resolve cache and asks the database
 * (the bootstrap verifier: readiness is the database's truth, never a cached row).
 */
export async function resolveStoreContext(
  plainKey: string | undefined,
  requestId: string,
  opts: { fresh?: boolean } = {},
): Promise<StoreContext> {
  if (!plainKey || !plainKey.trim())
    throw unauthorized(`${CONTRACT_PUBLISHABLE_KEY_HEADER} header is required`);
  const organizationId = coreOrganizationId();
  const row = await loadKeyRow(
    organizationId,
    createHash('sha256').update(plainKey.trim()).digest('hex'),
    opts.fresh ?? false,
  );
  return {
    organizationId,
    storeId: row.store_id,
    storeCode: row.store_code,
    defaultCurrency: row.default_currency,
    salesChannelId: row.sales_channel_id,
    apiKeyId: row.id,
    apiKeyType: row.type,
    client: tenantClient({ organizationId, storeIds: [row.store_id] }),
    actor: { id: null, type: 'customer', requestId },
    requestId,
  };
}

/** Express middleware for the `/store` namespace: attaches `req.tenant` or fails with 401. */
export const storeContextMiddleware: RequestHandler = (req, _res, next) => {
  const raw = req.headers[CONTRACT_PUBLISHABLE_KEY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  resolveStoreContext(key, requestIdOf(req))
    .then((ctx) => {
      req.tenant = ctx;
      next();
    })
    .catch(next);
};

/** For handlers: the store context, or a 401 if the middleware did not run (programming error guard). */
export function requireTenant(req: { tenant?: StoreContext }): StoreContext {
  if (!req.tenant) throw unauthorized('no store context');
  return req.tenant;
}
