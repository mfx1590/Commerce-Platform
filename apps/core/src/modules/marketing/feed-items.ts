// Builds feed rows from the catalog (read-only), one row per sellable variant (#146).
//
// Mirrors the Store API read model, the same way the search module builds its index records: only `published`
// products, prices from the store's default active price list in the feed's currency, availability summed over
// active warehouses. Reads run on the caller's tenant client, so RLS guarantees the rows belong to the store.
//
// Marketing owns none of these tables and writes none of them.
import type { Queryable } from '@platform/db';
import type { Availability, FeedError, FeedFilters, FeedItem, ProductFeedRow } from './feed-types';

interface ProductRow {
  id: string;
  handle: string;
  title: string;
  description: string | null;
  brand_name: string | null;
  thumbnail_url: string | null;
}

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  barcode: string | null;
  manage_inventory: boolean;
  allow_backorder: boolean;
}

interface PriceRow {
  variant_id: string;
  amount_minor: string;
  compare_at_minor: string | null;
}

interface MediaRow {
  product_id: string;
  variant_id: string | null;
  url: string;
}

/** The store's primary domain, or the first verified one; `null` leaves `link` empty and the item invalid. */
async function primaryHost(tx: Queryable, storeId: string): Promise<string | null> {
  const r = await tx.query<{ hostname: string }>(
    `SELECT hostname FROM store_domain WHERE store_id = $1
      ORDER BY is_primary DESC, verified_at NULLS LAST, created_at
      LIMIT 1`,
    [storeId],
  );
  return r.rows[0]?.hostname ?? null;
}

