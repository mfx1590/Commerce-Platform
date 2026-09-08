// Builds index records from the catalog tables (read-only). Mirrors the Store API read model: only published
// products, only default active price lists, only currencies enabled on the store, availability summed over
// active warehouses. A product with no price in any enabled currency is not sellable and is not indexed.
// Reads run on the caller's tenant client: RLS guarantees the rows belong to the store (store isolation).
import type { Queryable } from '@platform/db';
import { DESCRIPTION_MAX_CHARS, type SearchRecord, type SearchVariant } from './types';

interface ProductRow {
  id: string;
  store_id: string;
  handle: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  category_id: string | null;
  brand_name: string | null;
  tags: string[] | null;
  attributes: Record<string, unknown> | null;
  thumbnail_url: string | null;
  published_at: Date | null;
  updated_at: Date;
}

interface CategoryRow {
  id: string;
  handle: string;
  name: string;
  parent_id: string | null;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  options: Record<string, string> | null;
  manage_inventory: boolean;
  allow_backorder: boolean;
}

interface PriceRow {
  variant_id: string;
  currency: string;
  amount_minor: string;
  compare_at_minor: string | null;
}

interface InventoryRow {
  variant_id: string;
  available: number;
}

export interface LoadRecordsOptions {
  /** Restrict to these product ids (incremental sync); default: every published product of the store. */
  productIds?: string[];
  limit?: number;
  offset?: number;
}

/** Enabled currencies of the store (`store_currency`). */
export async function storeCurrencies(tx: Queryable, storeId: string): Promise<string[]> {
  const r = await tx.query<{ currency: string }>(
    `SELECT currency FROM store_currency WHERE store_id = $1 ORDER BY is_default DESC, currency`,
    [storeId],
  );
  return r.rows.map((x) => x.currency.trim().toUpperCase());
}

function categoryPath(categories: Map<string, CategoryRow>, id: string | null): CategoryRow[] {
  const path: CategoryRow[] = [];
  const seen = new Set<string>();
  let cur = id ? categories.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parent_id ? categories.get(cur.parent_id) : undefined;
  }
  return path;
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/**
 * Turns the loaded rows of one product into a record, or null when it has no price in an enabled currency.
 * Exported for unit tests (pure).
 */
export function buildRecord(
  product: ProductRow,
  variants: VariantRow[],
  prices: PriceRow[],
  inventory: InventoryRow[],
  categories: Map<string, CategoryRow>,
  currencies: string[],
): SearchRecord | null {
  const enabled = new Set(currencies.map((c) => c.toUpperCase()));
  const priceMin: Record<string, number> = {};
  const priceMax: Record<string, number> = {};
  const compareAt: Record<string, number> = {};
  const cheapestCompare: Record<string, { amount: number; compare: number | null }> = {};
  for (const p of prices) {
    const cur = p.currency.trim().toUpperCase();
    if (!enabled.has(cur)) continue;
    const amount = Number(p.amount_minor);
    if (!Number.isFinite(amount)) continue;
    priceMin[cur] = priceMin[cur] === undefined ? amount : Math.min(priceMin[cur], amount);
    priceMax[cur] = priceMax[cur] === undefined ? amount : Math.max(priceMax[cur], amount);
    const compare = p.compare_at_minor === null ? null : Number(p.compare_at_minor);
    const prev = cheapestCompare[cur];
    if (!prev || amount < prev.amount) cheapestCompare[cur] = { amount, compare };
  }
  for (const [cur, v] of Object.entries(cheapestCompare)) {
    if (v.compare !== null && Number.isFinite(v.compare)) compareAt[cur] = v.compare;
  }
  const sellable = Object.keys(priceMin).sort();
  if (sellable.length === 0) return null;

  const availableByVariant = new Map<string, number>();
  for (const i of inventory) {
    availableByVariant.set(i.variant_id, (availableByVariant.get(i.variant_id) ?? 0) + i.available);
  }
  let anyManaged = false;
  let totalAvailable = 0;
  const searchVariants: SearchVariant[] = variants.map((v) => {
    let inStock = true;
    if (v.manage_inventory) {
      anyManaged = true;
      const available = Math.max(0, availableByVariant.get(v.id) ?? 0);
      totalAvailable += available;
      inStock = available > 0 || v.allow_backorder;
    }
    return { id: v.id, sku: v.sku, title: v.title, options: v.options ?? {}, in_stock: inStock };
  });

  const path = categoryPath(categories, product.category_id);
  const leaf = path[path.length - 1];
  const publishedAt = product.published_at ? new Date(product.published_at) : null;
  const description = product.description
    ? product.description.length > DESCRIPTION_MAX_CHARS
      ? product.description.slice(0, DESCRIPTION_MAX_CHARS)
      : product.description
    : null;

  return {
    objectID: product.id,
    store_id: product.store_id,
    handle: product.handle,
    title: product.title,
    subtitle: product.subtitle,
    description,
    brand_name: product.brand_name,
    tags: product.tags ?? [],
    category_id: product.category_id,
    category_handle: leaf?.handle ?? null,
    category_name: leaf?.name ?? null,
    category_path: path.map((c) => c.handle),
    thumbnail_url: product.thumbnail_url,
    published_at: publishedAt ? publishedAt.toISOString() : null,
    published_at_ts: publishedAt ? Math.floor(publishedAt.getTime() / 1000) : 0,
    attributes: product.attributes ?? {},
    variants: searchVariants,
    price_minor: priceMin,
    price_max_minor: priceMax,
    compare_at_minor: compareAt,
    currencies: sellable,
    in_stock: searchVariants.length === 0 ? false : searchVariants.some((v) => v.in_stock),
    available_quantity: anyManaged ? totalAvailable : null,
    updated_at: new Date(product.updated_at).toISOString(),
  };
}

