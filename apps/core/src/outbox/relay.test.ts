// The outbox relay (#531). Database part always (throwaway database, app role, organization scope); the bus part
// only when the local Redpanda answers (prefixed topics, self-cleaning; skipped with a printed reason otherwise).
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { createOrganizationClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import {
  assertTopicsPresent,
  brokersFromEnv,
  createKafka,
  createKafkaPublisher,
  decodeMessage,
  ensureTopics,
  HEADER_OUTBOX_ID,
  HEADER_STORE_ID,
  planTopics,
  type RelayMessage,
  type TopicPolicy,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore } from '../modules/registry';
import { buildEvent, withEvents } from './index';
import {
  errorClass,
  guardPoolClients,
  relayOnce,
  runRelayLoop,
  type RelayPassResult,
  type RelayPublisher,
} from './relay';
import { parseArgs, requiredTopics } from './relay-cli';

const ORG = '31000000-0000-4000-8000-000000000001';
const LE = '31000000-0000-4000-8000-000000000011';
const ORG_B = '31000000-0000-4000-8000-000000000002';
const LE_B = '31000000-0000-4000-8000-000000000012';

let db: TestDatabase;
let hq: ReturnType<typeof createOrganizationClient>;
let hqB: ReturnType<typeof createOrganizationClient>;
let storeA: string;
let storeB: string;
const connectionErrors: string[] = [];
const quiet = () => {};

const policy: TopicPolicy = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../infra/redpanda/topics.policy.json'), 'utf8'),
);

/** Inserts `store.updated` rows for the given store ids (null = organization scope), in order, through withEvents. */
async function emit(
  client: typeof hq,
  storeIds: (string | null)[],
  tag: string,
): Promise<string[]> {
  const ids: string[] = [];
  await client.transaction(async (tx) => {
    const events = [];
    for (const storeId of storeIds) {
      const e = await buildEvent({
        topic: 'store.updated',
        organizationId: client.context.organizationId,
        storeId,
        aggregateType: 'store',
        aggregateId: storeId ?? storeA,
        payload: { store_id: storeId ?? storeA, code: 'x', status: 'draft', changed_fields: [tag] },
      });
      ids.push(e.event_id);
      events.push(e);
    }
    await withEvents(tx, events);
  });
  return ids;
}

async function unpublished(
  client: typeof hq,
): Promise<{ id: string; attempts: number; last_error: string | null }[]> {
  return (
    await client.query<{ id: string; attempts: number; last_error: string | null }>(
      'SELECT id, attempts, last_error FROM outbox WHERE published_at IS NULL ORDER BY seq',
    )
  ).rows;
}

async function drain(client: typeof hq): Promise<void> {
  const r = await relayOnce(
    client,
    { send: async () => {} },
    { organizationId: client.context.organizationId, log: quiet },
  );
  if (r.batch > 0) await drain(client);
}

/** A publisher that records what it was asked to send, and fails the topics in `failing` with the given error. */
function recording(failing: Record<string, Error> = {}) {
  const sent: { topic: string; messages: RelayMessage[] }[] = [];
  const publisher: RelayPublisher = {
    async send(topic, messages) {
      const err = Object.entries(failing).find(([t]) => topic.endsWith(t))?.[1];
      if (err) throw err;
      sent.push({ topic, messages });
    },
  };
  return { publisher, sent };
}

