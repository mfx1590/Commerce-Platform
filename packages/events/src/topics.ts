// Redpanda topic plan + idempotent creation (issue #530, ADR 0003 item 3).
//
// One topic per event topic in schemas/ (derived from EVENT_TOPICS, never hand-written), named verbatim
// (`order.placed`), partitioned by store_id so per-store order is kept, plus one compacted dead-letter topic
// per consumer group (`dlq.<groupId>`). The numbers (partitions, replication, retention classes) come from
// infra/redpanda/topics.policy.json; this module is pure apart from `ensureTopics`, which talks to the
// broker through the Kafka admin API. See infra/redpanda/README.md for every choice and its reason.
import net from 'node:net';
import tls from 'node:tls';
import kafkajs, { Kafka, logLevel } from 'kafkajs';
import type { ISocketFactoryArgs, KafkaConfig } from 'kafkajs';
import { EVENT_TOPICS } from './generated/schemas.js';

const { ConfigResourceTypes } = kafkajs;

/**
 * The slice of a Kafka admin client `ensureTopics` uses. kafkajs's `Admin` satisfies it as is; a future client
 * swap writes a small adapter instead of changing the signature (#535 review).
 */
export interface TopicAdmin {
  listTopics(): Promise<string[]>;
  createTopics(options: {
    waitForLeaders?: boolean;
    topics: {
      topic: string;
      numPartitions: number;
      replicationFactor: number;
      configEntries: { name: string; value: string }[];
    }[];
  }): Promise<boolean>;
  fetchTopicMetadata(options: {
    topics: string[];
  }): Promise<{ topics: { name: string; partitions: unknown[] }[] }>;
  describeConfigs(options: {
    includeSynonyms: boolean;
    resources: { type: number; name: string; configNames: string[] }[];
  }): Promise<{
    resources: {
      resourceName: string;
      configEntries: { configName: string; configValue: string }[];
    }[];
  }>;
  alterConfigs(options: {
    validateOnly: boolean;
    resources: { type: number; name: string; configEntries: { name: string; value: string }[] }[];
  }): Promise<unknown>;
  createPartitions(options: {
    topicPartitions: { topic: string; count: number }[];
  }): Promise<unknown>;
}

/** Shape of infra/redpanda/topics.policy.json. */
export interface TopicPolicy {
  environments: Record<
    string,
    { partitions: number; replication: number; min_insync_replicas?: number }
  >;
  /** Retention class → topic-name prefixes (`order.` matches `order.placed`). Every event topic needs exactly one. */
  retention: { forever: string[]; days_30: string[] };
  dlq: { prefix: string; consumer_groups: string[] };
}

export type RetentionClass = keyof TopicPolicy['retention'];

