import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganizationClient } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing.js';

const ORG = '40000000-0000-4000-8000-000000000001';
const LE = '40000000-0000-4000-8000-000000000011';
const STORE_A = '40000000-0000-4000-8000-000000000031';
const STORE_B = '40000000-0000-4000-8000-000000000032';

let db: TestDatabase;
/** Connects as platform_metrics — the role the observability exporter uses. */
let metrics: pg.Pool;

beforeAll(async () => {
  db = await createTestDatabase('platform_metrics_test');
  const url = new URL(db.owner.options.connectionString ?? process.env.DATABASE_URL!);
  url.username = 'platform_metrics';
  url.password = 'platform_metrics';
  metrics = new pg.Pool({ connectionString: url.toString(), max: 2 });
  metrics.on('error', () => {});

  const hq = createOrganizationClient(db.owner, { organizationId: ORG });
  await hq.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq-metrics', 'HQ')`, [
      ORG,
    ]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le', 'LE', 'NL', 'EUR')`,
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
    }
    // Two unpublished events for store A, one published (must not count), one for store B.
    await tx.query(
      `INSERT INTO outbox (organization_id, store_id, topic, version, aggregate_type, aggregate_id, payload, occurred_at, published_at, attempts)
       VALUES ($1, $2, 'order.placed', 1, 'order', gen_random_uuid(), '{}', now() - interval '10 minutes', NULL, 2),
              ($1, $2, 'order.placed', 1, 'order', gen_random_uuid(), '{}', now() - interval '5 minutes', NULL, 0),
              ($1, $2, 'order.placed', 1, 'order', gen_random_uuid(), '{}', now(), now(), 0),
              ($1, $3, 'product.published', 1, 'product', gen_random_uuid(), '{}', now(), NULL, 0)`,
      [ORG, STORE_A, STORE_B],
    );
  });
}, 90_000);

afterAll(async () => {
  await metrics?.end();
  await db?.drop();
});

describe('app.outbox_lag() for the metrics role', () => {
  it('reports unpublished events per store and topic, ignoring published ones', async () => {
    const r = await metrics.query<{
      store_id: string;
      topic: string;
      unpublished: string;
      max_attempts: number;
    }>(
      'SELECT store_id, topic, unpublished, max_attempts FROM app.outbox_lag() ORDER BY store_id, topic',
    );
    expect(r.rows).toEqual([
      { store_id: STORE_A, topic: 'order.placed', unpublished: '2', max_attempts: 2 },
      { store_id: STORE_B, topic: 'product.published', unpublished: '1', max_attempts: 0 },
    ]);
  });

  it('reports the age of the oldest unpublished event', async () => {
    const r = await metrics.query<{ oldest_occurred_at: Date }>(
      `SELECT oldest_occurred_at FROM app.outbox_lag() WHERE store_id = $1 AND topic = 'order.placed'`,
      [STORE_A],
    );
    const ageMs = Date.now() - new Date(r.rows[0]!.oldest_occurred_at).getTime();
    expect(ageMs).toBeGreaterThan(9 * 60_000);
  });

  it('cannot read the outbox table itself — aggregates only, no payloads', async () => {
    await expect(metrics.query('SELECT payload FROM outbox')).rejects.toThrow(/permission denied/);
    await expect(metrics.query('SELECT * FROM outbox')).rejects.toThrow(/permission denied/);
  });

  it('cannot read business tables or write anything', async () => {
    await expect(metrics.query('SELECT * FROM "order"')).rejects.toThrow(/permission denied/);
    await expect(metrics.query('SELECT email FROM customer')).rejects.toThrow(/permission denied/);
    await expect(
      metrics.query(
        `INSERT INTO outbox (organization_id, topic, version, aggregate_type, aggregate_id, payload)
                     VALUES ($1, 't', 1, 'a', gen_random_uuid(), '{}')`,
        [ORG],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
