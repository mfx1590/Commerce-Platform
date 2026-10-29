// Recommendations (task P5.8, #607): the write side (the nightly rebuild) and the read side (what the Store API
// serves). The maths is in recommendations-types.ts and the ClickHouse reads are in clickhouse.ts; this file is
// the part that touches Postgres, always through a scoped client from @platform/db.
//
// WRITE — `rebuildStoreRecommendations` is one transaction per store and kind/window: DELETE then INSERT. That is
// what "idempotent re-run" means here: a second run on unchanged data leaves byte-identical rows, and a pair that
// fell below the support threshold DISAPPEARS instead of lingering, which an upsert would not do. 0204 revokes
// UPDATE for the app role precisely so that this stays the only write shape.
//
// Two same-store guards, deliberately both: the INSERT joins `product` on (store_id, id) so a product ClickHouse
// still knows but Postgres has dropped simply does not get a row, and migration 0204's composite foreign keys
// make a cross-store pair impossible even if this code were wrong. RLS is the third.
//
// Published and in-stock are NOT applied at write time, on purpose: publication and stock change many times a day
// and the rebuild is nightly, so a write-time filter would serve a stale rail. The read path filters instead.
import type { Queryable, ScopedClient } from '@platform/db';
import type { StoreComponents } from '@platform/contracts';
import { notFound, validationError } from '../../lib/errors';
import { loadSearchRecords, storeCurrencies } from './records';
import type { BasketSource } from './clickhouse';
import {
  PAIR_WINDOW_DAYS,
  POPULAR_WINDOWS,
  recommendPairs,
  recommendPopular,
  type PopularWindow,
  type RecommendationKind,
  type Thresholds,
} from './recommendations-types';

type ProductSummary = StoreComponents['schemas']['ProductSummary'];
type RecommendationList = StoreComponents['schemas']['RecommendationList'];

// ---------------------------------------------------------------------------------------------------- write

export interface RebuildResult {
  storeId: string;
  /** Rows written for `bought_together` (both directions counted). */
  pairs: number;
  /** Rows written per popular window. */
  popular: Record<PopularWindow, number>;
}

const INSERT_PAIRS = `
  INSERT INTO product_recommendation
    (organization_id, store_id, product_id, related_product_id, kind, window_days, score, computed_at)
  SELECT app.current_organization_id(), $1, i.product_id, i.related_product_id,
         'bought_together', ${PAIR_WINDOW_DAYS}, i.score, $2
  FROM unnest($3::uuid[], $4::uuid[], $5::numeric[]) AS i(product_id, related_product_id, score)
  JOIN product anchor  ON anchor.store_id  = $1 AND anchor.id  = i.product_id
  JOIN product related ON related.store_id = $1 AND related.id = i.related_product_id`;

const INSERT_POPULAR = `
  INSERT INTO product_recommendation
    (organization_id, store_id, product_id, related_product_id, kind, window_days, score, computed_at)
  SELECT app.current_organization_id(), $1, NULL, i.related_product_id, 'popular', $2, i.score, $3
  FROM unnest($4::uuid[], $5::numeric[]) AS i(related_product_id, score)
  JOIN product related ON related.store_id = $1 AND related.id = i.related_product_id`;

/**
 * Recomputes both kinds for one store and rewrites its rows. `source` is ClickHouse in production and a fixture
 * until #601 lands; the thresholds are documented with a worked example in recommendations-types.ts.
 */
