'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createCycleCount, mapVariantToStockItem, reconcileCycleCount } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  CYCLE_COUNT_FIELDS,
  cycleCountSchema,
  describeCycleCountError,
  describeMapError,
  type CycleCountValues,
} from '@/lib/warehouse';

/**
 * HQ warehouse (#468). Each action refuses server-side, before the API, unless the principal holds
 * `operations` on `organization:hq` (`refuseUnlessPermitted`, `WAREHOUSE_PERMISSIONS`); path ids
 * must be uuids; the count's body is re-validated with the form's schema. Errors come back in the
 * words of window 11's brief (`describeCycleCountError`, `describeMapError`).
 */

type StockItem = AdminComponents['StockItem'];
type CycleCount = AdminComponents['CycleCount'];

const UUID = z.string().uuid();

function invalid(message = 'Some fields are not valid.'): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

function refusalOf(status: number, error: AdminComponents['Error']) {
  return status === 401 || status === 403 ? { status, error } : undefined;
}

/** "Pool this variant onto this item" — idempotent; 409 while the old item still holds stock. */
export async function mapVariantAction(
  stockItemId: string,
  variantId: string,
): Promise<ActionResult<StockItem>> {
  const refused = await refuseUnlessPermitted('mapVariantToStockItem', '');
  if (refused !== null) return refused;
  if (!UUID.safeParse(stockItemId).success || !UUID.safeParse(variantId).success) {
    return {
      status: 'error',
      fieldErrors: { variant_id: 'Enter a variant id (uuid).' },
      formError: null,
    };
  }
  const result = await mapVariantToStockItem(stockItemId, variantId);
  if (!result.ok) {
    return actionError(describeMapError(result), refusalOf(result.status, result.error));
  }
  revalidatePath('/warehouse');
  return { status: 'success', data: result.data };
}

/** Writes a count down; changes no stock. */
export async function recordCycleCountAction(
  values: CycleCountValues,
): Promise<ActionResult<CycleCount>> {
  const refused = await refuseUnlessPermitted('createCycleCount', '');
  if (refused !== null) return refused;
  const parsed = cycleCountSchema.safeParse(values);
  if (!parsed.success) return invalid();
  const { counted_at, note, ...rest } = parsed.data;
  const result = await createCycleCount({
    ...rest,
    ...(counted_at === undefined ? {} : { counted_at }),
    ...(note === undefined ? {} : { note }),
  });
  if (!result.ok) {
    return actionError(
      describeCycleCountError(result, CYCLE_COUNT_FIELDS),
      refusalOf(result.status, result.error),
    );
  }
  revalidatePath('/warehouse');
  return { status: 'success', data: result.data };
}

/** Reconcile (no body) → applied or flagged; with `approve`, applies the delta as it is now. */
export async function reconcileCycleCountAction(
  cycleCountId: string,
  approve: boolean,
): Promise<ActionResult<CycleCount>> {
  const refused = await refuseUnlessPermitted('reconcileCycleCount', '');
  if (refused !== null) return refused;
  if (!UUID.safeParse(cycleCountId).success) return invalid('That count is not valid.');
  const result = await reconcileCycleCount(cycleCountId, approve === true);
  if (!result.ok) {
    return actionError(describeCycleCountError(result), refusalOf(result.status, result.error));
  }
  revalidatePath('/warehouse');
  return { status: 'success', data: result.data };
}
