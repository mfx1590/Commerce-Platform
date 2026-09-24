'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { SelectField, TextField } from '@/components/form/fields';
import { MoneyField } from '@/components/form/money-field';
import { ActionRefusal } from '@/components/states/action-refusal';
import { cancelOrderAction, createRefundAction, createReturnAction } from '@/app/actions/orders';
import type { AdminComponents } from '@/lib/api/admin-client';
import type { ActionRefusalInfo, ActionResult } from '@/lib/forms/action-result';
import { formatMoney } from '@/lib/forms/money';
import { REFUND_REASONS } from '@/lib/forms/schemas';
import type { OrderPermissions } from '@/lib/orders/permissions';
import { cancellable, hasReturnableLines, returnable } from '@/lib/orders/quantities';
import { idempotencyKeyHolder, refundableMinor } from '@/lib/orders/refunds';

type Order = AdminComponents['Order'];

type Open = 'cancel' | 'refund' | 'return' | null;

/**
 * Cancel, refund and request-return. Each opens an inline form that asks before it acts; each is
 * offered only when the relation allows it (`orderPermissions`) and only when the order's state
 * allows it (`quantities.ts`); each is re-checked by the API and a refusal renders as the panel.
 *
 * The refund carries an `Idempotency-Key` minted for the attempt and reused on a retry after a
 * network error or a 5xx, so a request that timed out after the provider acted cannot refund
 * twice; a success mints a fresh key for the next refund (`idempotencyKeyHolder`).
 */
