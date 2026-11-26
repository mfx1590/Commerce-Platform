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
/** The four paths the core reads as one parcel, or not at all. */
const PARCEL_PATHS: readonly string[] = [
  'shipping.default_parcel.length_cm',
  'shipping.default_parcel.width_cm',
  'shipping.default_parcel.height_cm',
  'shipping.default_parcel.weight_g',
];

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
    case 'textList':
      // The core checks "array of strings"; an empty entry would be stored and read as a service
      // or an account id that matches nothing, so it is refused here rather than silently kept.
      return z.array(z.string().trim().min(1)).max(50);
    case 'countryMap':
      // `{ NL: 'wh-eu' }` — the core requires an ISO-3166-1 alpha-2 key and a non-empty code.
      return z.record(
        z.string().regex(/^[A-Za-z]{2}$/, 'A two-letter country code.'),
        z.string().trim().min(1),
      );
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
 * **A consequential change must arrive confirmed, and the confirmation names what was confirmed**
 * (#968 review). `confirmed` is not a boolean: it is the list of `{ path, to }` the reader was
 * shown and agreed to. This recomputes the consequential changes from the store as it is now and
 * requires the submitted list to match **exactly** — same paths, same values. So a confirmation
 * cannot authorise a change the reader never saw: not a stale snapshot (the value moved under
 * them), not a wider one (an extra path slipped in afterwards), and not a forged `true`.
 */
export async function saveStoreSettingsAction(
  storeId: string,
  cardId: CardId,
  values: Readonly<Record<string, unknown>>,
  loadedUpdatedAt: string,
  /** The `{ path, to }` entries the reader was shown and agreed to; `[]` when none were needed. */
  confirmed: readonly { path: string; to: unknown }[],
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
    // "Not set" clears the setting, whatever its kind: the core treats an absent path as not set
    // and keeps its own default, which is a different thing from storing `''`, `0` or `[]` — it
    // would refuse the first and honour the others as values. For `support_refund_limit_minor`
    // clearing is the ONLY way to say "support has no ceiling", so a schema that rejected
    // `undefined` here would make that unsayable (and it did: `z.number()` refuses it).
    if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
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

  // Exactly the consequential changes this save would make, as the reader must have seen them.
  const needConfirming = changed.filter(([path]) => CONFIRM_PATHS.includes(path));
  if (needConfirming.length > 0) {
    const asked = JSON.stringify(
      needConfirming
        .map(([path, to]) => [path, to ?? null])
        .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    );
    const agreed = JSON.stringify(
      [...confirmed]
        .map((entry) => [entry.path, entry.to ?? null])
        .sort((a, b) => (a[0] as string).localeCompare(b[0] as string)),
    );
    if (asked !== agreed) {
      return failure(
        'This change is not the one that was confirmed — it may have moved since you were asked. Nothing was saved; reload and try again.',
      );
    }
  }

  const next = withPaths(store.settings, Object.fromEntries(changed));

  // The default parcel is all-or-nothing in the core: `parcelOf` returns null unless length, width,
  // height and weight are ALL present and positive, and the whole parcel then falls back to
  // 30x20x10 cm / 1000 g. Three of four is not a smaller parcel, it is no parcel — a silent no-op.
  // Checked on the MERGED settings, not on what was submitted: since only changed fields are sent,
  // filling the last box is a one-field save that completes a parcel, and that must be allowed.
  const parcel = PARCEL_PATHS.map((path) => valueAt(next, path)).filter(
    (value) => value !== undefined && value !== null,
  );
  if (parcel.length > 0 && parcel.length < PARCEL_PATHS.length) {
    return failure(
      'The default parcel needs all four of length, width, height and weight, or none of them: the core ignores a partial one and quotes 30×20×10 cm at 1000 g instead. Nothing was saved.',
    );
  }

  const result = await updateStore(storeId, { settings: next });
  if (!result.ok) {
    return actionError(
      { fieldErrors: {}, formError: describeSettingsError(result) },
      refusalOf(result),
    );
  }
  revalidatePath(`/${storeId}/settings`);
  return { status: 'success', data: { updated_at: result.data.updated_at } };
}
