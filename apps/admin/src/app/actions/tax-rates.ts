'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createTaxRate, deleteTaxRate, updateTaxRate } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  describeTaxRateError,
  taxRateCreateSchema,
  taxRateUpdateSchema,
  type TaxRateCreateValues,
  type TaxRateUpdateValues,
} from '@/lib/tax-rates';

/**
 * Store tax rates (#520). Each action refuses server-side, before the API, unless the principal is
 * `store_admin` on the store (`refuseUnlessPermitted`, `TAX_PERMISSIONS`); ids must be uuids; the
 * bodies are re-validated with the forms' schemas. Refusals come back in words
 * (`describeTaxRateError`).
 */

type TaxRate = AdminComponents['TaxRate'];

const UUID = z.string().uuid();

function invalid(message = 'Some fields are not valid.'): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

function refusalOf(status: number, error: AdminComponents['Error']) {
  return status === 401 || status === 403 ? { status, error } : undefined;
}

/** Rates show on the store's settings and on the HQ readiness panel. */
function revalidateRates(storeId: string): void {
  revalidatePath(`/${storeId}/settings`);
  revalidatePath(`/onboarding/${storeId}`);
}

export async function createTaxRateAction(
  storeId: string,
  values: TaxRateCreateValues,
): Promise<ActionResult<TaxRate>> {
  const refused = await refuseUnlessPermitted('createTaxRate', storeId);
  if (refused !== null) return refused;
  const parsed = taxRateCreateSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key !== '' && fieldErrors[key] === undefined) fieldErrors[key] = issue.message;
    }
    return { status: 'error', fieldErrors, formError: null };
  }
  const result = await createTaxRate(storeId, parsed.data);
  if (!result.ok) {
    return actionError(describeTaxRateError(result), refusalOf(result.status, result.error));
  }
  revalidateRates(storeId);
  return { status: 'success', data: result.data };
}

export async function updateTaxRateAction(
  storeId: string,
  taxRateId: string,
  values: TaxRateUpdateValues,
): Promise<ActionResult<TaxRate>> {
  const refused = await refuseUnlessPermitted('updateTaxRate', storeId);
  if (refused !== null) return refused;
  if (!UUID.safeParse(taxRateId).success) return invalid('That tax rate is not valid.');
  const parsed = taxRateUpdateSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? '');
      if (key !== '' && fieldErrors[key] === undefined) fieldErrors[key] = issue.message;
    }
    return { status: 'error', fieldErrors, formError: null };
  }
  const result = await updateTaxRate(storeId, taxRateId, parsed.data);
  if (!result.ok) {
    return actionError(
      describeTaxRateError(result, ['name', 'rate_bp']),
      refusalOf(result.status, result.error),
    );
  }
  revalidateRates(storeId);
  return { status: 'success', data: result.data };
}

export async function deleteTaxRateAction(
  storeId: string,
  taxRateId: string,
): Promise<ActionResult<null>> {
  const refused = await refuseUnlessPermitted('deleteTaxRate', storeId);
  if (refused !== null) return refused;
  if (!UUID.safeParse(taxRateId).success) return invalid('That tax rate is not valid.');
  const result = await deleteTaxRate(storeId, taxRateId);
  if (!result.ok) {
    return actionError(describeTaxRateError(result), refusalOf(result.status, result.error));
  }
  revalidateRates(storeId);
  return { status: 'success', data: null };
}
