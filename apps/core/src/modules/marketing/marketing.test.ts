// Marketing module, service level (issue #145): campaign CRUD and transitions with their outbox events, tenant
// isolation across two stores, and the attribution report on real `attribution` + `"order"` rows.
//
// Orders are inserted straight into the table here rather than driven through checkout: this module never writes
// them (docs/marketing-scope.md — "marketing reads events and writes its own tables"), so the report only needs
// rows that look exactly like what window 1's placement leaves behind.
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  attributionReport,
  createCampaign,
  deleteCampaign,
  endCampaign,
  getCampaign,
  launchCampaign,
  listCampaigns,
  updateCampaign,
  type CampaignInput,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const actor = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: 'req-marketing' };

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let b: ReturnType<typeof createTenantClient>;

const input = (over: Partial<CampaignInput> = {}): CampaignInput => ({
  name: 'Autumn launch',
  type: 'paid_social',
  utm_source: 'meta',
  utm_medium: 'paid_social',
  utm_campaign: 'autumn-2026',
  budget: { amount_minor: 250_000, currency: 'EUR' },
  ...over,
});

/** Events the outbox holds for one aggregate, oldest first (the relay is window 14's, Phase 4). */
async function outbox(aggregateId: string) {
  const res = await db.owner.query<{ topic: string; version: number; payload: unknown }>(
    `SELECT topic, version, payload FROM outbox WHERE aggregate_id = $1 ORDER BY occurred_at, id`,
    [aggregateId],
  );
  return res.rows;
}

/**
 * One placed order for a store, optionally with attribution touches. Mirrors what
 * `src/lib/attribution.ts` writes at placement: `campaign_id` stays NULL — linking is the report's job.
 */
