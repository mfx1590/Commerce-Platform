// Store API read model: published products of ONE store in ONE currency, with the lowest default-list price and
// availability summed over active warehouses (issue #4). Reads only; the tenant client's RLS scope is the store.
import type { Queryable, ScopedClient } from '@platform/db';
import { notFound } from '../../lib/errors';
import { loadAggregates, type ProductAggregate } from './service';
import type {
  CategoryRow,
  InventoryRow,
  Money,
  Page,
  PriceRow,
  ProductRow,
  StoreCategory,
  StoreProduct,
  StoreProductQuery,
  StoreProductSummary,
  StoreVariant,
  VariantRow,
} from './types';

const money = (amount: string | number, currency: string): Money => ({
  amount_minor: Number(amount),
  currency,
});

/** Active categories of the store as a flat list (parent_id links the tree). */
export async function listStoreCategories(
  client: ScopedClient,
  storeId: string,
): Promise<StoreCategory[]> {
  const r = await client.query<CategoryRow>(
    `SELECT id, handle, name, description, parent_id, position, is_active FROM product_category
     WHERE store_id = $1 AND is_active ORDER BY parent_id NULLS FIRST, position, handle`,
    [storeId],
  );
  return r.rows.map((c) => ({
    id: c.id,
    handle: c.handle,
    name: c.name,
    parent_id: c.parent_id,
    position: c.position,
  }));
}

/** Default-list price of a variant in `currency` (min_quantity 1). */
function defaultPrice(
  prices: PriceRow[],
  variantId: string,
  currency: string,
  lists: Set<string>,
): PriceRow | undefined {
  return prices.find(
    (p) =>
      p.variant_id === variantId &&
      p.currency === currency &&
      p.min_quantity === 1 &&
      lists.has(p.price_list_id),
  );
}

function availability(
  v: VariantRow,
  inventory: InventoryRow[],
): { in_stock: boolean; available_quantity: number | null } {
  if (!v.manage_inventory) return { in_stock: true, available_quantity: null };
  const available = inventory
    .filter((i) => i.variant_id === v.id)
    .reduce((n, i) => n + i.available, 0);
  return {
    in_stock: available > 0 || v.allow_backorder,
    available_quantity: Math.max(0, available),
  };
}

function toStoreVariant(
  v: VariantRow,
  a: ProductAggregate,
  currency: string,
  lists: Set<string>,
): StoreVariant | null {
  const p = defaultPrice(a.prices, v.id, currency, lists);
  if (!p) return null; // no price in this currency → not sellable here
  return {
    id: v.id,
    sku: v.sku,
    title: v.title,
    options: v.options ?? {},
    price: money(p.amount_minor, currency),
    compare_at_price: p.compare_at_minor === null ? null : money(p.compare_at_minor, currency),
    ...availability(v, a.inventory),
    allow_backorder: v.allow_backorder,
    weight_g: v.weight_g,
  };
}