export interface TopicSpec {
  name: string;
  kind: 'event' | 'dlq';
  /** The event topic or the consumer group this topic serves. */
  source: string;
  partitions: number;
  replication: number;
  /** Broker configs the script manages. Anything else stays at the broker default. */
  configs: Record<string, string>;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS: Record<RetentionClass, string> = {
  forever: '-1',
  days_30: String(30 * DAY_MS),
};

/** Kafka's own rule for topic names. */
const TOPIC_NAME = /^[a-zA-Z0-9._-]{1,249}$/;
const GROUP_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * The retention class of an event topic, by prefix match against the policy. Throws when none or more than
 * one class claims the topic: a schema without a retention decision must fail the build, not default silently.
 */
export function retentionClassOf(topic: string, policy: TopicPolicy): RetentionClass {
  const classes = (Object.keys(policy.retention) as RetentionClass[]).filter((c) =>
    policy.retention[c].some((prefix) => topic.startsWith(prefix)),
  );
  if (classes.length === 1) return classes[0]!;
  if (classes.length === 0) {
    throw new Error(
      `topic ${topic} has no retention class in topics.policy.json (add its prefix to "forever" or "days_30")`,
    );
  }
  throw new Error(`topic ${topic} matches more than one retention class: ${classes.join(', ')}`);
}

/** `dlq.<groupId>`: the compacted dead-letter topic of one consumer group. */
export function dlqTopicName(groupId: string, policy?: Pick<TopicPolicy, 'dlq'>): string {
  if (!GROUP_ID.test(groupId)) {
    throw new Error(
      `invalid consumer group id "${groupId}" (lowercase letters, digits, . _ -; max 100)`,
    );
  }
  return `${policy?.dlq.prefix ?? 'dlq.'}${groupId}`;
}

/**
 * The Kafka message key: `store_id`, so one store's events share a partition and keep their order.
 * Organization-scope events (store_id null) are keyed by `organization_id`: ordered among themselves per
 * organization, but not relative to any store's stream (documented in infra/redpanda/README.md).
 */
export function partitionKey(e: { store_id: string | null; organization_id: string }): string {
  return e.store_id ?? e.organization_id;
}

/** Kafka folds `.` and `_` into the same metric name; two topics that collide there are a mistake. */
export function metricName(topic: string): string {
  return topic.replace(/\./g, '_');
}

export interface PlanOptions {
  /** Key into policy.environments. Default `local`. */
  environment?: string;
  /** Test isolation: every name gets this prefix (`t-abc.`), so a test never touches the real topics. */
  prefix?: string;
  /** Consumer groups that get a DLQ, in addition to policy.dlq.consumer_groups. */
  consumerGroups?: string[];
  /** Restrict to these event topics (tests). Default: every topic in EVENT_TOPICS. */
  topics?: readonly string[];
}

/** The full list of topics the broker must have. Pure; fails fast on an unknown environment or an unclassified topic. */
export function planTopics(policy: TopicPolicy, opts: PlanOptions = {}): TopicSpec[] {
  const envName = opts.environment ?? 'local';
  const env = policy.environments[envName];
  if (!env) {
    throw new Error(
      `unknown environment "${envName}" (policy has: ${Object.keys(policy.environments).join(', ')})`,
    );
  }
  const prefix = opts.prefix ?? '';
  const topics = opts.topics ?? EVENT_TOPICS;
  const base: Record<string, string> = env.min_insync_replicas
    ? { 'min.insync.replicas': String(env.min_insync_replicas) }
    : {};

  const specs: TopicSpec[] = topics.map((topic) => ({
    name: `${prefix}${topic}`,
    kind: 'event',
    source: topic,
    partitions: env.partitions,
    replication: env.replication,
    configs: {
      ...base,
      'cleanup.policy': 'delete',
      'retention.ms': RETENTION_MS[retentionClassOf(topic, policy)],
    },
  }));

  const groups = [...new Set([...policy.dlq.consumer_groups, ...(opts.consumerGroups ?? [])])];
  for (const groupId of groups) {
    specs.push({
      name: `${prefix}${dlqTopicName(groupId, policy)}`,
      kind: 'dlq',
      source: groupId,
      partitions: env.partitions,
      replication: env.replication,
      // Compacted and kept forever: the latest failure per outbox id wins, a successful replay tombstones it.
      configs: { ...base, 'cleanup.policy': 'compact', 'retention.ms': '-1' },
    });
  }

  const seen = new Map<string, string>();
  for (const s of specs) {
    if (!TOPIC_NAME.test(s.name)) throw new Error(`invalid topic name "${s.name}"`);
    const m = metricName(s.name);
    const other = seen.get(m);
    if (other && other !== s.name) {
      throw new Error(`topics "${other}" and "${s.name}" collide in Kafka metric names (${m})`);
    }
    seen.set(m, s.name);
  }
  return specs;
}

export const DEFAULT_BROKERS = ['127.0.0.1:19092'];

/** KAFKA_BROKERS (comma separated) or the local compose broker. */
export function brokersFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.KAFKA_BROKERS?.trim();
  return raw
    ? raw
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean)
    : [...DEFAULT_BROKERS];
}

/**
 * Loopback pin: the compose broker advertises `localhost:19092`, and Node 20 resolves `localhost` to `::1`
 * first, which Docker Desktop's IPv6 loopback proxy drops now and then while IPv4 keeps working (the same
 * gotcha as the DATABASE_URL rows). Every connection to `localhost` goes to 127.0.0.1 instead.
 */
