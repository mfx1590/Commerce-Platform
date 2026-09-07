// Catalog module (admin side) over packages/db migration 0004: product_category (tree), product, product_option,
// product_variant, product_media; read access to price / price_list (default list per currency) and
// inventory_level. Same contract as the registry module: every function takes a ScopedClient and a storeId, runs
// ONE transaction, writes audit_log, and emits its events through withEvents. RLS decides visibility; the explicit
// `store_id = $1` filters are defence in depth (a multi-store admin session must still address one store).
import type { Queryable, ScopedClient } from '@platform/db';
import type { EventEnvelope } from '@platform/events';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { mapPgError, notFound, validationError } from '../../lib/errors';
import { buildEvent, eventActor, withEvents } from '../../outbox';
import type {
  AdminCategory,
  AdminProduct,
  AdminProductQuery,
  AdminVariant,
  CategoryInput,
  CategoryRow,
  InventoryRow,
  MediaRow,
  OptionRow,
  Page,
  PriceRow,
  ProductInput,
  ProductRow,
  ProductSortField,
  SortOrder,
  VariantInput,
  VariantRow,
} from './types';

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const isoOrNull = (d: Date | string | null) => (d === null ? null : iso(d));

function organizationOf(client: ScopedClient): string {
  return client.context.organizationId;
}

// ------------------------------------------------------------------------------------------------ categories

const toCategory = (r: CategoryRow): AdminCategory => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  parent_id: r.parent_id,
  position: r.position,
  is_active: r.is_active,
});

const CATEGORY_COLS = 'id, handle, name, description, parent_id, position, is_active';

export async function listCategories(
  client: ScopedClient,
  storeId: string,
): Promise<AdminCategory[]> {
  const r = await client.query<CategoryRow>(
    `SELECT ${CATEGORY_COLS} FROM product_category WHERE store_id = $1 ORDER BY parent_id NULLS FIRST, position, handle`,
    [storeId],
  );
  return r.rows.map(toCategory);
}

export async function createCategory(
  client: ScopedClient,
  storeId: string,
  input: CategoryInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<AdminCategory> {
  const problems: Record<string, string> = {};
  if (!input.handle || !HANDLE.test(input.handle)) problems.handle = 'lowercase kebab-case';
  if (!input.name) problems.name = 'required';
  if (input.parent_id != null && !UUID.test(input.parent_id)) problems.parent_id = 'uuid';
  if (Object.keys(problems).length) throw validationError('invalid category input', problems);
  const organizationId = organizationOf(client);

  return client.transaction(async (tx) => {
    if (input.parent_id) {
      const parent = await tx.query(
        'SELECT id FROM product_category WHERE id = $1 AND store_id = $2',
        [input.parent_id, storeId],
      );
      if (parent.rowCount === 0) throw notFound('parent category', input.parent_id);
    }
    const r = await tx
      .query<CategoryRow>(
        `INSERT INTO product_category (organization_id, store_id, parent_id, handle, name, description, position, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${CATEGORY_COLS}`,
        [
          organizationId,
          storeId,
          input.parent_id ?? null,
          input.handle,
          input.name,
          input.description ?? null,
          input.position ?? 0,
          input.is_active ?? true,
        ],
      )
      .catch((e) => mapPgError(e, `category "${input.handle}"`));
    const category = toCategory(r.rows[0]!);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'product_category.create',
      entityType: 'product_category',
      entityId: category.id,
      after: category,
    });
    return category;
  });
}

// -------------------------------------------------------------------------------------------- product loading

export interface ProductAggregate {
  product: ProductRow;
  options: OptionRow[];
  variants: VariantRow[];
  prices: PriceRow[];
  inventory: InventoryRow[];
  media: MediaRow[];
}

const PRODUCT_COLS =
  'id, store_id, handle, title, subtitle, description, status, category_id, brand_name, tags, attributes, seo, thumbnail_url, published_at, created_at, updated_at';