beforeAll(async () => {
  db = await createTestDatabase('core_relay');
  const owner = createOrganizationClient(db.owner, { organizationId: ORG });
  await owner.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO organization (id, slug, name) VALUES ($1, 'hq-a', 'HQ A'), ($2, 'hq-b', 'HQ B')`,
      [ORG, ORG_B],
    );
    await tx.query(
      `INSERT INTO legal_entity (id, organization_id, code, name, country, currency)
       VALUES ($1, $2, 'le-a', 'LE A', 'NL', 'EUR'), ($3, $4, 'le-b', 'LE B', 'NL', 'EUR')`,
      [LE, ORG, LE_B, ORG_B],
    );
  });
  // what relay-cli does with the core's pool: a dropped connection is logged, not an uncaught exception
  guardPoolClients(db.app, (l) => connectionErrors.push(l.error_class));
  hq = createOrganizationClient(db.app, { organizationId: ORG });
  hqB = createOrganizationClient(db.app, { organizationId: ORG_B });
  const mk = (client: typeof hq, le: string, code: string) =>
    createStore(client, {
      legal_entity_id: le,
      code,
      name: code,
      default_currency: 'EUR',
      default_locale: 'en-GB',
      default_country: 'NL',
    });
  storeA = (await mk(hq, LE, 'brand-a')).id;
  storeB = (await mk(hq, LE, 'brand-b')).id;
  await mk(hqB, LE_B, 'brand-c');
  // the fixtures above wrote their own store.created rows; publish them through a no-op so every test starts clean
  await drain(hq);
  await drain(hqB);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe('relayOnce (database, recording publisher)', () => {
  it('reads unpublished rows in seq order, one send per topic, key = store_id (organization_id for organization scope), outbox_id header; then marks them', async () => {
    const ids = await emit(hq, [storeA, storeB, null, storeA], 'order');
    const { publisher, sent } = recording();
    const lines: RelayPassResult[] = [];
    const r = await relayOnce(hq, publisher, { organizationId: ORG, log: (l) => lines.push(l) });

    expect(r).toMatchObject({
      relay: 'outbox',
      organization_id: ORG,
      batch: 4,
      published: 4,
      failed: 0,
      invalid: 0,
      failed_topics: [],
      lag_rows: 0,
      lag_oldest_seconds: null,
    });
    expect(lines).toEqual([r]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.topic).toBe('store.updated');
    const msgs = sent[0]!.messages;
    expect(msgs.map((m) => m.headers[HEADER_OUTBOX_ID])).toEqual(ids);
    expect(msgs.map((m) => m.key)).toEqual([storeA, storeB, ORG, storeA]);
    expect(msgs[2]!.headers[HEADER_STORE_ID]).toBeUndefined();
    expect(msgs[0]!.headers).toMatchObject({
      topic: 'store.updated',
      version: '1',
      organization_id: ORG,
      store_id: storeA,
      event_id: ids[0],
      producer: 'core-outbox-relay/1',
    });
    const decoded = decodeMessage({
      key: msgs[0]!.key,
      value: msgs[0]!.value,
      headers: msgs[0]!.headers,
    });
    expect(decoded.outboxId).toBe(ids[0]);
    expect(decoded.envelope).toMatchObject({
      event_id: ids[0],
      topic: 'store.updated',
      store_id: storeA,
      actor: { type: 'system', id: null },
    });
    expect(decoded.envelope.payload).toEqual({
      store_id: storeA,
      code: 'x',
      status: 'draft',
      changed_fields: ['order'],
    });

    expect(await unpublished(hq)).toEqual([]);
    const marked = (
      await hq.query<{ attempts: number; published_at: Date | null }>(
        'SELECT attempts, published_at FROM outbox WHERE id = ANY($1::uuid[])',
        [ids],
      )
    ).rows;
    expect(marked.every((m) => m.attempts === 1 && m.published_at !== null)).toBe(true);
    // a second pass reads nothing
    expect((await relayOnce(hq, publisher, { organizationId: ORG, log: quiet })).batch).toBe(0);
  });

  it('a crash after the send and before the mark leaves the rows unpublished; the next pass sends them again (at-least-once)', async () => {
    const ids = await emit(hq, [storeA, storeA], 'crash');
    const { publisher, sent } = recording();
    await expect(
      relayOnce(hq, publisher, {
        organizationId: ORG,
        log: quiet,
        onPublished: () => {
          throw new Error('process died between the send and the commit');
        },
      }),
    ).rejects.toThrow('process died');
    expect(sent).toHaveLength(1); // the broker got them
    expect((await unpublished(hq)).map((r) => r.id)).toEqual(ids); // the database does not know
    expect((await unpublished(hq)).map((r) => r.attempts)).toEqual([0, 0]); // the rollback took the attempt with it

    const second = await relayOnce(hq, publisher, { organizationId: ORG, log: quiet });
    expect(second.published).toBe(2);
    expect(sent).toHaveLength(2);
    // the same outbox ids went out twice: that is what consumers dedupe on
    expect(sent[1]!.messages.map((m) => m.headers[HEADER_OUTBOX_ID])).toEqual(
      sent[0]!.messages.map((m) => m.headers[HEADER_OUTBOX_ID]),
    );
    expect(await unpublished(hq)).toEqual([]);
  });

  it('a broker outage leaves the rows unpublished with attempts + 1 and the error class, never lost; a working publisher drains them', async () => {
    const ids = await emit(hq, [storeA, storeB], 'outage');
    const down = new Error('connect ECONNREFUSED');
    down.name = 'KafkaJSNumberOfRetriesExceeded';
    const r = await relayOnce(hq, recording({ 'store.updated': down }).publisher, {
      organizationId: ORG,
      log: quiet,
    });
    expect(r).toMatchObject({
      batch: 2,
      published: 0,
      failed: 2,
      failed_topics: ['store.updated'],
      lag_rows: 2,
    });
    expect(r.lag_oldest_seconds).toBeGreaterThanOrEqual(0);
    expect(await unpublished(hq)).toEqual(
      ids.map((id) => ({ id, attempts: 1, last_error: 'KafkaJSNumberOfRetriesExceeded' })),
    );

    const again = await relayOnce(hq, recording({ 'store.updated': down }).publisher, {
      organizationId: ORG,
      log: quiet,
    });
    expect(again.failed).toBe(2);
    expect((await unpublished(hq)).map((x) => x.attempts)).toEqual([2, 2]);

    const ok = await relayOnce(hq, recording().publisher, { organizationId: ORG, log: quiet });
    expect(ok).toMatchObject({ published: 2, failed: 0, lag_rows: 0 });
    const done = (
      await hq.query<{ attempts: number; last_error: string | null }>(
        'SELECT attempts, last_error FROM outbox WHERE id = ANY($1::uuid[])',
        [ids],
      )
    ).rows;
    expect(done).toEqual([
      { attempts: 3, last_error: null },
      { attempts: 3, last_error: null },
    ]);
  });

  it('a partial pass (one topic refused) marks only the acknowledged topic', async () => {
    const [updated] = await emit(hq, [storeA], 'partial');
    const created = await buildEvent({
      topic: 'store.created',
      organizationId: ORG,
      storeId: storeA,
      aggregateType: 'store',
      aggregateId: storeA,
      payload: {
        store_id: storeA,
        code: 'brand-a',
        name: 'Brand A',
        status: 'draft',
        legal_entity_id: LE,
        default_currency: 'EUR',
        default_locale: 'en-GB',
        default_country: 'NL',
      },
    });
    await hq.transaction((tx) => withEvents(tx, [created]));
    const refused = new Error('leader moved');
    refused.name = 'KafkaJSProtocolError';
    (refused as Error & { type?: string }).type = 'NOT_LEADER_FOR_PARTITION';
    const { publisher, sent } = recording({ 'store.created': refused });
    const r = await relayOnce(hq, publisher, { organizationId: ORG, log: quiet });
    expect(r).toMatchObject({
      batch: 2,
      published: 1,
      failed: 1,
      failed_topics: ['store.created'],
    });
    expect(sent.map((s) => s.topic)).toEqual(['store.updated']);
    expect(await unpublished(hq)).toEqual([
      {
        id: created.event_id,
        attempts: 1,
        last_error: 'KafkaJSProtocolError:NOT_LEADER_FOR_PARTITION',
      },
    ]);
    expect(updated).toBeDefined();
    await drain(hq);
  });

  it("organization scope: one organization's pass never sees another organization's rows (RLS), each drains its own", async () => {
    const idsB = await emit(hqB, [null], 'org-b');
    const idsA = await emit(hq, [storeA], 'org-a');
    const a = recording();
    const rA = await relayOnce(hq, a.publisher, { organizationId: ORG, log: quiet });
    expect(rA.published).toBe(1);
    expect(a.sent[0]!.messages.map((m) => m.headers[HEADER_OUTBOX_ID])).toEqual(idsA);
    expect((await unpublished(hqB)).map((r) => r.id)).toEqual(idsB);
    const b = recording();
    const rB = await relayOnce(hqB, b.publisher, { organizationId: ORG_B, log: quiet });
    expect(rB.published).toBe(1);
    expect(b.sent[0]!.messages[0]!.key).toBe(ORG_B);
    expect(await unpublished(hqB)).toEqual([]);
  });

  it('batch size bounds a pass; the loop runs back to back until the batch is short, then stops on abort', async () => {
    await emit(hq, [storeA, storeB, storeA, storeB, storeA], 'loop');
    const { publisher, sent } = recording();
    const controller = new AbortController();
    const log = (l: RelayPassResult) => {
      if (l.batch < 2) controller.abort();
    };
    const totals = await runRelayLoop(hq, publisher, {
      organizationId: ORG,
      batchSize: 2,
      intervalMs: 10,
      signal: controller.signal,
      log,
    });
    expect(totals).toEqual({ passes: 3, published: 5, failed: 0, failed_passes: 0 });
    expect(sent.map((s) => s.messages.length)).toEqual([2, 2, 1]);
  });

  it('a publish that never answers is cut off by the relay deadline (attempts + 1, RelayPublishTimeout) and the loop goes on', async () => {
    const ids = await emit(hq, [storeA, storeB], 'hang');
    let calls = 0;
    const hangOnce: RelayPublisher = {
      send: () =>
        ++calls === 1 ? new Promise<void>(() => {}) /* never answers */ : Promise.resolve(),
    };
    const controller = new AbortController();
    const lines: RelayPassResult[] = [];
    const started = Date.now();
    const totals = await runRelayLoop(hq, hangOnce, {
      organizationId: ORG,
      publishTimeoutMs: 200,
      intervalMs: 10,
      signal: controller.signal,
      log: (l) => {
        lines.push(l);
        if (l.published === 2) controller.abort();
      },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(totals).toEqual({ passes: 2, published: 2, failed: 2, failed_passes: 0 });
    expect(lines[0]).toMatchObject({
      batch: 2,
      published: 0,
      failed: 2,
      failed_topics: ['store.updated'],
    });
    const rows = (
      await hq.query<{ attempts: number; last_error: string | null; published: boolean }>(
        'SELECT attempts, last_error, published_at IS NOT NULL AS published FROM outbox WHERE id = ANY($1::uuid[]) ORDER BY seq',
        [ids],
      )
    ).rows;
    expect(rows).toEqual([
      { attempts: 2, last_error: null, published: true },
      { attempts: 2, last_error: null, published: true },
    ]);
    // the first pass recorded the deadline class before the second pass cleared it
    expect(lines[0]!.failed).toBe(2);
  });

  it('the database backstop (idle_in_transaction_session_timeout) aborts a pass whose publish outlives it: nothing marked, the loop continues', async () => {
    const ids = await emit(hq, [storeA], 'backstop');
    const slow: RelayPublisher = {
      send: () => new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    };
    const opts = {
      organizationId: ORG,
      log: quiet,
      idleInTransactionTimeoutMs: 300,
      publishTimeoutMs: 5_000,
    };
    // Postgres ends the session with FATAL 25P03 (idle_in_transaction_session_timeout); pg reports the dead
    // connection on the next statement.
    await expect(relayOnce(hq, slow, opts)).rejects.toThrow(
      /idle-in-transaction|terminat|closed|not queryable/i,
    );
    expect(await unpublished(hq)).toEqual([{ id: ids[0]!, attempts: 0, last_error: null }]);
    // pg emits the FATAL (DatabaseError, name 'error') and then the socket close ('Error'): logged, not thrown
    expect(connectionErrors.length).toBeGreaterThanOrEqual(1);
    expect(connectionErrors[0]).toBe('error');

    const errors: string[] = [];
    const controller = new AbortController();
    let passes = 0;
    const totals = await runRelayLoop(
      hq,
      { send: async () => {} },
      {
        ...opts,
        intervalMs: 10,
        signal: controller.signal,
        log: () => {
          if (++passes >= 1) controller.abort();
        },
        onPassError: (l) => errors.push(l.error_class),
      },
    );
    expect(totals).toMatchObject({ published: 1, failed_passes: 0 });
    expect(errors).toEqual([]);
    expect(await unpublished(hq)).toEqual([]);
  });

  it('a pass that throws is logged by class and the loop continues', async () => {
    await drain(hq);
    const ids = await emit(hq, [storeA], 'throws');
    let calls = 0;
    const errors: string[] = [];
    const controller = new AbortController();
    const totals = await runRelayLoop(
      hq,
      { send: async () => {} },
      {
        organizationId: ORG,
        intervalMs: 10,
        signal: controller.signal,
        log: () => controller.abort(),
        onPassError: (l) => errors.push(l.error_class),
        onPublished: () => {
          if (++calls === 1) {
            const e = new Error('connection terminated unexpectedly');
            e.name = 'ConnectionDropped';
            throw e;
          }
        },
      },
    );
    expect(totals).toEqual({ passes: 2, published: 1, failed: 0, failed_passes: 1 });
    expect(errors).toEqual(['ConnectionDropped']);
    expect(await unpublished(hq)).toEqual([]);
    expect(ids).toHaveLength(1);
  });

  it('kafkajs against a broker that accepts the connection and never answers: bounded by the client timeouts, no hang', async () => {
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((s) => {
      // accepts, never writes; remembered so the teardown can destroy what kafkajs left open
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as net.AddressInfo).port;
    const kafka = createKafka({
      clientId: 'relay-test-silent',
      brokers: [`127.0.0.1:${port}`],
      config: {
        connectionTimeout: 500,
        requestTimeout: 500,
        retry: { retries: 0, initialRetryTime: 50 },
      },
    });
    const publisher = createKafkaPublisher(kafka, { retries: 0, requestTimeoutMs: 500 });
    const started = Date.now();
    let cls = '';
    try {
      await publisher.connect();
      await publisher.send('store.updated', []);
    } catch (err) {
      cls = errorClass(err);
    } finally {
      await publisher.disconnect().catch(() => {});
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
    // ApiVersions times out → KafkaJSNumberOfRetriesExceeded in ~0.6 s with retries off (with retries on,
    // kafkajs "connects" with assumed API versions and every later request times out the same way)
    expect(cls).toMatch(/^KafkaJS/);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('errorClass gives the class and the protocol type, never the message', () => {
    expect(errorClass(new Error('secret@example.com'))).toBe('Error');
    expect(errorClass('x')).toBe('Error');
    const e = new Error('m');
    e.name = 'KafkaJSProtocolError';
    (e as Error & { type?: string }).type = 'REQUEST_TIMED_OUT';
    expect(errorClass(e)).toBe('KafkaJSProtocolError:REQUEST_TIMED_OUT');
  });

  it('relay-cli: arguments and the required topic list (every event topic of the policy)', () => {
    expect(parseArgs([])).toEqual({ once: false, batchSize: 500, intervalMs: 1000 });
    expect(parseArgs(['--once', '--batch', '50', '--interval-ms', '250'])).toEqual({
      once: true,
      batchSize: 50,
      intervalMs: 250,
    });
    expect(() => parseArgs(['--batch', '0'])).toThrow(/positive integer/);
    const topics = requiredTopics();
    expect(topics).toContain('order.placed');
    expect(topics).toHaveLength(38);
    expect(topics.some((t) => t.startsWith('dlq.'))).toBe(false);
  });
});

// ---- the bus ------------------------------------------------------------------------------------------------

async function probeBroker(): Promise<string | null> {
  const [hostPort] = brokersFromEnv();
  const [host, port] = hostPort!.split(':');
  return new Promise((done) => {
    const s = net.connect({
      host: host === 'localhost' ? '127.0.0.1' : host!,
      port: Number(port),
      timeout: 1500,
    });
    s.once('connect', () => (s.destroy(), done(null)));
    s.once('error', (e) => done(`${hostPort}: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    s.once('timeout', () => (s.destroy(), done(`${hostPort}: timeout`)));
  });
}

