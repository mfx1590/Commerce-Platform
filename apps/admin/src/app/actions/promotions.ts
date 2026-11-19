'use server';

import { revalidatePath } from 'next/cache';
import { createPromotion, updatePromotion } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { toActionResult, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
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

/** Refused without `store_admin` on the store; re-validates with the form's schema (type-dependent rules included), then `createPromotion`. */
export async function createPromotionAction(
  storeId: string,
  values: PromotionFormValues,
): Promise<ActionResult<Promotion>> {
  const refused = await refuseUnlessPermitted('createPromotion', storeId);
  if (refused) return refused;
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
  const refused = await refuseUnlessPermitted('updatePromotion', storeId);
  if (refused) return refused;
  const parsed = promotionFormSchema.safeParse(values);
  if (!parsed.success)
    return invalid(parsed.error.issues[0]?.message ?? 'Some fields are not valid.');
  const result = await updatePromotion(storeId, promotionId, toPromotionPatch(parsed.data));
  if (result.ok) revalidate(storeId, promotionId);
  return toActionResult(result, KNOWN);
}
