// #623: customer.erased in the analytics store.
//   unit: the digest index (keyed, store-scoped, no raw value), the scrub (only matching identifier fields, only
//         erased values), customer.erased v1/v2 parsing, classify scrubbing at insert time;
//   ClickHouse (opt-in like models.test): customers with orders, carts and profile events, then an erasure through
//         the real processBatch → applyErasure path, and: the erased hash and customer id are in NO table or view of
//         the database (a formatRow sweep, non-FINAL); customer_erasures holds no raw value; fct_order's
//         customer_key is NULL for that customer and mart_customers_daily counts the orders as unknown; every money
//         mart is unchanged; a full replay (a fresh ingest that loads the erasures) keeps everything gone; and an
//         erasure that arrives BEFORE the orders (a rebuild) scrubs them at insert.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createValidator, makeEvent, type EventEnvelopeV1Base } from '@platform/events';
import { generateMonth, ORG, rng, STORE_A, STORE_B, uuidFrom } from '@platform/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBatcher } from './batcher.js';
import { createChClient, createRawEventsSink, type ChClient } from './clickhouse.js';
import { loadConfig } from './config.js';
import {
  applyErasure,
  createErasureIndex,
  erasedCustomerOf,
  ErasureConfigError,
  loadErasures,
  scrubPayload,
  type ErasureIndex,
} from './erasure.js';
import { assertSingleReplica, processBatch, SecondReplicaError, type BatchDeps } from './ingest.js';
import { migrate, readSqlFiles } from './migrations.js';
import { classify, type RawEventRow, type WireBatch } from './rows.js';
import { clickHouseSkipReason, throwawayDatabase } from './testing/clickhouse-gate.js';
import { FakeDlq, toWire } from './testing/fakes.js';

// a word, not a key: tests must never hold anything secret-shaped
const KEY = 'erasure-test-word-not-a-secret';
const validator = createValidator();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

// ---- fixtures: three customers in store A (one also in store B), orders, a cart, profile events ---------------

const month = generateMonth({ orders: 12, legalEntities: 2, deterministicIds: true, seed: 623 });
const placed = month.events.filter((e) => e.topic === 'order.placed');
const CUSTOMERS = [
  '00000000-0000-4000-8000-0000000c0001',
  '00000000-0000-4000-8000-0000000c0002',
  '00000000-0000-4000-8000-0000000c0003',
];
const HASHES = CUSTOMERS.map((c) => hash(`${c}@example.test`));
// The erased store is the first order's. Customers 0 and 1 own its orders alternately; customer 2 owns every order of the
// other store. Customer 0 is erased (in that store only), so 1 and 2 keep every identifier.
const erasedStore = placed[0]!.store_id!;
let alternate = 0;
const owner = (e: EventEnvelopeV1Base): number =>
  e.store_id === erasedStore ? alternate++ % 2 : 2;
const owned: EventEnvelopeV1Base[] = placed.map((e) => {
  const i = owner(e);
  return {
    ...e,
    payload: { ...(e.payload as object), customer_id: CUSTOMERS[i], email_hash: HASHES[i] },
  };
}) as EventEnvelopeV1Base[];
const ownerOf = (e: EventEnvelopeV1Base) =>
  (e.payload as unknown as { customer_id: string }).customer_id;
const others = month.events.filter((e) => e.topic !== 'order.placed');

function customerEvent(
  topic: 'customer.created' | 'customer.erased',
  i: number,
  store: string,
): EventEnvelopeV1Base {
  const base = { customer_id: CUSTOMERS[i]!, email_hash: HASHES[i]! };
  const payload =
    topic === 'customer.created'
      ? {
          ...base,
          identity_id: null,
          status: 'registered',
          customer_group_id: null,
          marketing_consent: false,
        }
      : { ...base, identity_id: null, erased_at: '2026-10-29T12:00:00.000Z' };
  return makeEvent({
    topic,
    organizationId: ORG,
    storeId: store,
    aggregateType: 'customer',
    aggregateId: CUSTOMERS[i]!,
    occurredAt: new Date(
      topic === 'customer.erased' ? '2026-10-29T12:00:00.000Z' : '2026-09-01T00:00:00.000Z',
    ),
    payload: payload as never,
  }) as unknown as EventEnvelopeV1Base;
}
const created = [0, 1, 2].map((i) => customerEvent('customer.created', i, erasedStore));
const erasure = customerEvent('customer.erased', 0, erasedStore);

