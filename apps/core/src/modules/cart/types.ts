import type { Queryable } from '@platform/db';
import type { StoreComponents } from '@platform/contracts';

// ---- Store API shapes (the service returns exactly what the contract routes send) ----
export type StoreCart = StoreComponents['schemas']['Cart'];
export type StoreLineItem = StoreComponents['schemas']['LineItem'];
export type StoreShippingOption = StoreComponents['schemas']['ShippingOption'];
export type StorePaymentSession = StoreComponents['schemas']['PaymentSession'];
export type Address = StoreComponents['schemas']['Address'];
export type Money = StoreComponents['schemas']['Money'];
export type CartStatus = StoreCart['status'];

/** The store a Store API request acts for (a subset of `StoreContext` so the module does not depend on src/http). */
export interface CartStoreContext {
  organizationId: string;
  storeId: string;
  /** Sales channel of the publishable key; falls back to the store's active `web` channel. */
  salesChannelId: string | null;
}

export interface CreateCartInput {
  country?: string | undefined;
  currency?: string | undefined;
  locale?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateCartInput {
  email?: string | undefined;
  shipping_address?: Address | undefined;
  billing_address?: Address | undefined;
  shipping_option_id?: string | undefined;
  promotion_codes?: string[] | undefined;
  country?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

// ---- Pricing provider interfaces (public API; windows 7 and 8 replace the defaults) ----

/** One cart line as the providers see it: ids + the money that is already known. Integer minor units. */
export interface PricingLine {
  lineItemId: string;
  variantId: string;
  productId: string;
  categoryId: string | null;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
}

export interface PricingContext {
  /** Transaction of the mutation being priced; providers that read our tables use it (RLS scope = the store). */
  tx: Queryable;
  organizationId: string;
  storeId: string;
  salesChannelId: string;
  currency: string;
  /** Shipping destination (`cart.country`), the tax and shipping key. */
  country: string;
  shippingAddress: Address | null;
  lines: PricingLine[];
  /**
   * `store.settings.tax.prices_include_tax` (#221; absent = false): when true every price in `lines` and the
   * shipping price already CONTAIN the tax, and a calculator returns the contained amount, not one to add on top.
   */
  pricesIncludeTax?: boolean | undefined;
}

export type TaxMode = 'exclusive' | 'inclusive';

/**
 * The last calculation of one line, kept in `cart_line_item.metadata.tax` and frozen onto
 * `order_line_item.metadata.tax` at placement (#221). One namespaced object so a later column migration is
 * mechanical. Line metadata is internal: no Store API response renders it.
 */
export interface LineTaxRecord {
  amount_minor: number;
  mode: TaxMode;
  bp: number;
}

export interface TaxLine {
  lineItemId: string;
  /** Effective rate in basis points, persisted on the line (`cart_line_item.tax_rate_bp`). */
  taxRateBp: number;
  /**
   * Tax on `quantity * unit − discount`, integer minor units: the amount to add on top (exclusive prices) or the
   * amount contained in it (`pricesIncludeTax`). The cart shows and the order freezes THIS amount — it is never
   * recomputed from `taxRateBp` (#221: a provider's per-line rounding is the truth).
   */
  taxMinor: number;
}

export interface TaxCalculation {
  lines: TaxLine[];
  /** Tax on the shipping price (0 for the table calculator). */
  shippingTaxMinor: number;
}

/**
 * Computes tax for a cart. Default: `tableTaxCalculator` (our `tax_rate` table, prices tax-exclusive). Window 7
 * (#127) replaces it with Stripe Tax through `setTaxCalculator` without touching this module.
 */
export interface TaxCalculator {
  calculate(ctx: PricingContext & { shippingMinor: number }): Promise<TaxCalculation>;
}

export interface ShippingRate {
  optionId: string;
  code: string;
  name: string;
  carrier: string;
  priceMinor: number;
  currency: string;
}

/**
 * Lists and prices shipping options for a cart. Default: `tableShippingRates` (our `shipping_option` table,
 * flat `price_minor`). Window 8 (#130) replaces it with live carrier rates through `setShippingRateProvider`.
 * `quote` returns `null` when the option is not available for this cart (unknown, inactive, wrong currency or
 * country) — the cart then drops the selection.
 */
export interface ShippingRateProvider {
  list(ctx: PricingContext): Promise<ShippingRate[]>;
  quote(ctx: PricingContext, optionId: string): Promise<ShippingRate | null>;
}

// ---- rows ----
export interface CartRow {
  id: string;
  organization_id: string;
  store_id: string;
  sales_channel_id: string;
  customer_id: string | null;
  email: string | null;
  currency: string;
  locale: string;
  country: string;
  shipping_address: Address | null;
  billing_address: Address | null;
  shipping_option_id: string | null;
  promotion_codes: string[];
  payment_session: StorePaymentSession | null;
  subtotal_minor: string;
  discount_minor: string;
  shipping_minor: string;
  tax_minor: string;
  total_minor: string;
  status: CartStatus;
  order_id: string | null;
  completed_at: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CartLineRow {
  id: string;
  cart_id: string;
  variant_id: string;
  product_id: string;
  category_id: string | null;
  sku: string;
  title: string;
  variant_title: string;
  thumbnail_url: string | null;
  quantity: number;
  unit_price_minor: string;
  discount_minor: string;
  tax_rate_bp: number;
  metadata: Record<string, unknown>;
}

export interface ShippingOptionRow {
  id: string;
  code: string;
  name: string;
  carrier: string;
  price_minor: string;
  currency: string;
}

// ---- unit prices (#179 part 3) ----

export interface PriceQuery {
  /** The mutation's transaction (RLS scope = the store). */
  tx: Queryable;
  storeId: string;
  currency: string;
  salesChannelId: string | null;
  /** The cart's customer, when signed in: a resolver derives customer groups from it. Null for guests. */
  customerId: string | null;
  /** One clock for the whole mutation: a quote and the placement that follows judge every price window alike. */
  at: Date;
  lines: { variantId: string; quantity: number }[];
}

/**
 * The effective unit price per variant, integer minor units. A variant ABSENT from the result has no applicable
 * price in the currency: not sellable. Default: `defaultListPriceResolver` (the store's default list, tiered by
 * quantity). The server registers window 9's `resolvePrices` (sale > override/group > default) at boot through
 * `setPriceResolver` — this module never imports the promotions module.
 */
export interface PriceResolver {
  resolve(query: PriceQuery): Promise<Map<string, number>>;
}

/** One line whose unit price differs from what the cart holds (`unitPriceMinor: null` = no longer sellable). */
export interface PriceChange {
  lineItemId: string;
  variantId: string;
  previousUnitPriceMinor: number;
  unitPriceMinor: number | null;
}
