// Live: the real ingest against local Redpanda and ClickHouse (the shared stack: HTTP 18123). A generated month
// over every topic, published under a throwaway topic prefix into a throwaway ClickHouse database, then:
//   (1) every event is in raw_events once per (topic, event_id), per topic; the invalid ones are on the DLQ of the
//       SAME (overridden) group;
//   (2) a full replay into a FRESH group changes no count() FINAL;
//   (3) a crash between insert and commit redelivers, and FINAL folds the copies.
// Opt-in locally (ANALYTICS_LIVE=1; CI always), then skipped with a printed reason when ClickHouse is down or
// refuses the configured user, or the broker is down. Self-cleaning (database, topics).
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  brokersFromEnv,
  createKafka,
  envelopeToMessage,
  ensureTopics,
  EVENT_TOPICS,
  planTopics,
  readDeadLetters,
  type EventEnvelopeV1Base,
  type TopicPolicy,
} from '@platform/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChClient, createRawEventsSink, type ChClient } from './clickhouse.js';
import { migrate, readSqlFiles } from './migrations.js';
import { loadConfig } from './config.js';
import { createIngest, SimulatedCrash, type Ingest, type IngestLogLine } from './ingest.js';
import { generateMonth } from './testing/month.js';

const chConfig = loadConfig(process.env, []).clickhouse;

