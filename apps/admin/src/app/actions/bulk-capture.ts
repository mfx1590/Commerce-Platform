'use server';

import { revalidatePath } from 'next/cache';
import { capturePayment, getOrder } from '@/lib/api/admin';
import { actionError, type ActionResult } from '@/lib/forms/action-result';
import { mapServerError } from '@/lib/forms/server-errors';
import {
  BULK_CAPTURE_CAP,
  capturedMessage,
  planCapture,
  totalsByCurrency,
} from '@/lib/orders/bulk-capture';
import { formatMoney } from '@/lib/forms/money';
import { refusalFor, refuseUnlessPermitted } from '@/lib/permissions/guard';
import { loadPrincipal } from '@/lib/principal';
import { outcomeOf, runBulk, type BulkReport, type BulkRowResult } from '@/lib/table/bulk';

/**
 * Bulk capture on the orders table (#870 wave 1 item 2, its own PR; Fable review). MONEY:
 *
 * - `capturePayment` is store_admin on the store. Refused up front for the whole action; then the
 *   principal is loaded once and every row is checked against it (`refusalFor`) before its call.
 * - Ticked ids only, at most 100 (`BULK_CAPTURE_CAP`); there is no "all matching" path.
 * - Preview first (`previewBulkCaptureAction`, reads only): per order, what would be captured,
 *   and the per-currency totals. The capture (`bulkCaptureAction`) receives the amounts the
 *   person confirmed and, per row, re-reads the order and re-plans it: a row whose amount or
 *   currency changed since the preview is NOT captured and says so.
 * - Amount = the order's current total capped at its authorisation (`planCapture`). Equal to the
 *   authorisation: no body (the whole authorisation); lower: `amount_minor` (partial).
 * - The core's capture is idempotent: the payment row is locked `FOR UPDATE`, a captured row is a
 *   replay answered 409 "payment is already captured" with no Stripe call, and the Stripe
 *   idempotency key is `capture_<payment_id>`. Still, an UNKNOWN outcome (status 0 / 5xx) is
 *   never retried here: it is reported, and the person reloads and checks.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

function checkIds(ids: readonly string[]): string[] | string {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 'Nothing is selected.';
  if (!unique.every((id) => UUID.test(id))) {
    return 'The selection is not valid. Reload the page and select again.';
  }
  if (unique.length > BULK_CAPTURE_CAP) {
    return `${unique.length} orders are selected; one bulk capture takes at most ${BULK_CAPTURE_CAP}.`;
  }
  return unique;
}

export interface CapturePreviewRow {
  id: string;
  label: string;
  capturable: boolean;
  /** Set when capturable. */
  amountMinor?: number;
  currency?: string;
  partial?: boolean;
  /** What will happen, or why not. */
  message: string;
}

export interface CapturePreview {
  rows: CapturePreviewRow[];
  /** Minor units per currency of the capturable rows. */
  totals: Record<string, number>;
  capturable: number;
}

/** Reads only. What capturing the ticked orders would do now, and the totals per currency. */
export async function previewBulkCaptureAction(
  storeId: string,
  ids: string[],
  locale = 'en-GB',
): Promise<ActionResult<CapturePreview>> {
  const refused = await refuseUnlessPermitted('capturePayment', storeId);
  if (refused !== null) return refused;
  const checked = checkIds(ids);
  if (typeof checked === 'string') return actionError({ fieldErrors: {}, formError: checked });
  const lang = LOCALE.test(locale) ? locale : 'en-GB';

  const rows: CapturePreviewRow[] = new Array(checked.length);
  await runBulk(
    checked.map((id) => ({ id })),
    async ({ id }) => {
      const index = checked.indexOf(id);
      const read = await getOrder(storeId, id);
      if (!read.ok) {
        rows[index] = {
          id,
          label: id,
          capturable: false,
          message: `Not read: ${read.error.message}`,
        };
      } else {
        const plan = planCapture(read.data, lang);
        const label = `#${read.data.display_id}`;
        rows[index] = plan.capturable
          ? {
              id,
              label,
              capturable: true,
              amountMinor: plan.amountMinor,
              currency: plan.currency,
              partial: plan.partial,
              message: plan.partial
                ? `${formatMoney(plan.amountMinor, plan.currency, lang)} of ${formatMoney(plan.authorizedMinor, plan.currency, lang)} authorised (the order total is lower now).`
                : formatMoney(plan.amountMinor, plan.currency, lang),
            }
          : { id, label, capturable: false, message: plan.reason };
      }
      return { id, label: id, outcome: 'done', message: '' };
    },
  );
  const capturable = rows.filter((row) => row.capturable);
  return {
    status: 'success',
    data: {
      rows,
      totals: totalsByCurrency(
        capturable.map((row) => ({ amountMinor: row.amountMinor!, currency: row.currency! })),
      ),
      capturable: capturable.length,
    },
  };
}

