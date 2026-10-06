'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MoneyField } from '@/components/form/money-field';
import { ActionRefusal } from '@/components/states/action-refusal';
import { capturePaymentAction } from '@/app/actions/orders';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { formatMoney } from '@/lib/forms/money';
import { capturable } from '@/lib/orders/lifecycle';
import type { OrderForPayments } from '@/lib/orders/projection';
import { statusLabel, toneFor } from '../orders-table.config';

type Outcome =
  | { kind: 'captured' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string | null; refusal?: ActionRefusalInfo | undefined };

/**
 * The order's payments, with **Capture** on an `authorized` one (`capturePayment`, store_admin).
 *
 * Capture moves money, so the button only opens the question: the whole authorised amount by
 * default, or a part of it (never more — the field refuses it before the core would, with 409).
 * A provider that cannot capture (422 `provider_unsupported`, the manual provider) is a neutral
 * note, not an error: nothing went wrong, the provider simply has nothing to capture. Refund lists
 * captured payments only, so a capture is what makes a payment refundable.
 */
export function PaymentsPanel({
  storeId,
  order,
  locale,
  canCapture,
}: {
  storeId: string;
  order: OrderForPayments;
  locale: string;
  canCapture: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [asking, setAsking] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  const [amountMinor, setAmountMinor] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (order.payments.length === 0) return <p className="text-muted text-sm">No payments yet.</p>;

  const capture = (paymentId: string, authorisedMinor: number) => {
    if (partial && (amountMinor === null || amountMinor < 1 || amountMinor > authorisedMinor)) {
      setOutcome({ kind: 'error', message: 'Enter an amount up to the authorised amount.' });
      return;
    }
    setOutcome(null);
    startTransition(async () => {
      const result = await capturePaymentAction(
        storeId,
        order.id,
        paymentId,
        partial && amountMinor !== null ? { amount_minor: amountMinor } : {},
      );
      setAsking(null);
      if (result.status === 'success') {
        setOutcome({ kind: 'captured' });
        router.refresh();
      } else if (result.unavailable === true) {
        setOutcome({ kind: 'unavailable', message: result.formError ?? 'Not available.' });
      } else {
        setOutcome({ kind: 'error', message: result.formError, refusal: result.refusal });
      }
    });
  };

  return (
    <div className="space-y-3">
      {outcome?.kind === 'error' && (
        <ActionRefusal refusal={outcome.refusal} message={outcome.message} />
      )}
      {outcome?.kind === 'unavailable' && (
        <p
          role="status"
          data-testid="capture-unavailable"
          className="border-line text-muted rounded-md border px-3 py-2 text-sm"
        >
          {outcome.message}
        </p>
      )}
      {outcome?.kind === 'captured' && (
        <p role="status" className="text-success text-sm">
          Payment captured.
        </p>
      )}

      <ul className="divide-line divide-y text-sm" aria-label="Payments">
        {order.payments.map((payment) => {
          const authorised = formatMoney(
            payment.amount.amount_minor,
            payment.amount.currency,
            locale,
          );
          return (
            <li key={payment.id} className="space-y-2 py-2">
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={toneFor(payment.status)}>{statusLabel(payment.status)}</Badge>
                <span className="font-mono">{authorised}</span>
                <span className="text-muted">{payment.provider}</span>
                {canCapture && capturable(payment) && asking === null && (
                  <Button
                    size="sm"
                    className="ml-auto"
                    disabled={isPending}
                    onClick={() => {
                      setOutcome(null);
                      setPartial(false);
                      setAmountMinor(payment.amount.amount_minor);
                      setAsking(payment.id);
                    }}
                  >
                    Capture
                  </Button>
                )}
              </div>

              {asking === payment.id && (
                <form
                  role="alertdialog"
                  aria-label="Confirm capture"
                  className="border-warning/30 bg-warning/5 space-y-3 rounded-md border px-3 py-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    capture(payment.id, payment.amount.amount_minor);
                  }}
                >
                  <p>
                    Capture {partial ? 'part of' : 'the whole'} authorised {authorised}? The
                    customer is charged; the captured amount can then be refunded but not
                    un-captured.
                  </p>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={partial}
                      onChange={(event) => setPartial(event.currentTarget.checked)}
                    />
                    Capture only part of it
                  </label>
                  {partial && (
                    <div className="max-w-48">
                      <MoneyField
                        label="Amount to capture"
                        currency={payment.amount.currency}
                        valueMinor={amountMinor}
                        onChangeMinor={setAmountMinor}
                        hint={`At most ${authorised}.`}
                        required
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={isPending}>
                      {isPending ? 'Capturing…' : 'Yes, capture'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => setAsking(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