const VARIANT_COLS =
  'id, product_id, sku, barcode, title, options, manage_inventory, allow_backorder, weight_g, dimensions_mm, hs_code, origin_country, position';

/** Loads products with options, variants (prices, inventory) and media in five batched queries. */
export async function loadAggregates(
  tx: Queryable,
  products: ProductRow[],
): Promise<ProductAggregate[]> {
  if (products.length === 0) return [];
  const ids = products.map((p) => p.id);
  const [options, variants, media] = await Promise.all([
    tx.query<OptionRow>(
      `SELECT id, product_id, name, "values", position FROM product_option WHERE product_id = ANY($1) ORDER BY position, name`,
      [ids],
    ),
    tx.query<VariantRow>(
      `SELECT ${VARIANT_COLS} FROM product_variant WHERE product_id = ANY($1) ORDER BY position, sku`,
      [ids],
    ),
    tx.query<MediaRow>(
      `SELECT id, product_id, variant_id, url, alt, position FROM product_media WHERE product_id = ANY($1) ORDER BY position, id`,
      [ids],
    ),
  ]);
  const variantIds = variants.rows.map((v) => v.id);
  const [prices, inventory] = variantIds.length
    ? await Promise.all([
        tx.query<PriceRow>(
          `SELECT p.variant_id, p.price_list_id, p.currency, p.amount_minor::text, p.compare_at_minor::text, p.min_quantity
           FROM price p WHERE p.variant_id = ANY($1) ORDER BY p.currency, p.min_quantity`,
          [variantIds],
        ),
        tx.query<InventoryRow>(
          `SELECT il.variant_id, il.warehouse_id, il.on_hand, il.reserved, il.available
           FROM inventory_level il JOIN warehouse w ON w.id = il.warehouse_id AND w.is_active
           WHERE il.variant_id = ANY($1) ORDER BY w.priority`,
          [variantIds],
        ),
      ])
    : [{ rows: [] as PriceRow[] }, { rows: [] as InventoryRow[] }];

  const by = <T extends { product_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows)
      (m.get(r.product_id) ?? m.set(r.product_id, []).get(r.product_id)!).push(r);
    return m;
  };
  const byVariant = <T extends { variant_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows)
      (m.get(r.variant_id) ?? m.set(r.variant_id, []).get(r.variant_id)!).push(r);
    return m;
  };
  const optionsBy = by(options.rows);
  const variantsBy = by(variants.rows);
  const mediaBy = by(media.rows);
  const pricesBy = byVariant(prices.rows);
  const inventoryBy = byVariant(inventory.rows);

  return products.map((product) => {
    const vs = variantsBy.get(product.id) ?? [];
    return {
      product,
      options: optionsBy.get(product.id) ?? [],
      variants: vs,
      prices: vs.flatMap((v) => pricesBy.get(v.id) ?? []),
      inventory: vs.flatMap((v) => inventoryBy.get(v.id) ?? []),
      media: mediaBy.get(product.id) ?? [],
    };
  });
}

export function toAdminVariant(
  v: VariantRow,
  prices: PriceRow[],
  inventory: InventoryRow[],
): AdminVariant {
  return {
    id: v.id,
    product_id: v.product_id,
    sku: v.sku,
    barcode: v.barcode,
    title: v.title,
    options: v.options ?? {},
    manage_inventory: v.manage_inventory,
    allow_backorder: v.allow_backorder,
    weight_g: v.weight_g,
    dimensions_mm: v.dimensions_mm,
    hs_code: v.hs_code,
    origin_country: v.origin_country,
    position: v.position,
    prices: prices
      .filter((p) => p.variant_id === v.id)
      .map((p) => ({
        price_list_id: p.price_list_id,
        currency: p.currency,
        amount_minor: Number(p.amount_minor),
        compare_at_minor: p.compare_at_minor === null ? null : Number(p.compare_at_minor),
        min_quantity: p.min_quantity,
      })),
    inventory: inventory
      .filter((i) => i.variant_id === v.id)
      .map((i) => ({
        warehouse_id: i.warehouse_id,
        on_hand: i.on_hand,
        reserved: i.reserved,
        available: i.available,
      })),
  };
}

