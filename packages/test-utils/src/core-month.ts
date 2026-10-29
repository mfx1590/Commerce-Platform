// writeMonthToCoreDb (#602): a generated event month PROJECTED into the core rows the reporting views read, so the
// bookings and cash identities can be proven on the CI month (the views read Postgres orders, payments and refunds,
// which an event stream does not create).
//
// A pure projection, payload → row. Every money column is copied from the event that carries it; nothing is
// computed, rounded or re-derived, and no business rule is applied. The mapping:
//   order.placed      → "order" (ids, totals, currency, placed_at as in the payload)
//   order.cancelled   → that order's status = 'cancelled', cancelled_at
//   payment.captured  → payment (status 'captured', amount, fee, captured_at); the order's payment_status 'captured'
//   payment.failed    → payment (status 'failed'); the order's payment_status 'failed' unless it was captured
//   refund.issued     → refund (status 'succeeded', amount, reason, created_at = issued_at)
// Columns the events do not carry and no report reads get neutral fixture values: `email` is
// `projection+<order_id>@example.test` (the event carries only a hash), the addresses hold only the payload's
// country, `sales_channel_id` is the store's first channel (the payload's id is not a row in a test database), and
// `display_id` is left to the core's trigger (generated display ids may collide; no report reads it).
// Other topics are ignored.
//
// Writes through the OWNER pool into a throwaway database only: it refuses any database whose name is not a
// createTestDatabase name (`<prefix containing "test">_<8 random chars>`) or is a shared dev name (#595 pattern).
import type { EventEnvelopeV1Base } from '@platform/events';

export interface OwnerQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export class NotAThrowawayDatabaseError extends Error {
  constructor(name: string) {
    super(
      `writeMonthToCoreDb writes only into a throwaway test database (createTestDatabase); refused "${name}"`,
    );
    this.name = 'NotAThrowawayDatabaseError';
  }
}

const SHARED = new Set(['platform', 'postgres', 'template0', 'template1']);
const THROWAWAY = /^[a-z0-9_]*test[a-z0-9_]*_[a-z0-9]{8}$/;

export async function assertThrowawayCoreDatabase(db: OwnerQueryable): Promise<string> {
  const name =
    (await db.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name ?? '';
  if (SHARED.has(name) || !THROWAWAY.test(name)) throw new NotAThrowawayDatabaseError(name);
  return name;
}

export interface ProjectionCounts {
  orders: number;
  cancelled: number;
  payments: number;
  refunds: number;
  ignored: number;
}

type Payload = Record<string, unknown>;
const p = (e: EventEnvelopeV1Base) => e.payload as unknown as Payload;

/** Projects `events` (any order) into the core tables of the throwaway database `db` connects to. */
export async function writeMonthToCoreDb(
  db: OwnerQueryable,
  events: readonly EventEnvelopeV1Base[],
): Promise<ProjectionCounts> {
  await assertThrowawayCoreDatabase(db);
  const placed = events.filter((e) => e.topic === 'order.placed');
  const cancelled = new Map(
    events
      .filter((e) => e.topic === 'order.cancelled')
      .map((e) => [String(p(e).order_id), String(p(e).cancelled_at)]),
  );
  const captured = events.filter((e) => e.topic === 'payment.captured');
  const failed = events.filter((e) => e.topic === 'payment.failed');
  const refunds = events.filter((e) => e.topic === 'refund.issued');
  const capturedOrders = new Set(captured.map((e) => String(p(e).order_id)));
  const failedOrders = new Set(failed.map((e) => String(p(e).order_id)));
  const known = new Set([
    'order.placed',
    'order.cancelled',
    'payment.captured',
    'payment.failed',
    'refund.issued',
  ]);

  const channels = new Map<string, string>();
  const channelOf = async (storeId: string): Promise<string> => {
    let c = channels.get(storeId);
    if (!c) {
      const r = await db.query<{ id: string }>(
        'SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at, id LIMIT 1',
        [storeId],
      );
      if (!r.rows[0])
        throw new Error(
          `writeMonthToCoreDb: store ${storeId} has no sales channel (seed the database first)`,
        );
      c = r.rows[0].id;
      channels.set(storeId, c);
    }
    return c;
  };

  for (const e of placed) {
    const o = p(e);
    const totals = o.totals as Record<string, number>;
    const orderId = String(o.order_id);
    const paymentStatus = capturedOrders.has(orderId)
      ? 'captured'
      : failedOrders.has(orderId)
        ? 'failed'
        : 'awaiting';
    const address = JSON.stringify({ country: o.shipping_country });
    const billing = JSON.stringify({ country: o.billing_country });
    await db.query(
      `INSERT INTO "order" (id, organization_id, store_id, display_id, sales_channel_id, email, currency, locale,
                            status, payment_status, shipping_address, billing_address, promotion_codes,
                            subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor, placed_at,
                            cancelled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        orderId,
        e.organization_id,
        e.store_id,
        // 0 = the order_display_id trigger numbers it: a generated month's display ids may collide within a store
        0,
        await channelOf(String(e.store_id)),
        `projection+${orderId}@example.test`,
        o.currency,
        o.locale,
        cancelled.has(orderId) ? 'cancelled' : 'pending',
        paymentStatus,
        address,
        billing,
        o.promotion_codes ?? [],
        totals.subtotal_minor,
        totals.discount_minor,
        totals.shipping_minor,
        totals.tax_minor,
        totals.total_minor,
        o.placed_at,
        cancelled.get(orderId) ?? null,
      ],
    );
  }

  for (const [e, status] of [
    ...captured.map((x) => [x, 'captured'] as const),
    ...failed.map((x) => [x, 'failed'] as const),
  ]) {
    const x = p(e);
    await db.query(
      `INSERT INTO payment (id, organization_id, store_id, order_id, provider, provider_payment_id, amount_minor,
                            currency, status, fee_minor, captured_at, failure_reason, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        x.payment_id,
        e.organization_id,
        e.store_id,
        x.order_id,
        x.provider,
        x.provider_payment_id ?? null,
        x.amount_minor,
        x.currency,
        status,
        status === 'captured' ? (x.fee_minor ?? null) : null,
        status === 'captured' ? x.captured_at : null,
        status === 'failed' ? (x.failure_reason ?? null) : null,
        `projection:${String(x.payment_id)}`,
      ],
    );
  }

  for (const e of refunds) {
    const x = p(e);
    await db.query(
      `INSERT INTO refund (id, organization_id, store_id, order_id, payment_id, amount_minor, currency, reason, status,
                           provider_refund_id, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'succeeded', $9, $10, $11)`,
      [
        x.refund_id,
        e.organization_id,
        e.store_id,
        x.order_id,
        x.payment_id,
        x.amount_minor,
        x.currency,
        x.reason,
        x.provider_refund_id ?? null,
        `projection:${String(x.refund_id)}`,
        x.issued_at,
      ],
    );
  }

  return {
    orders: placed.length,
    cancelled: cancelled.size,
    payments: captured.length + failed.length,
    refunds: refunds.length,
    ignored: events.filter((e) => !known.has(e.topic)).length,
  };
}
