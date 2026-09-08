// Attribution at placement (Integration 1): cart.metadata.attribution → order.metadata + attribution rows +
// attribution.recorded events, all on one transaction. Window 1's checkout task (2.2) calls `recordAttribution`.
import { createOrganizationClient, createTenantClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orderMetadataFromCart,
  parseCartAttribution,
  recordAttribution,
  referrerOrigin,
} from '../src/lib/attribution';
import { createStore } from '../src/modules/registry';

const ORG = '31000000-0000-4000-8000-000000000001';
const LE = '31000000-0000-4000-8000-000000000011';

const cartMetadata = {
  attribution: {
    first: {
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'Spring',
      utm_term: null,
      utm_content: null,
      ref: 'FRIEND1',
      referrer: 'https://www.google.com/search?q=secret+person',
      landing_path: '/collections/new',
      at: '2026-09-01T10:00:00.000Z',
    },
    last: {
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'spring',
      utm_term: null,
      utm_content: 'hero',
      ref: null,
      referrer: null,
      landing_path: '/',
      at: '2026-09-07T09:30:00.000Z',
    },
    captured_at: '2026-09-07T09:30:00.000Z',
  },
  note: 'gift',
};

describe('parseCartAttribution (pure)', () => {
  it('reads both touches, trims, caps, and reduces the referrer to its origin', () => {
    const p = parseCartAttribution({
      attribution: {
        first: { utm_source: '  x'.padEnd(300, 'y'), referrer: 'https://a.example/path?q=1' },
      },
    });
    expect(p.first?.utm_source?.length).toBe(200);
    expect(p.first?.referrer).toBe('https://a.example');
    expect(p.last).toBeNull();
  });
  it('yields no touches for missing, malformed or empty blocks', () => {
    expect(parseCartAttribution(undefined)).toEqual({ first: null, last: null });
    expect(parseCartAttribution({ attribution: 'x' })).toEqual({ first: null, last: null });
    expect(
      parseCartAttribution({ attribution: { first: {}, last: { utm_source: '  ' } } }),
    ).toEqual({
      first: null,
      last: null,
    });
  });
  it('referrerOrigin drops non-http and unparsable values', () => {
    expect(referrerOrigin('javascript:alert(1)')).toBeNull();
    expect(referrerOrigin('not a url')).toBeNull();
    expect(referrerOrigin('http://Example.COM:8080/x')).toBe('http://example.com:8080');
  });
  it('orderMetadataFromCart is a plain copy', () => {
    const copy = orderMetadataFromCart(cartMetadata);
    expect(copy).toEqual(cartMetadata);
    expect(copy).not.toBe(cartMetadata);
    expect(orderMetadataFromCart(null)).toEqual({});
  });
});