export function toAdminProduct(a: ProductAggregate): AdminProduct {
  const p = a.product;
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    subtitle: p.subtitle,
    description: p.description,
    status: p.status,
    category_id: p.category_id,
    brand_name: p.brand_name,
    tags: p.tags ?? [],
    attributes: p.attributes ?? {},
    seo: p.seo ?? {},
    thumbnail_url: p.thumbnail_url,
    options: a.options.map((o) => ({
      id: o.id,
      name: o.name,
      values: o.values,
      position: o.position,
    })),
    variants: a.variants.map((v) => toAdminVariant(v, a.prices, a.inventory)),
    media: a.media.map((m) => ({
      id: m.id,
      url: m.url,
      alt: m.alt,
      position: m.position,
      variant_id: m.variant_id,
    })),
    published_at: isoOrNull(p.published_at),
    created_at: iso(p.created_at),
    updated_at: iso(p.updated_at),
  };
}

async function loadProduct(tx: Queryable, storeId: string, productId: string): Promise<ProductRow> {
  const r = await tx.query<ProductRow>(
    `SELECT ${PRODUCT_COLS} FROM product WHERE id = $1 AND store_id = $2`,
    [productId, storeId],
  );
  if (!r.rows[0]) throw notFound('product', productId);
  return r.rows[0];
}

async function loadAggregate(
  tx: Queryable,
  storeId: string,
  productId: string,
): Promise<ProductAggregate> {
  const [a] = await loadAggregates(tx, [await loadProduct(tx, storeId, productId)]);
  return a!;
}

const variantSummaries = (a: ProductAggregate) =>
  a.variants.map((v) => ({ variant_id: v.id, sku: v.sku, title: v.title }));

async function emitProductUpdated(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  a: ProductAggregate,
  changedFields: string[],
  actor: Actor,
): Promise<void> {
  await withEvents(tx, [
    await buildEvent({
      topic: 'product.updated',
      organizationId,
      storeId,
      aggregateType: 'product',
      aggregateId: a.product.id,
      actor: eventActor(actor),
      payload: {
        product_id: a.product.id,
        handle: a.product.handle,
        status: a.product.status,
        changed_fields: [...new Set(changedFields)].sort(),
        variants: variantSummaries(a),
      },
    }),
  ]);
}

// -------------------------------------------------------------------------------------------------- products

/** Whitelisted ORDER BY per contract `sort` value (never interpolate user input into SQL). */
const PRODUCT_ORDER_BY: Record<ProductSortField, string> = {
  title: 'title',
  handle: 'handle',
  status: 'status',
  created_at: 'created_at',
  updated_at: 'updated_at',
};

export async function listProducts(
  client: ScopedClient,
  storeId: string,
  q: AdminProductQuery = {},
): Promise<Page<AdminProduct>> {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(100, Math.max(1, q.limit ?? 20));
  const where: string[] = ['store_id = $1'];
  const params: unknown[] = [storeId];
  if (q.status) {
    params.push(q.status);
    where.push(`status = $${params.length}`);
  }
  if (q.category_id) {
    params.push(q.category_id);
    where.push(`category_id = $${params.length}`);
  }
  if (q.q?.trim()) {
    params.push(`%${q.q.trim()}%`);
    where.push(`(title ILIKE $${params.length} OR handle ILIKE $${params.length})`);
  }
  const clause = where.join(' AND ');
  // Contract defaults: sort updated_at, order desc; `order` only applies together with `sort`.
  const sort: ProductSortField = q.sort ?? 'updated_at';
  const order: SortOrder = q.sort ? (q.order ?? 'desc') : 'desc';
  const orderBy = `${PRODUCT_ORDER_BY[sort]} ${order === 'asc' ? 'ASC' : 'DESC'}, handle`;
  return client.transaction(async (tx) => {
    const total = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM product WHERE ${clause}`,
      params,
    );
    const rows = await tx.query<ProductRow>(
      `SELECT ${PRODUCT_COLS} FROM product WHERE ${clause} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    const aggregates = await loadAggregates(tx, rows.rows);
    return {
      page,
      limit,
      total: Number(total.rows[0]?.n ?? 0),
      items: aggregates.map(toAdminProduct),
    };
  });
}