/** One row as the person confirmed it in the preview. */
export interface ConfirmedCapture {
  id: string;
  amountMinor: number;
  currency: string;
}

/** Captures the confirmed rows: per row, re-read, re-plan, compare with what was confirmed, call. */
export async function bulkCaptureAction(
  storeId: string,
  confirmed: ConfirmedCapture[],
  locale = 'en-GB',
): Promise<ActionResult<BulkReport>> {
  const refused = await refuseUnlessPermitted('capturePayment', storeId);
  if (refused !== null) return refused;
  const checked = checkIds(confirmed.map((row) => row.id));
  if (typeof checked === 'string') return actionError({ fieldErrors: {}, formError: checked });
  const expected = new Map(confirmed.map((row) => [row.id, row]));
  for (const row of expected.values()) {
    if (
      !Number.isSafeInteger(row.amountMinor) ||
      row.amountMinor < 1 ||
      !/^[A-Z]{3}$/.test(row.currency)
    ) {
      return actionError({
        fieldErrors: {},
        formError: 'The confirmed amounts are not valid. Preview again.',
      });
    }
  }
  const lang = LOCALE.test(locale) ? locale : 'en-GB';
  // Once for the action: React's cache() does not memoise inside a server action's body.
  const principal = await loadPrincipal();
  if (!principal.ok) {
    return actionError(mapServerError({ status: principal.status, error: principal.error }));
  }

  const report = await runBulk(
    checked.map((id) => ({ id })),
    async ({ id }): Promise<BulkRowResult> => {
      const rowRefused = refusalFor(principal.data, 'capturePayment', storeId);
      if (rowRefused !== null) {
        return {
          id,
          label: id,
          outcome: 'refused',
          message:
            rowRefused.status === 'error' ? (rowRefused.formError ?? 'Refused.') : 'Refused.',
        };
      }
      const read = await getOrder(storeId, id);
      if (!read.ok) return { id, label: id, ...outcomeOf(read, '') };
      const label = `#${read.data.display_id}`;
      const plan = planCapture(read.data, lang);
      if (!plan.capturable) {
        return { id, label, outcome: 'skipped', message: plan.reason };
      }
      const want = expected.get(id)!;
      if (plan.amountMinor !== want.amountMinor || plan.currency !== want.currency) {
        return {
          id,
          label,
          outcome: 'skipped',
          message: `Not captured: the amount changed since the preview (${formatMoney(want.amountMinor, want.currency, lang)} → ${formatMoney(plan.amountMinor, plan.currency, lang)}). Preview again.`,
        };
      }
      const result = await capturePayment(
        storeId,
        id,
        plan.paymentId,
        plan.partial ? { amount_minor: plan.amountMinor } : {},
      );
      if (result.ok) return { id, label, outcome: 'done', message: capturedMessage(plan, lang) };
      if (result.status === 409) {
        return { id, label, outcome: 'skipped', message: `Not captured: ${result.error.message}.` };
      }
      if (result.status === 422) {
        return {
          id,
          label,
          outcome: 'skipped',
          message: `Not capturable: ${result.error.message}.`,
        };
      }
      return { id, label, ...outcomeOf(result, '') };
    },
  );
  revalidatePath(`/${storeId}/orders`);
  return { status: 'success', data: report };
}