export async function rebuildStoreRecommendations(
  client: ScopedClient,
  storeId: string,
  source: BasketSource,
  thresholds: Thresholds,
  now: Date = new Date(),
): Promise<RebuildResult> {
  const counts = await source.counts(storeId, thresholds);
  const pairs = recommendPairs(counts, thresholds);

  const popularByWindow = new Map<PopularWindow, { relatedProductId: string; score: number }[]>();
  for (const window of POPULAR_WINDOWS) {
    const units = await source.units(storeId, window);
    popularByWindow.set(window, recommendPopular(units, thresholds.maxPopularPerStore));
  }

  return client.transaction(async (tx) => {
    await tx.query(
      `DELETE FROM product_recommendation WHERE store_id = $1 AND kind = 'bought_together'`,
      [storeId],
    );
    let pairRows = 0;
    if (pairs.length > 0) {
      const r = await tx.query(INSERT_PAIRS, [
        storeId,
        now,
        pairs.map((p) => p.productId),
        pairs.map((p) => p.relatedProductId),
        pairs.map((p) => String(p.score)),
      ]);
      pairRows = r.rowCount ?? 0;
    }

    const popular: Record<PopularWindow, number> = { 7: 0, 30: 0 };
    for (const window of POPULAR_WINDOWS) {
      await tx.query(
        `DELETE FROM product_recommendation WHERE store_id = $1 AND kind = 'popular' AND window_days = $2`,
        [storeId, window],
      );
      const list = popularByWindow.get(window) ?? [];
      if (list.length === 0) continue;
      const r = await tx.query(INSERT_POPULAR, [
        storeId,
        window,
        now,
        list.map((p) => p.relatedProductId),
        list.map((p) => String(p.score)),
      ]);
      popular[window] = r.rowCount ?? 0;
    }

    return { storeId, pairs: pairRows, popular };
  });
}

// ----------------------------------------------------------------------------------------------------- read

export interface RecommendationContext {
  client: ScopedClient;
  storeId: string;
  /** The store's default currency; the contract's `currency` query overrides it. */
  defaultCurrency: string;
}

export interface ListRecommendationsInput {
  kind: RecommendationKind;
  /** The product-detail anchor. */
  productId?: string | undefined;
  /** Cart line variant ids; their products are the anchors and are never recommended back. */
  variantIds?: string[] | undefined;
  windowDays: PopularWindow;
  limit: number;
  currency?: string | undefined;
}

interface Candidate {
  productId: string;
  score: number;
}

