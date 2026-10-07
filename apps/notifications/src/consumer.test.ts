// The consumer against a seeded throwaway database (#360): exactly once, retries, stuck rows, isolation, auth,
// and a PII sweep over every log line the whole file produced.
//
// Schema: `notification_delivery` is the PROPOSED migration in ../migrations, applied here on top of the real
// migrations; `marketing_cursor` is 0170 (#244). The outbox rows are built with packages/events' own
// `makeEvent`/`toOutboxRow` and validated against the `order.placed` / `shipment.shipped` schemas, so a payload
// change upstream fails this file rather than the worker in production.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createOrganizationClient, SEED_IDS, seed, type ScopedClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { createValidator, makeEvent, toOutboxRow, type EventEnvelope } from '@platform/events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, createStaffAuth } from './auth.js';
import { brandProfile } from './brands.js';
import {
  claimEvents,
  CURSOR_NAME,
  deliverPending,
  resolveStores,
  runOnce,
  type ConsumerDeps,
  type StoreTarget,
} from './consumer.js';
import {
  TransportError,
  type DeliveryMeta,
  type Logger,
  type RenderedEmail,
  type SendResult,
  type Transport,
} from './types.js';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const B = SEED_IDS.stores.brandB;
const EMAIL = 'ada@example.test';
const NBSP = new RegExp(String.fromCharCode(0xa0), 'g');
const plain = (s: string): string => s.replace(NBSP, ' ');

class RecordingTransport implements Transport {
  readonly name = 'record';
  sent: { email: RenderedEmail; meta: DeliveryMeta }[] = [];
  calls = 0;
  /** The first N calls throw, as a provider outage would. */
  failUntil = 0;
  async send(email: RenderedEmail, meta: DeliveryMeta): Promise<SendResult> {
    this.calls += 1;
    if (this.calls <= this.failUntil)
      throw new TransportError('resend: HTTP 500 internal_error', true);
    this.sent.push({ email, meta });
    return { providerMessageId: `rec:${this.calls}` };
  }
}

/** Every line any test logged, swept for PII at the end. */
const LOG_LINES: string[] = [];
const log: Logger = {
  info: (m) => LOG_LINES.push(`info ${m}`),
  warn: (m) => LOG_LINES.push(`warn ${m}`),
  error: (m) => LOG_LINES.push(`error ${m}`),
};

let db: TestDatabase;
let hq: ScopedClient;
let stores: StoreTarget[];
let transport: RecordingTransport;
const validator = createValidator();

function deps(extra: Partial<ConsumerDeps> = {}): ConsumerDeps {
  return {
    client: hq,
    transport,
    brands: (code) => brandProfile(code, {}),
    log,
    // No lookback by default so `scanned` counts are exact; the lookback has its own test below.
    lookback: 0,
    ...extra,
  };
}

interface Placed {
  orderId: string;
  lineIds: string[];
  salesChannelId: string;
}

