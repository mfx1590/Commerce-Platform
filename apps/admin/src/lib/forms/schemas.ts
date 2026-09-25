/**
 * Zod schemas mirroring the Admin API input types (contracts-v0.1).
 *
 * Why hand-written rather than generated: `admin-api.yaml` marks almost every input property
 * optional, because `POST` and `PATCH` share one schema — `StoreInput` has no `required` list at
 * all. A generated schema would therefore accept an empty create form and let the server say no.
 * So each *form* gets the schema it actually needs: `storeCreateSchema` demands what a store cannot
 * exist without, `storeUpdateSchema` is the same fields all optional.
 *
 * The `MatchesContract` assertions below fail the build if a field name or value type ever drifts
 * from the contract, so this file cannot silently rot.
 */

import { z } from 'zod';
import type { AdminComponents } from '../api/admin-client';

/**
 * Compile-time guard. Assigning `true` fails when a schema no longer fits the contract — either
 * because it grew a field the contract does not have (a typo, or a field invented for the UI), or
 * because a value type drifted.
 *
 * The contract side is widened to "every property optional and possibly undefined" on purpose:
 * `exactOptionalPropertyTypes` is on, so `code?: string` and Zod's `code?: string | undefined` are
 * not the same type, and that difference is noise rather than drift.
 */
type Undefinable<T> = T extends readonly (infer Element)[]
  ? readonly Undefinable<Element>[]
  : T extends object
    ? { [K in keyof T]?: Undefinable<T[K]> | undefined }
    : T;

export type MatchesContract<Schema, Contract> = [Exclude<keyof Schema, keyof Contract>] extends [
  never,
]
  ? Schema extends Undefinable<Contract>
    ? true
    : { error: 'a value type drifted from the contract'; schema: Schema; contract: Contract }
  : {
      error: 'the schema has fields the contract does not';
      unknown: Exclude<keyof Schema, keyof Contract>;
    };

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const kebabCase = (label: string) =>
  z
    .string()
    .min(1, `Enter a ${label}`)
    .regex(KEBAB, `Use lower-case letters, numbers and single hyphens, e.g. brand-a`);

const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter ISO code in capitals, e.g. EUR');

const countryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Use a two-letter ISO code in capitals, e.g. NL');

export const STORE_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;

/** Creating a store: the fields a store cannot exist without (contract `StoreInput` subset). */
export const storeCreateSchema = z.object({
  legal_entity_id: z.string().uuid('Choose a legal entity'),
  code: kebabCase('code'),
  name: z.string().min(1, 'Enter a name'),
  status: z.enum(STORE_STATUSES),
  default_currency: currencyCode,
  default_locale: z.string().min(2, 'Enter a locale, e.g. en-GB'),
  default_country: countryCode,
  timezone: z.string().min(1, 'Enter a timezone, e.g. Europe/Amsterdam'),
});

export type StoreCreateValues = z.infer<typeof storeCreateSchema>;
const _storeCreateMatches: MatchesContract<StoreCreateValues, AdminComponents['StoreInput']> = true;

/** Editing a store: same rules, but only the fields actually touched are sent. */
export const storeUpdateSchema = storeCreateSchema.partial();
export type StoreUpdateValues = z.infer<typeof storeUpdateSchema>;
const _storeUpdateMatches: MatchesContract<StoreUpdateValues, AdminComponents['StoreInput']> = true;

export const PRODUCT_STATUSES = ['draft', 'published', 'archived'] as const;

/**
 * A product option and its values. The variant matrix in #28 is the cross-product of these, which
 * is why duplicate values are rejected here rather than discovered as duplicate variants later.
 */
export const productOptionSchema = z.object({
  name: z.string().min(1, 'Name the option, e.g. Size'),
  values: z
    .array(z.string().min(1, 'Values cannot be blank'))
    .min(1, 'Add at least one value')
    .refine((values) => new Set(values).size === values.length, 'Values must be unique'),
});

/** `ProductInput.media`: an ordered list of image URLs, each optionally tied to one variant. */
export const productMediaSchema = z.object({
  url: z.string().min(1, 'Enter an image URL').url('Enter a full URL, e.g. https://…/front.jpg'),
  alt: z.string().nullable().optional(),
  position: z.number().int().optional(),
  variant_id: z.string().uuid().nullable().optional(),
});

export const productCreateSchema = z.object({
  handle: kebabCase('handle'),
  title: z.string().min(1, 'Enter a title'),
  subtitle: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  brand_name: z.string().nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
  options: z.array(productOptionSchema).optional(),
  media: z.array(productMediaSchema).optional(),
});

export type ProductCreateValues = z.infer<typeof productCreateSchema>;
const _productMatches: MatchesContract<ProductCreateValues, AdminComponents['ProductInput']> = true;

