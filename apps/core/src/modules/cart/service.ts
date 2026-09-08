// Cart module (issue #103): the Store API cart over our `cart` / `cart_line_item` tables (packages/db 0006), one
// transaction per use case on a store-scoped client. Carts BYPASS Medusa's cart module (decision 2026-09-08,
// README "Decisions"). Every mutation locks the cart row, applies the change, then `recalculate()`s the totals in
// the same transaction through the pricing providers (providers.ts) — integer minor units throughout. Carts emit
// no events (docs/domain.md); `cart.abandoned` is task 2.6's job.
import type { Queryable, ScopedClient } from '@platform/db';
import { AppError, notFound, validationError } from '../../lib/errors';
import {
  currentShippingRateProvider,
  currentTaxCalculator,
  taxOn,
  type PricingContext,
} from './providers';
import type {
  Address,
  CartLineRow,
  CartRow,
  CartStoreContext,
  CreateCartInput,
  Money,
  PricingLine,
  ShippingOptionRow,
  StoreCart,
  StoreLineItem,
  UpdateCartInput,
} from './types';

const CART_COLS = `id, organization_id, store_id, sales_channel_id, customer_id, email, currency, locale, country,
  shipping_address, billing_address, shipping_option_id, promotion_codes, payment_session,
  subtotal_minor::text, discount_minor::text, shipping_minor::text, tax_minor::text, total_minor::text,
  status, order_id, completed_at, metadata, created_at, updated_at`;

const LINE_COLS = `li.id, li.cart_id, li.variant_id, v.product_id, p.category_id, li.sku, li.title, li.variant_title,
  li.thumbnail_url, li.quantity, li.unit_price_minor::text, li.discount_minor::text, li.tax_rate_bp, li.metadata`;

const money = (amount: string | number, currency: string): Money => ({
  amount_minor: Number(amount),
  currency,
});

const cartCompleted = (cart: CartRow) =>
  new AppError('cart_completed', `cart ${cart.id} is ${cart.status}`, {
    cart_id: cart.id,
    status: cart.status,
    order_id: cart.order_id,
  });

// ---- loading ----

