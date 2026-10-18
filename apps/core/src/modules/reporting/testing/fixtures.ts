// Shared fixtures for the reporting tests: a seeded throwaway database migrated through 0200 (fails loudly if a
// reporting view is missing) and the money fixtures both test files reconcile against — two stores, EUR + GBP in
// brand A, cancelled / voided / failed / awaiting orders, payments with and without a known fee, refunds
// (succeeded and failed) and customers. Fixture emails are example.test addresses; nothing here is PII.
import { seed, SEED_IDS, type ScopedClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { REPORTING_VIEWS } from '../index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;

type Row = Record<string, unknown>;

async function rows(client: ScopedClient, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await client.query<Row>(sql, params)).rows;
}

/** `createTestDatabase` + `seed`; throws (and drops the database) unless every 0200 view exists. */
export async function createReportingDatabase(prefix: string): Promise<TestDatabase> {
  const db = await createTestDatabase(prefix);
  try {
    await seed(db.owner);
    const found = await db.owner.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relkind = 'v' AND relname = ANY($1)`,
      [[...REPORTING_VIEWS]],
    );
    if (found.rowCount !== REPORTING_VIEWS.length) {
      throw new Error(
        `reporting tests: migration 0200 views missing — found ${found.rows.map((r) => r.relname).join(', ') || 'none'}`,
      );
    }
  } catch (err) {
    await db.drop();
    throw err;
  }
  return db;
}

/** Inserts the reporting fixtures through an organization-scoped client. */
export async function insertReportingFixtures(hq: ScopedClient): Promise<void> {
  const channel = async (store: string) =>
    (
      await rows(
        hq,
        `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
        [store],
      )
    )[0]!.id as string;
  const channels: Record<string, string> = { [A]: await channel(A), [B]: await channel(B) };
  const address = JSON.stringify({
    line1: 'Fixture street 1',
    city: 'Testville',
    postal_code: '00000',
    country: 'DE',
  });

  let n = 0;
  const order = async (
    store: string,
    currency: string,
    placedAt: string,
    total: number,
    status = 'confirmed',
    paymentStatus = 'captured',
  ): Promise<string> => {
    n += 1;
    const sub = total - 100;
    const res = await rows(
      hq,
      `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, email, currency, locale, status,
                            payment_status, shipping_address, billing_address, subtotal_minor, discount_minor,
                            shipping_minor, tax_minor, total_minor, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'en', $7, $8, $9, $9, $10, 50, 100, 50, $11, $12) RETURNING id`,
      [
        ORG,
        store,
        900_000 + n,
        channels[store],
        `rpt-${n}@example.test`,
        currency,
        status,
        paymentStatus,
        address,
        sub,
        total,
        placedAt,
      ],
    );
    return res[0]!.id as string;
  };
  const payment = async (
    store: string,
    orderId: string,
    currency: string,
    amount: number,
    capturedAt: string,
    fee: number | null,
    status = 'captured',
  ): Promise<string> => {
    n += 1;
    const res = await rows(
      hq,
      `INSERT INTO payment (organization_id, store_id, order_id, provider, amount_minor, currency, status, fee_minor,
                            captured_at, idempotency_key)
       VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        ORG,
        store,
        orderId,
        amount,
        currency,
        status,
        fee,
        status === 'captured' ? capturedAt : null,
        `rpt-pay-${n}`,
      ],
    );
    return res[0]!.id as string;
  };
  const refund = async (
    store: string,
    orderId: string,
    paymentId: string,
    currency: string,
    amount: number,
    createdAt: string,
    status = 'succeeded',
    reason = 'goodwill',
  ): Promise<void> => {
    n += 1;
    await rows(
      hq,
      `INSERT INTO refund (organization_id, store_id, order_id, payment_id, amount_minor, currency, reason, status,
                           idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [ORG, store, orderId, paymentId, amount, currency, reason, status, `rpt-ref-${n}`, createdAt],
    );
  };

  // Brand A, EUR: two orders either side of a UTC midnight, one refunded twice (succeeded + failed) days later.
  const a1 = await order(A, 'EUR', '2026-03-01T23:30:00Z', 10_000);
  const a1p = await payment(A, a1, 'EUR', 10_000, '2026-03-01T23:31:00Z', 290);
  await refund(A, a1, a1p, 'EUR', 2_500, '2026-03-05T10:00:00Z');
  await refund(A, a1, a1p, 'EUR', 1_000, '2026-03-05T11:00:00Z', 'failed');
  const a2 = await order(A, 'EUR', '2026-03-02T00:30:00Z', 4_000);
  await payment(A, a2, 'EUR', 4_000, '2026-03-02T00:31:00Z', null);
  // Brand A, GBP, the same day as a1: must stay its own row.
  const a3 = await order(A, 'GBP', '2026-03-01T12:00:00Z', 7_000);
  const a3p = await payment(A, a3, 'GBP', 7_000, '2026-03-01T12:01:00Z', 210);
  await refund(A, a3, a3p, 'GBP', 7_000, '2026-03-03T09:00:00Z', 'succeeded', 'return');
  // Excluded from sales: cancelled, voided, failed. Kept: awaiting.
  const a4 = await order(A, 'EUR', '2026-03-01T15:00:00Z', 9_900, 'cancelled', 'refunded');
  const a4p = await payment(A, a4, 'EUR', 9_900, '2026-03-01T15:01:00Z', 280);
  await refund(A, a4, a4p, 'EUR', 9_900, '2026-03-01T16:00:00Z', 'succeeded', 'cancellation');
  await order(A, 'EUR', '2026-03-01T16:00:00Z', 5_100, 'cancelled', 'voided');
  const a6 = await order(A, 'EUR', '2026-03-01T17:00:00Z', 3_300, 'pending', 'failed');
  await payment(A, a6, 'EUR', 3_300, '2026-03-01T17:01:00Z', null, 'failed');
  await order(A, 'EUR', '2026-03-01T18:00:00Z', 2_200, 'pending', 'awaiting');
  // Brand B, GBP.
  const b1 = await order(B, 'GBP', '2026-03-01T10:00:00Z', 6_000);
  const b1p = await payment(B, b1, 'GBP', 6_000, '2026-03-01T10:01:00Z', 180);
  await refund(B, b1, b1p, 'GBP', 600, '2026-03-02T10:00:00Z');

  // Customers (counts only ever leave the database).
  for (const [store, status, at] of [
    [A, 'registered', '2026-03-01T08:00:00Z'],
    [A, 'guest', '2026-03-01T09:00:00Z'],
    [A, 'erased', '2026-03-01T10:00:00Z'],
    [B, 'guest', '2026-03-01T11:00:00Z'],
  ] as const) {
    n += 1;
    await rows(
      hq,
      `INSERT INTO customer (organization_id, store_id, email, status, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [ORG, store, `rpt-c${n}@example.test`, status, at],
    );
  }
}
