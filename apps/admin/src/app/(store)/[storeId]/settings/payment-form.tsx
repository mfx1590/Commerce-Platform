'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ActionRefusal } from '@/components/states/action-refusal';
import { Button } from '@/components/ui/button';
import { updatePaymentSettingsAction } from '@/app/actions/store-payment';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';

/**
 * Store › Settings › Payment (#825). Only `invoice_allowed` and the store's `updated_at` reach the
 * browser; the action re-reads the store and keeps every other setting.
 */
export function PaymentSettingsForm({
  storeId,
  invoiceAllowed,
  updatedAt,
}: {
  storeId: string;
  invoiceAllowed: boolean;
  updatedAt: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [checked, setChecked] = useState(invoiceAllowed);
  // What the core has now: the baseline for "changed", updated by each save (not only by a refresh).
  const [saved, setSaved] = useState(invoiceAllowed);
  const [loadedAt, setLoadedAt] = useState(updatedAt);
  const [failure, setFailure] = useState<{
    message: string | null;
    refusal?: ActionRefusalInfo | undefined;
  } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The page re-renders with the store as it is now after any save on it (General, this form), so
  // a newer `updated_at` prop is the store's real state: take it as the stale-check baseline, or the
  // next Payment save after a General save would be refused as stale until a reload (#833 review).
  // Adjusting state during render (React's documented pattern), not remounting: a remount would
  // drop this form's own "Saved" status. An unsaved tick of the checkbox is kept.
  const [seenUpdatedAt, setSeenUpdatedAt] = useState(updatedAt);
  if (seenUpdatedAt !== updatedAt) {
    setSeenUpdatedAt(updatedAt);
    setLoadedAt(updatedAt);
    setSaved(invoiceAllowed);
  }

  return (
    <form
      aria-label="Payment settings"
      noValidate
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setFailure(null);
        setDone(null);
        startTransition(async () => {
          const result = await updatePaymentSettingsAction(storeId, {
            invoice_allowed: checked,
            loaded_updated_at: loadedAt,
          });
          if (result.status === 'success') {
            setLoadedAt(result.data.updated_at);
            setSaved(result.data.invoice_allowed);
            setDone(
              result.data.invoice_allowed
                ? 'Saved: customers can pay on invoice.'
                : 'Saved: payment on invoice is off.',
            );
            router.refresh();
            return;
          }
          setFailure({ message: result.formError, refusal: result.refusal });
        });
      }}
    >
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          onChange={(event) => setChecked(event.currentTarget.checked)}
        />
        <span>
          <span className="font-medium">Pay on invoice</span>
          <span className="text-muted block text-xs">
            Customers can place an order and pay later by invoice. Without it, a store with no card
            payments cannot take an order.
          </span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || checked === saved}>
          {pending ? 'Saving…' : 'Save payment settings'}
        </Button>
        {done !== null && (
          <p role="status" className="text-success text-sm">
            {done}
          </p>
        )}
      </div>
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </form>
  );
}
