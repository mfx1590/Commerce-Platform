'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createShippingOption, listShippingOptions, updateShippingOption } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  describeShippingOptionError,
  shippingOptionCreateSchema,
  shippingOptionUpdateSchema,
  toShippingOptionPatch,
  type ShippingOptionCreateValues,
  type ShippingOptionUpdateValues,
} from '@/lib/shipping-options';

/**
 * Store shipping options (#809). Each action refuses server-side, before the API, unless the principal
 * is `store_admin` on the store (`refuseUnlessPermitted`, `SHIPPING_PERMISSIONS`); ids must be uuids;
 * the bodies are re-validated with the forms' schemas, the price parsed with the option currency's own
 * digits. Refusals come back in words (`describeShippingOptionError`).
 */

type ShippingOption = AdminComponents['ShippingOption'];

const UUID = z.string().uuid();

function invalid(message = 'Some fields are not valid.'): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

function refusalOf(status: number, error: AdminComponents['Error']) {
  return status === 401 || status === 403 ? { status, error } : undefined;
}

function fieldErrorsOf(error: z.ZodError): ActionResult<never> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key !== '' && fieldErrors[key] === undefined) fieldErrors[key] = issue.message;
  }
  return { status: 'error', fieldErrors, formError: null };
}

/** Options show on the store's settings and decide the HQ readiness panel. */
function revalidateOptions(storeId: string): void {
  revalidatePath(`/${storeId}/settings`);
  revalidatePath(`/onboarding/${storeId}`);
}

export async function createShippingOptionAction(
  storeId: string,
  values: ShippingOptionCreateValues,
): Promise<ActionResult<ShippingOption>> {
  const refused = await refuseUnlessPermitted('createShippingOption', storeId);
  if (refused !== null) return refused;
  const parsed = shippingOptionCreateSchema.safeParse(values);
  if (!parsed.success) return fieldErrorsOf(parsed.error);
  // `manual` is the contract's default carrier: a flat price, no live rate shopping.
  const result = await createShippingOption(storeId, { ...parsed.data, carrier: 'manual' });
  if (!result.ok) {
    return actionError(describeShippingOptionError(result), refusalOf(result.status, result.error));
  }
  revalidateOptions(storeId);
  return { status: 'success', data: result.data };
}

/** The store's options as the core has them now; an API failure is returned in words. */
async function currentOptions(
  storeId: string,
): Promise<{ ok: true; options: ShippingOption[] } | { ok: false; result: ActionResult<never> }> {
  const list = await listShippingOptions(storeId);
  if (list.ok) return { ok: true, options: list.data.items };
  return {
    ok: false,
    result: actionError(describeShippingOptionError(list), refusalOf(list.status, list.error)),
  };
}

/**
 * Sends only what differs from the option AS THE CORE HAS IT, re-read here: the client's copy is not
 * trusted, and the stored currency is what decides how the price's digits are read (a page held open
 * while the option changed would otherwise parse ¥ as €-cents). Deactivating is this action with
 * `is_active: false`; on a live store the core refuses one that would leave a market country without an
 * option in the store currency, and that 409 is said in words.
 */
export async function updateShippingOptionAction(
  storeId: string,
  optionId: string,
  values: Omit<ShippingOptionUpdateValues, 'currency'>,
): Promise<ActionResult<ShippingOption | null>> {
  const refused = await refuseUnlessPermitted('updateShippingOption', storeId);
  if (refused !== null) return refused;
  if (!UUID.safeParse(optionId).success) return invalid('That shipping option is not valid.');
  const read = await currentOptions(storeId);
  if (!read.ok) return read.result;
  const current = read.options.find((option) => option.id === optionId);
  if (current === undefined) {
    return invalid('That shipping option was not found — it may belong to another store.');
  }
  const parsed = shippingOptionUpdateSchema.safeParse({
    ...values,
    currency: current.price.currency,
  });
  if (!parsed.success) return fieldErrorsOf(parsed.error);
  const patch = toShippingOptionPatch(current, parsed.data);
  if (patch === null) return { status: 'success', data: null };
  const result = await updateShippingOption(storeId, optionId, patch);
  if (!result.ok) {
    return actionError(
      describeShippingOptionError(result, ['name', 'price', 'countries', 'is_active']),
      refusalOf(result.status, result.error),
    );
  }
  revalidateOptions(storeId);
  return { status: 'success', data: result.data };
}

export interface CountryOptionValues {
  country: string;
  currency: string;
  name: string;
  price: string;
}

export type CountryOptionOutcome =
  | { outcome: 'created'; option: ShippingOption }
  | { outcome: 'reactivated'; option: ShippingOption };

/**
 * The readiness panel's "Create a shipping option for XX" (#815 review). Its code is
 * `standard-<cc>`, and options are never deleted — so after a deactivation that code is taken by an
 * inactive row and a plain create would 409. Decided here, on the core's current list:
 * - no `standard-<cc>`: create it;
 * - an INACTIVE `standard-<cc>` in the same currency: REACTIVATE it with the typed name and price, and
 *   the country added to its list if it was dropped — one row per country stays one row;
 * - otherwise (it is active, or in another currency, which cannot change): create the next free code,
 *   `standard-<cc>-2`, `-3`, ….
 * Both writes are store_admin, refused server-side first.
 */
export async function createCountryShippingOptionAction(
  storeId: string,
  values: CountryOptionValues,
): Promise<ActionResult<CountryOptionOutcome>> {
  const refused =
    (await refuseUnlessPermitted('createShippingOption', storeId)) ??
    (await refuseUnlessPermitted('updateShippingOption', storeId));
  if (refused !== null) return refused;
  const country = values.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return invalid('That country is not valid.');
  const read = await currentOptions(storeId);
  if (!read.ok) return read.result;
  const base = `standard-${country.toLowerCase()}`;
  const codes = new Set(read.options.map((option) => option.code));
  const existing = read.options.find((option) => option.code === base);
  const currency = values.currency.trim().toUpperCase();

  if (existing !== undefined && !existing.is_active && existing.price.currency === currency) {
    const parsed = shippingOptionUpdateSchema.safeParse({
      name: values.name,
      price: values.price,
      currency,
      countries: [...new Set([...existing.countries, country])].join(', '),
      is_active: true,
    });
    if (!parsed.success) return fieldErrorsOf(parsed.error);
    const patch = toShippingOptionPatch(existing, parsed.data) ?? { is_active: true };
    const result = await updateShippingOption(storeId, existing.id, patch);
    if (!result.ok) {
      return actionError(
        describeShippingOptionError(result, ['name', 'price', 'countries', 'is_active']),
        refusalOf(result.status, result.error),
      );
    }
    revalidateOptions(storeId);
    return { status: 'success', data: { outcome: 'reactivated', option: result.data } };
  }

  let code = base;
  for (let n = 2; codes.has(code); n += 1) code = `${base}-${n}`;
  const parsed = shippingOptionCreateSchema.safeParse({
    code,
    name: values.name,
    price: values.price,
    currency,
    countries: country,
    is_active: true,
  });
  if (!parsed.success) return fieldErrorsOf(parsed.error);
  const result = await createShippingOption(storeId, { ...parsed.data, carrier: 'manual' });
  if (!result.ok) {
    return actionError(describeShippingOptionError(result), refusalOf(result.status, result.error));
  }
  revalidateOptions(storeId);
  return { status: 'success', data: { outcome: 'created', option: result.data } };
}