export function OrderActions({
  storeId,
  order,
  locale,
  permissions,
  supportRefundLimitMinor,
  mintKey,
}: {
  storeId: string;
  order: Order;
  locale: string;
  permissions: OrderPermissions;
  supportRefundLimitMinor: number | null;
  /** Test seam: how idempotency keys are minted. Defaults to a random one per attempt. */
  mintKey?: () => string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState<Open>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ActionRefusalInfo | undefined>(undefined);
  const [done, setDone] = useState<string | null>(null);
  const keys = useRef(idempotencyKeyHolder(mintKey));
  const money = (amountMinor: number, currency: string) =>
    formatMoney(amountMinor, currency, locale);

  // cancel
  const [reason, setReason] = useState('');
  // refund
  const ceiling = refundableMinor(order);
  const [amountMinor, setAmountMinor] = useState<number | null>(ceiling > 0 ? ceiling : null);
  const [refundReason, setRefundReason] = useState<(typeof REFUND_REASONS)[number]>('goodwill');
  const [paymentId, setPaymentId] = useState<string>('');
  // return
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [returnReason, setReturnReason] = useState('');

  const run = <T,>(work: () => Promise<ActionResult<T>>, success: string, after?: () => void) => {
    setError(null);
    setRefusal(undefined);
    setDone(null);
    startTransition(async () => {
      const result = await work();
      if (result.status === 'success') {
        after?.();
        setOpen(null);
        setDone(success);
        router.refresh();
        return;
      }
      setRefusal(result.refusal);
      setError(result.refusal === undefined ? (result.formError ?? 'Could not do that.') : null);
    });
  };

  const capturedPayments = order.payments.filter((payment) => payment.status === 'captured');
  const canCancel = permissions.canEditOrder && cancellable(order);
  const canRefund = permissions.canRefund && ceiling > 0;
  const canReturn = permissions.canRequestReturn && hasReturnableLines(order);

  if (!canCancel && !canRefund && !canReturn) {
    return (
      <p className="text-muted text-sm">
        {permissions.canEditOrder || permissions.canRefund || permissions.canRequestReturn
          ? 'Nothing to do on this order in its current state.'
          : 'Your relation on this store does not allow order actions.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ActionRefusal refusal={refusal} message={error} />
      {done !== null && (
        <p role="status" className="text-success text-sm">
          {done}
        </p>
      )}

      {open === null && (
        <div className="flex flex-wrap gap-2">
          {canCancel && (
            <Button
              variant="danger"
              size="sm"
              disabled={isPending}
              onClick={() => setOpen('cancel')}
            >
              Cancel order
            </Button>
          )}
          {canRefund && (
            <Button size="sm" disabled={isPending} onClick={() => setOpen('refund')}>
              Refund
            </Button>
          )}
          {canReturn && (
            <Button
              variant="secondary"
              size="sm"
              disabled={isPending}
              onClick={() => setOpen('return')}
            >
              Request return
            </Button>
          )}
        </div>
      )}

      {open === 'cancel' && (
        <form
          className="space-y-3"
          aria-label="Cancel order"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => cancelOrderAction(storeId, order.id, { reason }), 'Order cancelled.');
          }}
        >
          <p className="text-sm">
            Cancel order #{order.display_id}? Stock is released and the payment voided or refunded.
          </p>
          <TextField
            label="Reason"
            required
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="danger"
              size="sm"
              disabled={isPending || reason.trim() === ''}
            >
              Yes, cancel the order
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(null)}>
              Keep it
            </Button>
          </div>
        </form>
      )}

      {open === 'refund' && (
        <form
          className="space-y-3"
          aria-label="Refund"
          onSubmit={(event) => {
            event.preventDefault();
            if (amountMinor === null) return;
            const key = keys.current.current();
            run(
              () =>
                createRefundAction(storeId, order.id, key, {
                  amount_minor: amountMinor,
                  reason: refundReason,
                  ...(paymentId === '' ? {} : { payment_id: paymentId }),
                }).then((result) => {
                  if (result.status === 'success') keys.current.succeeded();
                  else keys.current.failed();
                  return result;
                }),
              `Refund of ${money(amountMinor, order.currency)} requested.`,
            );
          }}
        >
          <p className="text-sm">
            Up to {money(ceiling, order.currency)} can still be refunded
            {supportRefundLimitMinor !== null && (
              <>
                ; <code className="text-xs">support</code> may refund up to{' '}
                {money(supportRefundLimitMinor, order.currency)} per refund
              </>
            )}
            .
          </p>
          <MoneyField
            label="Amount"
            currency={order.currency}
            valueMinor={amountMinor}
            onChangeMinor={setAmountMinor}
            required
            {...(amountMinor !== null && amountMinor > ceiling
              ? { error: `At most ${money(ceiling, order.currency)}` }
              : {})}
          />
          <SelectField
            label="Reason"
            value={refundReason}
            onChange={(event) =>
              setRefundReason(event.currentTarget.value as (typeof REFUND_REASONS)[number])
            }
            options={REFUND_REASONS.map((value) => ({ value, label: value }))}
          />
          {capturedPayments.length > 1 && (
            <SelectField
              label="Payment"
              value={paymentId}
              onChange={(event) => setPaymentId(event.currentTarget.value)}
              options={[
                { value: '', label: '— the captured payment —' },
                ...capturedPayments.map((payment) => ({
                  value: payment.id,
                  label: `${payment.provider} · ${money(payment.amount.amount_minor, payment.amount.currency)}`,
                })),
              ]}
            />
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                isPending || amountMinor === null || amountMinor < 1 || amountMinor > ceiling
              }
            >
              {amountMinor === null
                ? 'Refund'
                : `Yes, refund ${money(amountMinor, order.currency)}`}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {open === 'return' && (
        <form
          className="space-y-3"
          aria-label="Request return"
          onSubmit={(event) => {
            event.preventDefault();
            const items = Object.entries(returnQuantities)
              .filter(([, quantity]) => quantity > 0)
              .map(([order_line_item_id, quantity]) => ({ order_line_item_id, quantity }));
            run(
              () =>
                createReturnAction(storeId, order.id, {
                  items,
                  ...(returnReason.trim() === '' ? {} : { reason: returnReason.trim() }),
                }),
              'Return requested.',
              () => setReturnQuantities({}),
            );
          }}
        >
          <p className="text-sm">Which shipped units are coming back?</p>
          <ul className="space-y-2">
            {order.items
              .filter((line) => returnable(line) > 0)
              .map((line) => (
                <li key={line.id} className="flex items-center gap-3 text-sm">
                  <label htmlFor={`return-${line.id}`} className="flex-1">
                    {line.title} · {line.variant_title}{' '}
                    <span className="text-muted text-xs">(up to {returnable(line)})</span>
                  </label>
                  <input
                    id={`return-${line.id}`}
                    type="number"
                    min={0}
                    max={returnable(line)}
                    value={returnQuantities[line.id] ?? 0}
                    onChange={(event) => {
                      const typed = Number(event.currentTarget.value);
                      setReturnQuantities((current) => ({
                        ...current,
                        [line.id]: Math.min(returnable(line), Math.max(0, typed)),
                      }));
                    }}
                    className="border-line bg-surface h-8 w-16 rounded-md border px-2 font-mono text-xs"
                  />
                </li>
              ))}
          </ul>
          <TextField
            label="Reason"
            value={returnReason}
            onChange={(event) => setReturnReason(event.currentTarget.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                isPending || !Object.values(returnQuantities).some((quantity) => quantity > 0)
              }
            >
              Yes, request the return
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