/** Reachable AND the configured user is accepted (`/ping` answers without credentials). */
async function probeClickHouse(): Promise<string | null> {
  try {
    const auth = Buffer.from(`${chConfig.username}:${chConfig.password}`).toString('base64');
    const res = await fetch(`${chConfig.url}/?query=SELECT%201`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok ? null : `${chConfig.url}: HTTP ${res.status} for user ${chConfig.username}`;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return `${chConfig.url}: ${cause ?? (err as Error).name}`;
  }
}

async function probeBroker(): Promise<string | null> {
  const [hostPort] = brokersFromEnv();
  const [host, port] = hostPort!.split(':');
  return new Promise((done) => {
    const s = net.connect({
      host: host === 'localhost' ? '127.0.0.1' : host!,
      port: Number(port),
      timeout: 1_500,
    });
    s.once('connect', () => (s.destroy(), done(null)));
    s.once('error', (e) => done(`${hostPort}: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    s.once('timeout', () => (s.destroy(), done(`${hostPort}: timeout`)));
  });
}

// Opt-in on a laptop (ANALYTICS_LIVE=1): the shared stack is measured by one window at a time, so a plain
// `pnpm test` never starts a live run just because the services happen to be up. CI always opts in.
const optedIn = process.env.ANALYTICS_LIVE === '1' || process.env.CI === 'true';
const down = optedIn
  ? ((await probeClickHouse()) ?? (await probeBroker()))
  : 'not opted in (set ANALYTICS_LIVE=1 once you hold the machine)';
if (down)
  console.warn(
    `live.test: ${down} — the live ingest tests are skipped (ClickHouse: CLICKHOUSE_URL/USER/PASSWORD from the manager's step 0; the broker: pnpm compose:up)`,
  );

const POLICY = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../infra/redpanda/topics.policy.json', import.meta.url)),
    'utf8',
  ),
) as TopicPolicy;

async function until(
  cond: () => boolean | Promise<boolean>,
  what: string,
  ms = 90_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.runIf(down === null)('live ingest (local Redpanda + ClickHouse)', () => {
  const run = Math.random().toString(36).slice(2, 8);
  const prefix = `it-${run}.`;
  const database = `analytics_test_${run}`; // a throwaway database for DDL (never `analytics`)
  const group = `analytics.raw.it-${run}`; // an OVERRIDE: the DLQ must follow it (#599)
  const kafka = createKafka({ clientId: `analytics-ingest-it-${run}` });
  const month = generateMonth({ seed: 7, perKey: 3 });
  const invalid: EventEnvelopeV1Base[] = [
    { ...month.events[0]!, event_id: crypto.randomUUID(), version: 99 } as EventEnvelopeV1Base,
    {
      ...month.events[1]!,
      event_id: crypto.randomUUID(),
      organization_id: 'nope',
    } as EventEnvelopeV1Base,
  ];
  let admin: ChClient;
  let db: ChClient;
  const ingests: Ingest[] = [];

  const finalCount = async (): Promise<number> => {
    const r = await db.query({
      query: 'SELECT count() AS n FROM raw_events FINAL',
      format: 'JSONEachRow',
    });
    return Number((await r.json<{ n: string }>())[0]!.n);
  };

  function ingestFor(
    groupId: string,
    extra: { onBeforeCommit?: () => void; log?: (l: IngestLogLine) => void } = {},
  ) {
    const i = createIngest({
      config: {
        groupId,
        dlqTopic: `${prefix}dlq.${groupId}`,
        topicPrefix: prefix,
        batchSize: 200,
        flushMs: 200,
        concurrency: 8,
      },
      kafka,
      sink: createRawEventsSink(db),
      log: extra.log ?? (() => {}),
      onBeforeCommit: extra.onBeforeCommit,
    });
    ingests.push(i);
    return i;
  }

  async function publish(events: readonly EventEnvelopeV1Base[]): Promise<void> {
    const producer = kafka.producer({ allowAutoTopicCreation: false });
    await producer.connect();
    try {
      const byTopic = new Map<string, EventEnvelopeV1Base[]>();
      for (const e of events) byTopic.set(e.topic, [...(byTopic.get(e.topic) ?? []), e]);
      await producer.sendBatch({
        topicMessages: [...byTopic].map(([topic, es]) => ({
          topic: `${prefix}${topic}`,
          messages: es.map((e) => envelopeToMessage(e, 'analytics-ingest-it')),
        })),
      });
    } finally {
      await producer.disconnect();
    }
  }

  beforeAll(async () => {
    admin = createChClient(chConfig, 'default');
    db = createChClient(chConfig, database);
    const ka = kafka.admin();
    await ka.connect();
    try {
      await ensureTopics(
        ka,
        planTopics(POLICY, {
          environment: 'local',
          prefix,
          topics: [...EVENT_TOPICS],
          consumerGroups: [],
        }),
      );
    } finally {
      await ka.disconnect();
    }
  });

  afterAll(async () => {
    await Promise.allSettled(ingests.map((i) => i.stop()));
    await admin?.command({ query: `DROP DATABASE IF EXISTS ${database}` }).catch(() => undefined);
    await Promise.allSettled([admin?.close(), db?.close()]);
    const ka = kafka.admin();
    await ka.connect();
    try {
      const mine = (await ka.listTopics()).filter((t) => t.startsWith(prefix));
      if (mine.length > 0) await ka.deleteTopics({ topics: mine });
    } finally {
      await ka.disconnect();
    }
  });

  it('ch:migrate is idempotent', async () => {
    const first = await migrate(admin, db, database, readSqlFiles());
    expect(first.applied).toContain('0001_raw_events.sql');
    const second = await migrate(admin, db, database, readSqlFiles());
    expect(second.applied).toEqual([]);
  });

  it('every event lands once per topic; invalid ones go to the DLQ of the overridden group', async () => {
    await publish([...month.events, ...invalid]);
    const ingest = ingestFor(group);
    expect(ingest.dlqTopic).toBe(`${prefix}dlq.${group}`);
    await ingest.start();
    await until(
      () =>
        ingest.stats.rows === month.events.length && ingest.stats.dead_lettered === invalid.length,
      'the month to be ingested',
    );
    await ingest.stop();

    const r = await db.query({
      query:
        'SELECT topic, version, count() AS n, uniqExact(event_id) AS u FROM raw_events FINAL GROUP BY topic, version',
      format: 'JSONEachRow',
    });
    const perKey: Record<string, number> = {};
    for (const row of await r.json<{ topic: string; version: number; n: string; u: string }>()) {
      expect(row.n).toBe(row.u);
      perKey[`${row.topic}@${row.version}`] = Number(row.n);
    }
    expect(perKey).toEqual(month.perKey);

    const letters = await readDeadLetters(group, { kafka, topicPrefix: prefix });
    expect(letters.map((l) => l.error_class).sort()).toEqual([
      'InvalidEventError',
      'UnknownEventError',
    ]);
    expect(letters.every((l) => l.group_id === group)).toBe(true);
  });

  it('a full replay into a fresh group changes no count() FINAL', async () => {
    const before = await finalCount();
    const replay = ingestFor(`${group}.replay`);
    await replay.start();
    await until(() => replay.stats.rows === month.events.length, 'the replay');
    await replay.stop();
    expect(await finalCount()).toBe(before);
  });

  it('a crash between insert and commit redelivers, and FINAL folds the copies', async () => {
    const before = await finalCount();
    const extra = generateMonth({ seed: 99, perKey: 1 }).events.slice(0, 5);
    await publish(extra);
    let crashed = false;
    const crashing = ingestFor(group, {
      onBeforeCommit: () => {
        throw new SimulatedCrash();
      },
      log: (l) => {
        if (l.event === 'crashed_before_commit') crashed = true;
      },
    });
    await crashing.start();
    await until(() => crashed, 'the simulated crash');
    await crashing.stop();
    const after = ingestFor(group);
    await after.start();
    // the crashed batch's rows were inserted before the crash, so the count alone is reached at once: wait for the
    // restarted ingest to have received the uncommitted batch again
    await until(() => after.stats.rows >= 1, 'the redelivery');
    await until(async () => (await finalCount()) === before + extra.length, 'the fold');
    await after.stop();
    expect(after.stats.rows).toBeGreaterThanOrEqual(1); // the crashed batch came back
    expect(await finalCount()).toBe(before + extra.length);
  });
});
