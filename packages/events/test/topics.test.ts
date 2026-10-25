// Topic plan (pure) + the live block against the local Redpanda (issue #530).
// The live block runs only when the broker answers a TCP probe; otherwise it prints the reason and skips.
// It works under a random prefix (`t-<rand>.`) and deletes only its own topics: the shared broker's real
// topics are never created, altered or deleted by a test.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  brokersFromEnv,
  createKafka,
  dlqTopicName,
  ensureTopics,
  EVENT_TOPICS,
  metricName,
  partitionKey,
  planTopics,
  RETENTION_MS,
  retentionClassOf,
  type TopicPolicy,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const policy: TopicPolicy = JSON.parse(
  readFileSync(resolve(here, '../../../infra/redpanda/topics.policy.json'), 'utf8'),
);

describe('topics.policy.json', () => {
  it('every event schema has exactly one retention class (a new schema without one fails here)', () => {
    for (const topic of EVENT_TOPICS) {
      expect(() => retentionClassOf(topic, policy), topic).not.toThrow();
    }
  });

  it('ledger-relevant topics are kept forever, the rest 30 days (ADR 0003)', () => {
    expect(retentionClassOf('order.placed', policy)).toBe('forever');
    expect(retentionClassOf('payment.captured', policy)).toBe('forever');
    expect(retentionClassOf('refund.issued', policy)).toBe('forever');
    expect(retentionClassOf('shipment.shipped', policy)).toBe('forever');
    expect(retentionClassOf('stock.moved', policy)).toBe('forever');
    expect(retentionClassOf('stock_item.mapped', policy)).toBe('forever');
    expect(retentionClassOf('product.published', policy)).toBe('days_30');
    expect(retentionClassOf('cart.abandoned', policy)).toBe('days_30');
    expect(RETENTION_MS.forever).toBe('-1');
    expect(RETENTION_MS.days_30).toBe(String(30 * 24 * 60 * 60 * 1000));
  });

  it('a topic with no class, or two classes, throws', () => {
    expect(() => retentionClassOf('invoice.issued', policy)).toThrow(/no retention class/);
    const twice: TopicPolicy = {
      ...policy,
      retention: { forever: ['order.'], days_30: ['order.placed'] },
    };
    expect(() => retentionClassOf('order.placed', twice)).toThrow(/more than one/);
  });

  it('local and ci are single-node, one partition (the dev container budget); production has 12 partitions, replication 3, min.insync.replicas 2', () => {
    expect(policy.environments.local).toEqual({ partitions: 1, replication: 1 });
    expect(policy.environments.ci).toEqual({ partitions: 1, replication: 1 });
    expect(policy.environments.production?.replication).toBe(3);
    expect(policy.environments.production?.min_insync_replicas).toBe(2);
  });
});

describe('the known consumer groups (#561)', () => {
  // the group ids the apps export on main: accounting LEDGER_GROUP, engagement OPS_GROUP_ID / CDP_GROUP_ID /
  // CRM_GROUP_ID. packages/events cannot import apps, so the names are pinned here and listed in the README.
  const GROUPS = ['accounting.ledger', 'engagement.ops', 'engagement.cdp', 'engagement.crm'];

  it('the policy lists exactly the four groups, so create-topics makes their DLQs with the environment numbers', () => {
    expect(policy.dlq.consumer_groups).toEqual(GROUPS);
  });

  it('each gets a compacted, never-expiring dlq.<group> after the event topics; production uses 12 × 3', () => {
    const dlqs = planTopics(policy).filter((s) => s.kind === 'dlq');
    expect(dlqs.map((s) => s.name)).toEqual(GROUPS.map((g) => `dlq.${g}`));
    expect(
      dlqs.every(
        (s) => s.configs['cleanup.policy'] === 'compact' && s.configs['retention.ms'] === '-1',
      ),
    ).toBe(true);
    const prod = planTopics(policy, { environment: 'production' }).filter((s) => s.kind === 'dlq');
    expect(prod.every((s) => s.partitions === 12 && s.replication === 3)).toBe(true);
  });
});