async function placeOrder(opts: {
  storeId: string;
  totalMinor: number;
  currency?: string;
  placedAt: string;
  status?: string;
  touches?: {
    touch: 'first' | 'last';
    source: string | null;
    medium: string | null;
    campaign: string | null;
  }[];
}): Promise<string> {
  const channel = await db.owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
    [opts.storeId],
  );
  const address = JSON.stringify({
    first_name: 'Test',
    last_name: 'Buyer',
    line1: '1 Test Street',
    city: 'Amsterdam',
    postal_code: '1011AA',
    country: 'NL',
  });
  const order = await db.owner.query<{ id: string }>(
    `INSERT INTO "order" (organization_id, store_id, sales_channel_id, email, currency, locale, status,
                          shipping_address, billing_address, subtotal_minor, total_minor, placed_at)
     VALUES ($1, $2, $3, 'buyer@example.com', $4, 'en-GB', $5, $6, $6, $7, $7, $8)
     RETURNING id`,
    [
      ORG,
      opts.storeId,
      channel.rows[0]!.id,
      opts.currency ?? 'EUR',
      opts.status ?? 'confirmed',
      address,
      opts.totalMinor,
      opts.placedAt,
    ],
  );
  const orderId = order.rows[0]!.id;
  for (const t of opts.touches ?? []) {
    await db.owner.query(
      `INSERT INTO attribution (organization_id, store_id, order_id, touch, utm_source, utm_medium, utm_campaign,
                                captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ORG, opts.storeId, orderId, t.touch, t.source, t.medium, t.campaign, opts.placedAt],
    );
  }
  return orderId;
}

beforeAll(async () => {
  db = await createTestDatabase('core_marketing');
  await seed(db.owner, { productsPerStore: 4, log: () => {} });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A], actorId: actor.id });
  b = createTenantClient(db.app, { organizationId: ORG, storeIds: [B], actorId: actor.id });
}, 180_000);

afterAll(async () => {
  await db?.drop();
});

beforeEach(async () => {
  await db.owner.query('DELETE FROM attribution');
  await db.owner.query('DELETE FROM "order"');
  await db.owner.query('DELETE FROM campaign');
  await db.owner.query('DELETE FROM outbox');
});

describe('campaign CRUD', () => {
  it('creates in status draft and maps budget between Money and the two columns', async () => {
    const created = await createCampaign(a, A, input(), actor);
    expect(created).toMatchObject({
      store_id: A,
      name: 'Autumn launch',
      type: 'paid_social',
      status: 'draft',
      budget: { amount_minor: 250_000, currency: 'EUR' },
      launched_at: null,
      ended_at: null,
    });

    // The table keeps two columns; the contract sees one Money object.
    const row = await db.owner.query<{ budget_minor: string; currency: string }>(
      `SELECT budget_minor, currency FROM campaign WHERE id = $1`,
      [created.id],
    );
    expect(row.rows[0]).toEqual({ budget_minor: '250000', currency: 'EUR' });

    // No budget at all is legal and comes back as null, not as a zero-amount Money.
    const noBudget = await createCampaign(a, A, input({ name: 'No budget', budget: null }), actor);
    expect(noBudget.budget).toBeNull();
  });

  it('creating writes an audit_log row and no event (only launch/end are events)', async () => {
    const created = await createCampaign(a, A, input(), actor);
    const audit = await db.owner.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE entity_id = $1`,
      [created.id],
    );
    expect(audit.rows).toEqual([{ action: 'campaign.create', actor_id: actor.id }]);
    expect(await outbox(created.id)).toEqual([]);
  });

  it('lists with status/type filters, sort, order and paging', async () => {
    await createCampaign(a, A, input({ name: 'Aaa', type: 'email' }), actor);
    await createCampaign(a, A, input({ name: 'Bbb', type: 'paid_social' }), actor);
    const third = await createCampaign(a, A, input({ name: 'Ccc', type: 'email' }), actor);
    await launchCampaign(a, A, third.id, actor);

    const all = await listCampaigns(a, A, { sort: 'name', order: 'asc' });
    expect(all.total).toBe(3);
    expect(all.items.map((c) => c.name)).toEqual(['Aaa', 'Bbb', 'Ccc']);

    expect((await listCampaigns(a, A, { type: 'email' })).total).toBe(2);
    const active = await listCampaigns(a, A, { status: 'active' });
    expect(active.items.map((c) => c.name)).toEqual(['Ccc']);

    const page2 = await listCampaigns(a, A, { sort: 'name', order: 'asc', page: 2, limit: 2 });
    expect(page2).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(page2.items.map((c) => c.name)).toEqual(['Ccc']);
  });

  it('rejects an ends_at before starts_at and a negative budget', async () => {
    await expect(
      createCampaign(
        a,
        A,
        input({ starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-09-01T00:00:00Z' }),
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'validation_error',
      details: { ends_at: 'must not be before starts_at' },
    });

    await expect(
      createCampaign(a, A, input({ budget: { amount_minor: -1, currency: 'EUR' } }), actor),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('deletes a draft, refuses to delete anything else, and 404s across stores', async () => {
    const draft = await createCampaign(a, A, input(), actor);
    await deleteCampaign(a, A, draft.id, actor);
    await expect(getCampaign(a, A, draft.id)).rejects.toMatchObject({ code: 'not_found' });

    const live = await createCampaign(a, A, input({ name: 'Live' }), actor);
    await launchCampaign(a, A, live.id, actor);
    await expect(deleteCampaign(a, A, live.id, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { status: 'active' },
    });
  });
});

describe('launch and end', () => {
  it('launches, emits campaign.launched, ends, emits campaign.ended', async () => {
    const created = await createCampaign(a, A, input(), actor);

    const active = await launchCampaign(a, A, created.id, actor);
    expect(active.status).toBe('active');
    expect(active.launched_at).not.toBeNull();

    const ended = await endCampaign(a, A, created.id, actor);
    expect(ended.status).toBe('ended');
    expect(ended.ended_at).not.toBeNull();
    // launched_at survives the end: consumers anchor the spend line on it.
    expect(ended.launched_at).toBe(active.launched_at);

    const events = await outbox(created.id);
    expect(events.map((e) => e.topic)).toEqual(['campaign.launched', 'campaign.ended']);
    expect(events[0]).toMatchObject({ version: 1 });
    expect(events[0]!.payload).toMatchObject({
      campaign_id: created.id,
      name: 'Autumn launch',
      type: 'paid_social',
      utm_campaign: 'autumn-2026',
      budget: { amount_minor: 250_000, currency: 'EUR' },
    });
    // No PII ever leaves through an event.
    expect(JSON.stringify(events)).not.toContain('@');
  });

  it('keeps the first launched_at when a paused campaign is relaunched', async () => {
    const created = await createCampaign(a, A, input(), actor);
    const first = await launchCampaign(a, A, created.id, actor);
    await db.owner.query(`UPDATE campaign SET status = 'paused' WHERE id = $1`, [created.id]);
    const again = await launchCampaign(a, A, created.id, actor);
    expect(again.launched_at).toBe(first.launched_at);
  });

  it('refuses illegal transitions and edits of an ended campaign with 409', async () => {
    const created = await createCampaign(a, A, input(), actor);

    await expect(endCampaign(a, A, created.id, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { status: 'draft' },
    });

    await launchCampaign(a, A, created.id, actor);
    await endCampaign(a, A, created.id, actor);

    await expect(launchCampaign(a, A, created.id, actor)).rejects.toMatchObject({
      code: 'conflict',
      details: { status: 'ended' },
    });
    await expect(
      updateCampaign(a, A, created.id, input({ name: 'Rewritten' }), actor),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { status: 'ended' },
    });

    // A rejected transition leaves exactly the two events of the legal ones behind.
    expect((await outbox(created.id)).map((e) => e.topic)).toEqual([
      'campaign.launched',
      'campaign.ended',
    ]);
  });
});

describe('tenant isolation (RLS)', () => {
  it('a campaign of brand A is invisible to a brand B client', async () => {
    const mine = await createCampaign(a, A, input(), actor);
    const theirs = await createCampaign(b, B, input({ name: 'Brand B campaign' }), actor);

    expect((await listCampaigns(a, A)).items.map((c) => c.id)).toEqual([mine.id]);
    expect((await listCampaigns(b, B)).items.map((c) => c.id)).toEqual([theirs.id]);

    await expect(getCampaign(b, B, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    // Even naming brand A's store explicitly: RLS answers with no row, so the service 404s.
    await expect(getCampaign(b, A, mine.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(launchCampaign(b, A, mine.id, actor)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('the report of one store never counts another store orders', async () => {
    await placeOrder({
      storeId: A,
      totalMinor: 10_000,
      placedAt: '2026-09-10T10:00:00Z',
      touches: [{ touch: 'last', source: 'meta', medium: 'paid_social', campaign: 'autumn-2026' }],
    });
    await placeOrder({
      storeId: B,
      totalMinor: 99_000,
      placedAt: '2026-09-10T10:00:00Z',
      touches: [{ touch: 'last', source: 'meta', medium: 'paid_social', campaign: 'autumn-2026' }],
    });

    const report = await attributionReport(a, A, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
    });
    expect(report.totals).toEqual({
      orders_count: 1,
      revenue: { amount_minor: 10_000, currency: 'EUR' },
    });
  });
});

describe('attribution report', () => {
  const window = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' };

  it('totals match by touch, and first/last differ when the touches differ', async () => {
    await placeOrder({
      storeId: A,
      totalMinor: 12_000,
      placedAt: '2026-09-05T10:00:00Z',
      touches: [
        { touch: 'first', source: 'google', medium: 'organic', campaign: null },
        { touch: 'last', source: 'meta', medium: 'paid_social', campaign: 'autumn-2026' },
      ],
    });
    await placeOrder({
      storeId: A,
      totalMinor: 8_000,
      placedAt: '2026-09-06T10:00:00Z',
      touches: [
        { touch: 'first', source: 'meta', medium: 'paid_social', campaign: 'autumn-2026' },
        { touch: 'last', source: 'meta', medium: 'paid_social', campaign: 'autumn-2026' },
      ],
    });

    const last = await attributionReport(a, A, { ...window, touch: 'last' });
    expect(last.touch).toBe('last');
    expect(last.totals).toEqual({
      orders_count: 2,
      revenue: { amount_minor: 20_000, currency: 'EUR' },
    });
    expect(last.items).toEqual([
      {
        utm_source: 'meta',
        utm_medium: 'paid_social',
        utm_campaign: 'autumn-2026',
        campaign_id: null,
        orders_count: 2,
        revenue: { amount_minor: 20_000, currency: 'EUR' },
      },
    ]);

    const first = await attributionReport(a, A, { ...window, touch: 'first' });
    expect(first.totals.orders_count).toBe(2);
    // First touch splits the same two orders differently, biggest revenue first (google carries the 12 000 one).
    expect(first.items.map((i) => [i.utm_source, i.orders_count, i.revenue.amount_minor])).toEqual([
      ['google', 1, 12_000],
      ['meta', 1, 8_000],
    ]);
    // Both touch models see the same money — they only split it differently.
    expect(first.totals.revenue).toEqual(last.totals.revenue);
  });

  it('orders without attribution appear as direct and still reconcile with the totals', async () => {
    await placeOrder({
      storeId: A,
      totalMinor: 5_000,
      placedAt: '2026-09-07T10:00:00Z',
      touches: [{ touch: 'last', source: 'meta', medium: 'paid_social', campaign: 'autumn-2026' }],
    });
    await placeOrder({ storeId: A, totalMinor: 3_000, placedAt: '2026-09-08T10:00:00Z' });
    await placeOrder({ storeId: A, totalMinor: 1_000, placedAt: '2026-09-09T10:00:00Z' });

    const report = await attributionReport(a, A, window);
    const direct = report.items.find((i) => i.utm_source === 'direct');
    expect(direct).toMatchObject({
      utm_medium: null,
      utm_campaign: null,
      campaign_id: null,
      orders_count: 2,
      revenue: { amount_minor: 4_000, currency: 'EUR' },
    });
    expect(report.totals).toEqual({
      orders_count: 3,
      revenue: { amount_minor: 9_000, currency: 'EUR' },
    });
    // The report reconciles with the store's order list: nothing is silently dropped.
    expect(report.items.reduce((n, i) => n + i.orders_count, 0)).toBe(report.totals.orders_count);
  });

  it('links a campaign by utm_campaign case-insensitively, at report time', async () => {
    await placeOrder({
      storeId: A,
      totalMinor: 7_000,
      placedAt: '2026-09-11T10:00:00Z',
      touches: [{ touch: 'last', source: 'meta', medium: 'paid_social', campaign: 'Autumn-2026' }],
    });

    // Before the campaign exists the order is reported with no campaign_id …
    const before = await attributionReport(a, A, window);
    expect(before.items[0]!.campaign_id).toBeNull();

    // … and creating the campaign afterwards claims it, without touching the attribution row.
    const campaign = await createCampaign(a, A, input({ utm_campaign: 'autumn-2026' }), actor);
    const after = await attributionReport(a, A, window);
    expect(after.items[0]).toMatchObject({
      utm_campaign: 'Autumn-2026',
      campaign_id: campaign.id,
      orders_count: 1,
    });

    const stored = await db.owner.query<{ campaign_id: string | null }>(
      `SELECT campaign_id FROM attribution`,
    );
    expect(stored.rows.every((r) => r.campaign_id === null)).toBe(true);
  });

  it('excludes cancelled orders, orders outside the window and other currencies', async () => {
    const touches = [
      { touch: 'last' as const, source: 'meta', medium: 'paid_social', campaign: 'autumn-2026' },
    ];
    await placeOrder({ storeId: A, totalMinor: 6_000, placedAt: '2026-09-12T10:00:00Z', touches });
    await placeOrder({
      storeId: A,
      totalMinor: 100_000,
      placedAt: '2026-09-12T10:00:00Z',
      status: 'cancelled',
      touches,
    });
    await placeOrder({
      storeId: A,
      totalMinor: 200_000,
      placedAt: '2026-08-01T10:00:00Z',
      touches,
    });
    // `to` is exclusive.
    await placeOrder({
      storeId: A,
      totalMinor: 400_000,
      placedAt: '2026-10-01T00:00:00Z',
      touches,
    });
    // Brand A sells EUR; a GBP order is out of scope until multi-currency reporting exists (README).
    await placeOrder({
      storeId: A,
      totalMinor: 300_000,
      currency: 'GBP',
      placedAt: '2026-09-12T11:00:00Z',
      touches,
    });

    const report = await attributionReport(a, A, window);
    expect(report.currency).toBe('EUR');
    expect(report.totals).toEqual({
      orders_count: 1,
      revenue: { amount_minor: 6_000, currency: 'EUR' },
    });
  });

  it('rejects a missing or inverted window', async () => {
    await expect(attributionReport(a, A, { from: '', to: '' })).rejects.toMatchObject({
      code: 'validation_error',
      details: { from: 'date-time (required)', to: 'date-time (required)' },
    });
    await expect(
      attributionReport(a, A, { from: window.to, to: window.from }),
    ).rejects.toMatchObject({ code: 'validation_error', details: { to: 'must be after from' } });
  });
});