export async function getProduct(
  client: ScopedClient,
  storeId: string,
  productId: string,
): Promise<AdminProduct> {
  return client.transaction(async (tx) =>
    toAdminProduct(await loadAggregate(tx, storeId, productId)),
  );
}

function validateProductInput(input: ProductInput, mode: 'create' | 'update'): void {
  const problems: Record<string, string> = {};
  if (mode === 'create') {
    if (!input.handle) problems.handle = 'required';
    if (!input.title) problems.title = 'required';
  }
  if (input.handle !== undefined && !HANDLE.test(input.handle))
    problems.handle = 'lowercase kebab-case';
  if (input.category_id != null && !UUID.test(input.category_id)) problems.category_id = 'uuid';
  if (input.options) {
    const names = new Set<string>();
    for (const o of input.options) {
      if (!o.name || !Array.isArray(o.values) || o.values.length === 0)
        problems.options = 'each option needs a name and values';
      if (names.has(o.name)) problems.options = `duplicate option "${o.name}"`;
      names.add(o.name);
    }
  }
  if (input.media)
    for (const m of input.media) if (!m.url) problems.media = 'each media item needs a url';
  if (Object.keys(problems).length) throw validationError('invalid product input', problems);
}

async function replaceOptions(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  productId: string,
  options: NonNullable<ProductInput['options']>,
): Promise<void> {
  await tx.query('DELETE FROM product_option WHERE product_id = $1', [productId]);
  for (const [i, o] of options.entries()) {
    await tx.query(
      `INSERT INTO product_option (organization_id, store_id, product_id, name, "values", position) VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, storeId, productId, o.name, o.values, i],
    );
  }
}

async function replaceMedia(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  productId: string,
  media: NonNullable<ProductInput['media']>,
): Promise<void> {
  await tx.query('DELETE FROM product_media WHERE product_id = $1', [productId]);
  for (const [i, m] of media.entries()) {
    if (m.variant_id) {
      const v = await tx.query('SELECT id FROM product_variant WHERE id = $1 AND product_id = $2', [
        m.variant_id,
        productId,
      ]);
      if (v.rowCount === 0) throw notFound('variant', m.variant_id);
    }
    await tx.query(
      `INSERT INTO product_media (organization_id, store_id, product_id, variant_id, url, alt, position) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        organizationId,
        storeId,
        productId,
        m.variant_id ?? null,
        m.url,
        m.alt ?? null,
        m.position ?? i,
      ],
    );
  }
}

async function assertCategory(tx: Queryable, storeId: string, categoryId: string): Promise<void> {
  const c = await tx.query('SELECT id FROM product_category WHERE id = $1 AND store_id = $2', [
    categoryId,
    storeId,
  ]);
  if (c.rowCount === 0) throw notFound('category', categoryId);
}

/** Creates a draft product with options and media. Emits `product.updated` (created). */
export async function createProduct(
  client: ScopedClient,
  storeId: string,
  input: ProductInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<AdminProduct> {
  validateProductInput(input, 'create');
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    if (input.category_id) await assertCategory(tx, storeId, input.category_id);
    const r = await tx
      .query<ProductRow>(
        `INSERT INTO product (organization_id, store_id, handle, title, subtitle, description, status, category_id, brand_name, tags, attributes, seo, thumbnail_url)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12) RETURNING ${PRODUCT_COLS}`,
        [
          organizationId,
          storeId,
          input.handle,
          input.title,
          input.subtitle ?? null,
          input.description ?? null,
          input.category_id ?? null,
          input.brand_name ?? null,
          input.tags ?? [],
          JSON.stringify(input.attributes ?? {}),
          JSON.stringify(input.seo ?? {}),
          input.media?.[0]?.url ?? null,
        ],
      )
      .catch((e) => mapPgError(e, `product "${input.handle}"`));
    const row = r.rows[0]!;
    if (input.options) await replaceOptions(tx, organizationId, storeId, row.id, input.options);
    if (input.media) await replaceMedia(tx, organizationId, storeId, row.id, input.media);

    const a = await loadAggregate(tx, storeId, row.id);
    const product = toAdminProduct(a);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'product.create',
      entityType: 'product',
      entityId: row.id,
      after: product,
    });
    const changed = Object.keys(input).filter((k) => input[k as keyof ProductInput] !== undefined);
    await emitProductUpdated(
      tx,
      organizationId,
      storeId,
      a,
      changed.length ? changed : ['created'],
      actor,
    );
    return product;
  });
}

