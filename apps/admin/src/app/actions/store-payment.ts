'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getStore, updateStore } from '@/lib/api/admin';
import type { AdminComponents } from '@/lib/api/admin-client';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { refuseUnlessPermitted } from '@/lib/permissions/guard';
import {
  describeSettingsError,
  paymentSettingsFrom,
  withInvoiceAllowed,
  type PaymentSettingsView,
} from '@/lib/settings';

/**
 * Store › Settings › Payment (#825): turns "Pay on invoice" on or off. Without it (and without the
 * store's Stripe key) `GET /store` answers `payment.methods: []` and no cart can be paid for: a
 * wizard-onboarded store had no way to get one from the admin.
 *
 * - Refused server-side, before the API, below `store_admin` on the store (`updateStore`).
 * - `updateStore` REPLACES `settings`, so the store is re-read here and only
 *   `payment.invoice_allowed` changes; every other key is sent back as the core has it now
 *   (`withInvoiceAllowed`). The derived `payment.methods` is never written.
 * - Concurrent edits: the page sends the `updated_at` it rendered. If the store changed since, the
 *   change is refused ("reload"), so a stale page cannot silently undo someone else's edit. The
 *   contract has no If-Match, so a write landing between this re-read and the PATCH is still
 *   possible; the window is one request, and the merge keeps every key we read.
 * - The core's 422 `details.settings` is said in words.
 */

type Store = AdminComponents['Store'];

const UUID = z.string().uuid();
const input = z.object({
  invoice_allowed: z.boolean(),
  /** `updated_at` of the store the page rendered (the concurrency check). */
  loaded_updated_at: z.string().min(1),
});

export type PaymentSettingsInput = z.input<typeof input>;

function refusalOf(status: number, error: AdminComponents['Error']) {
  return status === 401 || status === 403 ? { status, error } : undefined;
}

function failure(message: string): ActionResult<never> {
  return { status: 'error', fieldErrors: {}, formError: message };
}

export async function updatePaymentSettingsAction(
  storeId: string,
  values: PaymentSettingsInput,
): Promise<ActionResult<PaymentSettingsView & { updated_at: string }>> {
  const refused = await refuseUnlessPermitted('updateStore', storeId);
  if (refused !== null) return refused;
  if (!UUID.safeParse(storeId).success) return failure('That store is not valid.');
  const parsed = input.safeParse(values);
  if (!parsed.success) return failure('Choose whether the store accepts payment on invoice.');

  const current = await getStore(storeId);
  if (!current.ok) {
    return actionError(
      { fieldErrors: {}, formError: current.error.message },
      refusalOf(current.status, current.error),
    );
  }
  const store: Store = current.data;
  if (store.updated_at !== parsed.data.loaded_updated_at) {
    return failure(
      'The store was changed since this page was opened (by someone else, or in another tab). Reload the page and try again — nothing was saved.',
    );
  }
  if (paymentSettingsFrom(store.settings).invoice_allowed === parsed.data.invoice_allowed) {
    return {
      status: 'success',
      data: { invoice_allowed: parsed.data.invoice_allowed, updated_at: store.updated_at },
    };
  }

  const result = await updateStore(storeId, {
    settings: withInvoiceAllowed(store.settings, parsed.data.invoice_allowed),
  });
  if (!result.ok) {
    return actionError(
      { fieldErrors: {}, formError: describeSettingsError(result) },
      refusalOf(result.status, result.error),
    );
  }
  revalidatePath(`/${storeId}/settings`);
  return {
    status: 'success',
    data: { ...paymentSettingsFrom(result.data.settings), updated_at: result.data.updated_at },
  };
}
