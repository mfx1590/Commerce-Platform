// Abandoned carts (issue #108) on a seeded throwaway database with an injected clock: idle active carts become
// abandoned with ONE cart.abandoned each (no PII), a second run emits nothing, empty carts are skipped, a
// mutation reactivates an abandoned cart and restarts its idle clock (a later abandonment is a new event), and
// SKIP LOCKED keeps two concurrent runs from double-processing. Idleness is driven by the injected `now` (the
// schema's `app.set_updated_at` trigger overwrites any `updated_at` a test would try to backdate).
import { createOrganizationClient, createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addLineItem,
  createCart,
  markAbandonedCarts,
  markAllAbandonedCarts,
  updateCart,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const HOUR = 3_600_000;
const IDLE = 6 * HOUR;
const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR);

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let org: ReturnType<typeof createTenantClient>;
let owner: ReturnType<typeof createOrganizationClient>;
let scopeA: { organizationId: string; storeId: string; salesChannelId: string | null };
let variantId: string;

beforeAll(async () => {
  db = await createTestDatabase('core_abandoned');
  await seed(db.owner, { log: () => {} });
  owner = createOrganizationClient(db.owner, { organizationId: ORG });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A] });
  org = createTenantClient(db.app, { organizationId: ORG, storeIds: [A, SEED_IDS.stores.brandB] });
  scopeA = { organizationId: ORG, storeId: A, salesChannelId: null };
  const v = await owner.query<{ id: string }>(
    `SELECT v.id FROM product_variant v JOIN product p ON p.id = v.product_id AND p.status = 'published'
     JOIN price pr ON pr.variant_id = v.id AND pr.currency = 'EUR' AND pr.min_quantity = 1
     JOIN inventory_level il ON il.variant_id = v.id AND il.available >= 5
     WHERE v.store_id = $1 ORDER BY v.sku LIMIT 1`,
    [A],
  );
  variantId = v.rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

/** A cart with one line (or none), last activity = now. */
async function cart(opts: { email?: string; empty?: boolean; attribution?: boolean } = {}) {
  const c = await createCart(
    a,
    scopeA,
    opts.attribution ? { metadata: { attribution: { first: { utm_source: 'x' } } } } : {},
  );
  if (!opts.empty) await addLineItem(a, c.id, { variant_id: variantId, quantity: 1 });
  if (opts.email) await updateCart(a, c.id, { email: opts.email });
  return c.id;
}

const status = async (id: string) =>
  (await owner.query<{ status: string }>(`SELECT status FROM cart WHERE id = $1`, [id])).rows[0]!
    .status;
const events = async (id: string) =>
  (
    await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox WHERE topic = 'cart.abandoned' AND aggregate_id::text = $1::text ORDER BY occurred_at`,
      [id],
    )
  ).rows.map((r) => r.payload);

describe('markAbandonedCarts', () => {
  it('abandons carts idle beyond the threshold with one event each (no PII), skips fresh and empty carts, is idempotent', async () => {
    const stale = await cart({ email: ' Jane.Doe@Example.com ', attribution: true });
    const other = await cart();
    const empty = await cart({ empty: true });
    // one hour later: nothing is idle for 6 h yet
    const early = await markAllAbandonedCarts(org, { now: at(1), idleForMs: IDLE });
    expect(early.cartIds).toEqual(expect.not.arrayContaining([stale, other, empty]));
    expect(await status(stale)).toBe('active');
    // seven hours later: the carts with lines are abandoned (batchSize 1 → the loop runs several batches)
    const now = at(7);
    const r1 = await markAllAbandonedCarts(org, { now, idleForMs: IDLE, batchSize: 1 });
    expect(r1.cartIds).toEqual(expect.arrayContaining([stale, other]));
    expect(r1.cartIds).not.toContain(empty);
    expect(await status(stale)).toBe('abandoned');
    expect(await status(other)).toBe('abandoned');
    expect(await status(empty)).toBe('active');
    const ev = await events(stale);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      cart_id: stale,
      customer_id: null,
      currency: 'EUR',
      line_item_count: 1,
      has_attribution: true,
      abandoned_at: now.toISOString(),
    });
    expect(ev[0]!.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ev[0]).toLowerCase()).not.toContain('jane');
    expect(typeof ev[0]!.total_minor).toBe('number');
    expect(ev[0]!.total_minor as number).toBeGreaterThan(0);
    expect(Date.parse(String(ev[0]!.last_activity_at))).toBeLessThan(now.getTime());
    // second run: nothing new
    const r2 = await markAllAbandonedCarts(org, { now, idleForMs: IDLE });
    expect(r2.cartIds).not.toContain(stale);
    expect(await events(stale)).toHaveLength(1);
  });

  it('a mutation reactivates an abandoned cart and restarts the idle clock; a later abandonment is a new event', async () => {
    const id = await cart();
    await markAbandonedCarts(org, { now: at(7), idleForMs: IDLE });
    expect(await status(id)).toBe('abandoned');
    // the customer comes back: the mutation succeeds and the cart is active again (updated_at = now)
    const reactivated = await addLineItem(a, id, { variant_id: variantId, quantity: 1 });
    expect(reactivated.status).toBe('active');
    expect(reactivated.items[0]!.quantity).toBe(2);
    const touched = Date.now();
    // not re-abandoned within the threshold (the clock restarted at the mutation)…
    await markAbandonedCarts(org, { now: new Date(touched + IDLE - 60_000), idleForMs: IDLE });
    expect(await status(id)).toBe('active');
    expect(await events(id)).toHaveLength(1);
    // …but after a full idle period it is abandoned again, with a second event
    await markAbandonedCarts(org, { now: new Date(touched + IDLE + 60_000), idleForMs: IDLE });
    expect(await status(id)).toBe('abandoned');
    expect(await events(id)).toHaveLength(2);
    // a completed cart is still refused (409), not reactivated
    await owner.query(`UPDATE cart SET status = 'completed' WHERE id = $1`, [id]);
    await expect(addLineItem(a, id, { variant_id: variantId, quantity: 1 })).rejects.toMatchObject({
      code: 'cart_completed',
    });
  });

  it('two concurrent runs never double-process (SKIP LOCKED) and the email hash is null without an email', async () => {
    const ids = await Promise.all([cart(), cart(), cart()]);
    const now = at(8);
    const [r1, r2] = await Promise.all([
      markAllAbandonedCarts(org, { now, idleForMs: IDLE, batchSize: 2 }),
      markAllAbandonedCarts(org, { now, idleForMs: IDLE, batchSize: 2 }),
    ]);
    const all = [...r1.cartIds, ...r2.cartIds];
    for (const id of ids) {
      expect(all.filter((x) => x === id)).toHaveLength(1);
      const ev = await events(id);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.email_hash).toBeNull();
    }
  });
});
