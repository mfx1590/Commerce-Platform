// Marketing end to end (issue #150): one customer's attributed order travels through every Phase 2 surface of the
// module — attribution rows → the campaign's report line → a published feed → a materialised segment and its
// window 16 sync payload — against one real database, in the order a store would actually meet them.
//
// The same run is the PII sweep (#150 acceptance): every outbox payload and audit row the flow wrote, and every
// console call it made, is searched for the customer's email, name, address and phone. Marketing events and logs
// carry ids, amounts and utm strings; the only customer-derived value that ever leaves is `email_hash`.
import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantClient, SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  attributionReport,
  createCampaign,
  createFeed,
  createSegment,
  emailHash,
  endCampaign,
  FilesystemFeedStorage,
  launchCampaign,
  materializeSegment,
  previewSegment,
  publishFeed,
  resetFeedStorage,
  segmentSyncPayload,
  setFeedStorage,
} from './index';

const ORG = SEED_IDS.organization;
const A = SEED_IDS.stores.brandA;
const REQUEST_ID = 'req-marketing-endtoend';
const actor = { id: SEED_IDS.users.storeAdmin, type: 'staff' as const, requestId: REQUEST_ID };

/** Everything that identifies the customer. None of it may appear in an event, an audit row or a log line. */
const PERSON = {
  email: 'ada.lovelace@example.test',
  firstName: 'Augusta',
  lastName: 'Lovelace',
  line1: 'Analytical Engine Lane',
  city: 'Marylebone',
  phone: '+44 20 7946 0000',
};
const PII_VALUES = Object.values(PERSON);
/** Keys that would carry PII under any value. `email_hash` is the documented exception and is not matched. */
const PII_KEYS =
  /"(email|first_name|last_name|phone|line1|line2|city|postal_code|shipping_address|billing_address)"\s*:/;

let db: TestDatabase;
let a: ReturnType<typeof createTenantClient>;
let dir: string;
let outboxFloor: number;
const consoleCalls: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase('core_marketing_endtoend');
  await seed(db.owner, { productsPerStore: 4, log: () => {} });
  a = createTenantClient(db.app, { organizationId: ORG, storeIds: [A], actorId: actor.id });
  dir = await mkdtemp(join(tmpdir(), 'marketing-endtoend-'));
  setFeedStorage(new FilesystemFeedStorage({ dir, baseUrl: 'https://feeds.example/feeds' }));
  const floor = await db.owner.query<{ seq: string | null }>(
    `SELECT max(seq)::text AS seq FROM outbox`,
  );
  outboxFloor = Number(floor.rows[0]?.seq ?? 0);
  // Record every console call the flow makes; the sweep below reads them.
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    });
  }
}, 180_000);

afterAll(async () => {
  vi.restoreAllMocks();
  resetFeedStorage();
  await rm(dir, { recursive: true, force: true });
  await db?.drop();
});

/** The customer and one order placed on the campaign's link, shaped as window 1's placement leaves them. */
async function customerWithAttributedOrder(utmCampaign: string): Promise<string> {
  const customer = await db.owner.query<{ id: string }>(
    `INSERT INTO customer (organization_id, store_id, email, first_name, last_name, phone, status, consent)
     VALUES ($1, $2, $3, $4, $5, $6, 'registered', $7)
     RETURNING id`,
    [
      ORG,
      A,
      PERSON.email,
      PERSON.firstName,
      PERSON.lastName,
      PERSON.phone,
      JSON.stringify({ marketing_email: { granted: true } }),
    ],
  );
  const customerId = customer.rows[0]!.id;
  const address = JSON.stringify({
    first_name: PERSON.firstName,
    last_name: PERSON.lastName,
    line1: PERSON.line1,
    city: PERSON.city,
    postal_code: 'NW1 6XE',
    country: 'GB',
    phone: PERSON.phone,
  });
  const channel = await db.owner.query<{ id: string }>(
    `SELECT id FROM sales_channel WHERE store_id = $1 ORDER BY created_at LIMIT 1`,
    [A],
  );
  const order = await db.owner.query<{ id: string }>(
    `INSERT INTO "order" (organization_id, store_id, sales_channel_id, customer_id, email, currency, locale, status,
                          shipping_address, billing_address, subtotal_minor, total_minor, placed_at)
     VALUES ($1, $2, $3, $4, $5, 'EUR', 'en-GB', 'confirmed', $6, $6, 12500, 12500, '2026-09-15T10:00:00Z')
     RETURNING id`,
    [ORG, A, channel.rows[0]!.id, customerId, PERSON.email, address],
  );
  for (const touch of ['first', 'last'] as const) {
    await db.owner.query(
      `INSERT INTO attribution (organization_id, store_id, order_id, touch, utm_source, utm_medium, utm_campaign,
                                captured_at)
       VALUES ($1, $2, $3, $4, 'newsletter', 'email', $5, '2026-09-15T10:00:00Z')`,
      [ORG, A, order.rows[0]!.id, touch, utmCampaign],
    );
  }
  return customerId;
}

