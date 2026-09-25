import { describe, expect, it, vi } from 'vitest';
import { orderPermissions } from '@/lib/orders/permissions';
import {
  canLowerTo,
  cancellable,
  editable,
  fulfillable,
  hasFulfillableLines,
  hasReturnableLines,
  isLastLine,
  returnable,
} from '@/lib/orders/quantities';
import {
  capturedMinor,
  idempotencyKeyHolder,
  isValidIdempotencyKey,
  refundableMinor,
  refundedMinor,
  supportRefundLimitMinor,
} from '@/lib/orders/refunds';
import { orderTimeline } from '@/lib/orders/timeline';
import { IDS, line, order, payment, refund, ret, shipment } from './fixtures/orders';
import { SEED, principals, type PrincipalKey } from './fixtures/principals';

describe('quantities: what can still happen to a line', () => {
  it('counts fulfillable and returnable units from the three contract counters', () => {
    const untouched = line({ quantity: 3 });
    expect(fulfillable(untouched)).toBe(3);
    expect(returnable(untouched)).toBe(0);

    const partly = line({ quantity: 3, fulfilled_quantity: 2, returned_quantity: 1 });
    expect(fulfillable(partly)).toBe(1);
    expect(returnable(partly)).toBe(1);
  });

  it('never goes negative when the counters disagree', () => {
    const odd = line({ quantity: 1, fulfilled_quantity: 2, returned_quantity: 5 });
    expect(fulfillable(odd)).toBe(0);
    expect(returnable(odd)).toBe(0);
  });

  it('edits are before fulfilment only, strictly lower and at least one', () => {
    const fresh = line({ quantity: 3 });
    expect(editable(fresh)).toBe(true);
    expect(canLowerTo(fresh, 2)).toBe(true);
    expect(canLowerTo(fresh, 3)).toBe(false);
    expect(canLowerTo(fresh, 0)).toBe(false);
    expect(canLowerTo(fresh, 1.5)).toBe(false);
    expect(editable(line({ fulfilled_quantity: 1 }))).toBe(false);
  });

  it('the last line is never offered for cancellation', () => {
    expect(isLastLine(order())).toBe(false);
    expect(isLastLine(order({ items: [line()] }))).toBe(true);
  });

  it('an order is cancellable only while nothing shipped and it is still open', () => {
    expect(cancellable(order())).toBe(true);
    expect(cancellable(order({ status: 'cancelled' }))).toBe(false);
    expect(cancellable(order({ status: 'completed' }))).toBe(false);
    expect(cancellable(order({ items: [line({ fulfilled_quantity: 1 })] }))).toBe(false);
  });

  it('knows whether anything can be shipped or returned at all', () => {
    expect(hasFulfillableLines(order())).toBe(true);
    expect(hasReturnableLines(order())).toBe(false);
    const shipped = order({ items: [line({ quantity: 1, fulfilled_quantity: 1 })] });
    expect(hasFulfillableLines(shipped)).toBe(false);
    expect(hasReturnableLines(shipped)).toBe(true);
  });
});