export const categoryCreateSchema = z.object({
  handle: kebabCase('handle'),
  name: z.string().min(1, 'Enter a name'),
  parent_id: z.string().uuid().nullable().optional(),
  description: z.string().optional(),
  position: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

export type CategoryCreateValues = z.infer<typeof categoryCreateSchema>;
const _categoryMatches: MatchesContract<CategoryCreateValues, AdminComponents['CategoryInput']> =
  true;

/**
 * A variant price. `amount_minor` is an integer in minor units — the form's money input parses the
 * typed string into one (`src/lib/forms/money.ts`); nothing here ever sees a float.
 */
export const variantPriceSchema = z.object({
  currency: currencyCode,
  amount_minor: z.number().int('Amounts are whole minor units').min(0, 'Enter a positive amount'),
  compare_at_minor: z.number().int().min(0).nullable().optional(),
});

export const variantCreateSchema = z.object({
  sku: z.string().min(1, 'Enter a SKU'),
  title: z.string().min(1, 'Enter a title'),
  barcode: z.string().nullable().optional(),
  options: z.record(z.string(), z.string()).optional(),
  manage_inventory: z.boolean().optional(),
  allow_backorder: z.boolean().optional(),
  weight_g: z.number().int().nullable().optional(),
  position: z.number().int().optional(),
  prices: z.array(variantPriceSchema).optional(),
});

export type VariantCreateValues = z.infer<typeof variantCreateSchema>;
const _variantMatches: MatchesContract<VariantCreateValues, AdminComponents['VariantInput']> = true;

/** A hostname, not a URL: no scheme, no port, no path — those are configuration mistakes here. */
export const DOMAIN_HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** `addDomain` takes `{ hostname, is_primary }` inline — the contract has no named input schema. */
export const domainCreateSchema = z.object({
  hostname: z
    .string()
    .min(1, 'Enter a hostname')
    .regex(DOMAIN_HOSTNAME, 'Enter a hostname like shop.brand-a.com, without http:// or a path'),
  is_primary: z.boolean().optional(),
});
export type DomainCreateValues = z.infer<typeof domainCreateSchema>;

export const SALES_CHANNEL_TYPES = ['web', 'app', 'marketplace', 'pos'] as const;

/** `createSalesChannel` takes `{ code, name, type }` inline. */
export const salesChannelCreateSchema = z.object({
  code: kebabCase('code'),
  name: z.string().min(1, 'Enter a name'),
  type: z.enum(SALES_CHANNEL_TYPES),
});
export type SalesChannelCreateValues = z.infer<typeof salesChannelCreateSchema>;

export const API_KEY_TYPES = ['publishable', 'secret'] as const;

/** `createApiKey` takes `{ name, type, sales_channel_id }` inline. */
export const apiKeyCreateSchema = z.object({
  name: z.string().min(1, 'Name the key so it can be recognised later'),
  type: z.enum(API_KEY_TYPES),
  sales_channel_id: z.union([z.string().uuid(), z.literal('')]).optional(),
});
export type ApiKeyCreateValues = z.infer<typeof apiKeyCreateSchema>;

/** The field paths a form renders, for `toActionResult`'s known-field check. */
export function fieldNames(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape);
}

// ---------------------------------------------------------------------------- orders (task 2.2)
// The order operations take inline request bodies (no named input schema in the contract), so
// these are hand-written to the shapes in admin-api.yaml 0.4.5 and typed against the wrappers.

export const REFUND_REASONS = ['return', 'cancellation', 'goodwill', 'chargeback'] as const;
export const RETURN_CONDITIONS = ['resellable', 'damaged'] as const;
export const SHIPMENT_UPDATE_STATUSES = [
  'label_created',
  'shipped',
  'in_transit',
  'delivered',
  'failed',
  'cancelled',
] as const;

/** `cancelOrder`: `{ reason }`, required. */
export const orderCancelSchema = z.object({
  reason: z.string().min(1, 'Say why the order is cancelled'),
});
export type OrderCancelValues = z.infer<typeof orderCancelSchema>;

/** `updateOrderLineItem`: `{ quantity }` — must be lower than now; the form also checks that. */
export const lineItemQuantitySchema = z.object({
  quantity: z.number().int('Whole units only').min(1, 'At least one — cancel the line instead'),
});
export type LineItemQuantityValues = z.infer<typeof lineItemQuantitySchema>;

/** `createRefund` body; the `Idempotency-Key` header travels separately. */
export const refundCreateSchema = z.object({
  amount_minor: z.number().int('Amounts are whole minor units').min(1, 'Enter an amount'),
  reason: z.enum(REFUND_REASONS),
  payment_id: z.string().uuid().optional(),
  return_id: z.string().uuid().optional(),
});
export type RefundCreateValues = z.infer<typeof refundCreateSchema>;

const lineQuantity = z.object({
  order_line_item_id: z.string().uuid(),
  quantity: z.number().int().min(1),
});

/** `createReturn`: at least one line with a quantity. */
export const returnCreateSchema = z.object({
  reason: z.string().optional(),
  items: z.array(lineQuantity).min(1, 'Pick at least one line to return'),
});
export type ReturnCreateValues = z.infer<typeof returnCreateSchema>;

/** `createShipment`: warehouse + at least one line. */
export const shipmentCreateSchema = z.object({
  warehouse_id: z.string().uuid('Choose a warehouse'),
  carrier: z.string().optional(),
  service: z.string().optional(),
  items: z.array(lineQuantity).min(1, 'Pick at least one line to ship'),
});
export type ShipmentCreateValues = z.infer<typeof shipmentCreateSchema>;

/** `updateShipment`: everything optional; an empty body is not a change. */
export const shipmentUpdateSchema = z
  .object({
    status: z.enum(SHIPMENT_UPDATE_STATUSES).optional(),
    tracking_number: z.string().optional(),
    tracking_url: z.string().url('Enter a full URL').optional(),
    label_url: z.string().url('Enter a full URL').optional(),
    cost_minor: z.number().int().min(0).optional(),
  })
  .refine((values) => Object.values(values).some((value) => value !== undefined), {
    message: 'Change at least one field',
  });
export type ShipmentUpdateValues = z.infer<typeof shipmentUpdateSchema>;

/** `packShipment`: optional parcel count. */
export const shipmentPackSchema = z.object({
  parcel_count: z.number().int().min(1, 'At least one parcel').optional(),
});
export type ShipmentPackValues = z.infer<typeof shipmentPackSchema>;

/** `receiveReturn`: warehouse + per-line condition. */
export const returnReceiveSchema = z.object({
  warehouse_id: z.string().uuid('Choose a warehouse'),
  items: z
    .array(lineQuantity.extend({ condition: z.enum(RETURN_CONDITIONS) }))
    .min(1, 'Say what was received'),
});
export type ReturnReceiveValues = z.infer<typeof returnReceiveSchema>;

// ---------------------------------------------------------------------------- customers (task 2.3)

export const CUSTOMER_EDITABLE_STATUSES = ['registered', 'disabled'] as const;

/**
 * `updateCustomer`'s inline body. `guest` and `erased` are states the core sets, not ones a form
 * may choose, so the select offers only the two the contract lists as inputs. Empty strings mean
 * "not sent" — `compact` drops them upstream — so clearing a phone is not the same as sending "".
 */
export const customerUpdateSchema = z.object({
  first_name: z.string().max(120).optional(),
  last_name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
  customer_group_id: z
    .union([z.string().uuid('Enter a group id (uuid)'), z.literal('')])
    .optional(),
  status: z.enum(CUSTOMER_EDITABLE_STATUSES).optional(),
});
export type CustomerUpdateValues = z.infer<typeof customerUpdateSchema>;

// ---------------------------------------------------------------------------- pricing (task 2.4)

export const PRICE_LIST_TYPES = ['default', 'sale', 'override'] as const;
export const PRICE_LIST_STATUSES = ['active', 'draft', 'expired'] as const;

const optionalUuid = z.union([z.string().uuid('Enter a uuid'), z.literal('')]).optional();
/** `datetime-local` input value or empty; the action turns it into an ISO date-time or null. */
const optionalDateTime = z
  .union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'Enter a date and time'),
    z.literal(''),
  ])
  .optional();

