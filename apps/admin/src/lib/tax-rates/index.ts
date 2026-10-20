/**
 * Store tax rates (#520, CONTRACT CHANGE #522, Admin API 0.4.23): the permission table, the form
 * schema, what each refusal says, and the rate in people's units. Pure — no React, no `next/*`.
 *
 * A rate is one row per (country, region, product category); country, region and category identify
 * it and are immutable (delete and create instead). `activateStore` requires at least one row for
 * each market country of the store (`default_country` plus every active shipping option's country):
 * its 409 lists them in `details.missing_tax_countries`. Deleting an active store's last row for a
 * market country is refused (409 `last_rate_of_market_country`) — it would tax that country at 0 bp.
 */

import { z } from 'zod';
import type { AdminError } from '../api/admin-client';
import type { FormErrors } from '../forms/server-errors';
import { mapServerError } from '../forms/server-errors';
import type { Principal } from '../nav/navigation';
import { holds, type PermissionRule } from '../permissions/rules';

/** Each mutation's `x-permission` in `admin-api.yaml` (pinned in a unit test). */
export const TAX_PERMISSIONS = {
  createTaxRate: { relation: 'store_admin', object: 'store' },
  updateTaxRate: { relation: 'store_admin', object: 'store' },
  deleteTaxRate: { relation: 'store_admin', object: 'store' },
} as const satisfies Record<string, PermissionRule>;

/** `listTaxRates` is `viewer` on the store: whoever reaches the settings page reads the rates. */
export const TAX_READS = {
  listTaxRates: { relation: 'viewer', object: 'store:{storeId}' },
} as const;

export type TaxOperation = keyof typeof TAX_PERMISSIONS;

/** Whether the principal may change this store's rates (a convenience: the server decides). */
export function mayManageTaxRates(principal: Principal, storeId: string): boolean {
  return holds(principal, TAX_PERMISSIONS.createTaxRate, storeId);
}

// ---------------------------------------------------------------------------- forms

const rateBp = z.coerce
  .number({ error: 'Enter the rate in basis points.' })
  .int('Whole basis points only (2100 = 21%).')
  .min(0, 'A rate cannot be negative.')
  .max(10000, 'At most 10000 basis points (100%).');

const name = z
  .string()
  .trim()
  .min(1, 'Give the rate a name, e.g. VAT 21%.')
  .max(120, 'At most 120 characters.');

export const taxRateCreateSchema = z.object({
  country: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/, 'A two-letter country code, e.g. NL.')),
  region: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? null : value.trim()))
    .pipe(z.string().max(64, 'At most 64 characters.').nullable()),
  name,
  rate_bp: rateBp,
  product_category_id: z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value))
    .pipe(z.string().uuid('Choose a category.').nullable()),
});

export const taxRateUpdateSchema = z.object({ name, rate_bp: rateBp });

export type TaxRateCreateValues = z.input<typeof taxRateCreateSchema>;
export type TaxRateUpdateValues = z.input<typeof taxRateUpdateSchema>;
export const TAX_RATE_FIELDS = [
  'country',
  'region',
  'name',
  'rate_bp',
  'product_category_id',
] as const;

// ---------------------------------------------------------------------------- words

/** 2100 → "21%", 950 → "9.5%", 0 → "0%". */
export function formatRate(rateBp: number): string {
  const percent = rateBp / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, '')}%`;
}

function details(error: AdminError): Record<string, unknown> {
  return (error.details as Record<string, unknown> | undefined) ?? {};
}

/**
 * Every refusal of the three mutations, in words: 409 duplicate (a row with the same country,
 * region and category exists, `details.tax_rate_id`); 409 `last_rate_of_market_country` on delete;
 * 404; 400 under the field it names (a category of another store is `product_category_id`).
 */
export function describeTaxRateError(
  failure: { status: number; error: AdminError },
  knownFields: readonly string[] = TAX_RATE_FIELDS,
): FormErrors {
  const { status, error } = failure;
  const d = details(error);
  if (status === 409 && d['reason'] === 'last_rate_of_market_country') {
    const country = typeof d['country'] === 'string' ? d['country'] : 'that country';
    return {
      fieldErrors: {},
      formError: `This is the last rate for ${country} on an active store: removing it would tax ${country} at 0%. Add another rate for ${country} first.`,
    };
  }
  if (status === 409) {
    return {
      fieldErrors: {},
      formError:
        'A rate for this country, region and category already exists — edit that one instead.',
    };
  }
  if (status === 404) {
    return {
      fieldErrors: {},
      formError: 'That tax rate was not found — it may have been removed.',
    };
  }
  return mapServerError(failure, knownFields);
}

/** The activation 409's `details.missing_tax_countries`, read safely and sorted. */
export function readMissingTaxCountries(d: Record<string, unknown> | undefined): string[] {
  const value = d?.['missing_tax_countries'];
  return Array.isArray(value)
    ? value.filter((c): c is string => typeof c === 'string' && /^[A-Z]{2}$/.test(c)).sort()
    : [];
}
