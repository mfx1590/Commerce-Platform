import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProduct, publishProduct } from '../modules/catalog';
import { createStore } from '../modules/registry';
import { buildEvent, InvalidEventError, withEvents } from './index';

const ORG = '30000000-0000-4000-8000-000000000001';
const LE = '30000000-0000-4000-8000-000000000011';

let db: TestDatabase;
let hq: ReturnType<typeof createOrganizationClient>;
let storeId: string;

const countOutbox = async () =>
  Number((await hq.query<{ n: string }>('SELECT count(*)::text AS n FROM outbox')).rows[0]!.n);

beforeAll(async () => {
  db = await createTestDatabase('core_outbox');
  const owner = createOrganizationClient(db.owner, { organizationId: ORG });
  await owner.transaction(async (tx) => {
    await tx.query(`INSERT INTO organization (id, slug, name) VALUES ($1, 'hq', 'HQ')`, [ORG]);
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency) VALUES ($1, $2, 'le', 'LE', 'NL', 'EUR')`,
      [LE, ORG],
    );
  });
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  const store = await createStore(hq, {
    legal_entity_id: LE,
    code: 'brand-x',
    name: 'Brand X',
    default_currency: 'EUR',
    default_locale: 'en-GB',
    default_country: 'NL',
  });
  storeId = store.id;
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe('withEvents', () => {
  it('a mutation that throws after the outbox insert leaves no outbox row and no state change', async () => {
    const before = await countOutbox();
    await expect(
      hq.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, 'pos-9', 'POS', 'pos')`,
          [ORG, storeId],
        );
        await withEvents(tx, [
          await buildEvent({
            topic: 'store.updated',
            organizationId: ORG,
            storeId,
            aggregateType: 'store',
            aggregateId: storeId,
            payload: { store_id: storeId, code: 'brand-x', status: 'draft', changed_fields: ['x'] },
          }),
        ]);
        throw new Error('boom after the outbox insert');
      }),
    ).rejects.toThrow('boom after the outbox insert');
    expect(await countOutbox()).toBe(before);
    expect((await hq.query(`SELECT 1 FROM sales_channel WHERE code = 'pos-9'`)).rowCount).toBe(0);
  });

  it('an envelope that fails its JSON Schema aborts the transaction with a clear error', async () => {
    const before = await countOutbox();
    const bad = await buildEvent({
      topic: 'store.updated',
      organizationId: ORG,
      storeId,
      aggregateType: 'store',
      aggregateId: storeId,
      // `code` and `changed_fields` missing, status not in the enum
      payload: { store_id: storeId, status: 'live' } as never,
    });
    let caught: unknown;
    await hq
      .transaction(async (tx) => {
        await tx.query(
          `INSERT INTO sales_channel (organization_id, store_id, code, name, type) VALUES ($1, $2, 'pos-8', 'POS', 'pos')`,
          [ORG, storeId],
        );
        await withEvents(tx, [bad]);
      })
      .catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(InvalidEventError);
    const err = caught as InvalidEventError;
    expect(err.topic).toBe('store.updated');
    expect(err.message).toMatch(/invalid event store\.updated: \/payload/);
    expect(err.errors.join(' ')).toMatch(/code|changed_fields/);
    expect(await countOutbox()).toBe(before);
    expect((await hq.query(`SELECT 1 FROM sales_channel WHERE code = 'pos-8'`)).rowCount).toBe(0);
  });

  it('validates every envelope before inserting any (a good event in the same batch is not written)', async () => {
    const before = await countOutbox();
    const good = await buildEvent({
      topic: 'store.updated',
      organizationId: ORG,
      storeId,
      aggregateType: 'store',
      aggregateId: storeId,
      payload: { store_id: storeId, code: 'brand-x', status: 'draft', changed_fields: ['name'] },
    });
    const bad = { ...good, event_id: 'not-a-uuid' } as typeof good;
    await expect(hq.transaction((tx) => withEvents(tx, [good, bad]))).rejects.toThrow(/event_id/);
    expect(await countOutbox()).toBe(before);
  });

  it('creating a product then publishing it yields exactly product.updated then product.published', async () => {
    const product = await createProduct(hq, storeId, { handle: 'outbox-tee', title: 'Outbox Tee' });
    await publishProduct(hq, storeId, product.id);
    const rows = await hq.query<{
      topic: string;
      version: number;
      store_id: string;
      published_at: Date | null;
      aggregate_type: string;
    }>(
      `SELECT topic, version, store_id, published_at, aggregate_type FROM outbox WHERE aggregate_id = $1 ORDER BY seq`,
      [product.id],
    );
    expect(rows.rows).toEqual([
      {
        topic: 'product.updated',
        version: 1,
        store_id: storeId,
        published_at: null,
        aggregate_type: 'product',
      },
      {
        topic: 'product.published',
        version: 1,
        store_id: storeId,
        published_at: null,
        aggregate_type: 'product',
      },
    ]);
  });

  it('writes headers with the actor and an empty trace, and an envelope-shaped payload', async () => {
    const row = await hq.query<{ headers: { actor: unknown; trace: unknown }; payload: unknown }>(
      `SELECT headers, payload FROM outbox WHERE topic = 'store.created' AND aggregate_id = $1`,
      [storeId],
    );
    expect(row.rows[0]!.headers).toEqual({ actor: { type: 'system', id: null }, trace: {} });
    expect(row.rows[0]!.payload).toMatchObject({ store_id: storeId, code: 'brand-x' });
  });
});
