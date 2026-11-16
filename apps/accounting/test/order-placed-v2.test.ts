// #696 gate, accounting side: `order.placed@2` (= v1 with `email_hash` nullable; null = an erased customer, #629)
// posts EXACTLY like v1. The ledger never reads email_hash or customer_id, never branches on the version, and
// validates through the generic validator, so the handler is run with the validator the regenerated
// `@platform/events` will give it (`v2AwareValidator()`: the real one plus a local @2 mock that steps aside the day
// @2 is published). Typecheck cannot catch this: every consumer casts the payload.
//   (a) v2 with a hash posts the same journal lines as v1;
//   (b) v2 with email_hash AND customer_id null posts the same lines — no crash, no park, no dead letter;
//   (c) a replayed v2 with the same event_id changes nothing (idempotent by source_event_id), after a v1 or a v2;
//   (d) a shipment and a return refund parked for an order that arrives later as v2 are released and posted (a
//       payment never parks: it posts on its own).
import type { EventEnvelopeV1Base } from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLedgerEvent } from '../src/consumer.js';
import { balanceByCurrency } from '../src/ledger.js';
import {
  LE_A,
  orderPlaced,
  paymentCaptured,
  refundIssued,
  shipmentShipped,
  STORE_A,
} from '../src/posting/fixtures.js';
import { postEvent } from '../src/posting/index.js';
import {
  orderPlacedV2IsPublished,
  toOrderPlacedV2,
  v2AwareValidator,
} from '../src/testing/order-placed-v2.js';
import { createAccountingTestDatabase, type AccountingTestDatabase } from './helpers/db.js';

let t: AccountingTestDatabase;
const validator = v2AwareValidator();
const handle = (e: EventEnvelopeV1Base) =>
  handleLedgerEvent(
    t.hq,
    { envelope: e, outboxId: e.event_id, schemaId: null, headers: {} },
    { validator },
  );
/** an order of 2 × 50.00 at 20 %, shipping 10.00 + 2.00, for legal entity A */
const placed = () =>
  orderPlaced({
    legalEntityId: LE_A,
    storeId: STORE_A,
    currency: 'EUR',
    lines: [{ quantity: 2, unit_price_minor: 5_000, tax_rate_bp: 2000 }],
    shipping_minor: 1_000,
    shipping_tax_minor: 200,
    placed_at: '2026-10-05T10:00:00.000Z',
  });
type Line = { account_code: string; debit_minor: number; credit_minor: number; currency: string };
const sorted = (lines: Line[]) =>
  [...lines].sort(
    (a, b) => a.account_code.localeCompare(b.account_code) || a.debit_minor - b.debit_minor,
  );
/** what the pure posting of the v1 event writes: the reference every v2 result is compared with */
const v1Lines = (e: EventEnvelopeV1Base) =>
  sorted(postEvent(e as Parameters<typeof postEvent>[0], null).entries.flatMap((en) => en.lines));
const ledgerLines = async (eventId: string) =>
  sorted(
    (
      await t.hq.query<{
        account_code: string;
        debit_minor: string;
        credit_minor: string;
        currency: string;
      }>(
        'SELECT account_code, debit_minor::text, credit_minor::text, currency FROM ledger_entry WHERE source_event_id = $1',
        [eventId],
      )
    ).rows.map((r) => ({
      account_code: r.account_code,
      debit_minor: Number(r.debit_minor),
      credit_minor: Number(r.credit_minor),
      currency: r.currency,
    })),
  );
const count = async (sql: string, params: unknown[] = []) =>
  Number(
    (await t.hq.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params)).rows[0]!.n,
  );

beforeAll(async () => {
  t = await createAccountingTestDatabase();
}, 180_000);

afterAll(async () => {
  await t?.drop();
});

