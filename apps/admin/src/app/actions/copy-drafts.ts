'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { draftProductCopy, updateProduct } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import {
  toActionResult,
  type ActionRefusalInfo,
  type ActionResult,
} from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  COPY_FIELDS,
  describeDraftError,
  type CopyPatch,
  type DraftRefusal,
  type ProductCopyDraft,
} from '@/lib/copy-drafts';

/**
 * AI copy drafts (#608). The action refuses server-side, before the API, below `store_staff` on the
 * store (`refuseUnlessPermitted`, `COPY_DRAFT_PERMISSIONS`); ids must be uuids and the body is
 * re-validated. Nothing here writes the product — saving the edited draft is `updateProduct`.
 */

export type DraftResult =
  | { status: 'success'; draft: ProductCopyDraft }
  | { status: 'refused'; refusal: ActionRefusalInfo }
  | { status: 'error'; error: DraftRefusal };

const bodySchema = z.object({
  locale: z.string().min(2).max(35),
  fields: z.array(z.enum(COPY_FIELDS)).min(1),
});

export async function draftProductCopyAction(
  storeId: string,
  productId: string,
  values: { locale: string; fields: readonly string[] },
): Promise<DraftResult> {
  const refused = await refuseUnlessPermitted('draftProductCopy', storeId);
  if (refused !== null) {
    return refused.status === 'error' && refused.refusal !== undefined
      ? { status: 'refused', refusal: refused.refusal }
      : {
          status: 'error',
          error: {
            code: 'invalid',
            title: 'The request was not accepted',
            message: refused.status === 'error' ? (refused.formError ?? 'Not allowed.') : '',
            retry: false,
          },
        };
  }
  const parsed = bodySchema.safeParse({ ...values, fields: [...new Set(values.fields)] });
  if (!z.string().uuid().safeParse(productId).success || !parsed.success) {
    return {
      status: 'error',
      error: {
        code: 'invalid',
        title: 'Pick a locale and at least one field',
        message: 'Choose one of the store’s locales and at least one field to draft.',
        retry: false,
      },
    };
  }
  const result = await draftProductCopy(storeId, productId, parsed.data);
  if (result.ok) return { status: 'success', draft: result.data };
  if (result.status === 401 || result.status === 403) {
    return { status: 'refused', refusal: { status: result.status, error: result.error } };
  }
  return { status: 'error', error: describeDraftError(result) };
}

const patchSchema = z
  .object({
    title: z.string().trim().min(1, 'A title cannot be empty.').max(200).optional(),
    description: z.string().max(6000, 'At most 6000 characters.').optional(),
    seo: z
      .object({
        title: z.string().max(70, 'An SEO title is at most 70 characters.'),
        description: z.string().max(160, 'An SEO description is at most 160 characters.'),
      })
      .catchall(z.unknown())
      .optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Choose at least one field to save.');

/**
 * Saves the human-edited draft with the normal `updateProduct` — a PARTIAL body with only the
 * accepted fields (the product form carries no `seo`, so its full-form action cannot). store_staff
 * on the store, as `updateProduct` itself.
 */
export async function saveProductCopyAction(
  storeId: string,
  productId: string,
  patch: CopyPatch,
): Promise<ActionResult<AdminComponents['Product']>> {
  const refused = await refuseUnlessPermitted('updateProduct', storeId);
  if (refused !== null) return refused;
  if (!z.string().uuid().safeParse(productId).success) {
    return { status: 'error', fieldErrors: {}, formError: 'That product is not valid.' };
  }
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { status: 'error', fieldErrors: {}, formError: issue?.message ?? 'Not valid.' };
  }
  // Only the keys that are there: `exactOptionalPropertyTypes` forbids an explicit undefined.
  const { title, description, seo } = parsed.data;
  const body = {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(seo === undefined ? {} : { seo }),
  };
  const result = await updateProduct(storeId, productId, body);
  if (result.ok) {
    revalidatePath(`/${storeId}/catalog`);
    revalidatePath(`/${storeId}/catalog/${productId}`);
  }
  return toActionResult(result, ['title', 'description', 'seo']);
}