describe('planTopics', () => {
  it('derives one topic per EVENT_TOPICS entry, named verbatim, with the policy numbers and configs', () => {
    const plan = planTopics(policy);
    expect(plan.filter((s) => s.kind === 'event').map((s) => s.name)).toEqual([...EVENT_TOPICS]);
    const placed = plan.find((s) => s.name === 'order.placed')!;
    expect(placed).toEqual({
      name: 'order.placed',
      kind: 'event',
      source: 'order.placed',
      partitions: 1,
      replication: 1,
      configs: { 'cleanup.policy': 'delete', 'retention.ms': '-1' },
    });
    const published = plan.find((s) => s.name === 'product.published')!;
    expect(published.configs['retention.ms']).toBe(RETENTION_MS.days_30);
  });

  it('production adds min.insync.replicas to every topic', () => {
    const plan = planTopics(policy, { environment: 'production' });
    expect(plan.every((s) => s.configs['min.insync.replicas'] === '2')).toBe(true);
    expect(plan.every((s) => s.replication === 3 && s.partitions === 12)).toBe(true);
  });

  it('a prefix applies to every name (test isolation) and an unknown environment throws', () => {
    const plan = planTopics(policy, { prefix: 't-x.', consumerGroups: ['bi'] });
    expect(plan.every((s) => s.name.startsWith('t-x.'))).toBe(true);
    expect(plan.at(-1)?.name).toBe('t-x.dlq.bi');
    expect(() => planTopics(policy, { environment: 'staging' })).toThrow(/unknown environment/);
  });

  it('adds one compacted, never-expiring DLQ per consumer group (policy list + call option, deduplicated)', () => {
    const withGroups: TopicPolicy = {
      ...policy,
      dlq: { prefix: 'dlq.', consumer_groups: ['accounting'] },
    };
    const plan = planTopics(withGroups, { consumerGroups: ['accounting', 'engagement'] });
    const dlqs = plan.filter((s) => s.kind === 'dlq');
    expect(dlqs.map((s) => s.name)).toEqual(['dlq.accounting', 'dlq.engagement']);
    expect(dlqs[0]!.configs).toEqual({ 'cleanup.policy': 'compact', 'retention.ms': '-1' });
    expect(dlqs[0]!.source).toBe('accounting');
  });

  it('fails when a schema topic has no retention class (the policy must name every new topic)', () => {
    const incomplete: TopicPolicy = {
      ...policy,
      retention: { forever: ['order.'], days_30: ['product.'] },
    };
    expect(() => planTopics(incomplete)).toThrow(/attribution\.recorded has no retention class/);
  });

  it('rejects topics that collide in Kafka metric names (dot vs underscore)', () => {
    expect(() =>
      planTopics(
        { ...policy, retention: { forever: ['stock'], days_30: [] } },
        { topics: ['stock.moved', 'stock_moved'] },
      ),
    ).toThrow(/collide in Kafka metric names/);
    expect(new Set(EVENT_TOPICS.map(metricName)).size).toBe(EVENT_TOPICS.length);
  });
});

describe('naming helpers', () => {
  it('dlqTopicName validates the group id', () => {
    expect(dlqTopicName('accounting')).toBe('dlq.accounting');
    expect(dlqTopicName('bi-orders_v2', policy)).toBe('dlq.bi-orders_v2');
    expect(() => dlqTopicName('Accounting')).toThrow(/invalid consumer group id/);
    expect(() => dlqTopicName('')).toThrow(/invalid consumer group id/);
  });

  it('partitionKey is the store id, or the organization id for organization-scope events', () => {
    expect(partitionKey({ store_id: 'store-1', organization_id: 'org-1' })).toBe('store-1');
    expect(partitionKey({ store_id: null, organization_id: 'org-1' })).toBe('org-1');
  });

  it('brokersFromEnv parses KAFKA_BROKERS and defaults to the local compose broker on 127.0.0.1', () => {
    expect(brokersFromEnv({})).toEqual(['127.0.0.1:19092']);
    expect(brokersFromEnv({ KAFKA_BROKERS: ' a:1, b:2 ,' })).toEqual(['a:1', 'b:2']);
  });
});

// ---- live block ----------------------------------------------------------------------------------------

async function probeBroker(): Promise<string | null> {
  const [hostPort] = brokersFromEnv();
  const [host, port] = hostPort!.split(':');
  return new Promise((done) => {
    const socket = net.connect({
      host: host === 'localhost' ? '127.0.0.1' : host!,
      port: Number(port),
      timeout: 1500,
    });
    socket.once('connect', () => {
      socket.destroy();
      done(null);
    });
    socket.once('error', (err) =>
      done(`${hostPort}: ${(err as NodeJS.ErrnoException).code ?? err.message}`),
    );
    socket.once('timeout', () => {
      socket.destroy();
      done(`${hostPort}: timeout`);
    });
  });
}

const brokerDown = await probeBroker();
if (brokerDown) {
  console.warn(
    `topics.test: broker ${brokerDown} — live block skipped (start the compose stack: pnpm compose:up)`,
  );
}