export function ipv4LoopbackSocketFactory({
  host,
  port,
  ssl,
  onConnect,
}: ISocketFactoryArgs): net.Socket {
  const target = host === 'localhost' ? '127.0.0.1' : host;
  const socket = ssl
    ? tls.connect({ host: target, port, servername: host, ...ssl }, onConnect)
    : net.connect({ host: target, port }, onConnect);
  socket.setKeepAlive(true, 60_000);
  return socket;
}

export interface CreateKafkaOptions {
  brokers?: string[];
  clientId?: string;
  logLevel?: logLevel;
  /** Extra kafkajs options (ssl, sasl, …) — none locally. */
  config?: Partial<KafkaConfig>;
}

/** One kafkajs client with our defaults: env brokers, loopback pin, quiet logger. */
export function createKafka(opts: CreateKafkaOptions = {}): Kafka {
  return new Kafka({
    clientId: opts.clientId ?? 'platform-events',
    brokers: opts.brokers ?? brokersFromEnv(),
    logLevel: opts.logLevel ?? logLevel.ERROR,
    socketFactory: ipv4LoopbackSocketFactory,
    // A broker that accepts the connection and never answers must fail a request, not hang it (the relay holds
    // a database transaction while it waits): bounded connect and request times, enforced client-side.
    connectionTimeout: 3_000,
    requestTimeout: 10_000,
    enforceRequestTimeout: true,
    ...opts.config,
  });
}

export interface EnsureResult {
  created: string[];
  altered: { topic: string; changes: Record<string, { from: string | null; to: string }> }[];
  partitionsRaised: { topic: string; from: number; to: number }[];
  unchanged: string[];
  warnings: string[];
}

export interface EnsureOptions {
  /** Report what would change without touching the broker. */
  dryRun?: boolean;
}

/** Per-topic CreateTopics errors that mean "try again shortly", not "the request is wrong". */
const RETRIABLE_CREATE_ERRORS = new Set([
  // Redpanda answers this when the partition allocator has no room yet: a dev container (512 MiB, 4 MiB per
  // partition = 128 partitions) is still reclaiming the partitions of topics deleted a moment ago.
  'INVALID_PARTITIONS',
  'REQUEST_TIMED_OUT',
  'NOT_CONTROLLER',
  'LEADER_NOT_AVAILABLE',
  'UNKNOWN_TOPIC_OR_PARTITION',
  // the previous attempt did create it before the response was lost
  'TOPIC_ALREADY_EXISTS',
]);

const CREATE_ATTEMPTS = 6;
const CREATE_BACKOFF_MS = 500;

type CreateError = Error & { errors?: (Error & { type?: string; topic?: string })[] };

/**
 * One CreateTopics call for every missing topic, retried for the topics that failed with a retriable error
 * (bounded: 6 attempts, 0.5 s → 2.5 s). Partial success is normal: a broker that creates 4 of 39 and refuses
 * the rest gets the remaining 35 again. A non-retriable error, or the attempts running out, throws.
 */
async function createWithRetry(
  admin: TopicAdmin,
  specs: TopicSpec[],
  warnings: string[],
): Promise<void> {
  let pending = specs;
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.createTopics({
        waitForLeaders: true,
        topics: pending.map((s) => ({
          topic: s.name,
          numPartitions: s.partitions,
          replicationFactor: s.replication,
          configEntries: Object.entries(s.configs).map(([name, value]) => ({ name, value })),
        })),
      });
      return;
    } catch (err) {
      const errors = (err as CreateError).errors ?? [];
      const retriable = errors.filter((e) => e.type && RETRIABLE_CREATE_ERRORS.has(e.type));
      if (errors.length === 0 || retriable.length !== errors.length || attempt >= CREATE_ATTEMPTS) {
        throw err;
      }
      const existing = new Set(await admin.listTopics());
      pending = pending.filter((s) => !existing.has(s.name));
      if (pending.length === 0) return;
      const reasons = [...new Set(retriable.map((e) => e.type))].join(', ');
      warnings.push(
        `createTopics attempt ${attempt}: ${pending.length} topic(s) refused (${reasons}), retrying`,
      );
      await new Promise((r) => setTimeout(r, CREATE_BACKOFF_MS * attempt));
    }
  }
}