/**
 * Loads published products of `storeId` (all, or the given ids) and builds their records. Products among
 * `productIds` that are missing, unpublished or unsellable are simply absent from the result — the caller
 * deletes them from the index.
 */
export async function loadSearchRecords(
  tx: Queryable,
  storeId: string,
  opts: LoadRecordsOptions = {},
): Promise<SearchRecord[]> {
  const params: unknown[] = [storeId];
  let where = `p.store_id = $1 AND p.status = 'published'`;
  if (opts.productIds) {
    if (opts.productIds.length === 0) return [];
    params.push(opts.productIds);
    where += ` AND p.id = ANY($${params.length})`;
  }
  let paging = '';
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    paging += ` LIMIT $${params.length}`;
  }
  if (opts.offset !== undefined) {
    params.push(opts.offset);
    paging += ` OFFSET $${params.length}`;
  }
  const products = await tx.query<ProductRow>(
    `SELECT p.id, p.store_id, p.handle, p.title, p.subtitle, p.description, p.category_id, p.brand_name, p.tags,
            p.attributes, p.thumbnail_url, p.published_at, p.updated_at
     FROM product p WHERE ${where} ORDER BY p.published_at DESC NULLS LAST, p.id${paging}`,
    params,
  );
  if (products.rows.length === 0) return [];
  const ids = products.rows.map((p) => p.id);

  // Sequential on purpose: one transaction = one pg client, which cannot run queries concurrently.
  const categories = await tx.query<CategoryRow>(
    `SELECT id, handle, name, parent_id FROM product_category WHERE store_id = $1`,
    [storeId],
  );
  const currencies = await storeCurrencies(tx, storeId);
  const variants = await tx.query<VariantRow>(
    `SELECT id, product_id, sku, title, options, manage_inventory, allow_backorder
     FROM product_variant WHERE product_id = ANY($1) ORDER BY position, sku`,
    [ids],
  );
  const variantIds = variants.rows.map((v) => v.id);
  const prices = variantIds.length
    ? await tx.query<PriceRow>(
        `SELECT pr.variant_id, pr.currency, pr.amount_minor::text, pr.compare_at_minor::text
         FROM price pr
         JOIN price_list pl ON pl.id = pr.price_list_id
         WHERE pr.variant_id = ANY($1) AND pr.min_quantity = 1
           AND pl.type = 'default' AND pl.status = 'active' AND pl.currency = pr.currency`,
        [variantIds],
      )
    : { rows: [] as PriceRow[] };
  const inventory = variantIds.length
    ? await tx.query<InventoryRow>(
        `SELECT il.variant_id, il.available
         FROM inventory_level il JOIN warehouse w ON w.id = il.warehouse_id AND w.is_active
         WHERE il.variant_id = ANY($1)`,
        [variantIds],
      )
    : { rows: [] as InventoryRow[] };

  const categoryMap = new Map(categories.rows.map((c) => [c.id, c]));
  const variantsByProduct = groupBy(variants.rows, (v) => v.product_id);
  const productOfVariant = new Map(variants.rows.map((v) => [v.id, v.product_id]));
  const pricesByProduct = groupBy(prices.rows, (p) => productOfVariant.get(p.variant_id) ?? '');
  const inventoryByProduct = groupBy(
    inventory.rows,
    (i) => productOfVariant.get(i.variant_id) ?? '',
  );

  const records: SearchRecord[] = [];
  for (const p of products.rows) {
    const r = buildRecord(
      p,
      variantsByProduct.get(p.id) ?? [],
      pricesByProduct.get(p.id) ?? [],
      inventoryByProduct.get(p.id) ?? [],
      categoryMap,
      currencies,
    );
    if (r) records.push(r);
  }
  return records;
}
