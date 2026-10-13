import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganizationClient, createTenantClient } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

const ORG = '10000000-0000-4000-8000-000000000001';
const OTHER_ORG = '10000000-0000-4000-8000-000000000002';
const LE = '10000000-0000-4000-8000-000000000011';
const STORE_A = '10000000-0000-4000-8000-000000000031';
const STORE_B = '10000000-0000-4000-8000-000000000032';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  // Fixtures through the owner role, but FORCE RLS still applies: organization scope must be set explicitly.
  const hq = createOrganizationClient(db.owner, { organizationId: ORG });
  await hq.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq', 'HQ')`, [ORG]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le-a', 'A BV', 'NL', 'EUR')`,
      [LE, ORG],
    );
    for (const [id, code] of [
      [STORE_A, 'brand-a'],
      [STORE_B, 'brand-b'],
    ] as const) {
      await tx.query(
        `INSERT INTO store (id, organization_id, legal_entity_id, code, name, default_currency, default_locale, default_country)
         VALUES ($1, $2, $3, $4, $4, 'EUR', 'en-GB', 'NL')`,
        [id, ORG, LE, code],
      );
      await tx.query(
        `INSERT INTO product (organization_id, store_id, handle, title, status) VALUES ($1, $2, 'tee', 'Tee ' || $3, 'published')`,
        [ORG, id, code],
      );
    }
  });
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe('row-level security (platform_app role)', () => {
  it('a store-A session reads only store-A rows', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const products = await a.query<{ store_id: string }>('SELECT store_id FROM product');
    expect(products.rows).toHaveLength(1);
    expect(products.rows[0]?.store_id).toBe(STORE_A);

    const stores = await a.query<{ id: string }>('SELECT id FROM store');
    expect(stores.rows.map((r) => r.id)).toEqual([STORE_A]);
  });

  it('a store-A session cannot read store-B rows even when filtering for them', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const r = await a.query('SELECT id FROM product WHERE store_id = $1', [STORE_B]);
    expect(r.rowCount).toBe(0);
    const s = await a.query('SELECT id FROM store WHERE id = $1', [STORE_B]);
    expect(s.rowCount).toBe(0);
  });

  it('a store-A session cannot insert a row for store B', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    await expect(
      a.query(
        `INSERT INTO product (organization_id, store_id, handle, title) VALUES ($1, $2, 'hack', 'Hack')`,
        [ORG, STORE_B],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a store-A session cannot move its own row to store B', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    await expect(
      a.query('UPDATE product SET store_id = $1 WHERE store_id = $2', [STORE_B, STORE_A]),
    ).rejects.toThrow(/row-level security/);
  });

  it('a multi-store session sees exactly its stores', async () => {
    const ab = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A, STORE_B] });
    const r = await ab.query<{ store_id: string }>(
      'SELECT store_id FROM product ORDER BY store_id',
    );
    expect(r.rows.map((x) => x.store_id)).toEqual([STORE_A, STORE_B]);
  });

  it('organization scope sees every store; a foreign organization sees nothing', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    expect((await hq.query('SELECT id FROM product')).rowCount).toBe(2);
    expect((await hq.query('SELECT id FROM store')).rowCount).toBe(2);

    const other = createOrganizationClient(db.app, { organizationId: OTHER_ORG });
    expect((await other.query('SELECT id FROM product')).rowCount).toBe(0);
    expect((await other.query('SELECT id FROM organization')).rowCount).toBe(0);
  });

  it('no context means no rows (a pooled connection never leaks a previous tenant)', async () => {
    const client = await db.app.connect();
    try {
      expect((await client.query('SELECT id FROM product')).rowCount).toBe(0);
      expect((await client.query('SELECT id FROM store')).rowCount).toBe(0);
      expect((await client.query('SELECT id FROM organization')).rowCount).toBe(0);
    } finally {
      client.release();
    }
  });

  it('organization-level audit rows (store_id NULL) are hidden from store scope', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.query(
      `INSERT INTO audit_log (organization_id, store_id, actor_type, action, entity_type, entity_id)
       VALUES ($1, NULL, 'system', 'organization.update', 'organization', $1),
              ($1, $2, 'system', 'product.update', 'product', $1)`,
      [ORG, STORE_A],
    );
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const r = await a.query<{ action: string }>('SELECT action FROM audit_log');
    expect(r.rows.map((x) => x.action)).toEqual(['product.update']);
    expect((await hq.query('SELECT id FROM audit_log')).rowCount).toBe(2);
  });

  it('the app role cannot update or delete append-only tables', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await expect(hq.query(`DELETE FROM audit_log`)).rejects.toThrow(/permission denied/);
  });

  it('order display ids are per store and sequential', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const ids = await hq.transaction(async (tx) => {
      const out: Array<{ store_id: string; display_id: string }> = [];
      for (const store of [STORE_A, STORE_A, STORE_B]) {
        const ch = await tx.query<{ id: string }>(
          `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, 'web-' || gen_random_uuid(), 'Web', 'web') RETURNING id`,
          [ORG, store],
        );
        const o = await tx.query<{ store_id: string; display_id: string }>(
          `INSERT INTO "order" (organization_id, store_id, sales_channel_id, email, currency, locale,
             shipping_address, billing_address, subtotal_minor, total_minor)
           VALUES ($1, $2, $3, 'x@example.com', 'EUR', 'en-GB', '{}', '{}', 1000, 1000)
           RETURNING store_id, display_id`,
          [ORG, store, ch.rows[0]!.id],
        );
        out.push(o.rows[0]!);
      }
      return out;
    });
    expect(ids.map((x) => [x.store_id, Number(x.display_id)])).toEqual([
      [STORE_A, 1000],
      [STORE_A, 1001],
      [STORE_B, 1000],
    ]);
  });

  it('marketing: a store-A session sees only its own campaign and attribution rows (0120)', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.transaction(async (tx) => {
      for (const store of [STORE_A, STORE_B]) {
        const campaign = await tx.query<{ id: string }>(
          `INSERT INTO campaign (organization_id, store_id, name, type, utm_source, utm_medium, utm_campaign)
           VALUES ($1, $2, 'Autumn', 'paid_social', 'meta', 'paid_social', 'autumn') RETURNING id`,
          [ORG, store],
        );
        const ch = await tx.query<{ id: string }>(
          `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, 'mkt-' || gen_random_uuid(), 'Web', 'web') RETURNING id`,
          [ORG, store],
        );
        const order = await tx.query<{ id: string }>(
          `INSERT INTO "order" (organization_id, store_id, sales_channel_id, email, currency, locale,
             shipping_address, billing_address, subtotal_minor, total_minor)
           VALUES ($1, $2, $3, 'x@example.com', 'EUR', 'en-GB', '{}', '{}', 1000, 1000) RETURNING id`,
          [ORG, store, ch.rows[0]!.id],
        );
        await tx.query(
          `INSERT INTO attribution (organization_id, store_id, order_id, touch, utm_source, campaign_id, captured_at)
           VALUES ($1, $2, $3, 'first', 'meta', $4, now()), ($1, $2, $3, 'last', 'google', NULL, now())`,
          [ORG, store, order.rows[0]!.id, campaign.rows[0]!.id],
        );
      }
    });

    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const campaigns = await a.query<{ store_id: string }>('SELECT store_id FROM campaign');
    expect(campaigns.rows.map((r) => r.store_id)).toEqual([STORE_A]);
    const attributions = await a.query<{ store_id: string; touch: string }>(
      'SELECT store_id, touch FROM attribution ORDER BY touch',
    );
    expect(attributions.rows).toEqual([
      { store_id: STORE_A, touch: 'first' },
      { store_id: STORE_A, touch: 'last' },
    ]);
    expect(
      (await a.query('SELECT id FROM attribution WHERE store_id = $1', [STORE_B])).rowCount,
    ).toBe(0);
    await expect(
      a.query(
        `INSERT INTO campaign (organization_id, store_id, name, type) VALUES ($1, $2, 'hack', 'email')`,
        [ORG, STORE_B],
      ),
    ).rejects.toThrow(/row-level security/);
    // (order_id, touch) is unique: a second first-touch row for the same order is refused.
    await expect(
      a.query(
        `INSERT INTO attribution (organization_id, store_id, order_id, touch, captured_at)
         SELECT organization_id, store_id, order_id, 'first', now() FROM attribution WHERE touch = 'first' LIMIT 1`,
      ),
    ).rejects.toThrow(/attribution_order_id_touch_key/);
    expect((await hq.query('SELECT id FROM campaign')).rowCount).toBe(2);
    expect((await hq.query('SELECT id FROM attribution')).rowCount).toBe(4);
  });

  it('marketing: segment templates (store_id NULL) are visible only in organization scope (0120)', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.query(
      `INSERT INTO segment (organization_id, store_id, name, rules)
       VALUES ($1, NULL, 'VIP template', '{"total_spent_minor": {"gte": 50000}}'),
              ($1, $2, 'VIP A', '{"total_spent_minor": {"gte": 50000}}'),
              ($1, $3, 'VIP B', '{"total_spent_minor": {"gte": 50000}}')`,
      [ORG, STORE_A, STORE_B],
    );
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const mine = await a.query<{ name: string }>('SELECT name FROM segment ORDER BY name');
    expect(mine.rows.map((r) => r.name)).toEqual(['VIP A']);
    await expect(
      a.query(
        `INSERT INTO segment (organization_id, store_id, name) VALUES ($1, NULL, 'sneaky template')`,
        [ORG],
      ),
    ).rejects.toThrow(/row-level security/);
    const all = await hq.query<{ name: string }>('SELECT name FROM segment ORDER BY name');
    expect(all.rows.map((r) => r.name)).toEqual(['VIP A', 'VIP B', 'VIP template']);
    const other = createOrganizationClient(db.app, { organizationId: OTHER_ORG });
    expect((await other.query('SELECT id FROM segment')).rowCount).toBe(0);
  });

  it('merchandising: a store-A session sees only its own rule; one rule per store + scope (0130)', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.transaction(async (tx) => {
      for (const store of [STORE_A, STORE_B]) {
        const category = await tx.query<{ id: string }>(
          `INSERT INTO product_category (organization_id, store_id, handle, name) VALUES ($1, $2, 'tees', 'Tees') RETURNING id`,
          [ORG, store],
        );
        await tx.query(
          `INSERT INTO merchandising_rule (organization_id, store_id, scope_type, scope_key, category_id, pins)
           VALUES ($1, $2, 'category', $3::text, $3::uuid, '[]'), ($1, $2, 'query', 'summer tee', NULL, '[]')`,
          [ORG, store, category.rows[0]!.id],
        );
      }
    });

    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const mine = await a.query<{ store_id: string; scope_type: string }>(
      'SELECT store_id, scope_type FROM merchandising_rule ORDER BY scope_type',
    );
    expect(mine.rows).toEqual([
      { store_id: STORE_A, scope_type: 'category' },
      { store_id: STORE_A, scope_type: 'query' },
    ]);
    expect(
      (await a.query('SELECT id FROM merchandising_rule WHERE store_id = $1', [STORE_B])).rowCount,
    ).toBe(0);
    await expect(
      a.query(
        `INSERT INTO merchandising_rule (organization_id, store_id, scope_type, scope_key) VALUES ($1, $2, 'query', 'hack')`,
        [ORG, STORE_B],
      ),
    ).rejects.toThrow(/row-level security/);
    // one rule per (store, scope_type, scope_key): a second query rule for the same words is refused
    await expect(
      a.query(
        `INSERT INTO merchandising_rule (organization_id, store_id, scope_type, scope_key) VALUES ($1, $2, 'query', 'summer tee')`,
        [ORG, STORE_A],
      ),
    ).rejects.toThrow(/merchandising_rule_store_id_scope_type_scope_key_key/);
    // a category scope must carry its category_id (and a query scope must not)
    await expect(
      a.query(
        `INSERT INTO merchandising_rule (organization_id, store_id, scope_type, scope_key) VALUES ($1, $2, 'category', 'x')`,
        [ORG, STORE_A],
      ),
    ).rejects.toThrow(/check constraint/);
    expect((await hq.query('SELECT id FROM merchandising_rule')).rowCount).toBe(4);
  });

  it('promotions: buy_x_get_y inserts after 0150; unknown types are still refused; rows stay per store', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const created = await a.query<{ id: string; type: string }>(
      `INSERT INTO promotion (organization_id, store_id, name, type, rules)
       VALUES ($1, $2, 'Buy 2 get 1', 'buy_x_get_y', '{"buy_quantity": 2, "get_quantity": 1, "exclusive": true}')
       RETURNING id, type`,
      [ORG, STORE_A],
    );
    expect(created.rows[0]?.type).toBe('buy_x_get_y');
    await expect(
      a.query(
        `INSERT INTO promotion (organization_id, store_id, name, type) VALUES ($1, $2, 'Nope', 'bogo')`,
        [ORG, STORE_A],
      ),
    ).rejects.toThrow(/promotion_type_check/);
    await expect(
      a.query(
        `INSERT INTO promotion (organization_id, store_id, name, type) VALUES ($1, $2, 'Hack', 'buy_x_get_y')`,
        [ORG, STORE_B],
      ),
    ).rejects.toThrow(/row-level security/);
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
    expect(
      (await b.query('SELECT id FROM promotion WHERE type = $1', ['buy_x_get_y'])).rowCount,
    ).toBe(0);
  });

  it('webhook_event (0140): rows stay per store; a redelivery conflicts on (provider, provider_event_id)', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    await a.query(
      `INSERT INTO webhook_event (organization_id, store_id, provider, provider_event_id, event_type, payload_hash)
       VALUES ($1, $2, 'stripe', 'evt_rls_case', 'payment_intent.succeeded', 'deadhash')`,
      [ORG, STORE_A],
    );
    await expect(
      a.query(
        `INSERT INTO webhook_event (organization_id, store_id, provider, provider_event_id, event_type, payload_hash)
         VALUES ($1, $2, 'stripe', 'evt_rls_hack', 'payment_intent.succeeded', 'deadhash')`,
        [ORG, STORE_B],
      ),
    ).rejects.toThrow(/row-level security/);
    // the dedupe key is intentionally NOT per store: the same delivery routed twice still inserts once
    await expect(
      a.query(
        `INSERT INTO webhook_event (organization_id, store_id, provider, provider_event_id, event_type, payload_hash)
         VALUES ($1, $2, 'stripe', 'evt_rls_case', 'payment_intent.succeeded', 'deadhash')`,
        [ORG, STORE_A],
      ),
    ).rejects.toThrow(/webhook_event_provider_provider_event_id_key/);
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
    expect((await b.query('SELECT id FROM webhook_event')).rowCount).toBe(0);
  });

  it('marketing_cursor (0170): rows stay per store; one cursor per (store, name)', async () => {
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    await a.query(
      `INSERT INTO marketing_cursor (organization_id, store_id, name, seq) VALUES ($1, $2, 'cart_recovery', 7)`,
      [ORG, STORE_A],
    );
    await expect(
      a.query(
        `INSERT INTO marketing_cursor (organization_id, store_id, name, seq) VALUES ($1, $2, 'cart_recovery', 1)`,
        [ORG, STORE_B],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      a.query(
        `INSERT INTO marketing_cursor (organization_id, store_id, name, seq) VALUES ($1, $2, 'cart_recovery', 9)`,
        [ORG, STORE_A],
      ),
    ).rejects.toThrow(/marketing_cursor_store_id_name_key/);
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
    expect((await b.query('SELECT id FROM marketing_cursor')).rowCount).toBe(0);
  });

  it('cart_recovery (0170): the corrected constraints are what a fresh database gets', async () => {
    const r = await db.owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'cart_recovery'::regclass AND contype IN ('u','c') ORDER BY conname`,
    );
    const defs = r.rows.map((x) => x.def).join('\n');
    // behaviour (replay no-op, single-use redemption) is proven in the marketing module's suites;
    // this pins the migration: the per-cart and per-token-hash UNIQUEs exist, the status/recovered_at
    // CHECK exists, and the dropped cross-clock CHECK (#244 correction) is really absent
    expect(defs).toMatch(/UNIQUE \(cart_id\)/);
    expect(defs).toMatch(/UNIQUE \(token_hash\)/);
    expect(defs).toMatch(/recovered_at IS NOT NULL/);
    expect(defs).not.toMatch(/redeemed_at >= created_at/);
  });

  it('shipment.status CHECK includes picking and packed after 0160', async () => {
    const r = await db.owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'shipment_status_check'`,
    );
    // behaviour (legal transitions, refusals) is proven in the fulfillment module's suites;
    // this pins the migration itself: the widened constraint is what a fresh database gets
    expect(r.rows[0]!.def).toContain("'picking'");
    expect(r.rows[0]!.def).toContain("'packed'");
    expect(r.rows[0]!.def).not.toContain("'boxed'");
  });

  it('notification_delivery (0180): rows stay per store; organization scope sees all; one row per event_id', async () => {
    const EVENT_A = '10000000-0000-4000-8000-000000000181';
    const EVENT_B = '10000000-0000-4000-8000-000000000182';
    const AGG = '10000000-0000-4000-8000-000000000189';
    const insert = `INSERT INTO notification_delivery
       (organization_id, store_id, event_id, event_seq, topic, aggregate_id, kind)
       VALUES ($1, $2, $3, $4, 'order.placed', $5, 'order_confirmation')`;
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
    await a.query(insert, [ORG, STORE_A, EVENT_A, 1, AGG]);
    await b.query(insert, [ORG, STORE_B, EVENT_B, 2, AGG]);
    // same store: reads and updates its own row
    expect((await a.query('SELECT store_id FROM notification_delivery')).rows).toEqual([
      { store_id: STORE_A },
    ]);
    expect(
      (
        await a.query(`UPDATE notification_delivery SET attempts = 1 WHERE event_id = $1`, [
          EVENT_A,
        ])
      ).rowCount,
    ).toBe(1);
    // cross store: B's row is invisible even when filtered for, cannot be updated, and A cannot insert or move into B
    expect(
      (await a.query('SELECT id FROM notification_delivery WHERE store_id = $1', [STORE_B]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await a.query(`UPDATE notification_delivery SET attempts = 9 WHERE event_id = $1`, [
          EVENT_B,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(
      a.query(insert, [ORG, STORE_B, '10000000-0000-4000-8000-000000000183', 3, AGG]),
    ).rejects.toThrow(/row-level security/);
    await expect(
      a.query('UPDATE notification_delivery SET store_id = $1 WHERE event_id = $2', [
        STORE_B,
        EVENT_A,
      ]),
    ).rejects.toThrow(/row-level security/);
    // organization scope (the worker's client) sees both stores; a foreign organization sees nothing
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    expect((await hq.query('SELECT id FROM notification_delivery')).rowCount).toBe(2);
    const other = createOrganizationClient(db.app, { organizationId: OTHER_ORG });
    expect((await other.query('SELECT id FROM notification_delivery')).rowCount).toBe(0);
    // the replay guard: a re-delivered event conflicts (and the key is per event, not per store)
    await expect(a.query(insert, [ORG, STORE_A, EVENT_A, 1, AGG])).rejects.toThrow(
      /notification_delivery_event_id_key/,
    );
    // status 'sent' requires sent_at, and vice versa
    await expect(
      a.query(`UPDATE notification_delivery SET status = 'sent' WHERE event_id = $1`, [EVENT_A]),
    ).rejects.toThrow(/notification_delivery_check/);
  });

  it('notification_delivery (0180): carries no recipient column', async () => {
    const r = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'notification_delivery'`,
    );
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).toContain('event_id');
    expect(cols).toContain('store_id');
    expect(cols).toContain('organization_id');
    expect(cols.filter((c) => /email|recipient|address|phone|name/.test(c))).toEqual([]);
  });

  // --- stock pool (0190) ---------------------------------------------------------------------------
  const poolVariant = async (store: string, sku: string): Promise<string> => {
    const client = createTenantClient(db.app, { organizationId: ORG, storeIds: [store] });
    const made = await client.query<{ id: string }>(
      `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title)
       SELECT $1, $2, p.id, $3, 'One size' FROM product p WHERE p.store_id = $2 RETURNING id`,
      [ORG, store, sku],
    );
    const row = made.rows[0];
    if (!row) throw new Error(`no variant created for ${sku}`);
    return row.id;
  };
  const stockItemOf = async (variantId: string): Promise<string> => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const found = await hq.query<{ stock_item_id: string | null }>(
      'SELECT stock_item_id FROM product_variant WHERE id = $1',
      [variantId],
    );
    const item = found.rows[0]?.stock_item_id;
    if (!item) throw new Error(`variant ${variantId} has no stock item`);
    return item;
  };

  it('stock pool (0190): a store session reaches only the stock items its own variants map', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    // a variant is created unmapped in store scope (what the catalog does) and, since 0191, gets its own item
    // from the insert trigger: 1:1, never merging ...
    const variantA = await poolVariant(STORE_A, 'POOL-A');
    const variantB = await poolVariant(STORE_B, 'POOL-B');
    // ... so the backfill (which mapped them before 0191) finds nothing left to do
    await db.owner.query('SELECT app.backfill_stock_items()');
    const itemA = await stockItemOf(variantA);
    const itemB = await stockItemOf(variantB);
    expect(itemA).not.toBe(itemB);
    const named = await hq.query<{ sku: string }>(
      'SELECT sku FROM stock_item WHERE id = ANY($1) ORDER BY sku',
      [[itemA, itemB]],
    );
    expect(named.rows).toEqual([{ sku: 'POOL-A' }, { sku: 'POOL-B' }]);
    // a second run touches nothing that is already mapped
    await db.owner.query('SELECT app.backfill_stock_items()');
    expect(await stockItemOf(variantA)).toBe(itemA);

    // store A: its own item, never brand B's — to read or to write
    const seen = await a.query<{ id: string }>('SELECT id FROM stock_item WHERE id = ANY($1)', [
      [itemA, itemB],
    ]);
    expect(seen.rows.map((r) => r.id)).toEqual([itemA]);
    const touched = await a.query('UPDATE stock_item SET name = $2 WHERE id = $1', [itemB, 'x']);
    expect(touched.rowCount).toBe(0);
    // a store session cannot create a stock item: no variant maps a row that does not exist yet
    await expect(
      a.query(`INSERT INTO stock_item (organization_id, sku, name) VALUES ($1, 'ROGUE', 'Rogue')`, [
        ORG,
      ]),
    ).rejects.toThrow(/row-level security/);
    // organization scope sees both; another organization none
    const both = await hq.query('SELECT id FROM stock_item WHERE id = ANY($1)', [[itemA, itemB]]);
    expect(both.rows).toHaveLength(2);
    const other = createOrganizationClient(db.app, { organizationId: OTHER_ORG });
    expect((await other.query('SELECT id FROM stock_item')).rows).toHaveLength(0);
  });

  it('stock pool (0190): only organization scope may map a variant to a stock item', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const variantA = await poolVariant(STORE_A, 'MAP-A');
    const variantB = await poolVariant(STORE_B, 'MAP-B');
    await db.owner.query('SELECT app.backfill_stock_items()');
    const itemA = await stockItemOf(variantA);
    const itemB = await stockItemOf(variantB);
    const refused = /only organization scope may/;

    // store scope cannot point its variant at another brand's item (which would hand it that item's pool) ...
    await expect(
      a.query('UPDATE product_variant SET stock_item_id = $2 WHERE id = $1', [variantA, itemB]),
    ).rejects.toThrow(refused);
    // ... nor insert a variant that arrives already mapped — to an item it maps, or to one it does not
    for (const [sku, item] of [
      ['MAP-A2', itemA],
      ['MAP-A3', itemB],
    ] as const) {
      await expect(
        a.query(
          `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title, stock_item_id)
           SELECT $1, $2, p.id, $3, 'One size', $4 FROM product p WHERE p.store_id = $2`,
          [ORG, STORE_A, sku, item],
        ),
      ).rejects.toThrow(refused);
    }
    // fail closed: a session with no scope at all (the owner role) is refused too
    await expect(
      db.owner.query('UPDATE product_variant SET stock_item_id = $2 WHERE id = $1', [
        variantA,
        itemB,
      ]),
    ).rejects.toThrow(refused);
    expect(await stockItemOf(variantA)).toBe(itemA);

    // an ordinary edit of the variant in store scope is untouched by the guard
    const edited = await a.query(`UPDATE product_variant SET title = 'Edited' WHERE id = $1`, [
      variantA,
    ]);
    expect(edited.rowCount).toBe(1);

    // organization scope maps — and only then does the store reach the shared item
    expect((await a.query('SELECT id FROM stock_item WHERE id = $1', [itemB])).rows).toHaveLength(
      0,
    );
    await hq.query('UPDATE product_variant SET stock_item_id = $2 WHERE id = $1', [
      variantA,
      itemB,
    ]);
    expect((await a.query('SELECT id FROM stock_item WHERE id = $1', [itemB])).rows).toHaveLength(
      1,
    );
  });

  it('stock pool (0191): the variant trigger never reads a product of another store', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const foreign = await hq.query<{ id: string }>(
      'SELECT id FROM product WHERE store_id = $1 LIMIT 1',
      [STORE_B],
    );
    const productB = foreign.rows[0]?.id;
    if (!productB) throw new Error('no product of store B');
    // store A names brand B's product id for a variant of its own store: the foreign key alone would accept it,
    // and the trigger (organization scope) would copy brand B's title into a stock item store A can read
    await expect(
      a.query(
        `INSERT INTO product_variant (organization_id, store_id, product_id, sku, title)
         VALUES ($1, $2, $3, 'TITLE-PROBE', 'One size')`,
        [ORG, STORE_A, productB],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const left = await hq.query('SELECT id FROM stock_item WHERE sku LIKE $1', ['%TITLE-PROBE']);
    expect(left.rows).toHaveLength(0);
  });

  // --- stock pool (0191): the real tables, keyed by stock item ---------------------------------------
  const poolWarehouse = async (code: string): Promise<string> => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const made = await hq.query<{ id: string }>(
      `INSERT INTO warehouse (organization_id, code, name, country) VALUES ($1, $2, $2, 'NL')
       ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [ORG, code],
    );
    const row = made.rows[0];
    if (!row) throw new Error(`no warehouse ${code}`);
    return row.id;
  };
  /** Brand A's variant mapped onto brand B's item by organization scope: one pool, two brands. */
  const sharedItem = async (
    prefix: string,
  ): Promise<{ variantA: string; variantB: string; item: string }> => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const variantA = await poolVariant(STORE_A, `${prefix}-A`);
    const variantB = await poolVariant(STORE_B, `${prefix}-B`);
    const item = await stockItemOf(variantB);
    await hq.query('UPDATE product_variant SET stock_item_id = $2 WHERE id = $1', [variantA, item]);
    return { variantA, variantB, item };
  };

  it('stock pool (0191): inventory_level is a pool row — a store reaches it only through an item it maps', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
    const warehouse = await poolWarehouse('wh-pool');
    const elsewhere = await poolWarehouse('wh-pool-2');
    const variantA = await poolVariant(STORE_A, 'LEVEL-A');
    const variantB = await poolVariant(STORE_B, 'LEVEL-B');
    const itemA = await stockItemOf(variantA);
    const itemB = await stockItemOf(variantB);
    expect(itemA).not.toBe(itemB);

    // the row carries no store and no variant any more
    const cols = await db.owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inventory_level'`,
    );
    expect(cols.rows.map((r) => r.column_name)).toContain('stock_item_id');
    expect(cols.rows.map((r) => r.column_name)).not.toContain('store_id');
    expect(cols.rows.map((r) => r.column_name)).not.toContain('variant_id');

    const level = `INSERT INTO inventory_level (organization_id, stock_item_id, warehouse_id, on_hand)
                   VALUES ($1, $2, $3, $4) RETURNING id`;
    const levelA = (await hq.query<{ id: string }>(level, [ORG, itemA, warehouse, 10])).rows[0]!.id;
    const levelB = (await hq.query<{ id: string }>(level, [ORG, itemB, warehouse, 20])).rows[0]!.id;
    // one pool row per item and warehouse
    await expect(hq.query(level, [ORG, itemB, warehouse, 1])).rejects.toThrow(
      /inventory_level_stock_item_warehouse_key/,
    );

    // store A: its own item's level only — brand B's is unreadable, not updatable, not insertable
    const seen = await a.query<{ id: string }>(
      'SELECT id FROM inventory_level WHERE stock_item_id = ANY($1)',
      [[itemA, itemB]],
    );
    expect(seen.rows.map((r) => r.id)).toEqual([levelA]);
    const own = await a.query('UPDATE inventory_level SET reserved = 1 WHERE id = $1', [levelA]);
    expect(own.rowCount).toBe(1);
    const foreign = await a.query('UPDATE inventory_level SET on_hand = 0 WHERE id = $1', [levelB]);
    expect(foreign.rowCount).toBe(0);
    await expect(a.query(level, [ORG, itemB, elsewhere, 5])).rejects.toThrow(/row-level security/);
    const untouched = await hq.query<{ on_hand: number }>(
      'SELECT on_hand FROM inventory_level WHERE id = $1',
      [levelB],
    );
    expect(untouched.rows[0]?.on_hand).toBe(20);

    // organization scope maps A's variant onto B's item: now both brands see B's pool row ...
    await hq.query('UPDATE product_variant SET stock_item_id = $2 WHERE id = $1', [
      variantA,
      itemB,
    ]);
    const forA = await a.query('SELECT id FROM inventory_level WHERE id = $1', [levelB]);
    expect(forA.rows).toHaveLength(1);
    const forB = await b.query('SELECT id FROM inventory_level WHERE id = $1', [levelB]);
    expect(forB.rows).toHaveLength(1);
    // ... and A, which maps its former item no longer, has lost that item's row (the item itself is kept)
    const former = await a.query('SELECT id FROM inventory_level WHERE id = $1', [levelA]);
    expect(former.rows).toHaveLength(0);
    const kept = await hq.query('SELECT id FROM inventory_level WHERE id = $1', [levelA]);
    expect(kept.rows).toHaveLength(1);
    // another organization sees none of it
    const other = createOrganizationClient(db.app, { organizationId: OTHER_ORG });
    expect((await other.query('SELECT id FROM inventory_level')).rows).toHaveLength(0);
  });

  it('stock pool (0191): stock_movement is the pool ledger — on a shared item a store reads and writes only its own movements', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const warehouse = await poolWarehouse('wh-pool');
    const { variantA, variantB, item } = await sharedItem('LEDGER');
    const move = `INSERT INTO stock_movement (organization_id, store_id, variant_id, stock_item_id, warehouse_id, delta, reason)
                  VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;

    // store A: a movement attributed to itself, written and read back
    const mine = await a.query<{ id: string }>(move, [
      ORG,
      STORE_A,
      variantA,
      item,
      warehouse,
      -1,
      'sale',
    ]);
    const ownId = mine.rows[0]!.id;
    const readOwn = await a.query('SELECT id FROM stock_movement WHERE id = $1', [ownId]);
    expect(readOwn.rows).toHaveLength(1);
    // store A cannot forge a movement attributed to brand B, nor write one no store caused
    await expect(
      a.query(move, [ORG, STORE_B, variantB, item, warehouse, -1, 'sale']),
    ).rejects.toThrow(/row-level security/);
    await expect(a.query(move, [ORG, null, null, item, warehouse, 5, 'receipt'])).rejects.toThrow(
      /row-level security/,
    );

    // organization scope writes all three kinds
    const theirs = await hq.query<{ id: string }>(move, [
      ORG,
      STORE_B,
      variantB,
      item,
      warehouse,
      -2,
      'sale',
    ]);
    const receipt = await hq.query<{ id: string }>(move, [
      ORG,
      null,
      null,
      item,
      warehouse,
      50,
      'receipt',
    ]);
    const forA = await hq.query<{ id: string }>(move, [
      ORG,
      STORE_A,
      variantA,
      item,
      warehouse,
      1,
      'return',
    ]);
    expect(forA.rows).toHaveLength(1);
    // store A reads neither brand B's sale nor the store-less receipt, even on an item it maps
    const readTheirs = await a.query('SELECT id FROM stock_movement WHERE id = $1', [
      theirs.rows[0]!.id,
    ]);
    expect(readTheirs.rows).toHaveLength(0);
    const readReceipt = await a.query('SELECT id FROM stock_movement WHERE id = $1', [
      receipt.rows[0]!.id,
    ]);
    expect(readReceipt.rows).toHaveLength(0);
    const visible = await a.query<{ store_id: string | null }>(
      'SELECT DISTINCT store_id FROM stock_movement WHERE stock_item_id = $1',
      [item],
    );
    expect(visible.rows).toEqual([{ store_id: STORE_A }]);
    // organization scope reads all four
    const all = await hq.query('SELECT id FROM stock_movement WHERE stock_item_id = $1', [item]);
    expect(all.rows).toHaveLength(4);
    // a store and its variant come together or not at all
    await expect(
      hq.query(move, [ORG, STORE_A, null, item, warehouse, 1, 'adjustment']),
    ).rejects.toThrow(/stock_movement_store_attribution_check/);
    // the ledger is still append-only for the application role
    await expect(
      a.query('UPDATE stock_movement SET delta = -9 WHERE id = $1', [ownId]),
    ).rejects.toThrow(/permission denied/);
  });

  it('stock pool (0191): a reservation stays per store, also on a shared item', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const a = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_A] });
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [STORE_B] });
    const warehouse = await poolWarehouse('wh-pool');
    const { variantA, variantB, item } = await sharedItem('HOLD');
    // a reservation needs a cart or an order: one order per store
    const orders = await hq.transaction(async (tx) => {
      const out: Record<string, string> = {};
      for (const store of [STORE_A, STORE_B]) {
        const ch = await tx.query<{ id: string }>(
          `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, 'pool-' || gen_random_uuid(), 'Web', 'web') RETURNING id`,
          [ORG, store],
        );
        const o = await tx.query<{ id: string }>(
          `INSERT INTO "order" (organization_id, store_id, sales_channel_id, email, currency, locale,
             shipping_address, billing_address, subtotal_minor, total_minor)
           VALUES ($1, $2, $3, 'x@example.com', 'EUR', 'en-GB', '{}', '{}', 1000, 1000) RETURNING id`,
          [ORG, store, ch.rows[0]!.id],
        );
        out[store] = o.rows[0]!.id;
      }
      return out;
    });
    const reserve = `INSERT INTO reservation (organization_id, store_id, variant_id, stock_item_id, warehouse_id, order_id, quantity, allocation_rule)
                     VALUES ($1, $2, $3, $4, $5, $6, 1, 'single_warehouse') RETURNING id`;

    // each store reserves for itself on the same pool row
    const mine = await a.query<{ id: string }>(reserve, [
      ORG,
      STORE_A,
      variantA,
      item,
      warehouse,
      orders[STORE_A],
    ]);
    const theirs = await b.query<{ id: string }>(reserve, [
      ORG,
      STORE_B,
      variantB,
      item,
      warehouse,
      orders[STORE_B],
    ]);
    // store A maps the item, yet reads only its own reservation on it
    const seen = await a.query<{ id: string }>(
      'SELECT id FROM reservation WHERE stock_item_id = $1',
      [item],
    );
    expect(seen.rows.map((r) => r.id)).toEqual([mine.rows[0]!.id]);
    const readTheirs = await a.query('SELECT id FROM reservation WHERE id = $1', [
      theirs.rows[0]!.id,
    ]);
    expect(readTheirs.rows).toHaveLength(0);
    const released = await a.query('UPDATE reservation SET released_at = now() WHERE id = $1', [
      theirs.rows[0]!.id,
    ]);
    expect(released.rowCount).toBe(0);
    // nor can it reserve in brand B's name
    await expect(
      a.query(reserve, [ORG, STORE_B, variantB, item, warehouse, orders[STORE_B]]),
    ).rejects.toThrow(/row-level security/);
    // organization scope sees both
    const both = await hq.query('SELECT id FROM reservation WHERE stock_item_id = $1', [item]);
    expect(both.rows).toHaveLength(2);
    // the pool row a reservation holds is mandatory
    await expect(
      hq.query(
        `INSERT INTO reservation (organization_id, store_id, variant_id, warehouse_id, order_id, quantity)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [ORG, STORE_A, variantA, warehouse, orders[STORE_A]],
      ),
    ).rejects.toThrow(/stock_item_id/);
  });
});