const PRODUCT_PATCH_COLUMNS = [
  'handle',
  'title',
  'subtitle',
  'description',
  'category_id',
  'brand_name',
  'tags',
  'attributes',
  'seo',
] as const;

/** Partial update; `options` / `media` replace the whole set when provided. Emits `product.updated`. */
export async function updateProduct(
  client: ScopedClient,
  storeId: string,
  productId: string,
  patch: ProductInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<AdminProduct> {
  validateProductInput(patch, 'update');
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const before = toAdminProduct(await loadAggregate(tx, storeId, productId));
    if (patch.category_id) await assertCategory(tx, storeId, patch.category_id);

    const sets: string[] = [];
    const params: unknown[] = [productId];
    for (const col of PRODUCT_PATCH_COLUMNS) {
      const value = patch[col];
      if (value === undefined) continue;
      params.push(col === 'attributes' || col === 'seo' ? JSON.stringify(value) : value);
      sets.push(`${col} = $${params.length}`);
    }
    if (patch.media?.length) {
      params.push(patch.media[0]!.url);
      sets.push(`thumbnail_url = $${params.length}`);
    }
    if (sets.length) {
      await tx
        .query(`UPDATE product SET ${sets.join(', ')} WHERE id = $1`, params)
        .catch((e) => mapPgError(e, `product "${patch.handle ?? before.handle}"`));
    }
    if (patch.options) await replaceOptions(tx, organizationId, storeId, productId, patch.options);
    if (patch.media) await replaceMedia(tx, organizationId, storeId, productId, patch.media);

    const a = await loadAggregate(tx, storeId, productId);
    const after = toAdminProduct(a);
    const changed = (Object.keys(after) as (keyof AdminProduct)[]).filter(
      (k) => k !== 'updated_at' && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (changed.length === 0) return after;

    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'product.update',
      entityType: 'product',
      entityId: productId,
      before,
      after,
    });
    await emitProductUpdated(tx, organizationId, storeId, a, changed, actor);
    return after;
  });
}

/** draft → published (idempotent for an already published product). Emits `product.published`. */
export async function publishProduct(
  client: ScopedClient,
  storeId: string,
  productId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<AdminProduct> {
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const current = await loadProduct(tx, storeId, productId);
    if (current.status === 'archived')
      throw validationError('archived products cannot be published');
    if (current.status === 'published')
      return toAdminProduct(await loadAggregate(tx, storeId, productId));
    await tx.query(`UPDATE product SET status = 'published', published_at = now() WHERE id = $1`, [
      productId,
    ]);
    const a = await loadAggregate(tx, storeId, productId);
    const product = toAdminProduct(a);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'product.publish',
      entityType: 'product',
      entityId: productId,
      before: { status: current.status },
      after: { status: 'published', published_at: product.published_at },
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'product.published',
        organizationId,
        storeId,
        aggregateType: 'product',
        aggregateId: productId,
        actor: eventActor(actor),
        payload: {
          product_id: productId,
          handle: a.product.handle,
          title: a.product.title,
          category_id: a.product.category_id,
          variants: variantSummaries(a),
          published_at: product.published_at!,
        },
      }),
    ]);
    return product;
  });
}

