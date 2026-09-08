// Merchandising rules service (task 2.2, #135): validation against the store's catalog (no cross-store product
// or category ids — the tenant client's RLS makes a foreign id simply "not found"), storage through a
// RulesRepository, publish = replace the store index's Algolia rules with every active rule, and the Store API
// `sort=relevance` search that runs through the index with those rules applied.
import type { Queryable, ScopedClient } from '@platform/db';
import { notFound, validationError } from '../../lib/errors';
import { toAlgoliaRule, categoryFilter } from './algolia-rules';
import {
  isRuleActive,
  parsePatch,
  parseRuleInput,
  referencedProductIds,
  type MerchandisingRule,
  type MerchandisingRulePatch,
  type PublishResult,
} from './merchandising-types';
import type { RulesRepository } from './repository';
import { indexNameFor } from './settings';
import type { IndexClient, SearchResponse, StoreIndexTarget } from './types';

function organizationOf(client: ScopedClient): string {
  return client.context.organizationId;
}

/** Every id must be a product of this store (any status); otherwise 400 with the offending ids. */
async function assertProductsInStore(tx: Queryable, storeId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM product WHERE store_id = $1 AND id = ANY($2)`,
    [storeId, ids],
  );
  const found = new Set(r.rows.map((x) => x.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0)
    throw validationError('product ids do not belong to this store', { product_ids: missing });
}

async function assertCategoryInStore(tx: Queryable, storeId: string, id: string): Promise<void> {
  const r = await tx.query(`SELECT 1 FROM product_category WHERE store_id = $1 AND id = $2`, [
    storeId,
    id,
  ]);
  if (r.rowCount === 0)
    throw validationError('category does not belong to this store', { category_id: id });
}

export async function listRules(
  client: ScopedClient,
  storeId: string,
  repo: RulesRepository,
): Promise<MerchandisingRule[]> {
  return client.transaction((tx) => repo.list(tx, storeId));
}

export async function getRule(
  client: ScopedClient,
  storeId: string,
  id: string,
  repo: RulesRepository,
): Promise<MerchandisingRule> {
  const r = await client.transaction((tx) => repo.get(tx, storeId, id));
  if (!r) throw notFound('merchandising rule', id);
  return r;
}

export async function createRule(
  client: ScopedClient,
  storeId: string,
  body: unknown,
  repo: RulesRepository,
): Promise<MerchandisingRule> {
  const input = parseRuleInput(body);
  return client.transaction(async (tx) => {
    if (input.scope.type === 'category')
      await assertCategoryInStore(tx, storeId, input.scope.category_id);
    await assertProductsInStore(tx, storeId, referencedProductIds(input));
    return repo.create(tx, {
      organizationId: organizationOf(client),
      storeId,
      scope: input.scope,
      pins: input.pins ?? [],
      boosts: input.boosts ?? [],
      buries: input.buries ?? [],
      enabled: input.enabled ?? true,
      starts_at: input.starts_at ?? null,
      ends_at: input.ends_at ?? null,
    });
  });
}

export async function updateRule(
  client: ScopedClient,
  storeId: string,
  id: string,
  body: unknown,
  repo: RulesRepository,
): Promise<MerchandisingRule> {
  const patch: MerchandisingRulePatch = parsePatch(body);
  return client.transaction(async (tx) => {
    const current = await repo.get(tx, storeId, id);
    if (!current) throw notFound('merchandising rule', id);
    // cross-field checks over the merged rule (a patch may pin what is already buried)
    const merged = {
      pins: patch.pins ?? current.pins,
      buries: patch.buries ?? current.buries,
      boosts: patch.boosts ?? current.boosts,
      starts_at: patch.starts_at === undefined ? current.starts_at : patch.starts_at,
      ends_at: patch.ends_at === undefined ? current.ends_at : patch.ends_at,
    };
    parsePatch(merged);
    await assertProductsInStore(tx, storeId, referencedProductIds(patch));
    const updated = await repo.update(tx, storeId, id, patch);
    if (!updated) throw notFound('merchandising rule', id);
    return updated;
  });
}

export async function deleteRule(
  client: ScopedClient,
  storeId: string,
  id: string,
  repo: RulesRepository,
): Promise<void> {
  const ok = await client.transaction((tx) => repo.delete(tx, storeId, id));
  if (!ok) throw notFound('merchandising rule', id);
}

/**
 * Pushes every active rule of the store as the index's complete rule set (disabled, expired and future rules
 * are skipped and therefore removed from the index) and stamps `published_at` on the published ones.
 */
export async function publishRules(
  client: ScopedClient,
  store: StoreIndexTarget,
  index: IndexClient,
  repo: RulesRepository,
  now = new Date(),
): Promise<PublishResult> {
  const indexName = indexNameFor(store);
  return client.transaction(async (tx) => {
    const rules = await repo.list(tx, store.id);
    const active = rules.filter((r) => isRuleActive(r, now));
    await index.saveRules(indexName, active.map(toAlgoliaRule), { clearExisting: true });
    await repo.markPublished(
      tx,
      store.id,
      active.map((r) => r.id),
      now,
    );
    return { index: indexName, published: active.length, skipped: rules.length - active.length };
  });
}

export interface RelevanceQuery {
  q?: string | undefined;
  category_id?: string | undefined;
  /** 1-based, like the Store API. */
  page?: number | undefined;
  limit?: number | undefined;
}

export interface RelevanceResult {
  /** Product ids in ranking order for this page. */
  ids: string[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Store API `sort=relevance`: one index query with the store's published rules applied. The caller (window 1's
 * store route) hydrates the ids from the catalog read model in this order; without credentials it keeps the
 * ILIKE stub.
 */
export async function searchRelevance(
  store: StoreIndexTarget,
  index: IndexClient,
  q: RelevanceQuery,
): Promise<RelevanceResult> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 24));
  const res: SearchResponse = await index.search(indexNameFor(store), {
    query: q.q?.trim() ?? '',
    ...(q.category_id ? { filters: categoryFilter(q.category_id) } : {}),
    page: page - 1,
    hitsPerPage: limit,
  });
  return { ids: res.hits.map((h) => h.objectID), total: res.nbHits, page, limit };
}
