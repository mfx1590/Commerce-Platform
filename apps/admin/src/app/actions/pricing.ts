'use server';

import { revalidatePath } from 'next/cache';
import { createPriceList, upsertPrices } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { compact } from '@/lib/api/payload';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import {
  fieldNames,
  priceListCreateSchema,
  priceUpsertBatchSchema,
  type PriceListCreateValues,
} from '@/lib/forms/schemas';
import { toIsoOrNull } from '@/lib/promotions/form';

type PriceList = AdminComponents['PriceList'];

function invalid(message: string): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

export async function createPriceListAction(
  storeId: string,
  values: PriceListCreateValues,
): Promise<ActionResult<PriceList>> {
  const parsed = priceListCreateSchema.safeParse(values);
  if (!parsed.success) return invalid('Some fields are not valid.');
  const { customer_group_id, sales_channel_id, starts_at, ends_at, ...rest } = parsed.data;
  const result = await createPriceList(storeId, {
    ...compact(rest),
    customer_group_id:
      customer_group_id === undefined || customer_group_id === '' ? null : customer_group_id,
    sales_channel_id:
      sales_channel_id === undefined || sales_channel_id === '' ? null : sales_channel_id,
    starts_at: toIsoOrNull(starts_at ?? ''),
    ends_at: toIsoOrNull(ends_at ?? ''),
  });
  if (result.ok) revalidatePath(`/${storeId}/promotions/price-lists`);
  return toActionResult(result, fieldNames(priceListCreateSchema));
}

/**
 * The bulk upsert, re-validated row by row on the server. The CSV preview and the editor only
 * ever submit rows they accepted, but a request can be edited in the browser — so a batch with a
 * non-integer amount, a negative amount, a bad uuid or a zero min-quantity is refused here as a
 * whole, naming the offending row, and **nothing** is sent to the API. There is no partial send:
 * a price list updated halfway is worse than a stated refusal.
 */
export async function upsertPricesAction(
  storeId: string,
  priceListId: string,
  prices: unknown,
): Promise<ActionResult<AdminComponents['Page'] extends never ? never : { upserted: number }>> {
  const parsed = priceUpsertBatchSchema.safeParse({ prices });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const row = typeof issue?.path[1] === 'number' ? ` (row ${issue.path[1] + 1})` : '';
    return invalid(`${issue?.message ?? 'Invalid prices'}${row}. Nothing was saved.`);
  }
  const result = await upsertPrices(
    storeId,
    priceListId,
    parsed.data.prices.map((price) => compact(price)),
  );
  if (result.ok) {
    revalidatePath(`/${storeId}/promotions/price-lists/${priceListId}`);
    revalidatePath(`/${storeId}/catalog`);
  }
  return toActionResult(result, ['prices']);
}