/** Any status → archived (never a hard delete). Emits `product.archived`. */
export async function archiveProduct(
  client: ScopedClient,
  storeId: string,
  productId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<AdminProduct> {
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const current = await loadProduct(tx, storeId, productId);
    if (current.status === 'archived')
      return toAdminProduct(await loadAggregate(tx, storeId, productId));
    const r = await tx.query<{ updated_at: Date }>(
      `UPDATE product SET status = 'archived' WHERE id = $1 RETURNING updated_at`,
      [productId],
    );
    const a = await loadAggregate(tx, storeId, productId);
    const product = toAdminProduct(a);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'product.archive',
      entityType: 'product',
      entityId: productId,
      before: { status: current.status },
      after: { status: 'archived' },
    });
    await withEvents(tx, [
      await buildEvent({
        topic: 'product.archived',
        organizationId,
        storeId,
        aggregateType: 'product',
        aggregateId: productId,
        actor: eventActor(actor),
        payload: {
          product_id: productId,
          handle: a.product.handle,
          archived_at: iso(r.rows[0]!.updated_at),
        },
      }),
    ]);
    return product;
  });
}

// -------------------------------------------------------------------------------------------------- variants

function validateVariantInput(input: VariantInput, mode: 'create' | 'update'): void {
  const problems: Record<string, string> = {};
  if (mode === 'create') {
    if (!input.sku) problems.sku = 'required';
    if (!input.title) problems.title = 'required';
  }
  if (input.origin_country != null && !/^[A-Z]{2}$/.test(input.origin_country))
    problems.origin_country = 'ISO-3166-1 alpha-2';
  if (input.weight_g != null && (!Number.isInteger(input.weight_g) || input.weight_g < 0))
    problems.weight_g = 'non-negative integer';
  for (const p of input.prices ?? []) {
    if (!CURRENCY.test(p.currency)) problems.prices = 'currency must be ISO-4217';
    if (!Number.isInteger(p.amount_minor) || p.amount_minor < 0)
      problems.prices = 'amount_minor must be a non-negative integer';
  }
  if (Object.keys(problems).length) throw validationError('invalid variant input', problems);
}

/** Variant options must use the product's option names and one of their values. */
function assertOptionsMatch(
  options: OptionRow[],
  values: Record<string, string> | undefined,
): void {
  if (!values) return;
  const problems: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const o = options.find((x) => x.name === name);
    if (!o) problems[name] = 'unknown option';
    else if (!o.values.includes(value)) problems[name] = `not one of ${o.values.join(', ')}`;
  }
  if (Object.keys(problems).length)
    throw validationError('variant options do not match product options', problems);
}

/** Writes `prices` onto the store's default price list of each currency (VariantInput.prices convenience). */
async function upsertDefaultPrices(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  variantId: string,
  prices: NonNullable<VariantInput['prices']>,
): Promise<void> {
  for (const p of prices) {
    const list = await tx.query<{ id: string }>(
      `SELECT id FROM price_list WHERE store_id = $1 AND type = 'default' AND currency = $2`,
      [storeId, p.currency],
    );
    const listId = list.rows[0]?.id;
    if (!listId)
      throw validationError(`store has no default price list for ${p.currency}`, {
        currency: p.currency,
      });
    await tx.query(
      `INSERT INTO price (organization_id, store_id, price_list_id, variant_id, currency, amount_minor, compare_at_minor, min_quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
       ON CONFLICT (price_list_id, variant_id, min_quantity) DO UPDATE SET amount_minor = EXCLUDED.amount_minor, compare_at_minor = EXCLUDED.compare_at_minor`,
      [
        organizationId,
        storeId,
        listId,
        variantId,
        p.currency,
        p.amount_minor,
        p.compare_at_minor ?? null,
      ],
    );
  }
}