/** An order with two line items, the way checkout leaves it; totals match templates/fixtures.ts. */
async function placeOrder(
  opts: { storeId?: string; locale?: string; displayId?: number; email?: string } = {},
): Promise<Placed> {
  const storeId = opts.storeId ?? A;
  const channel = await db.owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
    [storeId],
  );
  const salesChannelId = channel.rows[0]!.id;
  const address = JSON.stringify({
    first_name: 'Ada',
    last_name: 'Tester',
    line1: 'Keizersgracht 1',
    city: 'Amsterdam',
    postal_code: '1015 AA',
    country: 'NL',
  });
  const order = await db.owner.query<{ id: string }>(
    `INSERT INTO "order" (organization_id, store_id, display_id, sales_channel_id, email, currency, locale, status,
                          shipping_address, billing_address, shipping_method, promotion_codes,
                          subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor, placed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, $8, $9, $10, 10999, 1000, 495, 1821, 10494,
             '2026-10-07T09:30:00Z')
     RETURNING id`,
    [
      ORG,
      storeId,
      opts.displayId ?? 1001,
      salesChannelId,
      opts.email ?? EMAIL,
      storeId === A ? 'EUR' : 'GBP',
      opts.locale ?? 'en-GB',
      address,
      JSON.stringify({ code: 'standard', name: 'Standard', carrier: 'PostNL', price_minor: 495 }),
      ['WELCOME10'],
    ],
  );
  const orderId = order.rows[0]!.id;
  const lines = await db.owner.query<{ id: string }>(
    `INSERT INTO order_line_item (organization_id, store_id, order_id, sku, title, variant_title, quantity,
                                  unit_price_minor, discount_minor, tax_rate_bp, tax_minor, total_minor)
     VALUES ($1, $2, $3, 'HOOD-NVY-M', 'Everyday Hoodie', 'Navy / M', 2, 4500, 0, 2100, 1562, 9000),
            ($1, $2, $3, 'CAP-BLK', 'Classic Cap', 'Classic Cap', 1, 1999, 0, 2100, 347, 1999)
     RETURNING id`,
    [ORG, storeId, orderId],
  );
  return { orderId, lineIds: lines.rows.map((r) => r.id), salesChannelId };
}