/** `createPriceList` — the form's values; `toPriceListBody` maps them onto `PriceListInput`. */
export const priceListCreateSchema = z.object({
  code: kebabCase('code'),
  name: z.string().min(1, 'Enter a name'),
  type: z.enum(PRICE_LIST_TYPES),
  currency: currencyCode,
  customer_group_id: optionalUuid,
  sales_channel_id: optionalUuid,
  starts_at: optionalDateTime,
  ends_at: optionalDateTime,
  status: z.enum(PRICE_LIST_STATUSES),
  priority: z.number().int('Whole numbers only').min(0),
});
export type PriceListCreateValues = z.infer<typeof priceListCreateSchema>;

/**
 * One row of a bulk price upsert, exactly as the contract types it. The action validates every
 * row of a batch with this before anything is sent — a row the CSV preview rejected cannot reach
 * the API by editing the request in the browser.
 */
export const priceUpsertRowSchema = z.object({
  variant_id: z.string().uuid(),
  amount_minor: z.number().int('Amounts are whole minor units').min(0),
  compare_at_minor: z.number().int('Amounts are whole minor units').min(0).nullable().optional(),
  min_quantity: z.number().int().min(1).optional(),
});
export const priceUpsertBatchSchema = z.object({
  prices: z.array(priceUpsertRowSchema).min(1, 'Nothing to save'),
});
export type PriceUpsertBatch = z.infer<typeof priceUpsertBatchSchema>;