/** Products of this store that are published, by id — the anchors' 404 test. */
async function publishedProductIds(
  tx: Queryable,
  storeId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM product WHERE store_id = $1 AND status = 'published' AND id = ANY($2::uuid[])`,
    [storeId, ids],
  );
  return new Set(r.rows.map((x) => x.id));
}

/** Variant ids → their products, restricted to published products of this store. */
async function productsOfVariants(
  tx: Queryable,
  storeId: string,
  variantIds: string[],
): Promise<string[]> {
  if (variantIds.length === 0) return [];
  const r = await tx.query<{ product_id: string }>(
    `SELECT DISTINCT v.product_id
     FROM product_variant v
     JOIN product p ON p.id = v.product_id
     WHERE p.store_id = $1 AND p.status = 'published' AND v.id = ANY($2::uuid[])`,
    [storeId, variantIds],
  );
  return r.rows.map((x) => x.product_id);
}

/**
 * The best lift per related product across every anchor (a cart has several). Max, not sum: a sum would let a
 * long cart outvote a strong pair, and lift is already a per-pair strength. Anchors never recommend each other.
 */
async function pairCandidates(
  tx: Queryable,
  storeId: string,
  anchors: string[],
): Promise<Candidate[]> {
  const r = await tx.query<{ related_product_id: string; score: string }>(
    `SELECT related_product_id, max(score) AS score
     FROM product_recommendation
     WHERE store_id = $1 AND kind = 'bought_together' AND product_id = ANY($2::uuid[])
       AND NOT (related_product_id = ANY($2::uuid[]))
     GROUP BY related_product_id
     ORDER BY score DESC, related_product_id`,
    [storeId, anchors],
  );
  return r.rows.map((x) => ({ productId: x.related_product_id, score: Number(x.score) }));
}

async function popularCandidates(
  tx: Queryable,
  storeId: string,
  windowDays: PopularWindow,
  exclude: string[],
): Promise<Candidate[]> {
  const r = await tx.query<{ related_product_id: string; score: string }>(
    `SELECT related_product_id, score
     FROM product_recommendation
     WHERE store_id = $1 AND kind = 'popular' AND window_days = $2
       AND NOT (related_product_id = ANY($3::uuid[]))
     ORDER BY score DESC, related_product_id`,
    [storeId, windowDays, exclude],
  );
  return r.rows.map((x) => ({ productId: x.related_product_id, score: Number(x.score) }));
}

/**
 * Candidates → contract cards. The published filter and the price/stock facts come from `loadSearchRecords`, the
 * same read model the index and the Store API product list use, so a rail can never show a product the catalogue
 * would not. A candidate that is unpublished, out of stock, or has no price in the asked currency is dropped,
 * which is why the list may come back shorter than `limit`.
 */
async function toCards(
  tx: Queryable,
  storeId: string,
  candidates: Candidate[],
  currency: string,
  limit: number,
): Promise<ProductSummary[]> {
  if (candidates.length === 0) return [];
  const records = await loadSearchRecords(tx, storeId, {
    productIds: candidates.map((c) => c.productId),
  });
  const byId = new Map(records.map((r) => [r.objectID, r]));
  const items: ProductSummary[] = [];
  for (const c of candidates) {
    if (items.length >= limit) break;
    const rec = byId.get(c.productId);
    if (!rec || !rec.in_stock) continue;
    const amount = rec.price_minor[currency];
    if (amount === undefined) continue;
    const compare = rec.compare_at_minor[currency];
    items.push({
      id: rec.objectID,
      handle: rec.handle,
      title: rec.title,
      thumbnail_url: rec.thumbnail_url,
      price: { amount_minor: amount, currency },
      compare_at_price: compare === undefined ? null : { amount_minor: compare, currency },
      category_handle: rec.category_handle,
      tags: rec.tags,
    });
  }
  return items;
}

/**
 * `listProductRecommendations` (Store API 0.5.9). Returns the kind that was actually SERVED: asking for
 * `bought_together` and getting `popular` back is how the caller (and #609's analytics event) sees the fallback,
 * which is why there is no separate boolean in the response.
 */
export async function listProductRecommendations(
  ctx: RecommendationContext,
  input: ListRecommendationsInput,
): Promise<RecommendationList> {
  const currency = (input.currency ?? ctx.defaultCurrency).trim().toUpperCase();
  const tx = ctx.client;

  const enabled = await storeCurrencies(tx, ctx.storeId);
  if (!enabled.includes(currency)) {
    throw validationError(`currency must be one of ${enabled.join(', ')}`, { currency: 'enabled' });
  }

  if (input.kind === 'popular') {
    const candidates = await popularCandidates(tx, ctx.storeId, input.windowDays, []);
    return {
      kind: 'popular',
      items: await toCards(tx, ctx.storeId, candidates, currency, input.limit),
    };
  }

  // bought_together: resolve the anchors, 404 when they are not published products of this store.
  let anchors: string[];
  if (input.productId !== undefined) {
    const found = await publishedProductIds(tx, ctx.storeId, [input.productId]);
    if (!found.has(input.productId)) throw notFound('product', input.productId);
    anchors = [input.productId];
  } else {
    const variantIds = input.variantIds ?? [];
    anchors = await productsOfVariants(tx, ctx.storeId, variantIds);
    if (anchors.length === 0) throw notFound('product variant', variantIds.join(','));
  }

  const pairs = await pairCandidates(tx, ctx.storeId, anchors);
  const items = await toCards(tx, ctx.storeId, pairs, currency, input.limit);
  if (items.length > 0) return { kind: 'bought_together', items };

  // No pairs above the threshold (or none of them sellable right now): the popular list, reported as `popular`.
  const fallback = await popularCandidates(tx, ctx.storeId, input.windowDays, anchors);
  return {
    kind: 'popular',
    items: await toCards(tx, ctx.storeId, fallback, currency, input.limit),
  };
}