/** The cart row (404 when invisible); `lock = true` takes `FOR UPDATE` for a mutation. */
export async function loadCart(tx: Queryable, cartId: string, lock: boolean): Promise<CartRow> {
  const r = await tx.query<CartRow>(
    `SELECT ${CART_COLS} FROM cart WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [cartId],
  );
  const row = r.rows[0];
  // A cart of another store is invisible under RLS: the same 404 as a cart that never existed.
  if (!row) throw notFound('cart', cartId);
  return row;
}

/** Locks the cart row for the mutation and refuses completed/abandoned carts (409 `cart_completed`). */
export async function lockActiveCart(tx: Queryable, cartId: string): Promise<CartRow> {
  const cart = await loadCart(tx, cartId, true);
  if (cart.status !== 'active') throw cartCompleted(cart);
  return cart;
}

export async function loadLines(tx: Queryable, cartId: string): Promise<CartLineRow[]> {
  const r = await tx.query<CartLineRow>(
    `SELECT ${LINE_COLS} FROM cart_line_item li
     JOIN product_variant v ON v.id = li.variant_id
     JOIN product p ON p.id = v.product_id
     WHERE li.cart_id = $1 ORDER BY li.created_at, li.id`,
    [cartId],
  );
  return r.rows;
}

// ---- rendering ----

function toStoreLineItem(l: CartLineRow, currency: string): StoreLineItem {
  const unit = Number(l.unit_price_minor);
  const subtotal = l.quantity * unit;
  const discount = Number(l.discount_minor);
  const tax = taxOn(subtotal - discount, l.tax_rate_bp);
  return {
    id: l.id,
    variant_id: l.variant_id,
    sku: l.sku,
    title: l.title,
    variant_title: l.variant_title,
    thumbnail_url: l.thumbnail_url,
    quantity: l.quantity,
    unit_price: money(unit, currency),
    subtotal: money(subtotal, currency),
    discount: money(discount, currency),
    tax: money(tax, currency),
    total: money(subtotal - discount + tax, currency),
  };
}

/** The contract `Cart` for a cart id (404 when invisible). Exported as `renderCart` for the checkout module. */
export async function render(tx: Queryable, cartId: string): Promise<StoreCart> {
  const cart = await loadCart(tx, cartId, false);
  const lines = await loadLines(tx, cartId);
  let option: ShippingOptionRow | undefined;
  if (cart.shipping_option_id) {
    const r = await tx.query<ShippingOptionRow>(
      `SELECT id, code, name, carrier, price_minor::text, currency FROM shipping_option WHERE id = $1`,
      [cart.shipping_option_id],
    );
    option = r.rows[0];
  }
  return {
    id: cart.id,
    status: cart.status,
    currency: cart.currency,
    locale: cart.locale,
    country: cart.country,
    email: cart.email,
    items: lines.map((l) => toStoreLineItem(l, cart.currency)),
    shipping_address: cart.shipping_address,
    billing_address: cart.billing_address,
    shipping_option: option
      ? {
          id: option.id,
          code: option.code,
          name: option.name,
          carrier: option.carrier,
          // The price the cart was quoted (snapshot), not the option's current list price.
          price: money(cart.shipping_minor, cart.currency),
        }
      : null,
    promotion_codes: cart.promotion_codes,
    payment_session: cart.payment_session,
    totals: {
      subtotal: money(cart.subtotal_minor, cart.currency),
      discount: money(cart.discount_minor, cart.currency),
      shipping: money(cart.shipping_minor, cart.currency),
      tax: money(cart.tax_minor, cart.currency),
      total: money(cart.total_minor, cart.currency),
    },
    order_id: cart.order_id,
    metadata: cart.metadata,
  };
}

// ---- totals ----

interface RecalculateOptions {
  /** The request set `shipping_option_id`: an option the provider cannot quote is a 400, not a silent drop. */
  explicitShippingOption?: boolean;
}

/**
 * Recomputes every derived amount of a cart inside the mutation's transaction: shipping through the
 * ShippingRateProvider (a selection that is no longer quotable — e.g. after a country change — is dropped), tax
 * through the TaxCalculator (per-line `tax_rate_bp` persisted), then subtotal / discount / shipping / tax / total.
 * Discounts stay 0 until window 9's promotions API prices the stored codes.
 */
export async function recalculate(
  tx: Queryable,
  cart: CartRow,
  opts: RecalculateOptions = {},
): Promise<void> {
  const lines = await loadLines(tx, cart.id);
  const pricingLines: PricingLine[] = lines.map((l) => ({
    lineItemId: l.id,
    variantId: l.variant_id,
    productId: l.product_id,
    categoryId: l.category_id,
    quantity: l.quantity,
    unitPriceMinor: Number(l.unit_price_minor),
    discountMinor: Number(l.discount_minor),
  }));
  const ctx: PricingContext = {
    tx,
    organizationId: cart.organization_id,
    storeId: cart.store_id,
    salesChannelId: cart.sales_channel_id,
    currency: cart.currency,
    country: cart.country,
    shippingAddress: cart.shipping_address,
    lines: pricingLines,
  };

  let shippingOptionId = cart.shipping_option_id;
  let shippingMinor = 0;
  if (shippingOptionId) {
    const rate = await currentShippingRateProvider().quote(ctx, shippingOptionId);
    if (rate) {
      shippingMinor = rate.priceMinor;
    } else if (opts.explicitShippingOption) {
      throw validationError('shipping option is not available for this cart', {
        shipping_option_id: 'not available for this cart (store, currency, country, channel)',
      });
    } else {
      shippingOptionId = null;
    }
  }

  const tax = await currentTaxCalculator().calculate({ ...ctx, shippingMinor });
  const taxByLine = new Map(tax.lines.map((t) => [t.lineItemId, t]));
  let subtotal = 0;
  let discount = 0;
  let taxMinor = tax.shippingTaxMinor;
  for (const l of lines) {
    subtotal += l.quantity * Number(l.unit_price_minor);
    discount += Number(l.discount_minor);
    const t = taxByLine.get(l.id);
    taxMinor += t?.taxMinor ?? 0;
    const bp = t?.taxRateBp ?? 0;
    if (bp !== l.tax_rate_bp) {
      await tx.query(
        `UPDATE cart_line_item SET tax_rate_bp = $2, updated_at = now() WHERE id = $1`,
        [l.id, bp],
      );
    }
  }
  await tx.query(
    `UPDATE cart SET shipping_option_id = $2, subtotal_minor = $3, discount_minor = $4, shipping_minor = $5,
       tax_minor = $6, total_minor = $7, updated_at = now()
     WHERE id = $1`,
    [
      cart.id,
      shippingOptionId,
      subtotal,
      discount,
      shippingMinor,
      taxMinor,
      subtotal - discount + shippingMinor + taxMinor,
    ],
  );
}

// ---- use cases ----

interface StoreDefaultsRow {
  default_currency: string;
  default_locale: string;
  default_country: string;
}

async function resolveSalesChannel(tx: Queryable, ctx: CartStoreContext): Promise<string> {
  if (ctx.salesChannelId) return ctx.salesChannelId;
  const r = await tx.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 AND is_active
     ORDER BY (type = 'web') DESC, created_at LIMIT 1`,
    [ctx.storeId],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new AppError('internal', 'store has no active sales channel');
  return id;
}

/** `POST /store/carts`: an empty active cart in a currency the store sells (400 otherwise). */
export async function createCart(
  client: ScopedClient,
  ctx: CartStoreContext,
  input: CreateCartInput = {},
): Promise<StoreCart> {
  return client.transaction(async (tx) => {
    const store = await tx.query<StoreDefaultsRow>(
      `SELECT default_currency, default_locale, default_country FROM store WHERE id = $1`,
      [ctx.storeId],
    );
    const defaults = store.rows[0];
    if (!defaults) throw notFound('store', ctx.storeId);
    const currencies = (
      await tx.query<{ currency: string }>(
        `SELECT currency FROM store_currency WHERE store_id = $1 ORDER BY is_default DESC, currency`,
        [ctx.storeId],
      )
    ).rows.map((c) => c.currency);
    const currency = input.currency ?? defaults.default_currency;
    if (!currencies.includes(currency)) {
      throw validationError(`currency ${currency} is not enabled for this store`, {
        currency: `one of ${currencies.join(', ')}`,
      });
    }
    const salesChannelId = await resolveSalesChannel(tx, ctx);
    const r = await tx.query<{ id: string }>(
      `INSERT INTO cart (organization_id, store_id, sales_channel_id, currency, locale, country, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
      [
        ctx.organizationId,
        ctx.storeId,
        salesChannelId,
        currency,
        input.locale ?? defaults.default_locale,
        input.country ?? defaults.default_country,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return render(tx, r.rows[0]!.id);
  });
}

/** `GET /store/carts/{cartId}`: 404 unless the cart belongs to the request's store. */
export async function getCart(client: ScopedClient, cartId: string): Promise<StoreCart> {
  return client.transaction((tx) => render(tx, cartId));
}

/** Trim, drop empties, de-duplicate case-insensitively (first spelling wins), keep order. */
export function normalizePromotionCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of codes) {
    const code = raw.trim();
    const key = code.toLowerCase();
    if (!code || seen.has(key)) continue;
    seen.add(key);
    out.push(code);
  }
  return out;
}

/**
 * `PATCH /store/carts/{cartId}`: email, addresses, shipping option, promotion codes, country, metadata. Only the
 * fields present are changed; `metadata` replaces the stored object as a whole (the storefront owns it).
 * Promotion codes are stored as given (normalised) — window 9's promotions public API will validate and price
 * them; until then they carry no discount.
 */
export async function updateCart(
  client: ScopedClient,
  cartId: string,
  input: UpdateCartInput,
): Promise<StoreCart> {
  return client.transaction(async (tx) => {
    await lockActiveCart(tx, cartId);
    const sets: string[] = [];
    const params: unknown[] = [cartId];
    const set = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (input.email !== undefined) set('email', input.email);
    if (input.shipping_address !== undefined)
      set('shipping_address', JSON.stringify(input.shipping_address), '::jsonb');
    if (input.billing_address !== undefined)
      set('billing_address', JSON.stringify(input.billing_address), '::jsonb');
    if (input.shipping_option_id !== undefined) set('shipping_option_id', input.shipping_option_id);
    if (input.promotion_codes !== undefined)
      set('promotion_codes', normalizePromotionCodes(input.promotion_codes));
    if (input.country !== undefined) set('country', input.country);
    if (input.metadata !== undefined) set('metadata', JSON.stringify(input.metadata), '::jsonb');
    if (sets.length > 0) {
      await tx.query(
        `UPDATE cart SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
        params,
      );
    }
    const updated = await loadCart(tx, cartId, false);
    await recalculate(tx, updated, {
      explicitShippingOption: input.shipping_option_id !== undefined,
    });
    return render(tx, cartId);
  });
}