async function defaultListIds(
  tx: Queryable,
  storeId: string,
  currency: string,
): Promise<Set<string>> {
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM price_list WHERE store_id = $1 AND type = 'default' AND currency = $2 AND status = 'active'`,
    [storeId, currency],
  );
  return new Set(r.rows.map((x) => x.id));
}

/** Handles of `handle` and all its descendants (category filter includes children). */
async function categorySubtree(tx: Queryable, storeId: string, handle: string): Promise<string[]> {
  const r = await tx.query<{ id: string }>(
    `WITH RECURSIVE tree AS (
       SELECT id FROM product_category WHERE store_id = $1 AND handle = $2
       UNION ALL
       SELECT c.id FROM product_category c JOIN tree t ON c.parent_id = t.id
     ) SELECT id FROM tree`,
    [storeId, handle],
  );
  return r.rows.map((x) => x.id);
}

/**
 * Published products, paginated, with the lowest variant price in `currency`. Products without any default-list
 * price in that currency are not listed (the summary requires a price). `q` is an ILIKE stub over title, handle
 * and description until the search module (window 9) lands.
 */
export async function listStoreProducts(
  client: ScopedClient,
  storeId: string,
  currency: string,
  q: StoreProductQuery = {},
): Promise<Page<StoreProductSummary>> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 24));
  return client.transaction(async (tx) => {
    const where: string[] = [`p.store_id = $1`, `p.status = 'published'`];
    const params: unknown[] = [storeId, currency];
    if (q.category) {
      const ids = await categorySubtree(tx, storeId, q.category);
      if (ids.length === 0) return { page, limit, total: 0, items: [] };
      params.push(ids);
      where.push(`p.category_id = ANY($${params.length})`);
    }
    if (q.tag) {
      params.push(q.tag);
      where.push(`$${params.length} = ANY(p.tags)`);
    }
    if (q.q?.trim()) {
      params.push(`%${q.q.trim()}%`);
      where.push(
        `(p.title ILIKE $${params.length} OR p.handle ILIKE $${params.length} OR p.description ILIKE $${params.length})`,
      );
    }
    const priceJoin = `
      JOIN LATERAL (
        SELECT min(pr.amount_minor) AS amount_minor
        FROM price pr
        JOIN price_list pl ON pl.id = pr.price_list_id AND pl.type = 'default' AND pl.status = 'active' AND pl.currency = $2
        JOIN product_variant v ON v.id = pr.variant_id AND v.product_id = p.id
        WHERE pr.currency = $2 AND pr.min_quantity = 1
      ) lp ON lp.amount_minor IS NOT NULL`;
    const order =
      q.sort === 'price_asc'
        ? 'lp.amount_minor ASC, p.handle'
        : q.sort === 'price_desc'
          ? 'lp.amount_minor DESC, p.handle'
          : q.sort === 'newest'
            ? 'p.published_at DESC NULLS LAST, p.handle'
            : 'p.published_at DESC NULLS LAST, p.handle'; // relevance stub until window 9
    const clause = where.join(' AND ');
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM product p ${priceJoin} WHERE ${clause}`,
      params,
    );
    const rows = await tx.query<
      ProductRow & { min_amount: string; category_handle: string | null }
    >(
      `SELECT p.id, p.store_id, p.handle, p.title, p.subtitle, p.description, p.status, p.category_id, p.brand_name, p.tags,
              p.attributes, p.seo, p.thumbnail_url, p.published_at, p.created_at, p.updated_at,
              lp.amount_minor::text AS min_amount, c.handle AS category_handle
       FROM product p ${priceJoin}
       LEFT JOIN product_category c ON c.id = p.category_id
       WHERE ${clause}
       ORDER BY ${order}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    const aggregates = await loadAggregates(tx, rows.rows);
    const lists = await defaultListIds(tx, storeId, currency);
    const items = rows.rows.map((r, i) => {
      const a = aggregates[i]!;
      // compare_at of the cheapest variant that has one
      const cheapest = a.variants
        .map((v) => defaultPrice(a.prices, v.id, currency, lists))
        .filter((p): p is PriceRow => !!p)
        .sort((x, y) => Number(x.amount_minor) - Number(y.amount_minor))[0];
      return {
        id: r.id,
        handle: r.handle,
        title: r.title,
        thumbnail_url: r.thumbnail_url,
        price: money(r.min_amount, currency),
        compare_at_price:
          cheapest && cheapest.compare_at_minor !== null
            ? money(cheapest.compare_at_minor, currency)
            : null,
        category_handle: r.category_handle,
        tags: r.tags ?? [],
      };
    });
    return { page, limit, total: Number(total.rows[0]?.n ?? 0), items };
  });
}

/** One published product by handle with options, variants (price + availability) and media; 404 otherwise. */
export async function getStoreProduct(
  client: ScopedClient,
  storeId: string,
  currency: string,
  handle: string,
): Promise<StoreProduct> {
  return client.transaction(async (tx) => {
    const r = await tx.query<ProductRow>(
      `SELECT id, store_id, handle, title, subtitle, description, status, category_id, brand_name, tags, attributes, seo,
              thumbnail_url, published_at, created_at, updated_at
       FROM product WHERE store_id = $1 AND handle = $2 AND status = 'published'`,
      [storeId, handle],
    );
    const row = r.rows[0];
    if (!row) throw notFound('product', handle);
    const [a] = await loadAggregates(tx, [row]);
    const lists = await defaultListIds(tx, storeId, currency);
    let category: StoreCategory | null = null;
    if (row.category_id) {
      const c = await tx.query<CategoryRow>(
        'SELECT id, handle, name, description, parent_id, position, is_active FROM product_category WHERE id = $1',
        [row.category_id],
      );
      const cr = c.rows[0];
      if (cr)
        category = {
          id: cr.id,
          handle: cr.handle,
          name: cr.name,
          parent_id: cr.parent_id,
          position: cr.position,
        };
    }
    return {
      id: row.id,
      handle: row.handle,
      title: row.title,
      subtitle: row.subtitle,
      description: row.description,
      status: 'published',
      category,
      brand_name: row.brand_name,
      tags: row.tags ?? [],
      attributes: row.attributes ?? {},
      seo: (row.seo ?? {}) as StoreProduct['seo'],
      options: a!.options.map((o) => ({ name: o.name, values: o.values })),
      variants: a!.variants
        .map((v) => toStoreVariant(v, a!, currency, lists))
        .filter((v): v is StoreVariant => v !== null),
      media: a!.media.map((m) => ({
        url: m.url,
        alt: m.alt,
        position: m.position,
        variant_id: m.variant_id,
      })),
    };
  });
}
