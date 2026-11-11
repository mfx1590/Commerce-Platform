'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createShippingOption, updateShippingOption } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  describeShippingOptionError,
  shippingOptionCreateSchema,
  shippingOptionUpdateSchema,
  toShippingOptionPatch,
  type ShippingOptionCreateValues,
  type ShippingOptionCurrent,
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

/**
 * Sends only what differs from `current` (the row as the page read it). Deactivating is this action
 * with `is_active: false`; on a live store the core refuses one that would leave a market country
 * without an option in the store currency, and that 409 is said in words.
 */
export async function updateShippingOptionAction(
  storeId: string,
  optionId: string,
  current: ShippingOptionCurrent,
  values: Omit<ShippingOptionUpdateValues, 'currency'>,
): Promise<ActionResult<ShippingOption | null>> {
  const refused = await refuseUnlessPermitted('updateShippingOption', storeId);
  if (refused !== null) return refused;
  if (!UUID.safeParse(optionId).success) return invalid('That shipping option is not valid.');
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
