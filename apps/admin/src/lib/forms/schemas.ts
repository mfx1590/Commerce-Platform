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

type MatchesContract<Schema, Contract> = [Exclude<keyof Schema, keyof Contract>] extends [never]
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

export const productCreateSchema = z.object({
  handle: kebabCase('handle'),
  title: z.string().min(1, 'Enter a title'),
  subtitle: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category_id: z.string().uuid().nullable().optional(),
  brand_name: z.string().nullable().optional(),
  tags: z.array(z.string().min(1)).optional(),
  options: z.array(productOptionSchema).optional(),
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

/** The field paths a form renders, for `toActionResult`'s known-field check. */
export function fieldNames(schema: z.ZodObject<z.ZodRawShape>): string[] {
  return Object.keys(schema.shape);
}