export async function createVariant(
  client: ScopedClient,
  storeId: string,
  productId: string,
  input: VariantInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<AdminVariant> {
  validateVariantInput(input, 'create');
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const a = await loadAggregate(tx, storeId, productId);
    assertOptionsMatch(a.options, input.options);
    const r = await tx
      .query<VariantRow>(
        `INSERT INTO product_variant (organization_id, store_id, product_id, sku, barcode, title, options, manage_inventory, allow_backorder, weight_g, dimensions_mm, hs_code, origin_country, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${VARIANT_COLS}`,
        [
          organizationId,
          storeId,
          productId,
          input.sku,
          input.barcode ?? null,
          input.title,
          JSON.stringify(input.options ?? {}),
          input.manage_inventory ?? true,
          input.allow_backorder ?? false,
          input.weight_g ?? null,
          input.dimensions_mm ? JSON.stringify(input.dimensions_mm) : null,
          input.hs_code ?? null,
          input.origin_country ?? null,
          input.position ?? a.variants.length,
        ],
      )
      .catch((e) => mapPgError(e, `variant "${input.sku}"`));
    const variantId = r.rows[0]!.id;
    if (input.prices)
      await upsertDefaultPrices(tx, organizationId, storeId, variantId, input.prices);

    const after = await loadAggregate(tx, storeId, productId);
    const variant = after.variants.find((v) => v.id === variantId)!;
    const result = toAdminVariant(variant, after.prices, after.inventory);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'product_variant.create',
      entityType: 'product_variant',
      entityId: variantId,
      after: result,
    });
    await emitProductUpdated(tx, organizationId, storeId, after, ['variants'], actor);
    return result;
  });
}

const VARIANT_PATCH_COLUMNS = [
  'sku',
  'barcode',
  'title',
  'options',
  'manage_inventory',
  'allow_backorder',
  'weight_g',
  'dimensions_mm',
  'hs_code',
  'origin_country',
  'position',
] as const;

export async function updateVariant(
  client: ScopedClient,
  storeId: string,
  variantId: string,
  patch: VariantInput,
  actor: Actor = SYSTEM_ACTOR,
): Promise<AdminVariant> {
  validateVariantInput(patch, 'update');
  const organizationId = organizationOf(client);
  return client.transaction(async (tx) => {
    const owner = await tx.query<{ product_id: string }>(
      'SELECT product_id FROM product_variant WHERE id = $1 AND store_id = $2',
      [variantId, storeId],
    );
    if (!owner.rows[0]) throw notFound('variant', variantId);
    const productId = owner.rows[0].product_id;
    const beforeAgg = await loadAggregate(tx, storeId, productId);
    assertOptionsMatch(beforeAgg.options, patch.options);
    const before = toAdminVariant(
      beforeAgg.variants.find((v) => v.id === variantId)!,
      beforeAgg.prices,
      beforeAgg.inventory,
    );

    const sets: string[] = [];
    const params: unknown[] = [variantId];
    for (const col of VARIANT_PATCH_COLUMNS) {
      const value = patch[col];
      if (value === undefined) continue;
      params.push(
        col === 'options' || col === 'dimensions_mm'
          ? value === null
            ? null
            : JSON.stringify(value)
          : value,
      );
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length) {
      await tx
        .query(`UPDATE product_variant SET ${sets.join(', ')} WHERE id = $1`, params)
        .catch((e) => mapPgError(e, `variant "${patch.sku ?? before.sku}"`));
    }
    if (patch.prices)
      await upsertDefaultPrices(tx, organizationId, storeId, variantId, patch.prices);

    const afterAgg = await loadAggregate(tx, storeId, productId);
    const after = toAdminVariant(
      afterAgg.variants.find((v) => v.id === variantId)!,
      afterAgg.prices,
      afterAgg.inventory,
    );
    if (JSON.stringify(before) === JSON.stringify(after)) return after;
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'product_variant.update',
      entityType: 'product_variant',
      entityId: variantId,
      before,
      after,
    });
    await emitProductUpdated(tx, organizationId, storeId, afterAgg, ['variants'], actor);
    return after;
  });
}

export type { EventEnvelope };