async function insertOutbox(e: EventEnvelope): Promise<string> {
  const v = validator.validateEnvelope(e);
  if (!v.ok) throw new Error(`fixture event invalid: ${JSON.stringify(v.errors)}`);
  const row = toOutboxRow(e);
  await db.owner.query(
    `INSERT INTO outbox (id, organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload, headers, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.id,
      row.organization_id,
      row.store_id,
      row.topic,
      row.version,
      row.aggregate_type,
      row.aggregate_id,
      JSON.stringify(row.payload),
      JSON.stringify(row.headers),
      row.occurred_at,
    ],
  );
  return row.id;
}

/** A real `order.placed` v1 for the order, as checkout would emit it (email hashed, never in the payload). */
async function emitOrderPlaced(
  placed: Placed,
  storeId: string = A,
  email = EMAIL,
): Promise<string> {
  const legalEntityId =
    storeId === A ? SEED_IDS.legalEntities.brandA : SEED_IDS.legalEntities.brandB;
  return insertOutbox(
    makeEvent({
      topic: 'order.placed',
      organizationId: ORG,
      storeId,
      aggregateType: 'order',
      aggregateId: placed.orderId,
      payload: {
        order_id: placed.orderId,
        display_id: 1001,
        legal_entity_id: legalEntityId,
        sales_channel_id: placed.salesChannelId,
        customer_id: null,
        email_hash: createHash('sha256').update(email.toLowerCase()).digest('hex'),
        currency: storeId === A ? 'EUR' : 'GBP',
        locale: 'en-GB',
        totals: {
          subtotal_minor: 10999,
          discount_minor: 1000,
          shipping_minor: 495,
          tax_minor: 1821,
          total_minor: 10494,
        },
        line_items: [
          {
            order_line_item_id: placed.lineIds[0]!,
            variant_id: null,
            sku: 'HOOD-NVY-M',
            title: 'Everyday Hoodie',
            quantity: 2,
            unit_price_minor: 4500,
            discount_minor: 0,
            tax_rate_bp: 2100,
            tax_minor: 1562,
            total_minor: 9000,
          },
          {
            order_line_item_id: placed.lineIds[1]!,
            variant_id: null,
            sku: 'CAP-BLK',
            title: 'Classic Cap',
            quantity: 1,
            unit_price_minor: 1999,
            discount_minor: 0,
            tax_rate_bp: 2100,
            tax_minor: 347,
            total_minor: 1999,
          },
        ],
        shipping: { code: 'standard', name: 'Standard', carrier: 'PostNL', price_minor: 495 },
        shipping_country: 'NL',
        billing_country: 'NL',
        promotion_codes: ['WELCOME10'],
        placed_at: '2026-10-07T09:30:00.000Z',
      },
    }),
  );
}

async function ship(placed: Placed): Promise<{ shipmentId: string; eventId: string }> {
  const sh = await db.owner.query<{ id: string }>(
    `INSERT INTO shipment (organization_id, store_id, order_id, warehouse_id, carrier, service, tracking_number,
                           tracking_url, currency, status, shipped_at)
     VALUES ($1, $2, $3, $4, 'PostNL', 'Standard', '3SABCD123456789', 'https://tracking.example/3SABCD123456789',
             'EUR', 'shipped', '2026-10-08T14:05:00Z')
     RETURNING id`,
    [ORG, A, placed.orderId, SEED_IDS.warehouses.eu],
  );
  const shipmentId = sh.rows[0]!.id;
  await db.owner.query(
    `INSERT INTO shipment_item (organization_id, store_id, shipment_id, order_line_item_id, quantity)
     VALUES ($1, $2, $3, $4, 2), ($1, $2, $3, $5, 1)`,
    [ORG, A, shipmentId, placed.lineIds[0], placed.lineIds[1]],
  );
  const eventId = await insertOutbox(
    makeEvent({
      topic: 'shipment.shipped',
      organizationId: ORG,
      storeId: A,
      aggregateType: 'shipment',
      aggregateId: shipmentId,
      payload: {
        shipment_id: shipmentId,
        order_id: placed.orderId,
        legal_entity_id: SEED_IDS.legalEntities.brandA,
        warehouse_id: SEED_IDS.warehouses.eu,
        carrier: 'PostNL',
        service: 'Standard',
        tracking_number: '3SABCD123456789',
        cost_minor: 395,
        currency: 'EUR',
        items: [
          { order_line_item_id: placed.lineIds[0]!, quantity: 2 },
          { order_line_item_id: placed.lineIds[1]!, quantity: 1 },
        ],
        shipped_at: '2026-10-08T14:05:00.000Z',
      },
    }),
  );
  return { shipmentId, eventId };
}

interface DeliveryRow {
  event_id: string;
  kind: string;
  status: string;
  attempts: number;
  attempted_at: Date | null;
  sent_at: Date | null;
  provider: string | null;
  provider_message_id: string | null;
  locale: string | null;
  last_error: string | null;
}

async function deliveries(): Promise<DeliveryRow[]> {
  const r = await db.owner.query<DeliveryRow>(
    `SELECT event_id, kind, status, attempts, attempted_at, sent_at, provider, provider_message_id, locale, last_error
       FROM notification_delivery ORDER BY event_seq`,
  );
  return r.rows;
}

beforeAll(async () => {
  db = await createTestDatabase('platform_notif');
  await db.owner.query(
    readFileSync(new URL('../migrations/0180_notification_delivery.sql', import.meta.url), 'utf8'),
  );
  await seed(db.owner);
  hq = createOrganizationClient(db.app, { organizationId: ORG, actorId: null });
  stores = await resolveStores(hq, ['brand-a']);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  transport = new RecordingTransport();
  await db.owner.query(
    `DELETE FROM notification_delivery; DELETE FROM marketing_cursor; DELETE FROM outbox;
     DELETE FROM shipment_item; DELETE FROM shipment; DELETE FROM order_line_item; DELETE FROM "order"`,
  );
});

describe('resolveStores', () => {
  it('resolves the served stores with their legal entity and refuses a typo', async () => {
    expect(stores).toEqual([
      {
        id: A,
        code: 'brand-a',
        defaultLocale: 'en-GB',
        timeZone: 'Europe/Amsterdam',
        legal: { name: 'Brand A B.V.', vatNumber: 'NL000000000B01' },
      },
    ]);
    await expect(resolveStores(hq, ['brand-a', 'brand-x'])).rejects.toThrow(
      /unknown store code "brand-x"/,
    );
  });
});

describe('order.placed → order confirmation', () => {
  it('sends exactly one email per event, rendered from the order row in the order locale', async () => {
    const placed = await placeOrder({ locale: 'de-DE', displayId: 1001 });
    const eventId = await emitOrderPlaced(placed);

    const report = await runOnce(deps(), stores);
    expect(report.stores).toEqual([
      expect.objectContaining({
        storeCode: 'brand-a',
        scanned: 1,
        claimed: 1,
        sent: 1,
        failed: 0,
        skipped: 0,
        stuck: 0,
      }),
    ]);
    expect(transport.sent).toHaveLength(1);
    const { email, meta } = transport.sent[0]!;
    expect(meta).toEqual({
      eventId,
      kind: 'order_confirmation',
      storeCode: 'brand-a',
      locale: 'de-DE',
      displayId: 1001,
    });
    expect(email.to).toBe(EMAIL);
    expect(email.from).toEqual({ name: 'Brand A', email: 'orders@brand-a.example' });
    expect(email.subject).toBe('Ihre Bestellung #1001 bei Brand A ist bestätigt');
    expect(plain(email.text)).toContain('Gesamtbetrag: 104,94 €');
    expect(plain(email.text)).toContain('Versand (Standard): 4,95 €');
    expect(email.text).toContain('2 × Everyday Hoodie (Navy / M)');
    expect(email.text).toContain('Brand A B.V.');
    expect(email.text).toContain('USt-IdNr. NL000000000B01');
    expect(email.html).toContain('Keizersgracht 1');

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_id: eventId,
      kind: 'order_confirmation',
      status: 'sent',
      attempts: 1,
      provider: 'record',
      provider_message_id: 'rec:1',
      locale: 'de-DE',
      last_error: null,
    });
    expect(rows[0]!.sent_at).not.toBeNull();
    const cursor = await db.owner.query<{ seq: string }>(
      `SELECT seq::text AS seq FROM marketing_cursor WHERE store_id = $1 AND name = $2`,
      [A, CURSOR_NAME],
    );
    expect(Number(cursor.rows[0]!.seq)).toBe(report.stores[0]!.cursor);
  });

  it('a second run sends nothing, and a replayed event (cursor reset) sends nothing', async () => {
    const placed = await placeOrder();
    await emitOrderPlaced(placed);
    await runOnce(deps(), stores);
    expect(transport.sent).toHaveLength(1);

    const again = await runOnce(deps(), stores);
    expect(again.stores[0]).toMatchObject({ scanned: 0, claimed: 0, sent: 0 });

    // The event is delivered a second time: the cursor is reset to before it.
    await db.owner.query(`UPDATE marketing_cursor SET seq = 0 WHERE store_id = $1`, [A]);
    const replay = await runOnce(deps(), stores);
    expect(replay.stores[0]).toMatchObject({ scanned: 1, claimed: 0, sent: 0, failed: 0 });
    expect(transport.sent).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  it('falls back to the brand default when the order locale has no template', async () => {
    const placed = await placeOrder({ locale: 'fr-FR' });
    await emitOrderPlaced(placed);
    await runOnce(deps(), stores);
    expect(transport.sent[0]!.meta.locale).toBe('en-GB');
    expect(transport.sent[0]!.email.subject).toBe('Your Brand A order #1001 is confirmed');
  });

  it('skips an event whose order no longer exists', async () => {
    const placed = await placeOrder();
    const eventId = await emitOrderPlaced(placed);
    await db.owner.query(`DELETE FROM order_line_item; DELETE FROM "order"`);
    const report = await runOnce(deps(), stores);
    expect(report.stores[0]).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(await deliveries()).toEqual([
      expect.objectContaining({
        event_id: eventId,
        status: 'skipped',
        last_error: 'source_not_found',
      }),
    ]);
  });
});

describe('shipment.shipped → shipping notice', () => {
  it('sends the tracking details from the shipment row', async () => {
    const placed = await placeOrder();
    const { eventId } = await ship(placed);
    const report = await runOnce(deps(), stores);
    expect(report.stores[0]).toMatchObject({ claimed: 1, sent: 1 });
    const { email, meta } = transport.sent[0]!;
    expect(meta).toMatchObject({
      eventId,
      kind: 'shipment_shipped',
      locale: 'en-GB',
      displayId: 1001,
    });
    expect(email.to).toBe(EMAIL);
    expect(email.subject).toBe('Your Brand A order #1001 is on its way');
    expect(email.text).toContain('Carrier: PostNL (Standard)');
    expect(email.text).toContain('Tracking number: 3SABCD123456789');
    expect(email.text).toContain('2 × Everyday Hoodie (Navy / M)');
    expect(email.html).toContain('href="https://tracking.example/3SABCD123456789"');
  });

  it('both events of one order are two deliveries, each exactly once', async () => {
    const placed = await placeOrder();
    await emitOrderPlaced(placed);
    await ship(placed);
    const report = await runOnce(deps(), stores);
    expect(report.stores[0]).toMatchObject({ scanned: 2, claimed: 2, sent: 2 });
    expect(transport.sent.map((s) => s.meta.kind)).toEqual([
      'order_confirmation',
      'shipment_shipped',
    ]);
    expect((await runOnce(deps(), stores)).stores[0]).toMatchObject({ claimed: 0, sent: 0 });
  });
});

describe('failures', () => {
  it('retries a refused send on later runs and records why', async () => {
    const placed = await placeOrder();
    await emitOrderPlaced(placed);
    transport.failUntil = 2;

    const r1 = await runOnce(deps({ maxAttempts: 3 }), stores);
    expect(r1.stores[0]).toMatchObject({ claimed: 1, sent: 0, failed: 1, exhausted: 0 });
    expect((await deliveries())[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'resend: HTTP 500 internal_error',
    });

    const r2 = await runOnce(deps({ maxAttempts: 3 }), stores);
    expect(r2.stores[0]).toMatchObject({ claimed: 0, failed: 1 });
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 2 });

    const r3 = await runOnce(deps({ maxAttempts: 3 }), stores);
    expect(r3.stores[0]).toMatchObject({ sent: 1, failed: 0 });
    expect((await deliveries())[0]).toMatchObject({
      status: 'sent',
      attempts: 3,
      last_error: null,
    });
    expect(transport.sent).toHaveLength(1);
  });

  it('gives up at the attempt limit and reports the exhausted row', async () => {
    const placed = await placeOrder();
    await emitOrderPlaced(placed);
    transport.failUntil = 100;

    await runOnce(deps({ maxAttempts: 2 }), stores);
    const r2 = await runOnce(deps({ maxAttempts: 2 }), stores);
    expect(r2.stores[0]).toMatchObject({ failed: 1, exhausted: 1 });
    const r3 = await runOnce(deps({ maxAttempts: 2 }), stores);
    expect(r3.stores[0]).toMatchObject({ failed: 0, exhausted: 1 });
    expect(transport.calls).toBe(2);
    expect((await deliveries())[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('never resends a row that was attempted with no recorded outcome (a crash mid-send)', async () => {
    const placed = await placeOrder();
    await emitOrderPlaced(placed);
    const claim = await claimEvents(hq, stores[0]!, { lookback: 0 });
    expect(claim.claimed).toBe(1);
    // What the table looks like when the process died between the stamp and the mark.
    await db.owner.query(
      `UPDATE notification_delivery SET attempts = 1, attempted_at = now(), locale = 'en-GB'`,
    );

    const report = await deliverPending(deps(), stores[0]!);
    expect(report).toMatchObject({ sent: 0, failed: 0, stuck: 1 });
    expect(transport.calls).toBe(0);
    expect((await deliveries())[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(LOG_LINES.some((l) => l.startsWith('warn') && l.includes('stuck=1'))).toBe(true);
  });
});

describe('scope', () => {
  it('leaves other stores and other topics alone', async () => {
    const other = await placeOrder({ storeId: B, email: 'bob@example.test' });
    await emitOrderPlaced(other, B, 'bob@example.test');
    // an event of a topic the worker does not consume, on the served store (shape irrelevant here)
    const placed = await placeOrder();
    await db.owner.query(
      `INSERT INTO outbox (organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, 'order.cancelled', 1, 'order', $3, '{}')`,
      [ORG, A, placed.orderId],
    );
    const report = await runOnce(deps(), stores);
    expect(report.stores[0]).toMatchObject({ scanned: 0, claimed: 0, sent: 0 });
    expect(await deliveries()).toHaveLength(0);
    const cursors = await db.owner.query(`SELECT store_id FROM marketing_cursor`);
    expect(cursors.rows).toHaveLength(0);
  });

  it('re-reads a window below the cursor, so a row that committed late is not skipped', async () => {
    const placed = await placeOrder();
    await emitOrderPlaced(placed);
    const first = await claimEvents(hq, stores[0]!, { lookback: 0 });
    expect(first).toMatchObject({ scanned: 1, claimed: 1 });

    // A producer whose transaction committed after the cursor had moved past its seq.
    const late = await placeOrder({ displayId: 1002 });
    await emitOrderPlaced(late);
    await db.owner.query(`UPDATE marketing_cursor SET seq = seq + 10 WHERE store_id = $1`, [A]);
    expect(await claimEvents(hq, stores[0]!, { lookback: 0 })).toMatchObject({
      scanned: 0,
      claimed: 0,
    });
    const caught = await claimEvents(hq, stores[0]!, { lookback: 50 });
    expect(caught).toMatchObject({ scanned: 2, claimed: 1, cursor: first.cursor + 10 });

    // ... and the window is free of duplicates: the next run claims nothing new.
    expect(await claimEvents(hq, stores[0]!, { lookback: 50 })).toMatchObject({
      scanned: 2,
      claimed: 0,
    });
    const report = await deliverPending(deps(), stores[0]!);
    expect(report).toMatchObject({ sent: 2 });
  });
});

describe('staff auth (dev tokens)', () => {
  it('accepts an active seeded staff user and nobody else', async () => {
    const auth = createStaffAuth({ client: hq, devTokens: true, env: {} });
    expect(await auth.authenticate('Bearer dev:seed-store-admin')).toEqual({
      subject: 'seed-store-admin',
    });
    await expect(auth.authenticate('Bearer dev:nobody')).rejects.toMatchObject({
      status: 401,
      message: /unknown or disabled/,
    });
    await expect(auth.authenticate(undefined)).rejects.toBeInstanceOf(AuthError);
    await expect(auth.authenticate('Bearer dev:')).rejects.toMatchObject({ status: 401 });

    const off = createStaffAuth({ client: hq, devTokens: false, env: {} });
    await expect(off.authenticate('Bearer dev:seed-store-admin')).rejects.toMatchObject({
      message: /not enabled/,
    });
    const prod = createStaffAuth({ client: hq, devTokens: true, env: { NODE_ENV: 'production' } });
    await expect(prod.authenticate('Bearer dev:seed-store-admin')).rejects.toMatchObject({
      message: /never accepted in production/,
    });
  });

  it('routes a non-dev token through the verifier', async () => {
    const auth = createStaffAuth({
      client: hq,
      devTokens: false,
      env: {},
      verifier: { verify: async (t) => ({ subject: t === 'jwt-ok' ? 'seed-owner' : 'ghost' }) },
    });
    expect(await auth.authenticate('Bearer jwt-ok')).toEqual({ subject: 'seed-owner' });
    await expect(auth.authenticate('Bearer jwt-other')).rejects.toMatchObject({ status: 401 });
  });
});

describe('PII sweep', () => {
  it('no log line of this whole file carries an address, a name or an address line', () => {
    expect(LOG_LINES.length).toBeGreaterThan(5);
    expect(LOG_LINES.some((l) => l.includes('sent kind=order_confirmation'))).toBe(true);
    const forbidden = [EMAIL, 'bob@example.test', 'Ada', 'Tester', 'Keizersgracht', '@'];
    for (const line of LOG_LINES) {
      for (const needle of forbidden) expect(line, line).not.toContain(needle);
    }
  });
});
