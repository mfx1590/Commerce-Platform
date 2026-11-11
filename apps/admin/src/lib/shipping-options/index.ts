/**
 * Store shipping options (#809 / #815, Admin API 0.4.28): the permission table, the form schemas, what
 * each refusal says, and the activation 409's uncovered countries. Pure — no React, no `next/*`.
 *
 * A cart can only check out to the countries of the store's ACTIVE options in the cart's currency, and
 * `activateStore` requires an active option in the store's `default_currency` for every market country
 * (409 `details.missing_shipping_countries`). Rows are never deleted — `is_active: false` deactivates —
 * and `code` / `currency` are immutable. On an active store, a create or update that would leave a
 * market country without an active option in the store currency is refused with the same 409.
 *
 * Money is integer minor units in the option's own currency, typed as text and parsed with that
 * currency's digits (`parseMoney`, #810): "1980" for JPY is 1980 (¥1,980), "19.90" for EUR is 1990.
 */

import { z } from 'zod';
import type { AdminError } from '../api/admin-client';
import type { FormErrors } from '../forms/server-errors';
import { mapServerError } from '../forms/server-errors';
import { moneyErrorMessage, parseMoney } from '../forms/money';
import type { Principal } from '../nav/navigation';
import { holds, type PermissionRule } from '../permissions/rules';

/** Each mutation's `x-permission` in `admin-api.yaml` (pinned in a unit test). */
export const SHIPPING_PERMISSIONS = {
  createShippingOption: { relation: 'store_admin', object: 'store' },
  updateShippingOption: { relation: 'store_admin', object: 'store' },
} as const satisfies Record<string, PermissionRule>;

/** `listShippingOptions` is `viewer` on the store: whoever reaches the settings page reads them. */
export const SHIPPING_READS = {
  listShippingOptions: { relation: 'viewer', object: 'store:{storeId}' },
} as const;

/** Whether the principal may change this store's options (a convenience: the server decides). */
export function mayManageShippingOptions(principal: Principal, storeId: string): boolean {
  return holds(principal, SHIPPING_PERMISSIONS.createShippingOption, storeId);
}

// ---------------------------------------------------------------------------- forms

const name = z
  .string()
  .trim()
  .min(1, 'Give the option a name, e.g. Standard (2–4 days).')
  .max(120, 'At most 120 characters.');

/** "jp, kr  JP" → ["JP", "KR"]: upper-cased, distinct, in the order typed; commas or spaces. */
export function parseCountries(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    const code = part.trim().toUpperCase();
    if (code !== '' && !out.includes(code)) out.push(code);
  }
  return out;
}

const countries = z
  .string()
  .transform(parseCountries)
  .pipe(
    z
      .array(z.string().regex(/^[A-Z]{2}$/, 'Two-letter country codes, e.g. JP, KR.'))
      .min(1, 'At least one country, e.g. JP.'),
  );

/** The amount as typed, checked against the currency's digits; `price_minor` on success. */
function withPrice<T extends { price: string; currency: string }>(
  values: T,
  ctx: z.RefinementCtx,
): (Omit<T, 'price'> & { price_minor: number }) | typeof z.NEVER {
  const parsed = parseMoney(values.price, values.currency);
  if (!parsed.ok) {
    ctx.addIssue({
      code: 'custom',
      path: ['price'],
      message: moneyErrorMessage(parsed.reason, values.currency),
    });
    return z.NEVER;
  }
  const { price: _price, ...rest } = values;
  return { ...rest, price_minor: parsed.amountMinor };
}

export const shippingOptionCreateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'A short code, e.g. standard.')
      .max(64, 'At most 64 characters.'),
    name,
    price: z.string(),
    currency: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{3}$/, "One of the store's currencies, e.g. JPY.")),
    countries,
    is_active: z.boolean().default(true),
  })
  .transform(withPrice);

/** An edit: `code` and `currency` are fixed (the currency only decides how the price is read). */
export const shippingOptionUpdateSchema = z
  .object({ name, price: z.string(), currency: z.string(), countries, is_active: z.boolean() })
  .transform(withPrice);

