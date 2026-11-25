'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getStore, updateStore } from '@/lib/api/admin';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  CONFIRM_PATHS,
  SETTINGS_CARDS,
  valueAt,
  withPaths,
  type CardId,
  type SettingField,
} from '@/lib/settings/fields';
import { describeSettingsError } from '@/lib/settings/payment';

const UUID = z.string().uuid();

/** 401 and 403 are about the principal, so they render as a refusal panel, not a red line. */
function refusalOf(failed: { status: number; error: { code: string; message: string } }) {
  return failed.status === 401 || failed.status === 403
    ? { status: failed.status, error: failed.error }
    : undefined;
}

function failure(formError: string): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError };
}

/** Per-field validation built from the catalogue, which mirrors what the core enforces. */
function schemaFor(field: SettingField): z.ZodTypeAny {
  switch (field.kind) {
    case 'boolean':
      return z.boolean();
    case 'integer':
      return z
        .number()
        .int()
        .min(field.min ?? 0);
    case 'enum':
      return z.enum([...(field.options ?? [])] as [string, ...string[]]);
    case 'enumArray':
      return z
        .array(z.enum([...(field.options ?? [])] as [string, ...string[]]))
        .max((field.options ?? []).length);
    case 'text':
      return z
        .string()
        .trim()
        .min(field.minLength ?? 1)
        .max(field.maxLength ?? 500);
  }
}

/**
 * Saves one card of `store.settings`.
 *
 * **Only that card's paths can be written.** The incoming values are filtered against the card's
 * own field list before anything else, so a crafted request cannot reach a path belonging to
 * another card — or one this app does not edit at all, `payment.methods` included.
 *
 * **It is a read-modify-write, because `updateStore` REPLACES the settings column** (`settings = $n`
 * in the core's `updateStoreInTx`; not a shallow merge, a wholesale one). The store is re-read here
 * and the card's paths are deep-set into the settings **as the core has them now**, so no other
 * module's keys are lost. Established by `store-payment.ts` (#825).
 *
 * **A stale page cannot undo someone else's edit:** the form submits the `updated_at` it rendered
 * and this refuses when the store has moved since. One request's worth of window remains between
 * the re-read and the PATCH — the contract has no `If-Match` — and the merge preserves every key
 * read in that same breath, so the exposure is one card's fields, not the whole object.
 *
 * **A consequential change must arrive confirmed.** The UI shows a diff first, but that is UI: any
 * change to a `CONFIRM_PATHS` path is refused here unless `confirmed` is true, so skipping the
 * dialog does not skip the check.
 */
export async function saveStoreSettingsAction(
  storeId: string,
  cardId: CardId,
  values: Readonly<Record<string, unknown>>,
  loadedUpdatedAt: string,
  confirmed: boolean,
): Promise<ActionResult<{ updated_at: string }>> {
  const refused = await refuseUnlessPermitted('updateStore', storeId);
  if (refused) return refused;
  if (!UUID.safeParse(storeId).success) return failure('That store is not valid.');

  const card = SETTINGS_CARDS.find((candidate) => candidate.id === cardId);
  if (card === undefined) return failure('That settings card does not exist.');

  const fieldErrors: Record<string, string> = {};
  const updates: Record<string, unknown> = {};
  for (const field of card.fields) {
    if (!(field.path in values)) continue;
    const raw = values[field.path];
    // An empty text box clears the setting: the core treats absent as "not set" and keeps its own
    // default, which is a different thing from storing an empty string (it would refuse that).
    if (field.kind === 'text' && typeof raw === 'string' && raw.trim() === '') {
      updates[field.path] = undefined;
      continue;
    }
    const parsed = schemaFor(field).safeParse(raw);
    if (!parsed.success) {
      fieldErrors[field.path] = parsed.error.issues[0]?.message ?? 'Not valid.';
      continue;
    }
    updates[field.path] = parsed.data;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { status: 'error', fieldErrors, formError: 'Some fields are not valid.' };
  }

  const current = await getStore(storeId);
  if (!current.ok) {
    return actionError({ fieldErrors: {}, formError: current.error.message }, refusalOf(current));
  }
  const store = current.data;
  if (store.updated_at !== loadedUpdatedAt) {
    return failure(
      'The store was changed since this page was opened (by someone else, or in another tab). Reload the page and try again — nothing was saved.',
    );
  }

  const changed = Object.entries(updates).filter(
    ([path, value]) =>
      JSON.stringify(valueAt(store.settings, path) ?? null) !== JSON.stringify(value ?? null),
  );
  if (changed.length === 0) return { status: 'success', data: { updated_at: store.updated_at } };

  if (!confirmed && changed.some(([path]) => CONFIRM_PATHS.includes(path))) {
    return failure('That change has to be confirmed before it can be saved. Nothing was saved.');
  }

  const result = await updateStore(storeId, {
    settings: withPaths(store.settings, Object.fromEntries(changed)),
  });
  if (!result.ok) {
    return actionError(
      { fieldErrors: {}, formError: describeSettingsError(result) },
      refusalOf(result),
    );
  }
  revalidatePath(`/${storeId}/settings`);
  return { status: 'success', data: { updated_at: result.data.updated_at } };
}