describe('refunds: the ceiling and the idempotency key', () => {
  it('captured minus refunded-or-pending, failed refunds not counted, never negative', () => {
    const base = order();
    expect(capturedMinor(base)).toBe(5337);
    expect(refundableMinor(base)).toBe(5337);

    const some = order({
      refunds: [
        refund({ amount: { amount_minor: 500, currency: 'EUR' } }),
        refund({
          id: 'refund-pending-words',
          amount: { amount_minor: 200, currency: 'EUR' },
          status: 'pending',
        }),
        refund({
          id: 'refund-failed-words',
          amount: { amount_minor: 9999, currency: 'EUR' },
          status: 'failed',
        }),
      ],
    });
    expect(refundedMinor(some)).toBe(700);
    expect(refundableMinor(some)).toBe(4637);

    const over = order({
      refunds: [refund({ amount: { amount_minor: 99_999, currency: 'EUR' } })],
    });
    expect(refundableMinor(over)).toBe(0);
  });

  it('only captured payments count, not authorized or failed ones', () => {
    const mixed = order({
      payments: [
        payment(),
        payment({ id: 'payment-authorized-words', status: 'authorized' }),
        payment({ id: 'payment-failed-words', status: 'failed' }),
      ],
    });
    expect(capturedMinor(mixed)).toBe(5337);
  });

  it('reads the support ceiling from store settings when it is a whole number', () => {
    expect(supportRefundLimitMinor({ support_refund_limit_minor: 5000 })).toBe(5000);
    expect(supportRefundLimitMinor({ support_refund_limit_minor: '5000' })).toBeNull();
    expect(supportRefundLimitMinor({ support_refund_limit_minor: 12.5 })).toBeNull();
    expect(supportRefundLimitMinor({})).toBeNull();
    expect(supportRefundLimitMinor(undefined)).toBeNull();
  });

  it('a retry after a failure carries the SAME key; a success mints a new one', () => {
    const minted = ['refund-first-attempt', 'refund-second-refund', 'refund-third'];
    const mint = vi.fn(() => minted.shift() ?? 'refund-exhausted');
    const holder = idempotencyKeyHolder(mint);

    const first = holder.current();
    holder.failed();
    expect(holder.current()).toBe(first);
    holder.failed();
    expect(holder.current()).toBe(first);
    expect(mint).toHaveBeenCalledTimes(1);

    holder.succeeded();
    const second = holder.current();
    expect(second).not.toBe(first);
    expect(second).toBe('refund-second-refund');
  });

  it('the default mint produces a key the contract accepts', () => {
    const key = idempotencyKeyHolder().current();
    expect(key.startsWith('refund-')).toBe(true);
    expect(isValidIdempotencyKey(key)).toBe(true);
    expect(isValidIdempotencyKey('short')).toBe(false);
  });
});

describe('timeline: one story in time order', () => {
  it('interleaves payments, refunds, shipments and returns oldest first, undated last', () => {
    const money = (amountMinor: number, currency: string) => `${amountMinor} ${currency}`;
    const full = order({
      refunds: [refund({ created_at: '2026-09-06T09:00:00Z' })],
      shipments: [
        shipment({ status: 'shipped', shipped_at: '2026-09-05T12:00:00Z' }),
        shipment({ id: 'shipment-planned-words', status: 'pending' }),
      ],
      returns: [ret({ requested_at: '2026-09-07T08:00:00Z' })],
    });
    const entries = orderTimeline(full, money);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'order',
      'payment',
      'shipment',
      'refund',
      'return',
      'shipment',
    ]);
    expect(entries[0]?.title).toBe('Order #1000 placed');
    expect(entries[0]?.detail).toBe('5337 EUR');
    expect(entries[entries.length - 1]?.at).toBeNull();
  });

  it('adds a cancelled entry with the reason when the order was cancelled', () => {
    const cancelled = order({ status: 'cancelled', cancel_reason: 'customer changed mind' });
    const last = orderTimeline(cancelled, () => '').at(-1);
    expect(last?.title).toBe('Order cancelled');
    expect(last?.detail).toBe('customer changed mind');
  });
});

describe('permissions: which order actions each seeded role may be offered', () => {
  const table: [PrincipalKey, boolean, boolean, boolean][] = [
    // role, canEditOrder (store_admin), canRefund (support), canFulfil (operations on HQ)
    // owner implies finance/operations/analyst/support on the organization (ADR 0002).
    ['owner', true, true, true],
    ['finance', false, false, false],
    ['operations', false, false, true],
    ['support', false, true, false],
    ['analyst', false, false, false],
    ['storeAdmin', true, true, false],
    ['storeStaff', false, false, false],
    ['unassigned', false, false, false],
  ];

  it.each(table)('%s', (role, edit, refundOk, fulfil) => {
    const permissions = orderPermissions(principals[role], SEED.stores.brandA);
    expect(permissions.canEditOrder).toBe(edit);
    expect(permissions.canRefund).toBe(refundOk);
    expect(permissions.canRequestReturn).toBe(refundOk);
    expect(permissions.canFulfil).toBe(fulfil);
    expect(permissions.canReceiveReturn).toBe(fulfil);
  });

  it('a store the principal does not hold grants nothing on the store side', () => {
    const permissions = orderPermissions(principals.storeAdmin, SEED.stores.brandC);
    expect(permissions.canEditOrder).toBe(false);
    expect(permissions.canRefund).toBe(false);
  });

  it('exposes the fixture ids the screens tests rely on', () => {
    expect(IDS.lineTee).not.toBe(IDS.lineCap);
  });
});