describe.runIf(brokerDown === null)(
  'ensureTopics against the local Redpanda (prefixed, self-cleaning)',
  () => {
    const prefix = `t-${Math.random().toString(36).slice(2, 8)}.`;
    const kafka = createKafka({ clientId: 'events-topics-test' });
    const admin = kafka.admin();
    // A subset: the dev container has a budget of ~128 partitions in total (512 MiB / 4 MiB per partition),
    // shared with the real topics and the other windows' tests. The full plan is exercised by the real
    // `topics:create` run; the logic is the same for 5 topics as for 38.
    const plan = planTopics(policy, {
      environment: 'ci',
      prefix,
      consumerGroups: ['probe'],
      topics: [
        'order.placed',
        'order.cancelled',
        'product.published',
        'store.created',
        'stock.moved',
      ],
    });
    const names = plan.map((s) => s.name);
    const partitions = policy.environments.ci!.partitions;

    beforeAll(async () => {
      await admin.connect();
    }, 30_000);

    // The shared broker must never collect test topics: whatever happened above, delete every `t-<rand>.`
    // topic this block created, say which, and only then disconnect.
    afterAll(async () => {
      try {
        const existing = new Set(await admin.listTopics());
        const mine = names.filter((n) => existing.has(n));
        if (mine.length > 0) await admin.deleteTopics({ topics: mine, timeout: 30_000 });
        const left = (await admin.listTopics()).filter((n) => n.startsWith(prefix));
        console.info(
          `topics.test: deleted ${mine.length} test topic(s) with prefix ${prefix}: ${mine.join(', ') || '(none)'}` +
            (left.length ? ` — STILL PRESENT: ${left.join(', ')}` : ''),
        );
        expect(left).toEqual([]);
      } finally {
        await admin.disconnect();
      }
    }, 60_000);

    it('a dry run touches nothing', async () => {
      const r = await ensureTopics(admin, plan, { dryRun: true });
      expect(r.created).toEqual(names);
      const existing = new Set(await admin.listTopics());
      expect(names.some((n) => existing.has(n))).toBe(false);
    });

    it('first run creates every topic with the policy partitions, retention and cleanup policy', async () => {
      const r = await ensureTopics(admin, plan);
      expect(r.created).toEqual(names);
      expect(r.altered).toEqual([]);
      expect(r.partitionsRaised).toEqual([]);

      const { topics } = await admin.fetchTopicMetadata({ topics: names });
      expect(topics).toHaveLength(names.length);
      expect(topics.every((t) => t.partitions.length === partitions)).toBe(true);

      const { resources } = await admin.describeConfigs({
        includeSynonyms: false,
        resources: [
          {
            type: 2,
            name: `${prefix}order.placed`,
            configNames: ['retention.ms', 'cleanup.policy'],
          },
          {
            type: 2,
            name: `${prefix}product.published`,
            configNames: ['retention.ms', 'cleanup.policy'],
          },
          { type: 2, name: `${prefix}dlq.probe`, configNames: ['retention.ms', 'cleanup.policy'] },
        ],
      });
      const cfg = (i: number) =>
        Object.fromEntries(resources[i]!.configEntries.map((c) => [c.configName, c.configValue]));
      expect(cfg(0)).toEqual({ 'retention.ms': '-1', 'cleanup.policy': 'delete' });
      expect(cfg(1)).toEqual({ 'retention.ms': RETENTION_MS.days_30, 'cleanup.policy': 'delete' });
      expect(cfg(2)).toEqual({ 'retention.ms': '-1', 'cleanup.policy': 'compact' });
    }, 60_000);

    it('second run changes nothing (idempotent)', async () => {
      const r = await ensureTopics(admin, plan);
      expect(r.created).toEqual([]);
      expect(r.altered).toEqual([]);
      expect(r.partitionsRaised).toEqual([]);
      expect(r.warnings).toEqual([]);
      expect(r.unchanged).toEqual(names);
    }, 60_000);

    it('a policy change is applied as a config alteration, and only to the topics that drifted', async () => {
      const drifted = plan.map((s) =>
        s.name === `${prefix}product.published`
          ? { ...s, configs: { ...s.configs, 'retention.ms': String(7 * 24 * 60 * 60 * 1000) } }
          : s,
      );
      const r = await ensureTopics(admin, drifted);
      expect(r.created).toEqual([]);
      expect(r.altered).toEqual([
        {
          topic: `${prefix}product.published`,
          changes: {
            'retention.ms': { from: RETENTION_MS.days_30, to: String(7 * 24 * 60 * 60 * 1000) },
          },
        },
      ]);
      const again = await ensureTopics(admin, drifted);
      expect(again.altered).toEqual([]);
      // back to the policy: one alteration, then stable
      const back = await ensureTopics(admin, plan);
      expect(back.altered.map((a) => a.topic)).toEqual([`${prefix}product.published`]);
      expect((await ensureTopics(admin, plan)).altered).toEqual([]);
    }, 60_000);

    it('a raised partition count is applied; a lowered one is a warning, never a change', async () => {
      const raised = plan.map((s) =>
        s.name === `${prefix}order.placed` ? { ...s, partitions: partitions + 1 } : s,
      );
      const r = await ensureTopics(admin, raised);
      expect(r.partitionsRaised).toEqual([
        { topic: `${prefix}order.placed`, from: partitions, to: partitions + 1 },
      ]);
      const { topics } = await admin.fetchTopicMetadata({ topics: [`${prefix}order.placed`] });
      expect(topics[0]!.partitions).toHaveLength(partitions + 1);

      const lowered = await ensureTopics(admin, plan);
      expect(lowered.partitionsRaised).toEqual([]);
      expect(lowered.warnings).toEqual([
        `${prefix}order.placed has ${partitions + 1} partitions, policy says ${partitions}: Kafka cannot lower a count, left as is`,
      ]);
    }, 60_000);
  },
);