describe('erasure index and scrub (pure)', () => {
  it('refuses a missing or short key', () => {
    expect(() => createErasureIndex('')).toThrow(ErasureConfigError);
    expect(() => createErasureIndex('short')).toThrow(ErasureConfigError);
  });

  it('digests are keyed and store-scoped, and hold no raw identifier', () => {
    const a = createErasureIndex(KEY);
    const b = createErasureIndex(`${KEY}-other`);
    const d = a.digest(STORE_A, 'email', HASHES[0]!);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).not.toContain(HASHES[0]!);
    expect(d).not.toBe(b.digest(STORE_A, 'email', HASHES[0]!));
    a.add([d]);
    expect(a.has(STORE_A, 'email', HASHES[0]!)).toBe(true);
    expect(a.has(STORE_B, 'email', HASHES[0]!)).toBe(false); // the same person in another brand is not erased
    a.add([a.digest('*', 'customer', CUSTOMERS[1]!)]);
    expect(a.has(STORE_B, 'customer', CUSTOMERS[1]!)).toBe(true); // an organization-wide erasure
  });

  it('nulls only the identifier fields whose value is erased', () => {
    const idx = createErasureIndex(KEY);
    idx.add([idx.digest(STORE_A, 'customer', CUSTOMERS[0]!)]);
    const referral = {
      referrer_customer_id: CUSTOMERS[0],
      referee_customer_id: CUSTOMERS[1],
      reward_minor: 500,
    };
    const r = scrubPayload(referral, STORE_A, idx);
    expect(r).toEqual({
      changed: true,
      payload: { referrer_customer_id: null, referee_customer_id: CUSTOMERS[1], reward_minor: 500 },
    });
    expect(scrubPayload({ email_hash: HASHES[2], total: 1 }, STORE_A, idx)).toEqual({
      changed: false,
      payload: { email_hash: HASHES[2], total: 1 },
    });
  });

  it('reads customer.erased v2 (customer, email) and refuses nothing else', () => {
    expect(erasedCustomerOf(erasure)).toMatchObject({
      storeId: erasedStore,
      identifiers: [
        { kind: 'customer', value: CUSTOMERS[0] },
        { kind: 'email', value: HASHES[0] },
      ],
    });
    expect(erasedCustomerOf(owned[0]!)).toBeNull();
  });

  it('classify scrubs at insert time, so a late or replayed order of an erased customer never carries the hash', () => {
    const idx = createErasureIndex(KEY);
    idx.add([
      idx.digest(erasedStore, 'email', HASHES[0]!),
      idx.digest(erasedStore, 'customer', CUSTOMERS[0]!),
    ]);
    const c = classify(
      toWire(owned[0]!, 1),
      { topic: 'order.placed', partition: 0 },
      {
        groupId: 'analytics.raw',
        validator,
        now: new Date(),
        erasures: idx,
      },
    );
    if (c.kind !== 'row') throw new Error('expected a row');
    expect(c.row.payload).not.toContain(HASHES[0]!);
    expect(c.row.payload).not.toContain(CUSTOMERS[0]!);
    expect(JSON.parse(c.row.payload).totals).toEqual(
      (owned[0]!.payload as unknown as { totals: unknown }).totals,
    );
  });
});

