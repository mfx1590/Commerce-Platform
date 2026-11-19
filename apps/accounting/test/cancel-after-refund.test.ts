// #919 through the consumer path: the order projection's refund totals come from the LEDGER (what the order's refund
// entries posted to 4090 and 2200), so a refund and a cancel consumed in any order, in separate transactions, net to a
// settled order: nothing in 1200, 2200, 2300/2310 or 4090 — EUR and JPY. Own throwaway database.
import type { EventEnvelopeV1Base } from '@platform/events';
import { SEED_IDS } from '@platform/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLedgerEvent } from '../src/consumer.js';
import {
  orderCancelled,
  orderPlaced,
  paymentCaptured,
  refundIssued,
  shipmentShipped,
} from '../src/posting/fixtures.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

const FEE = 300;
let t: AccountingTestDatabase;
const handle = (e: EventEnvelopeV1Base) =>
  handleLedgerEvent(t.hq, { envelope: e, outboxId: e.event_id, schemaId: null, headers: {} });
/** the netted balance per account of exactly these events' ledger rows */
async function netOf(events: EventEnvelopeV1Base[]) {
  for (const e of events) await handle(e);
  const r = await t.hq.query<{ account_code: string; net: string }>(
    `SELECT account_code, (sum(debit_minor) - sum(credit_minor))::text AS net FROM ledger_entry
      WHERE source_event_id = ANY($1::uuid[]) GROUP BY account_code HAVING sum(debit_minor) <> sum(credit_minor)
      ORDER BY account_code`,
    [events.map((e) => e.event_id)],
  );
  return Object.fromEntries(r.rows.map((x) => [x.account_code, Number(x.net)]));
}
const SETTLED = { '1100': -FEE, '6100': FEE };

/** one order with its payment, goodwill refunds, cancel and the cancellation refund of the rest */
function scenario(opts: { jpy?: boolean; goodwill: number[] }) {
  const e = opts.jpy
    ? orderPlaced({
        legalEntityId: SEED_IDS.legalEntities.brandD,
        storeId: SEED_IDS.stores.brandD,
        currency: 'JPY',
        lines: [{ quantity: 2, unit_price_minor: 1_980, tax_rate_bp: 1000 }],
        shipping_minor: 990,
        shipping_tax_minor: 99,
        placed_at: '2026-10-05T10:00:00.000Z',
      })
    : orderPlaced({
        lines: [{ quantity: 2, unit_price_minor: 5_000, tax_rate_bp: 2000 }],
        shipping_minor: 1_000,
        shipping_tax_minor: 200,
        placed_at: '2026-10-05T10:00:00.000Z',
      });
  const total = e.payload.totals.total_minor;
  const pay = paymentCaptured(e, { fee_minor: FEE, captured_at: '2026-10-05T10:05:00.000Z' });
  const refunds = opts.goodwill.map((amount, i) =>
    refundIssued(e, pay, {
      amount_minor: amount,
      reason: 'goodwill',
      issued_at: `2026-10-0${6 + i}T12:00:00.000Z`,
    }),
  );
  const cancel = orderCancelled(e, { cancelled_at: '2026-10-09T09:00:00.000Z' });
  const rest = refundIssued(e, pay, {
    amount_minor: total - opts.goodwill.reduce((a, b) => a + b, 0),
    reason: 'cancellation',
    issued_at: '2026-10-09T09:30:00.000Z',
  });
  return { e, pay, refunds, cancel, rest };
}

beforeAll(async () => {
  t = await createAccountingTestDatabase();
}, 180_000);

afterAll(async () => {
  await t?.drop();
});