function availabilityOf(variant: VariantRow, available: number | undefined): Availability {
  // A variant that does not manage inventory is always sellable (made to order, digital, drop-shipped).
  if (!variant.manage_inventory) return 'in_stock';
  if ((available ?? 0) > 0) return 'in_stock';
  return variant.allow_backorder ? 'backorder' : 'out_of_stock';
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * Applies the feed's `mapping` overrides. The contract calls it "channel attribute → product field overrides
 * (e.g. `{ brand: Brand A }`)": a constant that wins over whatever the catalogue says. Three keys are
 * understood — `brand`, `description`, `item_group_id`. Anything else is kept in the column and ignored here
 * rather than rejected, so a channel-specific key added later does not invalidate existing feeds.
 */
function applyMapping(item: FeedItem, mapping: Record<string, unknown>): void {
  const brand = text(mapping.brand);
  if (brand) item.brand = brand;
  const description = text(mapping.description);
  if (description) item.description = description;
  const group = text(mapping.item_group_id);
  if (group) item.item_group_id = group;
}

function matchesTags(productTags: string[] | null, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  const have = new Set(productTags ?? []);
  return wanted.some((t) => have.has(t));
}

/**
 * Every row the feed emits, before validation. Ordered by product handle then variant position, so the rendered
 * file is stable between publishes — which is what makes the content hash a meaningful idempotency key.
 */
export async function buildFeedItems(
  tx: Queryable,
  storeId: string,
  feed: Pick<ProductFeedRow, 'currency' | 'filters' | 'mapping'>,
): Promise<{ items: FeedItem[]; errors: FeedError[] }> {
  const filters: FeedFilters = feed.filters ?? {};
  const currency = feed.currency.trim().toUpperCase();
  const errors: FeedError[] = [];

  const host = await primaryHost(tx, storeId);
  if (!host) {
    errors.push({
      code: 'no_primary_domain',
      message: 'the store has no domain, so feed items cannot be linked',
      product_id: null,
    });
  }

  const categoryIds = Array.isArray(filters.category_ids) ? filters.category_ids : null;
  const products = await tx.query<ProductRow & { tags: string[] | null }>(
    `SELECT p.id, p.handle, p.title, p.description, p.brand_name, p.thumbnail_url, p.tags
       FROM product p
      WHERE p.store_id = $1
        AND p.status = 'published'
        AND ($2::uuid[] IS NULL OR p.category_id = ANY($2))
      ORDER BY p.handle`,
    [storeId, categoryIds],
  );
  const wantedTags = Array.isArray(filters.tags) ? filters.tags : undefined;
  const kept = products.rows.filter((p) => matchesTags(p.tags, wantedTags));
  if (kept.length === 0) return { items: [], errors };

  const productIds = kept.map((p) => p.id);
  const variants = await tx.query<VariantRow>(
    `SELECT id, product_id, sku, title, barcode, manage_inventory, allow_backorder
       FROM product_variant WHERE product_id = ANY($1) ORDER BY product_id, position, sku`,
    [productIds],
  );
  const variantIds = variants.rows.map((v) => v.id);
  if (variantIds.length === 0) return { items: [], errors };

  // The store's default price list for this currency — the same read model the Store API prices from.
  const prices = await tx.query<PriceRow>(
    `SELECT pr.variant_id, pr.amount_minor, pr.compare_at_minor
       FROM price pr
       JOIN price_list pl ON pl.id = pr.price_list_id
      WHERE pr.variant_id = ANY($1)
        AND pr.currency = $2
        AND pl.type = 'default'
        AND pl.status = 'active'
        AND pl.currency = $2
        AND pr.min_quantity = 1`,
    [variantIds, currency],
  );
  const priceOf = new Map(prices.rows.map((p) => [p.variant_id, p]));

  const inventory = await tx.query<{ variant_id: string; available: number }>(
    `SELECT il.variant_id, SUM(il.available)::int AS available
       FROM inventory_level il JOIN warehouse w ON w.id = il.warehouse_id AND w.is_active
      WHERE il.variant_id = ANY($1)
      GROUP BY il.variant_id`,
    [variantIds],
  );
  const availableOf = new Map(inventory.rows.map((i) => [i.variant_id, i.available]));

  const media = await tx.query<MediaRow>(
    `SELECT product_id, variant_id, url FROM product_media
      WHERE product_id = ANY($1) ORDER BY product_id, position, created_at`,
    [productIds],
  );
  const productImage = new Map<string, string>();
  const variantImage = new Map<string, string>();
  for (const m of media.rows) {
    if (m.variant_id && !variantImage.has(m.variant_id)) variantImage.set(m.variant_id, m.url);
    if (!m.variant_id && !productImage.has(m.product_id)) productImage.set(m.product_id, m.url);
  }

  const productById = new Map(kept.map((p) => [p.id, p]));
  const items: FeedItem[] = [];
  for (const variant of variants.rows) {
    const product = productById.get(variant.product_id);
    if (!product) continue;

    const price = priceOf.get(variant.id);
    // A variant with no price in the feed currency is not sellable there. It is skipped rather than emitted as
    // an invalid row: the merchant did not ask to sell it in this currency, so it is not an error about data.
    if (!price) continue;

    const amount = Number(price.amount_minor);
    const compareAt = price.compare_at_minor === null ? null : Number(price.compare_at_minor);
    // Channel convention: `price` is the list price and `sale_price` the discounted one. Our `compare_at_minor`
    // is the "was" price, so a genuine markdown flips the two.
    const onSale = compareAt !== null && compareAt > amount;

    const availability = availabilityOf(variant, availableOf.get(variant.id));
    if (filters.in_stock_only === true && availability !== 'in_stock') continue;

    const variantTitle = text(variant.title);
    const item: FeedItem = {
      id: variant.sku,
      product_id: product.id,
      variant_id: variant.id,
      sku: variant.sku,
      title:
        variantTitle && variantTitle !== product.title
          ? `${product.title} - ${variantTitle}`
          : product.title,
      description: text(product.description),
      link: host ? `https://${host}/products/${product.handle}?variant=${variant.id}` : '',
      image_link:
        variantImage.get(variant.id) ?? productImage.get(product.id) ?? product.thumbnail_url,
      gtin: text(variant.barcode),
      brand: text(product.brand_name),
      availability,
      price: { amount_minor: onSale ? compareAt : amount, currency },
      sale_price: onSale ? { amount_minor: amount, currency } : null,
      item_group_id: product.handle,
      errors: [],
    };
    applyMapping(item, feed.mapping ?? {});
    items.push(item);
  }

  return { items, errors };
}