describe('the #631 review fixes (pure / transport)', () => {
  it('requested_by is scrubbed only when it names the CUSTOMER (requested_by_type customer)', () => {
    const idx = createErasureIndex(KEY);
    idx.add([idx.digest(STORE_A, 'customer', CUSTOMERS[0]!)]);
    const byCustomer = {
      customer_id: CUSTOMERS[0],
      requested_by: CUSTOMERS[0],
      requested_by_type: 'customer',
    };
    expect(scrubPayload(byCustomer, STORE_A, idx).payload).toEqual({
      customer_id: null,
      requested_by: null,
      requested_by_type: 'customer',
    });
    // a staff request names a staff user, never the customer: it stays (even if the ids collided)
    const byStaff = {
      customer_id: CUSTOMERS[0],
      requested_by: CUSTOMERS[0],
      requested_by_type: 'staff',
    };
    expect(scrubPayload(byStaff, STORE_A, idx).payload.requested_by).toBe(CUSTOMERS[0]);
  });

  it('the identifiers never appear in a request URL (multipart params), only in the request body', async () => {
    const seen: { url: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'text/plain', 'x-clickhouse-summary': '{}' });
        res.end('');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const ch = createChClient(
      {
        url: `http://127.0.0.1:${port}`,
        username: 'word',
        password: 'word',
        database: 'analytics_test_url',
      },
      'analytics_test_url',
    );
    try {
      const index = createErasureIndex(KEY);
      await applyErasure({ ch, index, flush: async () => {} }, erasedCustomerOf(erasure)!);
    } finally {
      await ch.close();
      await new Promise((r) => server.close(r));
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const v of [HASHES[0]!, CUSTOMERS[0]!])
      for (const s of seen) expect(decodeURIComponent(s.url), v).not.toContain(v);
    // ...and the lookup did send them, in its body
    expect(seen.some((s) => s.body.includes(HASHES[0]!) && s.body.includes(CUSTOMERS[0]!))).toBe(
      true,
    );
  });

  it('the guard: a short read-back means NO delete, the error surfaces, and the batch is not committed', async () => {
    const commands: string[] = [];
    const fake: ChClient = {
      async command({ query }) {
        commands.push(query);
      },
      async query({ query }) {
        // the lookup finds one event, but the read-back returns nothing (as the alias bug did)
        const rows = query.includes('SELECT DISTINCT')
          ? [{ id: owned[0]!.event_id, part: '202610' }]
          : [];
        return { json: async <T>() => rows as T[] };
      },
      async insert() {},
      async close() {},
    };
    const index = createErasureIndex(KEY);
    await expect(
      applyErasure({ ch: fake, index, flush: async () => {} }, erasedCustomerOf(erasure)!),
    ).rejects.toThrow('nothing deleted');
    expect(commands.filter((c) => c.startsWith('DELETE') || c.startsWith('OPTIMIZE'))).toEqual([]);

    const commits: string[] = [];
    const batcher = createBatcher<RawEventRow>({
      sink: { insert: async () => {} },
      batchSize: 1,
      flushMs: 5,
    });
    await expect(
      processBatch(
        { topic: 'customer.erased', partition: 0, messages: [toWire(erasure, 0)] },
        {
          groupId: 'analytics.raw',
          batcher,
          dlq: new FakeDlq(),
          validator,
          erasures: index,
          erase: (c) => applyErasure({ ch: fake, index, flush: () => batcher.flush() }, c),
          commit: async (_t, _p, o) => {
            commits.push(o);
          },
        },
      ),
    ).rejects.toThrow('nothing deleted');
    expect(commits).toEqual([]);
  });

  it('refuses to start next to another live member of its group (one replica: the index is per process)', async () => {
    const admin = (members: number, state = 'Stable') => ({
      describeGroups: async () => ({
        groups: [
          { groupId: 'analytics.raw', state, members: Array.from({ length: members }, () => ({})) },
        ],
      }),
    });
    await expect(assertSingleReplica(admin(1), 'analytics.raw')).rejects.toBeInstanceOf(
      SecondReplicaError,
    );
    await expect(assertSingleReplica(admin(0, 'Empty'), 'analytics.raw')).resolves.toBeUndefined();
    await expect(assertSingleReplica(admin(0, 'Dead'), 'analytics.raw')).resolves.toBeUndefined();
  });
});

// ---- ClickHouse ------------------------------------------------------------------------------------------------

const cfg = loadConfig(process.env, []).clickhouse;
const skip = await clickHouseSkipReason(cfg);
if (skip) console.warn(`erasure.test: ${skip} — the ClickHouse erasure tests are skipped`);

type Row = Record<string, string | number | null>;