interface VariantForCart {
  id: string;
  sku: string;
  title: string;
  product_id: string;
  manage_inventory: boolean;
  allow_backorder: boolean;
  product_title: string;
  product_status: string;
  product_thumbnail: string | null;
}

async function loadVariant(
  tx: Queryable,
  storeId: string,
  variantId: string,
): Promise<VariantForCart> {
  const r = await tx.query<VariantForCart>(
    `SELECT v.id, v.sku, v.title, v.product_id, v.manage_inventory, v.allow_backorder,
            p.title AS product_title, p.status AS product_status, p.thumbnail_url AS product_thumbnail
     FROM product_variant v JOIN product p ON p.id = v.product_id
     WHERE v.id = $1 AND v.store_id = $2`,
    [variantId, storeId],
  );
  const v = r.rows[0];
  if (!v || v.product_status !== 'published') {
    throw validationError('variant is not sold in this store', {
      variant_id: 'unknown or unpublished variant',
    });
  }
  return v;
}

/** Sum of `available` over active warehouses (same rule as the catalog read model). */
async function availableQuantity(tx: Queryable, variantId: string): Promise<number> {
  const r = await tx.query<{ available: number }>(
    `SELECT coalesce(sum(il.available), 0)::int AS available
     FROM inventory_level il JOIN warehouse w ON w.id = il.warehouse_id AND w.is_active
     WHERE il.variant_id = $1`,
    [variantId],
  );
  return r.rows[0]?.available ?? 0;
}

