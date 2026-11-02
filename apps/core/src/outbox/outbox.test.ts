import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProduct, publishProduct } from '../modules/catalog';
import { createStore } from '../modules/registry';
import { readFileSync } from 'node:fs';
import type { TopicPolicy } from '@platform/events';
import { buildEvent, FOREVER_TOPIC_PREFIXES, InvalidEventError, withEvents } from './index';
import { POLICY_PATH } from './relay-cli';

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

describe('no customer actor id on a forever topic (#707)', () => {
  const ORG7 = '33000000-0000-4000-8000-000000000071';
  const STORE7 = '33000000-0000-4000-8000-000000000072';
  const CUSTOMER = '33000000-0000-4000-8000-000000000073';
  const inserts: string[] = [];
  const tx = {
    query: async (_sql: string, params?: unknown[]) => {
      inserts.push(String(params?.[3])); // the topic column
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Parameters<typeof withEvents>[0];
  const stockMoved = (actor: { type: 'customer' | 'staff' | 'system'; id: string | null }) =>
    buildEvent({
      topic: 'stock.moved',
      organizationId: ORG7,
      storeId: null,
      aggregateType: 'stock_movement',
      aggregateId: crypto.randomUUID(),
      actor,
      payload: {
        stock_movement_id: crypto.randomUUID(),
        stock_item_id: crypto.randomUUID(),
        sku: 'TEE-M-RED',
        warehouse_id: crypto.randomUUID(),
        delta: -1,
        reason: 'sale',
        reference_type: null,
        reference_id: null,
        on_hand_after: 4,
        reserved_after: 0,
      },
    });

  it("the core's forever prefixes are the policy's (infra/redpanda/topics.policy.json)", () => {
    const policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as TopicPolicy;
    expect([...FOREVER_TOPIC_PREFIXES].sort()).toEqual([...policy.retention.forever].sort());
  });

  it('rejects a customer actor WITH an id on a forever topic before any insert; null ids, staff and 30-day topics pass', async () => {
    inserts.length = 0;
    const bad = await stockMoved({ type: 'customer', id: CUSTOMER });
    const ok = await stockMoved({ type: 'staff', id: CUSTOMER });
    await expect(withEvents(tx, [ok, bad])).rejects.toThrow(InvalidEventError);
    await expect(withEvents(tx, [bad])).rejects.toThrow(
      /customer id on a topic the bus keeps forever/,
    );
    expect(inserts).toEqual([]); // the whole batch is refused, like any invalid event

    await withEvents(tx, [ok, await stockMoved({ type: 'customer', id: null })]);
    // a signed-in checkout's payment.authorized is a 30-day topic since #707: its customer actor is fine
    await withEvents(tx, [
      await buildEvent({
        topic: 'payment.authorized',
        organizationId: ORG7,
        storeId: STORE7,
        aggregateType: 'payment',
        aggregateId: crypto.randomUUID(),
        actor: { type: 'customer', id: CUSTOMER },
        payload: {
          payment_id: crypto.randomUUID(),
          order_id: crypto.randomUUID(),
          legal_entity_id: crypto.randomUUID(),
          provider: 'manual',
          provider_payment_id: null,
          amount_minor: 1999,
          currency: 'EUR',
          authorized_at: new Date().toISOString(),
        },
      }),
    ]);
    expect(inserts).toEqual(['stock.moved', 'stock.moved', 'payment.authorized']);
  });
});