describe('order.placed@2 (#696): the ledger posts v2 exactly like v1', () => {
  it('the mock is the issue’s diff: v2 takes a null email_hash, v1 does not; the real @2 wins once published', () => {
    const v1 = placed();
    const erased = toOrderPlacedV2(v1, { emailHash: null, customerId: null });
    expect(validator.validateEnvelope(erased).ok).toBe(true);
    expect(validator.validatePayload('order.placed', 1, erased.payload).ok).toBe(false);
    expect(
      validator.validatePayload('order.placed', 2, {
        ...erased.payload,
        email_hash: 'x@example.com',
      }).ok,
    ).toBe(false);
    // v1 and every other topic still go through the real validator unchanged
    expect(validator.validateEnvelope(v1)).toEqual({ ok: true, errors: [] });
    console.info(
      `order-placed-v2.test: @2 published in @platform/events: ${orderPlacedV2IsPublished()}`,
    );
  });

  it.skipIf(orderPlacedV2IsPublished())(
    'the DEPLOY ORDER: with the @platform/events build that does not know @2, the stock validator refuses a v2 (the SDK would skip it as unknown before the handler)',
    async () => {
      const v2 = toOrderPlacedV2(placed(), { emailHash: null, customerId: null });
      await expect(
        handleLedgerEvent(t.hq, {
          envelope: v2,
          outboxId: v2.event_id,
          schemaId: null,
          headers: {},
        }),
      ).rejects.toMatchObject({ name: 'InvalidEvent' });
      expect(await count('ledger_entry WHERE source_event_id = $1', [v2.event_id])).toBe(0);
    },
  );

  it('(a) a v2 with a hash posts the same journal lines as the same order as v1', async () => {
    const v1 = placed();
    const hash = (v1.payload as { email_hash: string }).email_hash;
    const v2 = toOrderPlacedV2(v1, { emailHash: hash });
    expect(
      sorted(
        postEvent(v2 as Parameters<typeof postEvent>[0], null).entries.flatMap((en) => en.lines),
      ),
    ).toEqual(v1Lines(v1));
    expect(await handle(v2)).toMatchObject({ action: 'posted', entries: 1, parked_defects: [] });
    expect(await ledgerLines(v2.event_id)).toEqual(v1Lines(v1));
  });

  it('(b) a v2 with email_hash AND customer_id null (an erased customer) posts the same lines: no crash, no park, no dead letter', async () => {
    const v1 = placed();
    const erased = toOrderPlacedV2(v1, { emailHash: null, customerId: null });
    const r = await handle(erased); // a throw here would be a dead letter in the consumer
    expect(r).toMatchObject({
      action: 'posted',
      entries: 1,
      applied_parked: 0,
      parked_defects: [],
    });
    expect(await ledgerLines(erased.event_id)).toEqual(v1Lines(v1));
    expect(await count('accounting_parked_event WHERE order_id = $1', [v1.payload.order_id])).toBe(
      0,
    );
    const order = await t.hq.query<{ status: string }>(
      'SELECT status FROM accounting_order WHERE order_id = $1',
      [v1.payload.order_id],
    );
    expect(order.rows).toEqual([{ status: 'placed' }]);
  });

  it('(c) a v2 carrying the same event_id as an already-posted order changes nothing — after the original v1 and after itself', async () => {
    const v1 = placed();
    expect(await handle(v1)).toMatchObject({ action: 'posted' });
    const rows = await count('ledger_entry WHERE source_event_id = $1', [v1.event_id]);
    const total = await count('ledger_entry');
    // the same fact again as v2 without the ids (what a scrub-to-@2 replay would send; today the replay SKIPS an erased
    // customer's order.placed, #700): same event_id, version 2, no ids
    const replayed = toOrderPlacedV2(v1, { emailHash: null, customerId: null });
    expect(await handle(replayed)).toMatchObject({ action: 'noop', entries: 0 });
    expect(await handle(replayed)).toMatchObject({ action: 'noop', entries: 0 });
    expect(await count('ledger_entry WHERE source_event_id = $1', [v1.event_id])).toBe(rows);
    expect(await count('ledger_entry')).toBe(total);
    // and a v2 that was the original: its replay is a no-op too
    const v2 = toOrderPlacedV2(placed(), { emailHash: null, customerId: null });
    expect(await handle(v2)).toMatchObject({ action: 'posted' });
    const after = await count('ledger_entry');
    expect(await handle(v2)).toMatchObject({ action: 'noop', entries: 0 });
    expect(await count('ledger_entry')).toBe(after);
  });

  it('(d) a shipment and a return refund parked for an order that arrives later as v2 are released and posted; the payment never parked', async () => {
    const v1 = placed();
    const lineId = v1.payload.line_items[0]!.order_line_item_id;
    const payment = paymentCaptured(v1, {
      fee_minor: 300,
      captured_at: '2026-10-05T10:05:00.000Z',
    });
    const ship = shipmentShipped(v1, [{ order_line_item_id: lineId, quantity: 1 }], {
      cost_minor: 0,
      shipped_at: '2026-10-07T08:00:00.000Z',
    });
    const refund = refundIssued(v1, payment, {
      amount_minor: 6_000,
      reason: 'return',
      issued_at: '2026-10-09T08:00:00.000Z',
    });
    const before = await t.hq.transaction((tx) => balanceByCurrency(tx, LE_A));
    expect(await handle(payment)).toMatchObject({ action: 'posted' }); // payment.captured needs no order
    expect(await handle(ship)).toMatchObject({ action: 'parked' });
    expect(await handle(refund)).toMatchObject({ action: 'parked' });
    expect(await count('accounting_parked_event WHERE order_id = $1', [v1.payload.order_id])).toBe(
      2,
    );

    const erased = toOrderPlacedV2(v1, { emailHash: null, customerId: null });
    expect(await handle(erased)).toMatchObject({
      action: 'posted',
      applied_parked: 2,
      parked_defects: [],
    });
    expect(await count('accounting_parked_event WHERE order_id = $1', [v1.payload.order_id])).toBe(
      0,
    );
    expect(await count('ledger_entry WHERE source_event_id = $1', [ship.event_id])).toBeGreaterThan(
      0,
    );
    expect(
      await count('ledger_entry WHERE source_event_id = $1', [refund.event_id]),
    ).toBeGreaterThan(0);
    expect(await t.hq.transaction((tx) => balanceByCurrency(tx, LE_A))).toEqual({
      ...before,
      EUR: 0,
    });
  });
});
