'use server';

import { revalidatePath } from 'next/cache';
import { createPromotion, updatePromotion } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import {
  promotionFormSchema,
  toPromotionInput,
  toPromotionPatch,
  type PromotionFormValues,
} from '@/lib/promotions/form';

type Promotion = AdminComponents['Promotion'];

/** The form field paths, for `toActionResult`'s known-field check (the contract names `value`, `code`, …). */
const KNOWN = [
  'code',
  'name',
  'type',
  'value',
  'currency',
  'rules',
  'usage_limit',
  'per_customer_limit',
  'starts_at',
  'ends_at',
  'status',
  'stackable',
  'exclusive',
];

function invalid(message: string): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

function revalidate(storeId: string, promotionId?: string): void {
  revalidatePath(`/${storeId}/promotions`);
  if (promotionId !== undefined) revalidatePath(`/${storeId}/promotions/${promotionId}`);
}

/** Re-validates with the form's schema (type-dependent rules included), then `createPromotion`; `store_admin` re-checked by the API. */
export async function createPromotionAction(
  storeId: string,
  values: PromotionFormValues,
): Promise<ActionResult<Promotion>> {
  const parsed = promotionFormSchema.safeParse(values);
  if (!parsed.success)
    return invalid(parsed.error.issues[0]?.message ?? 'Some fields are not valid.');
  const result = await createPromotion(storeId, toPromotionInput(parsed.data));
  if (result.ok) revalidate(storeId);
  return toActionResult(result, KNOWN);
}

/** `PromotionPatch` only — `code` and `type` never leave the form on update (immutable in the contract). */
export async function updatePromotionAction(
  storeId: string,
  promotionId: string,
  values: PromotionFormValues,
): Promise<ActionResult<Promotion>> {
  const parsed = promotionFormSchema.safeParse(values);
  if (!parsed.success)
    return invalid(parsed.error.issues[0]?.message ?? 'Some fields are not valid.');
  const result = await updatePromotion(storeId, promotionId, toPromotionPatch(parsed.data));
  if (result.ok) revalidate(storeId, promotionId);
  return toActionResult(result, KNOWN);
}