describe('#919 on the consumer path: a refund then a cancel settles the order, in any arrival order', () => {
  it('full capture then cancel (no refund before): settled, the cancel entry unchanged', async () => {
    const s = scenario({ goodwill: [] });
    expect(await netOf([s.e, s.pay, s.cancel, s.rest])).toEqual(SETTLED);
  });

  it('goodwill then cancel — refund consumed before the cancel, and after it (separate transactions)', async () => {
    const a = scenario({ goodwill: [2_640] });
    expect(await netOf([a.e, a.pay, ...a.refunds, a.cancel, a.rest])).toEqual(SETTLED);
    const b = scenario({ goodwill: [2_640] });
    expect(await netOf([b.e, b.pay, b.cancel, ...b.refunds, b.rest])).toEqual(SETTLED);
  });

  it('two goodwill refunds then cancel, the cancel between them', async () => {
    const s = scenario({ goodwill: [1_320, 1_980] });
    expect(await netOf([s.e, s.pay, s.refunds[0]!, s.cancel, s.refunds[1]!, s.rest])).toEqual(
      SETTLED,
    );
  });

  it('JPY (whole yen): goodwill then cancel, both arrival orders; the cancel entry in yen', async () => {
    const a = scenario({ jpy: true, goodwill: [1_089] });
    expect(await netOf([a.e, a.pay, ...a.refunds, a.cancel, a.rest])).toEqual(SETTLED);
    const lines = await t.hq.query<{
      account_code: string;
      debit_minor: string;
      credit_minor: string;
      currency: string;
    }>(
      `SELECT account_code, debit_minor::text, credit_minor::text, currency FROM ledger_entry WHERE source_event_id = $1
        ORDER BY account_code`,
      [a.cancel.event_id],
    );
    expect(lines.rows).toEqual([
      {
        account_code: '1200',
        debit_minor: '0',
        credit_minor: String(5_445 - 1_089),
        currency: 'JPY',
      },
      { account_code: '2200', debit_minor: String(495 - 99), credit_minor: '0', currency: 'JPY' },
      { account_code: '2300', debit_minor: '3960', credit_minor: '0', currency: 'JPY' },
      { account_code: '2310', debit_minor: '990', credit_minor: '0', currency: 'JPY' },
      { account_code: '4090', debit_minor: '0', credit_minor: String(1_089 - 99), currency: 'JPY' },
    ]);
    const b = scenario({ jpy: true, goodwill: [1_089] });
    expect(await netOf([b.e, b.pay, b.cancel, ...b.refunds, b.rest])).toEqual(SETTLED);
  });

  it('a partial shipment consumed AFTER the cancel, with a goodwill above the shipped value: the fact-order books', async () => {
    const run = async (lateShipment: boolean) => {
      const e = orderPlaced({
        lines: [{ quantity: 2, unit_price_minor: 5_000, tax_rate_bp: 2000 }],
        placed_at: '2026-10-05T10:00:00.000Z',
      });
      const pay = paymentCaptured(e, { fee_minor: FEE, captured_at: '2026-10-05T10:05:00.000Z' });
      const ship = shipmentShipped(
        e,
        [{ order_line_item_id: e.payload.line_items[0]!.order_line_item_id, quantity: 1 }],
        {
          cost_minor: 0,
          shipped_at: '2026-10-06T08:00:00.000Z',
        },
      );
      const gw = refundIssued(e, pay, {
        amount_minor: 8_400,
        reason: 'goodwill',
        issued_at: '2026-10-07T12:00:00.000Z',
      });
      const cancel = orderCancelled(e, { cancelled_at: '2026-10-09T09:00:00.000Z' });
      const rest = refundIssued(e, pay, {
        amount_minor: 3_600,
        reason: 'cancellation',
        issued_at: '2026-10-09T09:30:00.000Z',
      });
      return netOf(
        lateShipment ? [e, pay, gw, cancel, ship, rest] : [e, pay, ship, gw, cancel, rest],
      );
    };
    const expected = { '4000': -5_000, '4090': 5_000, ...SETTLED };
    expect(await run(false)).toEqual(expected);
    expect(await run(true)).toEqual(expected);
  });

  // #931 review: the cancel consumed first, then the refund (its excess on 1200), then the late shipment — each in its
  // own transaction, the refund totals re-read from accounting_refund every time
  const lateWorld = (opts: {
    jpy?: boolean;
    reason: 'return' | 'goodwill';
    amount: number;
    rest: number;
  }) => {
    const e = opts.jpy
      ? orderPlaced({
          legalEntityId: SEED_IDS.legalEntities.brandD,
          storeId: SEED_IDS.stores.brandD,
          currency: 'JPY',
          lines: [{ quantity: 2, unit_price_minor: 1_980, tax_rate_bp: 1000 }],
          shipping_minor: 990,
          shipping_tax_minor: 99,
          placed_at: '2026-10-05T10:00:00.000Z',
        })
      : orderPlaced({
          lines: [{ quantity: 2, unit_price_minor: 5_000, tax_rate_bp: 2000 }],
          placed_at: '2026-10-05T10:00:00.000Z',
        });
    const pay = paymentCaptured(e, { fee_minor: FEE, captured_at: '2026-10-05T10:05:00.000Z' });
    const ship = shipmentShipped(
      e,
      [{ order_line_item_id: e.payload.line_items[0]!.order_line_item_id, quantity: 1 }],
      {
        cost_minor: 0,
        shipped_at: '2026-10-06T08:00:00.000Z',
      },
    );
    const ref = refundIssued(e, pay, {
      amount_minor: opts.amount,
      reason: opts.reason,
      issued_at: '2026-10-07T12:00:00.000Z',
    });
    const cancel = orderCancelled(e, { cancelled_at: '2026-10-09T09:00:00.000Z' });
    const rest = refundIssued(e, pay, {
      amount_minor: opts.rest,
      reason: 'cancellation',
      issued_at: '2026-10-09T09:30:00.000Z',
    });
    return { fact: [e, pay, ship, ref, cancel, rest], late: [e, pay, cancel, ref, ship, rest] };
  };

  it('cancel → return → late shipment (EUR): the fact-order books — 1200 = 0, 2200 = 0, 4090 = 50.00', async () => {
    const expected = { '4000': -5_000, '4090': 5_000, ...SETTLED };
    expect(await netOf(lateWorld({ reason: 'return', amount: 6_000, rest: 6_000 }).fact)).toEqual(
      expected,
    );
    expect(await netOf(lateWorld({ reason: 'return', amount: 6_000, rest: 6_000 }).late)).toEqual(
      expected,
    );
  });

  it('cancel → goodwill → late shipment (EUR, above and within the shipped value)', async () => {
    expect(await netOf(lateWorld({ reason: 'goodwill', amount: 8_400, rest: 3_600 }).late)).toEqual(
      {
        '4000': -5_000,
        '4090': 5_000,
        ...SETTLED,
      },
    );
    expect(await netOf(lateWorld({ reason: 'goodwill', amount: 3_000, rest: 6_000 }).late)).toEqual(
      {
        '1100': 3_000 - FEE, // the customer keeps a 60.00 unit and paid 30.00 net
        '2200': -500,
        '4000': -5_000,
        '4090': 2_500,
        '6100': FEE,
      },
    );
  });

  it('cancel → return / goodwill → late shipment (JPY): identical to fact order to the yen, 1200 = 0', async () => {
    for (const o of [
      { reason: 'return' as const, amount: 3_267, rest: 2_178 },
      { reason: 'goodwill' as const, amount: 4_000, rest: 1_445 },
    ]) {
      const fact = await netOf(lateWorld({ jpy: true, ...o }).fact);
      const late = await netOf(lateWorld({ jpy: true, ...o }).late);
      expect(late).toEqual(fact);
      expect(late['1200']).toBeUndefined();
    }
  });
});