/**
 * Makes the broker match `plan`, idempotently: creates missing topics, aligns the managed configs of existing
 * ones (only on drift), raises partition counts the policy raised, and never deletes anything. A second run
 * returns created [] / altered [] / partitionsRaised []. Partition counts cannot be lowered in Kafka: a topic
 * with more partitions than the policy says is reported as a warning and left alone.
 */
export async function ensureTopics(
  admin: TopicAdmin,
  plan: TopicSpec[],
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  const result: EnsureResult = {
    created: [],
    altered: [],
    partitionsRaised: [],
    unchanged: [],
    warnings: [],
  };
  const existing = new Set(await admin.listTopics());
  const missing = plan.filter((s) => !existing.has(s.name));
  const present = plan.filter((s) => existing.has(s.name));

  if (missing.length > 0) {
    result.created = missing.map((s) => s.name);
    if (!opts.dryRun) await createWithRetry(admin, missing, result.warnings);
  }

  if (present.length === 0) return result;

  // listTopics() above is the existence check; fetchTopicMetadata on an unknown topic would auto-create it
  // (Redpanda's dev-container mode enables auto_create_topics), so it only ever sees present topics.
  const { topics: metadata } = await admin.fetchTopicMetadata({
    topics: present.map((s) => s.name),
  });
  const partitionsByTopic = new Map(metadata.map((t) => [t.name, t.partitions.length]));

  const managedKeys = [...new Set(present.flatMap((s) => Object.keys(s.configs)))];
  const { resources } = await admin.describeConfigs({
    includeSynonyms: false,
    resources: present.map((s) => ({
      type: ConfigResourceTypes.TOPIC,
      name: s.name,
      configNames: managedKeys,
    })),
  });
  const currentByTopic = new Map(
    resources.map((r) => [
      r.resourceName,
      new Map(r.configEntries.map((c) => [c.configName, c.configValue])),
    ]),
  );

  const alterations: {
    type: number;
    name: string;
    configEntries: { name: string; value: string }[];
  }[] = [];
  for (const spec of present) {
    let changed = false;
    const current = currentByTopic.get(spec.name) ?? new Map<string, string>();
    const changes: EnsureResult['altered'][number]['changes'] = {};
    for (const [key, want] of Object.entries(spec.configs)) {
      const have = current.get(key) ?? null;
      if (have !== want) changes[key] = { from: have, to: want };
    }
    if (Object.keys(changes).length > 0) {
      changed = true;
      result.altered.push({ topic: spec.name, changes });
      alterations.push({
        type: ConfigResourceTypes.TOPIC,
        name: spec.name,
        configEntries: Object.entries(spec.configs).map(([name, value]) => ({ name, value })),
      });
    }
    const have = partitionsByTopic.get(spec.name) ?? 0;
    if (have < spec.partitions) {
      changed = true;
      result.partitionsRaised.push({ topic: spec.name, from: have, to: spec.partitions });
    } else if (have > spec.partitions) {
      result.warnings.push(
        `${spec.name} has ${have} partitions, policy says ${spec.partitions}: Kafka cannot lower a count, left as is`,
      );
    }
    if (!changed) result.unchanged.push(spec.name);
  }

  if (!opts.dryRun) {
    // AlterConfigs (not the incremental variant) sets the whole non-default config of a topic; we manage every
    // key we set and leave the rest at defaults, so sending the full managed set is exact, not lossy.
    if (alterations.length > 0)
      await admin.alterConfigs({ validateOnly: false, resources: alterations });
    if (result.partitionsRaised.length > 0) {
      await admin.createPartitions({
        topicPartitions: result.partitionsRaised.map((p) => ({ topic: p.topic, count: p.to })),
      });
    }
  }
  return result;
}