/** 409 `out_of_stock` when a tracked, non-backorderable variant cannot cover `quantity` (task 2.4 adds reservations). */
export async function assertStock(
  tx: Queryable,
  variant: Pick<VariantForCart, 'id' | 'manage_inventory' | 'allow_backorder'>,
  quantity: number,
): Promise<void> {
  if (!variant.manage_inventory || variant.allow_backorder) return;
  const available = await availableQuantity(tx, variant.id);
  if (quantity > available) {
    throw new AppError('out_of_stock', `Only ${available} left`, {
      variant_id: variant.id,
      available,
    });
  }
}

/**
 * `POST /store/carts/{cartId}/line-items`: adds `quantity` of a variant (or increases the existing line). The unit
 * price is the default-list price in the cart currency at first add (snapshot); a variant without one → 400.
 */
export async function addLineItem(
  client: ScopedClient,
  cartId: string,
  input: { variant_id: string; quantity: number },
): Promise<StoreCart> {
  return client.transaction(async (tx) => {
    const cart = await lockActiveCart(tx, cartId);
    const variant = await loadVariant(tx, cart.store_id, input.variant_id);
    const existing = await tx.query<{ quantity: number }>(
      `SELECT quantity FROM cart_line_item WHERE cart_id = $1 AND variant_id = $2`,
      [cartId, variant.id],
    );
    const newQuantity = (existing.rows[0]?.quantity ?? 0) + input.quantity;
    await assertStock(tx, variant, newQuantity);
    if (existing.rows[0]) {
      await tx.query(
        `UPDATE cart_line_item SET quantity = $3, updated_at = now() WHERE cart_id = $1 AND variant_id = $2`,
        [cartId, variant.id, newQuantity],
      );
    } else {
      const price = await tx.query<{ amount_minor: string }>(
        `SELECT pr.amount_minor::text FROM price pr
         JOIN price_list pl ON pl.id = pr.price_list_id AND pl.type = 'default' AND pl.status = 'active' AND pl.currency = $2
         WHERE pr.variant_id = $1 AND pr.currency = $2 AND pr.min_quantity = 1
         ORDER BY pr.amount_minor LIMIT 1`,
        [variant.id, cart.currency],
      );
      const unit = price.rows[0]?.amount_minor;
      if (unit === undefined) {
        throw validationError(`variant has no price in ${cart.currency}`, {
          variant_id: `not sold in ${cart.currency}`,
        });
      }
      const media = await tx.query<{ url: string }>(
        `SELECT url FROM product_media WHERE variant_id = $1 ORDER BY position, id LIMIT 1`,
        [variant.id],
      );
      await tx.query(
        `INSERT INTO cart_line_item (organization_id, store_id, cart_id, variant_id, sku, title, variant_title,
           thumbnail_url, quantity, unit_price_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          cart.organization_id,
          cart.store_id,
          cartId,
          variant.id,
          variant.sku,
          variant.product_title,
          variant.title,
          media.rows[0]?.url ?? variant.product_thumbnail,
          input.quantity,
          unit,
        ],
      );
    }
    await recalculate(tx, cart);
    return render(tx, cartId);
  });
}

async function loadLineVariant(
  tx: Queryable,
  cartId: string,
  lineItemId: string,
): Promise<Pick<VariantForCart, 'id' | 'manage_inventory' | 'allow_backorder'>> {
  const r = await tx.query<Pick<VariantForCart, 'id' | 'manage_inventory' | 'allow_backorder'>>(
    `SELECT v.id, v.manage_inventory, v.allow_backorder FROM cart_line_item li
     JOIN product_variant v ON v.id = li.variant_id WHERE li.id = $1 AND li.cart_id = $2`,
    [lineItemId, cartId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('line item', lineItemId);
  return row;
}

/** `PATCH /store/carts/{cartId}/line-items/{lineItemId}`: sets the quantity (stock-checked). */
export async function updateLineItem(
  client: ScopedClient,
  cartId: string,
  lineItemId: string,
  input: { quantity: number },
): Promise<StoreCart> {
  return client.transaction(async (tx) => {
    const cart = await lockActiveCart(tx, cartId);
    const variant = await loadLineVariant(tx, cartId, lineItemId);
    await assertStock(tx, variant, input.quantity);
    await tx.query(
      `UPDATE cart_line_item SET quantity = $3, updated_at = now() WHERE id = $1 AND cart_id = $2`,
      [lineItemId, cartId, input.quantity],
    );
    await recalculate(tx, cart);
    return render(tx, cartId);
  });
}

/** `DELETE /store/carts/{cartId}/line-items/{lineItemId}`: removes the line (404 when not in this cart). */
export async function removeLineItem(
  client: ScopedClient,
  cartId: string,
  lineItemId: string,
): Promise<StoreCart> {
  return client.transaction(async (tx) => {
    const cart = await lockActiveCart(tx, cartId);
    const r = await tx.query<{ id: string }>(
      `DELETE FROM cart_line_item WHERE id = $1 AND cart_id = $2 RETURNING id`,
      [lineItemId, cartId],
    );
    if (!r.rows[0]) throw notFound('line item', lineItemId);
    await recalculate(tx, cart);
    return render(tx, cartId);
  });
}

/** Re-checks every line of a cart against current availability (placement, before the order is written). */
export async function assertLinesInStock(tx: Queryable, cartId: string): Promise<void> {
  const r = await tx.query<
    Pick<VariantForCart, 'id' | 'manage_inventory' | 'allow_backorder'> & { quantity: number }
  >(
    `SELECT v.id, v.manage_inventory, v.allow_backorder, li.quantity FROM cart_line_item li
     JOIN product_variant v ON v.id = li.variant_id WHERE li.cart_id = $1 ORDER BY li.created_at`,
    [cartId],
  );
  for (const row of r.rows) await assertStock(tx, row, row.quantity);
}

export { render as renderCart };
export type { Address };