describe.runIf(skip === null)('customer.erased in ClickHouse (#623)', () => {
  const made: string[] = [];
  let admin: ChClient;
  const clients: ChClient[] = [];
  const q = async (c: ChClient, query: string): Promise<Row[]> =>
    (await c.query({ query, format: 'JSONEachRow' })).json<Row>();

  async function freshDatabase(): Promise<ChClient> {
    const db = throwawayDatabase();
    made.push(db);
    const c = createChClient(cfg, db);
    clients.push(c);
    await migrate(admin, c, db, readSqlFiles());
    return c;
  }

  /** The real path: processBatch with the real sink and the real applyErasure, one event per batch. */
  function ingestInto(ch: ChClient, index: ErasureIndex) {
    const batcher = createBatcher<RawEventRow>({
      sink: createRawEventsSink(ch),
      batchSize: 1,
      flushMs: 5,
    });
    const deps: BatchDeps = {
      groupId: 'analytics.raw',
      batcher,
      dlq: new FakeDlq(),
      validator,
      erasures: index,
      erase: (c) => applyErasure({ ch, index, flush: () => batcher.flush() }, c),
      commit: async () => {},
    };
    let offset = 0;
    return async (events: readonly EventEnvelopeV1Base[]) => {
      for (const e of events) {
        const batch: WireBatch = { topic: e.topic, partition: 0, messages: [toWire(e, offset++)] };
        await processBatch(batch, deps);
      }
    };
  }

  /** Every row of every table and view of the database that mentions `value`, non-FINAL. */
  async function sweep(ch: ChClient, db: string, value: string): Promise<string[]> {
    const objects = await q(
      ch,
      `SELECT name FROM system.tables WHERE database = '${db}' ORDER BY name`,
    );
    const hits: string[] = [];
    for (const { name } of objects) {
      // the value as a parameter with logging off (the test must not put it in query_log itself), and
      // apply_deleted_mask = 0: rows a lightweight DELETE only masked are counted too (physical removal)
      const r = (
        await (
          await ch.query({
            query: `SELECT count() AS n FROM ${String(name)} WHERE position(formatRow('JSONEachRow', *), {v:String}) > 0`,
            format: 'JSONEachRow',
            query_params: { v: value },
            use_multipart_params: true,
            clickhouse_settings: { log_queries: 0, apply_deleted_mask: 0 },
          })
        ).json<{ n: string }>()
      )[0]!;
      if (Number(r.n) > 0) hits.push(`${String(name)}: ${r.n}`);
    }
    return hits;
  }

  const moneyMarts = async (ch: ChClient) => ({
    bookings: await q(ch, 'SELECT * FROM mart_bookings_daily ORDER BY store_id, day, currency'),
    cash: await q(ch, 'SELECT * FROM mart_cash_daily ORDER BY store_id, day, currency, provider'),
    live: await q(ch, 'SELECT * FROM live_orders_minute ORDER BY store_id, currency, minute'),
  });

  beforeAll(() => {
    admin = createChClient(cfg, 'default');
  });
  afterAll(async () => {
    for (const db of made)
      await admin?.command({ query: `DROP DATABASE IF EXISTS ${db}` }).catch(() => undefined);
    await Promise.allSettled([admin?.close(), ...clients.map((c) => c.close())]);
  });

  it('erases the customer from every table and view, keeps the money, and a full replay keeps it gone', async () => {
    const ch = await freshDatabase();
    const db = made.at(-1)!;
    const index = createErasureIndex(KEY);
    const ingest = ingestInto(ch, index);
    await ingest([...created, ...owned, ...others]);
    expect(await sweep(ch, db, HASHES[0]!)).not.toEqual([]); // present before the erasure
    const before = await moneyMarts(ch);

    await ingest([erasure]);
    for (const v of [HASHES[0]!, CUSTOMERS[0]!]) expect(await sweep(ch, db, v), v).toEqual([]);
    for (const v of [HASHES[1]!, CUSTOMERS[1]!]) expect(await sweep(ch, db, v), v).not.toEqual([]); // others untouched
    expect(await moneyMarts(ch)).toEqual(before);

    const orders0 = owned.filter((e) => ownerOf(e) === CUSTOMERS[0]).length;
    expect(orders0).toBeGreaterThan(0);
    expect(owned.some((e) => ownerOf(e) === CUSTOMERS[2])).toBe(true);
    const [k] = await q(
      ch,
      `SELECT countIf(isNull(customer_key)) AS erased, countIf(isNotNull(customer_key)) AS kept FROM fct_order`,
    );
    expect(Number(k!.erased)).toBe(orders0);
    expect(Number(k!.kept)).toBe(owned.length - orders0);
    const [m] = await q(
      ch,
      'SELECT sum(unknown_orders) AS unknown, sum(new_customers) AS new FROM mart_customers_daily',
    );
    expect(Number(m!.unknown)).toBe(orders0);
    expect(Number(m!.new)).toBe(2); // customers 1 and 2, once each (each orders in one store); 0 is unknown now
    const [e] = await q(ch, 'SELECT count() AS n FROM customer_erasures');
    expect(Number(e!.n)).toBe(2); // customer id + email hash digests, no raw value (the sweep above proves it)

    // a full replay through a FRESH ingest, which loads the erasures from ClickHouse
    const replayIndex = createErasureIndex(KEY);
    expect(await loadErasures(ch, replayIndex)).toBe(2);
    await ingestInto(ch, replayIndex)([...created, ...owned, ...others]);
    for (const v of [HASHES[0]!, CUSTOMERS[0]!]) expect(await sweep(ch, db, v), v).toEqual([]);
    expect(await moneyMarts(ch)).toEqual(before);
  });

  it('an erasure that arrives before the orders (a rebuild) scrubs them at insert', async () => {
    const ch = await freshDatabase();
    const db = made.at(-1)!;
    const index = createErasureIndex(KEY);
    await ingestInto(ch, index)([erasure, ...created, ...owned, ...others]);
    for (const v of [HASHES[0]!, CUSTOMERS[0]!]) expect(await sweep(ch, db, v), v).toEqual([]);
  });

  it('no identifier reaches the query log: every erasure statement is parameterised and runs with log_queries = 0', async () => {
    const ch = await freshDatabase();
    const now = String((await q(ch, 'SELECT toString(now64(3)) AS now'))[0]!.now);
    await ingestInto(ch, createErasureIndex(KEY))([...created, ...owned, erasure]);
    await ch.command({ query: 'SYSTEM FLUSH LOGS' });
    for (const log of ['query_log', 'query_views_log', 'processes']) {
      const exists = await q(
        ch,
        `SELECT count() AS n FROM system.tables WHERE database = 'system' AND name = '${log}'`,
      );
      if (Number(exists[0]!.n) === 0) continue;
      // processes lists this very query (its parameters included): exclude it
      const timeFilter =
        log === 'processes'
          ? 'query_id != queryID()'
          : "event_time >= toDateTime({since:String}, 'UTC')";
      const queryCol = log === 'query_views_log' ? 'view_query' : 'query';
      const r = (
        await (
          await ch.query({
            query: `SELECT count() AS n FROM system.${log} WHERE ${timeFilter} AND (position(${queryCol}, {h:String}) > 0 OR position(${queryCol}, {c:String}) > 0)`,
            format: 'JSONEachRow',
            query_params: { since: now.slice(0, 19), h: HASHES[0]!, c: CUSTOMERS[0]! },
            use_multipart_params: true,
            clickhouse_settings: { log_queries: 0 },
          })
        ).json<{ n: string }>()
      )[0]!;
      expect(Number(r.n), log).toBe(0);
    }
  });

  it('converges under random cross-partition interleavings: orders and their erasure in parallel, every seed', async () => {
    const ch = await freshDatabase();
    const db = made.at(-1)!;
    const index = createErasureIndex(KEY);
    const SEEDS = 15;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const random = rng(seed * 7_919);
      const customer = uuidFrom(random);
      const emailHash = hash(`${customer}@example.test`);
      const orders = placed
        .filter((e) => e.store_id === erasedStore)
        .slice(0, 6)
        .map((e) => ({
          ...e,
          event_id: uuidFrom(random),
          payload: {
            ...(e.payload as object),
            order_id: uuidFrom(random),
            customer_id: customer,
            email_hash: emailHash,
          },
        })) as EventEnvelopeV1Base[];
      const gone = {
        ...erasure,
        event_id: uuidFrom(random),
        aggregate_id: customer,
        payload: { ...(erasure.payload as object), customer_id: customer, email_hash: emailHash },
      } as EventEnvelopeV1Base;
      // a buffer that flushes at random sizes and times, and a sink with random latency
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const sink = createRawEventsSink(ch);
      const batcher = createBatcher<RawEventRow>({
        sink: {
          insert: async (rows) => (await sleep(Math.floor(random() * 25)), sink.insert(rows)),
        },
        batchSize: 1 + Math.floor(random() * 3),
        flushMs: 5 + Math.floor(random() * 25),
      });
      const deps: BatchDeps = {
        groupId: 'analytics.raw',
        batcher,
        dlq: new FakeDlq(),
        validator,
        erasures: index,
        erase: (c) => applyErasure({ ch, index, flush: () => batcher.flush() }, c),
        commit: async () => {},
      };
      // every event in its own "partition", all at once, at random offsets
      await Promise.all(
        [...orders, gone].map(async (e, i) => {
          await sleep(Math.floor(random() * 40));
          await processBatch({ topic: e.topic, partition: i, messages: [toWire(e, i)] }, deps);
        }),
      );
      await batcher.flush();
      for (const v of [emailHash, customer])
        expect(await sweep(ch, db, v), `seed ${seed}: ${v}`).toEqual([]);
    }
  });
});
