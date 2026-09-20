// Abandoned-cart recovery (#148) against a seeded throwaway database.
//
// The `cart.abandoned` events here are **real**: the test builds carts, ages them, and calls window 1's own
// `markAllAbandonedCarts` through the cart module's public API, so the consumer is exercised against the emitter
// that actually runs in production rather than against a hand-written fixture payload. If window 1 changes the
// payload, this file fails — which is the point.
//
// Schema: `proposed/0170_cart_recovery.sql` (CONTRACT CHANGE #244), applied here because `packages/db` is frozen.
// When the migration lands on main, this block and the file go away in a small follow-up (#162's pattern).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markAllAbandonedCarts } from '../cart';
import {
  abandonedCartReport,
  consumeAbandonedCarts,
  getRecoveryByCart,
  hashToken,
  listRecoveries,
  mintToken,
  reconcileRecoveries,
  validateRecoveryToken,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-recovery' };

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;
let hq: ReturnType<typeof createOrganizationClient>;

/** A cart with one line item, last touched `hoursAgo` ago. Returns the cart id. */
async function makeCart(
  opts: { storeId?: string; hoursAgo?: number; totalMinor?: number; email?: string } = {},
): Promise<string> {
  const storeId = opts.storeId ?? A;
  const hoursAgo = opts.hoursAgo ?? 48;
  const total = opts.totalMinor ?? 12_000;
  const touched = new Date(Date.now() - hoursAgo * 3_600_000);

  const channel = await db.owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
    [storeId],
  );
  const variant = await db.owner.query<{ id: string; sku: string; title: string }>(
    `SELECT v.id, v.sku, v.title FROM product_variant v
       JOIN product p ON p.id = v.product_id
      WHERE v.store_id = $1 AND p.status = 'published'
      ORDER BY v.sku LIMIT 1`,
    [storeId],
  );
  const currency = storeId === A ? 'EUR' : 'GBP';

  const cart = await db.owner.query<{ id: string }>(
    `INSERT INTO cart (organization_id, store_id, sales_channel_id, email, currency, locale, country,
                       subtotal_minor, total_minor, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'en-GB', 'NL', $6, $6, 'active', $7, $7)
     RETURNING id`,
    [ORG, storeId, channel.rows[0]!.id, opts.email ?? 'ada@example.test', currency, total, touched],
  );
  const cartId = cart.rows[0]!.id;

  await db.owner.query(
    `INSERT INTO cart_line_item (organization_id, store_id, cart_id, variant_id, sku, title, variant_title,
                                 quantity, unit_price_minor, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $9)`,
    [
      ORG,
      storeId,
      cartId,
      variant.rows[0]!.id,
      variant.rows[0]!.sku,
      'Test product',
      variant.rows[0]!.title,
      total,
      touched,
    ],
  );
  // Do NOT re-stamp `cart.updated_at` with an UPDATE afterwards: the schema's app.set_updated_at trigger
  // fires BEFORE UPDATE and would bump it back to now(), so the cart would never look idle and window 1's job
  // would find nothing. The INSERT above sets it directly, which the trigger does not touch.
  return cartId;
}

/** Runs window 1's real abandoned-cart pass, which emits `cart.abandoned` into the outbox. */
async function abandonAll(): Promise<number> {
  const res = await markAllAbandonedCarts(hq, { now: new Date(), idleForMs: 6 * 3_600_000 });
  return res.abandoned;
}

/** Places an order against a cart, the way checkout does, and links it back. */
async function placeOrderFor(cartId: string, storeId = A, totalMinor = 12_000): Promise<string> {
  const cart = await db.owner.query<{ sales_channel_id: string; currency: string }>(
    `SELECT sales_channel_id, currency FROM cart WHERE id = $1`,
    [cartId],
  );
  const address = JSON.stringify({
    first_name: 'Ada',
    last_name: 'Tester',
    line1: 'One Test Street',
    city: 'Amsterdam',
    postal_code: '1011AA',
    country: 'NL',
  });
  const order = await db.owner.query<{ id: string }>(
    `INSERT INTO "order" (organization_id, store_id, sales_channel_id, cart_id, email, currency, locale, status,
                          shipping_address, billing_address, subtotal_minor, total_minor)
     VALUES ($1, $2, $3, $4, 'ada@example.test', $5, 'en-GB', 'confirmed', $6, $6, $7, $7)
     RETURNING id`,
    [
      ORG,
      storeId,
      cart.rows[0]!.sales_channel_id,
      cartId,
      cart.rows[0]!.currency,
      address,
      totalMinor,
    ],
  );
  const orderId = order.rows[0]!.id;
  await db.owner.query(
    `UPDATE cart SET status = 'completed', order_id = $2, completed_at = now() WHERE id = $1`,
    [cartId, orderId],
  );
  return orderId;
}

