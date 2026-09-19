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
});