// A CommonJS package cannot await at the top level, so the probe runs in the outer beforeAll and each bus test
// skips itself with the reason (CI's require-live-tests turns such a skip into a failure, which is the point).
let brokerDown: string | null = 'not probed yet';
beforeAll(async () => {
  brokerDown = await probeBroker();
  if (brokerDown)
    console.warn(`relay.test: broker ${brokerDown} — bus block skipped (pnpm compose:up)`);
});

describe('relay against the local Redpanda (prefixed topics, self-cleaning)', () => {
  const prefix = `t-${Math.random().toString(36).slice(2, 8)}.`;
  const kafka = createKafka({ clientId: 'core-relay-test' });
  const admin = kafka.admin();
  const publisher = createKafkaPublisher(kafka, { retries: 1, requestTimeoutMs: 10_000 });
  // 3 partitions: per-store order must hold with keys hashed across partitions, not only on a single one
  const plan = planTopics(policy, { environment: 'ci', prefix, topics: ['store.updated'] }).map(
    (s) => ({ ...s, partitions: 3 }),
  );
  const topic = `${prefix}store.updated`;
  type Seen = { partition: number; key: string; outboxId: string; tag: string };

  async function consume(expected: number, groupId: string, timeoutMs = 30_000): Promise<Seen[]> {
    const consumer = kafka.consumer({ groupId: `${prefix}${groupId}`, sessionTimeout: 10_000 });
    const seen: Seen[] = [];
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`consumed ${seen.length} of ${expected} within ${timeoutMs} ms`)),
        timeoutMs,
      );
      consumer
        .run({
          eachMessage: async ({ partition, message }) => {
            const d = decodeMessage({
              key: message.key,
              value: message.value,
              headers: message.headers,
            });
            const payload = d.envelope.payload as { changed_fields: string[] };
            seen.push({
              partition,
              key: message.key!.toString(),
              outboxId: d.outboxId,
              tag: payload.changed_fields[0]!,
            });
            if (seen.length >= expected) {
              clearTimeout(t);
              resolve();
            }
          },
        })
        .catch(reject);
    });
    await consumer.disconnect();
    return seen;
  }

  beforeAll(async () => {
    if (brokerDown) return;
    await admin.connect();
    await ensureTopics(admin, plan);
    await publisher.connect();
  }, 60_000);

  afterAll(async () => {
    if (brokerDown) return;
    try {
      await publisher.disconnect();
      const existing = new Set(await admin.listTopics());
      const mine = [topic].filter((n) => existing.has(n));
      if (mine.length > 0) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
      console.info(
        `relay.test: deleted ${mine.length} test topic(s): ${mine.join(', ') || '(none)'}`,
      );
      expect((await admin.listTopics()).filter((n) => n.startsWith(prefix))).toEqual([]);
    } finally {
      await admin.disconnect();
    }
  }, 60_000);

  it('refuses to start when a required topic is missing on the broker', async (ctx) => {
    if (brokerDown) return ctx.skip(`broker ${brokerDown}`);
    await expect(assertTopicsPresent(admin, [topic, `${prefix}order.placed`])).rejects.toThrow(
      `missing topic(s) on the broker: ${prefix}order.placed`,
    );
    await expect(assertTopicsPresent(admin, [topic])).resolves.toBeUndefined();
  });

  it('publishes for real: every row arrives, per store in seq order on one partition, organization-scope rows keyed by the organization', async (ctx) => {
    if (brokerDown) return ctx.skip(`broker ${brokerDown}`);
    const pattern = [storeA, storeB, storeA, null, storeB, storeA, null, storeB, storeA, storeB];
    const ids = await emit(hq, pattern, 'bus');
    const r = await relayOnce(hq, publisher, {
      organizationId: ORG,
      topicPrefix: prefix,
      log: quiet,
    });
    expect(r).toMatchObject({ batch: 10, published: 10, failed: 0 });
    expect(await unpublished(hq)).toEqual([]);

    const seen = await consume(10, 'bus');
    expect(new Set(seen.map((s) => s.outboxId))).toEqual(new Set(ids));
    const byKey = new Map<string, Seen[]>();
    for (const s of seen) byKey.set(s.key, [...(byKey.get(s.key) ?? []), s]);
    for (const key of [storeA, storeB, ORG]) {
      const mine = byKey.get(key)!;
      expect(new Set(mine.map((s) => s.partition)).size, `one partition for ${key}`).toBe(1);
      const expectedOrder = ids.filter((_, i) => (pattern[i] ?? ORG) === key);
      expect(
        mine.map((s) => s.outboxId),
        `seq order for ${key}`,
      ).toEqual(expectedOrder);
    }
  }, 60_000);

  it('a republish after a crash reaches the bus twice with the same outbox_id, and a consumer that dedupes on it handles each event once', async (ctx) => {
    if (brokerDown) return ctx.skip(`broker ${brokerDown}`);
    const ids = await emit(hq, [storeA, storeB], 'dup');
    await expect(
      relayOnce(hq, publisher, {
        organizationId: ORG,
        topicPrefix: prefix,
        log: quiet,
        onPublished: () => {
          throw new Error('crash before the mark');
        },
      }),
    ).rejects.toThrow('crash before the mark');
    const r = await relayOnce(hq, publisher, {
      organizationId: ORG,
      topicPrefix: prefix,
      log: quiet,
    });
    expect(r.published).toBe(2);

    const seen = (await consume(14, 'dup')).filter((s) => s.tag === 'dup');
    expect(seen).toHaveLength(4); // 2 events × 2 deliveries
    const handled = new Set<string>();
    let runs = 0;
    for (const s of seen) {
      if (handled.has(s.outboxId)) continue;
      handled.add(s.outboxId);
      runs += 1;
    }
    expect(runs).toBe(2);
    expect([...handled].sort()).toEqual([...ids].sort());
  }, 60_000);
});