describe('marketing, end to end', () => {
  let customerId: string;
  let campaignId: string;

  it('attribution rows → the campaign claims the order in its report', async () => {
    const campaign = await createCampaign(
      a,
      A,
      {
        name: 'Engine week',
        type: 'email',
        utm_source: 'newsletter',
        utm_medium: 'email',
        utm_campaign: 'engine-week',
      },
      actor,
    );
    campaignId = campaign.id;
    await launchCampaign(a, A, campaignId, actor);
    // Upper-case on the link: linking is case-insensitive and happens at report time, not at placement.
    customerId = await customerWithAttributedOrder('Engine-Week');

    const report = await attributionReport(a, A, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00Z',
      touch: 'last',
    });
    expect(report.items).toEqual([
      expect.objectContaining({
        utm_source: 'newsletter',
        campaign_id: campaignId,
        orders_count: 1,
        revenue: { amount_minor: 12_500, currency: 'EUR' },
      }),
    ]);
    expect(report.totals.orders_count).toBe(1);
    await endCampaign(a, A, campaignId, actor);
  });

  it('feed publish → a stored, served-ready artifact and one feed.published', async () => {
    const feed = await createFeed(
      a,
      A,
      { name: 'Google Shopping', channel: 'google_merchant', locale: 'en-GB', currency: 'EUR' },
      actor,
    );
    const published = await publishFeed(a, A, feed.id, actor);
    expect(published.status).toBe('active');
    expect(published.item_count).toBeGreaterThan(0);
    const files = await readdir(dir, { recursive: true });
    expect(files.some((f) => String(f).endsWith(`${feed.id}.xml`))).toBe(true);
  });

  it('segment materialise → the customer is a member, and the sync payload carries only the hash', async () => {
    const segment = await createSegment(
      a,
      A,
      {
        name: 'engine-buyers',
        rules: {
          v: 1,
          all: [
            { any: [{ field: 'orders_count', op: 'gte', value: 1 }] },
            { any: [{ field: 'consent', op: 'granted', value: 'email' }] },
          ],
        },
      },
      actor,
    );
    const preview = await previewSegment(a, A, segment.id);
    const materialised = await materializeSegment(a, A, segment.id, actor);
    expect(preview.count).toBe(1);
    expect(materialised.materialised_count).toBe(1);

    const payload = await segmentSyncPayload(a, A, segment.id, { limit: 10 });
    expect(payload.members).toEqual([
      expect.objectContaining({ customer_id: customerId, email_hash: emailHash(PERSON.email) }),
    ]);
    const serialised = JSON.stringify(payload);
    for (const value of PII_VALUES) expect(serialised).not.toContain(value);
  });

  it('PII sweep: no marketing event, audit row or log line carries the customer', async () => {
    const events = await db.owner.query<{ topic: string; payload: unknown }>(
      `SELECT topic, payload FROM outbox WHERE seq > $1 ORDER BY seq`,
      [outboxFloor],
    );
    // The flow above must have produced the events it is being swept for, or the sweep proves nothing.
    expect(events.rows.map((e) => e.topic)).toEqual(
      expect.arrayContaining(['campaign.launched', 'campaign.ended', 'feed.published']),
    );
    const audit = await db.owner.query<{ row: unknown }>(
      `SELECT to_jsonb(l) AS row FROM audit_log l WHERE request_id = $1`,
      [REQUEST_ID],
    );
    expect(audit.rows.length).toBeGreaterThan(0);

    const written = [
      ...events.rows.map((e) => ({ where: `outbox ${e.topic}`, text: JSON.stringify(e.payload) })),
      ...audit.rows.map((r) => ({ where: 'audit_log', text: JSON.stringify(r.row) })),
      ...consoleCalls.map((text) => ({ where: 'console', text })),
    ];
    for (const { where, text } of written) {
      for (const value of PII_VALUES)
        expect(text, `${where} contains customer data`).not.toContain(value);
      expect(text, `${where} carries a PII-shaped key`).not.toMatch(PII_KEYS);
    }
  });

  it('PII sweep, static: the module has no log call to leak through', async () => {
    // Recursive, so a sub-folder added later is swept too rather than silently skipped.
    const sources = (await readdir(__dirname, { recursive: true }))
      .map(String)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    for (const file of sources) {
      const text = await readFile(join(__dirname, file), 'utf8');
      expect(text, `${file} logs`).not.toMatch(
        /\bconsole\.\w+\(|\blogger\.\w+\(|\blog\.(info|warn|error|debug)\(/,
      );
    }
  });
});