describe('recordAttribution (database)', () => {
  let db: TestDatabase;
  let storeId: string;
  let channelId: string;
  let store: ReturnType<typeof createTenantClient>;

  beforeAll(async () => {
    db = await createTestDatabase('core_attribution');
    const owner = createOrganizationClient(db.owner, { organizationId: ORG });
    await owner.transaction(async (tx) => {
      await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq', 'HQ')`, [ORG]);
      await tx.query(
        `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le', 'LE', 'NL', 'EUR')`,
        [LE, ORG],
      );
    });
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const created = await createStore(hq, {
      legal_entity_id: LE,
      code: 'brand-x',
      name: 'Brand X',
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
    });
    storeId = created.id;
    store = createTenantClient(db.app, { organizationId: ORG, storeIds: [storeId] });
    const ch = await store.query<{ id: string }>(
      `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, 'web', 'Web', 'web') RETURNING id`,
      [ORG, storeId],
    );
    channelId = ch.rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  async function placeOrder(metadata: unknown, displayId: number) {
    return store.transaction(async (tx) => {
      const cart = await tx.query<{ id: string }>(
        `INSERT INTO cart (organization_id, store_id, sales_channel_id, currency, locale, country, metadata)
         VALUES ($1, $2, $3, 'EUR', 'en-GB', 'NL', $4) RETURNING id`,
        [ORG, storeId, channelId, JSON.stringify(metadata ?? {})],
      );
      const cartId = cart.rows[0]!.id;
      const order = await tx.query<{ id: string }>(
        `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, cart_id, email, currency, locale,
           shipping_address, billing_address, subtotal_minor, total_minor, metadata)
         VALUES ($1, $2, $3, $4, $5, 'jane@example.com', 'EUR', 'en-GB', '{}', '{}', 1000, 1000, $6) RETURNING id`,
        [
          ORG,
          storeId,
          displayId,
          channelId,
          cartId,
          JSON.stringify(orderMetadataFromCart(metadata)),
        ],
      );
      const orderId = order.rows[0]!.id;
      const rows = await recordAttribution(tx, {
        organizationId: ORG,
        storeId,
        orderId,
        cartId,
        cartMetadata: metadata,
        now: new Date('2026-09-08T12:00:00.000Z'),
      });
      return { cartId, orderId, rows };
    });
  }

  it('writes order.metadata, two attribution rows and two attribution.recorded events in one transaction', async () => {
    const { orderId, cartId, rows } = await placeOrder(cartMetadata, 1);
    expect(rows.map((r) => r.touch)).toEqual(['first', 'last']);

    const order = await store.query<{ metadata: unknown }>(
      `SELECT metadata FROM "order" WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0]!.metadata).toEqual(cartMetadata);

    const attr = await store.query<Record<string, unknown>>(
      `SELECT touch, utm_source, utm_campaign, referrer, landing_path, cart_id, campaign_id, captured_at::text AS captured_at
       FROM attribution WHERE order_id = $1 ORDER BY touch`,
      [orderId],
    );
    expect(attr.rows).toHaveLength(2);
    expect(attr.rows[0]).toMatchObject({
      touch: 'first',
      utm_source: 'google',
      utm_campaign: 'Spring',
      referrer: 'https://www.google.com', // origin only: the search query never reaches the database
      landing_path: '/collections/new',
      cart_id: cartId,
      campaign_id: null,
    });
    expect(attr.rows[1]).toMatchObject({ touch: 'last', utm_source: 'newsletter', referrer: null });

    const events = await store.query<{
      topic: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT topic, aggregate_id, payload FROM outbox WHERE topic = 'attribution.recorded' ORDER BY occurred_at, payload->>'touch'`,
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows.map((e) => e.aggregate_id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(events.rows[0]!.payload).toMatchObject({
      order_id: orderId,
      cart_id: cartId,
      touch: 'first',
      referrer: 'https://www.google.com',
      captured_at: '2026-09-01T10:00:00.000Z',
      recorded_at: '2026-09-08T12:00:00.000Z',
    });
    expect(JSON.stringify(events.rows)).not.toContain('jane@example.com');
    expect(JSON.stringify(events.rows)).not.toContain('secret');
  });

  it('a cart without attribution places fine: no rows, no events', async () => {
    const before = await store.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox`);
    const { rows } = await placeOrder({ note: 'plain' }, 2);
    expect(rows).toEqual([]);
    const after = await store.query<{ n: string }>(`SELECT count(*)::text AS n FROM outbox`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('is atomic with the placement: a failure after recording leaves no attribution rows and no events', async () => {
    const before = await store.query<{ n: string }>(`SELECT count(*)::text AS n FROM attribution`);
    await expect(
      store.transaction(async (tx) => {
        const cart = await tx.query<{ id: string }>(
          `INSERT INTO cart (organization_id, store_id, sales_channel_id, currency, locale, country, metadata)
           VALUES ($1, $2, $3, 'EUR', 'en-GB', 'NL', $4) RETURNING id`,
          [ORG, storeId, channelId, JSON.stringify(cartMetadata)],
        );
        const order = await tx.query<{ id: string }>(
          `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, cart_id, email, currency, locale,
             shipping_address, billing_address, subtotal_minor, total_minor)
           VALUES ($1, $2, 3, $3, $4, 'x@example.com', 'EUR', 'en-GB', '{}', '{}', 1, 1) RETURNING id`,
          [ORG, storeId, channelId, cart.rows[0]!.id],
        );
        await recordAttribution(tx, {
          organizationId: ORG,
          storeId,
          orderId: order.rows[0]!.id,
          cartId: cart.rows[0]!.id,
          cartMetadata,
        });
        throw new Error('payment failed');
      }),
    ).rejects.toThrow('payment failed');
    const after = await store.query<{ n: string }>(`SELECT count(*)::text AS n FROM attribution`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    const events = await store.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox WHERE topic = 'attribution.recorded'`,
    );
    expect(events.rows[0]!.n).toBe('2');
  });

  it('store B cannot see store A attribution rows', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    const other = await createStore(hq, {
      legal_entity_id: LE,
      code: 'brand-y',
      name: 'Brand Y',
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
    });
    const b = createTenantClient(db.app, { organizationId: ORG, storeIds: [other.id] });
    const seen = await b.query<{ n: string }>(`SELECT count(*)::text AS n FROM attribution`);
    expect(seen.rows[0]!.n).toBe('0');
  });
});