beforeAll(async () => {
  db = await createTestDatabase('core_recovery');
  await seed(db.owner, { productsPerStore: 3, log: () => {} });
  // PROPOSED schema (#244) — delete with the file when migration 0170 lands on main.
  await db.owner.query(readFileSync(join(__dirname, 'proposed', '0170_cart_recovery.sql'), 'utf8'));

  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A], actorId: actor.id });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B], actorId: actor.id });
  hq = createOrganizationClient(db.app, { organizationId: ORG, actorId: actor.id });
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.owner.query('DELETE FROM cart_recovery');
  await db.owner.query('DELETE FROM marketing_cursor');
  await db.owner.query('DELETE FROM outbox');
  // cart.order_id is a FK onto "order", so the link has to be cut before the orders go.
  await db.owner.query('UPDATE cart SET order_id = NULL WHERE order_id IS NOT NULL');
  await db.owner.query('DELETE FROM "order"');
  await db.owner.query('DELETE FROM cart_line_item');
  await db.owner.query('DELETE FROM cart');
});

describe('consuming cart.abandoned', () => {
  it('creates one record per abandoned cart from the real emitter', async () => {
    const first = await makeCart();
    const second = await makeCart({ totalMinor: 5_000 });
    expect(await abandonAll()).toBe(2);

    const result = await consumeAbandonedCarts(a, A);
    expect(result).toMatchObject({ processed: 2, created: 2 });
    expect(result.cursor).toBeGreaterThan(0);
    expect(result.tokens.size).toBe(2);

    const record = await getRecoveryByCart(a, A, first);
    expect(record).toMatchObject({
      store_id: A,
      cart_id: first,
      status: 'pending',
      line_item_count: 1,
      redeemed_at: null,
      expired: false,
      recovered_order_id: null,
    });
    expect(record.total).toEqual({ amount_minor: 12_000, currency: 'EUR' });
    // The payload's email_hash carries through; the address never does.
    expect(record.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain('@example.test');

    expect((await getRecoveryByCart(a, A, second)).total.amount_minor).toBe(5_000);
  });

  it('is idempotent: a second run and a replayed event create nothing new', async () => {
    const cartId = await makeCart();
    await abandonAll();

    const first = await consumeAbandonedCarts(a, A);
    expect(first.created).toBe(1);
    const token = first.tokens.get(cartId)!;

    // Nothing new to read.
    expect(await consumeAbandonedCarts(a, A)).toMatchObject({ processed: 0, created: 0 });

    // Rewind the cursor and replay the same event: UNIQUE (cart_id) makes it a no-op, not a second record
    // with a second live token.
    await db.owner.query(`UPDATE marketing_cursor SET seq = 0 WHERE name = 'cart_recovery'`);
    const replay = await consumeAbandonedCarts(a, A);
    expect(replay).toMatchObject({ processed: 1, created: 0 });
    expect(replay.tokens.size).toBe(0);

    expect((await listRecoveries(a, A)).length).toBe(1);
    // The original token still works — a replay must not invalidate a link already in someone's inbox.
    await expect(validateRecoveryToken(a, A, token)).resolves.toEqual({ cartId });
  });

  it('advances the cursor in batches and never re-reads', async () => {
    for (let i = 0; i < 3; i++) await makeCart({ totalMinor: 1_000 * (i + 1) });
    await abandonAll();

    const firstBatch = await consumeAbandonedCarts(a, A, { batchSize: 2 });
    expect(firstBatch).toMatchObject({ processed: 2, created: 2 });

    const secondBatch = await consumeAbandonedCarts(a, A, { batchSize: 2 });
    expect(secondBatch).toMatchObject({ processed: 1, created: 1 });
    expect(secondBatch.cursor).toBeGreaterThan(firstBatch.cursor);

    expect(await consumeAbandonedCarts(a, A, { batchSize: 2 })).toMatchObject({ processed: 0 });
    expect((await listRecoveries(a, A)).length).toBe(3);
  });

  it('keeps each store to its own carts and its own cursor', async () => {
    await makeCart({ storeId: A });
    await makeCart({ storeId: B });
    await abandonAll();

    expect(await consumeAbandonedCarts(a, A)).toMatchObject({ created: 1 });
    expect(await consumeAbandonedCarts(b, B)).toMatchObject({ created: 1 });

    expect((await listRecoveries(a, A)).length).toBe(1);
    expect((await listRecoveries(b, B)).length).toBe(1);

    const cursors = await db.owner.query<{ store_id: string }>(
      `SELECT store_id FROM marketing_cursor`,
    );
    expect(new Set(cursors.rows.map((r) => r.store_id)).size).toBe(2);
  });
});

describe('tokens', () => {
  it('stores only the hash, and the plaintext is handed over exactly once', async () => {
    const cartId = await makeCart();
    await abandonAll();
    const { tokens } = await consumeAbandonedCarts(a, A);
    const token = tokens.get(cartId)!;

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await db.owner.query<{ token_hash: string }>(
      `SELECT token_hash FROM cart_recovery WHERE cart_id = $1`,
      [cartId],
    );
    expect(stored.rows[0]!.token_hash).toBe(hashToken(token));
    // The plaintext is nowhere in the database.
    const anywhere = await db.owner.query(
      `SELECT 1 FROM cart_recovery WHERE token_hash = $1 OR cart_id::text = $1`,
      [token],
    );
    expect(anywhere.rowCount).toBe(0);
    // And nowhere in a read model either.
    expect(JSON.stringify(await getRecoveryByCart(a, A, cartId))).not.toContain(token);
  });

  it('mints unpredictable tokens', () => {
    const many = new Set(Array.from({ length: 500 }, () => mintToken()));
    expect(many.size).toBe(500);
  });

  it('redeems once, reactivates the cart, and refuses the second attempt', async () => {
    const cartId = await makeCart();
    await abandonAll();
    const { tokens } = await consumeAbandonedCarts(a, A);
    const token = tokens.get(cartId)!;

    const abandoned = await db.owner.query<{ status: string }>(
      `SELECT status FROM cart WHERE id = $1`,
      [cartId],
    );
    expect(abandoned.rows[0]!.status).toBe('abandoned');

    expect(await validateRecoveryToken(a, A, token, { actor })).toEqual({ cartId });

    const reactivated = await db.owner.query<{ status: string }>(
      `SELECT status FROM cart WHERE id = $1`,
      [cartId],
    );
    expect(reactivated.rows[0]!.status).toBe('active');

    const record = await getRecoveryByCart(a, A, cartId);
    expect(record.status).toBe('redeemed');
    expect(record.redeemed_at).not.toBeNull();

    // Single use.
    await expect(validateRecoveryToken(a, A, token)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers unknown, expired and used links identically', async () => {
    const cartId = await makeCart();
    await abandonAll();
    const { tokens } = await consumeAbandonedCarts(a, A);
    const used = tokens.get(cartId)!;
    await validateRecoveryToken(a, A, used);

    const expiredCart = await makeCart({ totalMinor: 7_000 });
    await abandonAll();
    const second = await consumeAbandonedCarts(a, A);
    const expiring = second.tokens.get(expiredCart)!;
    await db.owner.query(
      `UPDATE cart_recovery SET token_expires_at = now() - interval '1 day' WHERE cart_id = $1`,
      [expiredCart],
    );

    const bodies: string[] = [];
    for (const token of [mintToken(), used, expiring, 'not-even-a-token-shaped-string']) {
      try {
        await validateRecoveryToken(a, A, token);
        throw new Error(`expected ${token} to be refused`);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        expect(e.code).toBe('not_found');
        bodies.push(e.message ?? '');
      }
    }
    // One message for every case: a recovery link is a bearer credential and must not be probeable.
    expect(new Set(bodies).size).toBe(1);
  });

  it('answers 409, not 404, when the cart was already ordered', async () => {
    const cartId = await makeCart();
    await abandonAll();
    const { tokens } = await consumeAbandonedCarts(a, A);
    const token = tokens.get(cartId)!;

    await placeOrderFor(cartId);

    // The caller proved they hold a valid token, so "you already placed this order" leaks nothing and is what
    // the storefront should say.
    await expect(validateRecoveryToken(a, A, token)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never redeems another store token', async () => {
    const cartId = await makeCart({ storeId: A });
    await abandonAll();
    const { tokens } = await consumeAbandonedCarts(a, A);
    const token = tokens.get(cartId)!;

    await expect(validateRecoveryToken(b, B, token)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('recovery detection and the report', () => {
  const window = { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' };

  it('flips a record when its cart becomes an order, and counts it once', async () => {
    const recovered = await makeCart();
    const lost = await makeCart({ totalMinor: 8_000 });
    await abandonAll();
    await consumeAbandonedCarts(a, A);

    const orderId = await placeOrderFor(recovered, A, 15_000);

    expect(await reconcileRecoveries(a, A)).toEqual({ recovered: 1 });
    const record = await getRecoveryByCart(a, A, recovered);
    expect(record).toMatchObject({ status: 'recovered', recovered_order_id: orderId });
    expect(record.recovered_at).not.toBeNull();

    // Idempotent: running it again changes nothing and does not count the cart twice.
    expect(await reconcileRecoveries(a, A)).toEqual({ recovered: 0 });
    expect((await getRecoveryByCart(a, A, recovered)).recovered_at).toBe(record.recovered_at);
    expect((await getRecoveryByCart(a, A, lost)).status).toBe('pending');
  });

  it('reports abandoned, redeemed, recovered and the rate', async () => {
    const recovered = await makeCart({ totalMinor: 10_000 });
    const openedOnly = await makeCart({ totalMinor: 20_000 });
    await makeCart({ totalMinor: 30_000 });
    await abandonAll();
    const { tokens } = await consumeAbandonedCarts(a, A);

    await validateRecoveryToken(a, A, tokens.get(openedOnly)!);
    await validateRecoveryToken(a, A, tokens.get(recovered)!);
    await placeOrderFor(recovered, A, 11_000);
    await reconcileRecoveries(a, A);

    const report = await abandonedCartReport(a, A, window);
    expect(report).toMatchObject({
      currency: 'EUR',
      abandoned_count: 3,
      redeemed_count: 2,
      recovered_count: 1,
      recovery_rate: 0.3333,
    });
    expect(report.abandoned_value).toEqual({ amount_minor: 60_000, currency: 'EUR' });
    // The ORDER total, not the cart total: what the customer actually paid after coming back.
    expect(report.recovered_value).toEqual({ amount_minor: 11_000, currency: 'EUR' });
  });

  it('counts a cart once however many times the link was opened', async () => {
    const cartId = await makeCart();
    await abandonAll();
    await consumeAbandonedCarts(a, A);
    await placeOrderFor(cartId);
    await reconcileRecoveries(a, A);
    await reconcileRecoveries(a, A);

    const report = await abandonedCartReport(a, A, window);
    expect(report).toMatchObject({ abandoned_count: 1, recovered_count: 1, recovery_rate: 1 });
  });

  it('is 0% rather than a division by zero when nothing was abandoned', async () => {
    const report = await abandonedCartReport(a, A, window);
    expect(report).toMatchObject({ abandoned_count: 0, recovered_count: 0, recovery_rate: 0 });
    expect(report.abandoned_value).toEqual({ amount_minor: 0, currency: 'EUR' });
  });

  it('excludes carts outside the window and another store carts', async () => {
    await makeCart({ storeId: A, totalMinor: 9_000 });
    await makeCart({ storeId: B, totalMinor: 99_000 });
    await abandonAll();
    await consumeAbandonedCarts(a, A);
    await consumeAbandonedCarts(b, B);

    const inside = await abandonedCartReport(a, A, window);
    expect(inside.abandoned_count).toBe(1);
    expect(inside.abandoned_value.amount_minor).toBe(9_000);

    const outside = await abandonedCartReport(a, A, {
      from: '2000-01-01T00:00:00Z',
      to: '2000-02-01T00:00:00Z',
    });
    expect(outside.abandoned_count).toBe(0);
  });

  it('rejects a missing or inverted window', async () => {
    await expect(abandonedCartReport(a, A, { from: '', to: '' })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      abandonedCartReport(a, A, { from: window.to, to: window.from }),
    ).rejects.toMatchObject({ code: 'validation_error', details: { to: 'must be after from' } });
  });
});
