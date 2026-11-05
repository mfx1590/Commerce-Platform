// The richer payment month (#633), pure: deterministic by seed, opt-in (the default month carries none of it), and
// business-consistent: an order whose payment failed and was never captured has nothing downstream, every order's
// captures sum to its total (split captures included), and each month-end payout pays Σ net of its rows.
import type { EventEnvelopeV1Base } from '@platform/events';
import { describe, expect, it } from 'vitest';
import { generateMonth, LE_A, LE_B, LE_C } from '../src/index.js';

type P = Record<string, unknown>;
const pl = (e: EventEnvelopeV1Base) => e.payload as unknown as P;
const GATE = {
  orders: 150,
  seed: 6020,
  deterministicIds: true,
  legalEntities: 3,
  ordersPerDay: 5,
  richPayments: true,
} as const;

describe('generateMonth richPayments (#633)', () => {
  it('is deterministic by seed: the same options give the same bytes', () => {
    expect(JSON.stringify(generateMonth(GATE))).toBe(JSON.stringify(generateMonth(GATE)));
    expect(JSON.stringify(generateMonth({ ...GATE, seed: 6021 }))).not.toBe(
      JSON.stringify(generateMonth(GATE)),
    );
  });

  it('is opt-in: the default month has no failure, no split capture and no payout', () => {
    const m = generateMonth({ orders: 150, legalEntities: 3, deterministicIds: true, seed: 6020 });
    expect(m.events.some((e) => e.topic === 'payment.failed')).toBe(false);
    expect(m).toMatchObject({ failures: 0, retried: 0, splitCaptures: 0, payouts: [] });
    expect(m.events.filter((e) => e.topic === 'payment.captured')).toHaveLength(m.captures);
  });

  it('has failed payments, retried ones, never-captured ones and split captures, and counts them', () => {
    const m = generateMonth(GATE);
    const of = (t: string) => m.events.filter((e) => e.topic === t);
    expect(of('order.placed')).toHaveLength(150);
    expect(of('payment.failed')).toHaveLength(m.failures);
    expect(of('payment.captured')).toHaveLength(m.captures);
    expect(m.failures).toBeGreaterThan(m.retried);
    expect(m.retried).toBeGreaterThan(0);
    expect(m.splitCaptures).toBeGreaterThan(0);
    // every payment is its own payment_id (the core and the ledger key payments by it)
    const ids = [...of('payment.failed'), ...of('payment.captured')].map((e) => pl(e).payment_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a failed, never-captured order has nothing downstream; captures sum to the order total', () => {
    const m = generateMonth(GATE);
    const captured = new Map<string, number[]>();
    for (const e of m.events.filter((x) => x.topic === 'payment.captured')) {
      const o = String(pl(e).order_id);
      captured.set(o, [...(captured.get(o) ?? []), Number(pl(e).amount_minor)]);
    }
    const failedOnly = new Set(
      m.events
        .filter((e) => e.topic === 'payment.failed')
        .map((e) => String(pl(e).order_id))
        .filter((o) => !captured.has(o)),
    );
    expect(failedOnly.size).toBe(m.failures - m.retried);
    const downstream = m.events.filter(
      (e) =>
        failedOnly.has(String(pl(e).order_id)) &&
        e.topic !== 'order.placed' &&
        e.topic !== 'payment.failed',
    );
    expect(downstream).toEqual([]);
    for (const e of m.events.filter((x) => x.topic === 'order.placed')) {
      const parts = captured.get(String(pl(e).order_id));
      if (!parts) continue;
      expect(parts.reduce((a, b) => a + b, 0)).toBe(Number((pl(e).totals as P).total_minor));
    }
    expect([...captured.values()].filter((parts) => parts.length === 2)).toHaveLength(
      m.splitCaptures,
    );
  });

  it('a month-end payout per legal entity, in the payout-fixture shape, paying Σ net of its rows', () => {
    const m = generateMonth(GATE);
    expect(m.payouts.map((f) => [f.legal_entity_id, f.currency])).toEqual([
      [LE_A, 'EUR'],
      [LE_B, 'GBP'],
      [LE_C, 'USD'],
    ]);
    for (const f of m.payouts) {
      expect(f.payouts).toHaveLength(1);
      const p = f.payouts[0]!;
      expect(p.arrival_date).toBe('2026-10-31');
      expect(p.balance_transactions.length).toBeGreaterThan(0);
      expect(p.amount_minor).toBe(p.balance_transactions.reduce((a, r) => a + r.net_minor, 0));
      for (const r of p.balance_transactions) {
        expect(r.available_on < p.arrival_date).toBe(true);
        expect(r.net_minor).toBe(r.gross_minor - r.fee_minor);
        expect(r.currency).toBe(f.currency);
      }
    }
    // every capture available before the arrival is paid out, split captures included
    const paid = new Set(
      m.payouts.flatMap((f) => f.payouts[0]!.balance_transactions.map((r) => r.payment_intent_id)),
    );
    for (const e of m.events.filter((x) => x.topic === 'payment.captured'))
      expect(paid.has(String(pl(e).provider_payment_id))).toBe(true);
    expect(generateMonth({ ...GATE, legalEntities: 2 }).payouts).toHaveLength(2);
  });
});