export type ShippingOptionCreateValues = z.input<typeof shippingOptionCreateSchema>;
export type ShippingOptionUpdateValues = z.input<typeof shippingOptionUpdateSchema>;
export type ShippingOptionCreateInput = z.output<typeof shippingOptionCreateSchema>;
export const SHIPPING_OPTION_FIELDS = [
  'code',
  'name',
  'price',
  'currency',
  'countries',
  'is_active',
] as const;

/** What an option already is, for the patch. */
export interface ShippingOptionCurrent {
  name: string;
  price: { amount_minor: number; currency: string };
  countries: string[];
  is_active: boolean;
}

export interface ShippingOptionPatch {
  name?: string;
  price_minor?: number;
  countries?: string[];
  is_active?: boolean;
}

/**
 * Only what changed — the contract's patch needs at least one property, and a field sent unchanged
 * is still a write the audit would record. Null when nothing changed.
 */
export function toShippingOptionPatch(
  current: ShippingOptionCurrent,
  next: { name: string; price_minor: number; countries: string[]; is_active: boolean },
): ShippingOptionPatch | null {
  const patch: ShippingOptionPatch = {};
  if (next.name !== current.name) patch.name = next.name;
  if (next.price_minor !== current.price.amount_minor) patch.price_minor = next.price_minor;
  if (next.countries.join(',') !== current.countries.join(',')) patch.countries = next.countries;
  if (next.is_active !== current.is_active) patch.is_active = next.is_active;
  return Object.keys(patch).length === 0 ? null : patch;
}

// ---------------------------------------------------------------------------- words

function details(error: AdminError): Record<string, unknown> {
  return (error.details as Record<string, unknown> | undefined) ?? {};
}

function countryList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((c): c is string => typeof c === 'string' && /^[A-Z]{2}$/.test(c)).sort()
    : [];
}

/**
 * Every refusal of create and update, in words: 409 `missing_shipping_countries` (an active store
 * would be left unable to ship to a market country in its currency); 409 duplicate code
 * (`details.shipping_option_id`); 404; 400 under the field it names (`price_minor` → the price input).
 */
export function describeShippingOptionError(
  failure: { status: number; error: AdminError },
  knownFields: readonly string[] = SHIPPING_OPTION_FIELDS,
): FormErrors {
  const { status, error } = failure;
  const d = details(error);
  const uncovered = countryList(d['missing_shipping_countries']);
  if (status === 409 && uncovered.length > 0) {
    const list = uncovered.join(', ');
    return {
      fieldErrors: {},
      formError: `Not saved: the store is live, and this would leave ${list} without an active shipping option in the store's currency — carts to ${list} could not check out. Add or keep another active option for ${list} first.`,
    };
  }
  if (status === 409) {
    return {
      fieldErrors: { code: 'This store already has an option with this code.' },
      formError: 'An option with this code already exists — edit that one instead.',
    };
  }
  if (status === 404) {
    return {
      fieldErrors: {},
      formError: 'That shipping option was not found — it may belong to another store.',
    };
  }
  // A 400 names fields two ways: the request validator as JSON pointers (`/price_minor`), the
  // registry's own checks by plain name (`price_minor`). Both become pointers, and the API's
  // `price_minor` is the form's `price` (typed text).
  if (status === 400 && error.details !== undefined) {
    const pointed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(d)) {
      const [head = '', ...tail] = key.replace(/^\//, '').split('/');
      const name = head === 'price_minor' ? 'price' : head;
      pointed[`/${[name, ...tail].join('/')}`] = value;
    }
    return mapServerError({ status, error: { ...error, details: pointed } }, knownFields);
  }
  return mapServerError(failure, knownFields);
}

/** The activation 409's `details.missing_shipping_countries`, read safely and sorted. */
export function readMissingShippingCountries(d: Record<string, unknown> | undefined): string[] {
  return countryList(d?.['missing_shipping_countries']);
}
