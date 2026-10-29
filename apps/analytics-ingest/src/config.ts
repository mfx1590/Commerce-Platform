// Configuration from the environment and the command line. The consumer group is resolved ONCE here and every
// part of the process takes it from `IngestConfig.groupId`: the consumer, its DLQ topic and the `--once` report's
// DLQ watch. An override therefore moves all three together; it can never leave the process consuming one group
// while it watches another group's dead letters (#599).
import { dlqTopicName } from '@platform/events';

export const DEFAULT_GROUP = 'analytics.raw';

export interface ClickHouseConfig {
  url: string;
  username: string;
  password: string;
  database: string;
}

export interface IngestConfig {
  groupId: string;
  /** `dlq.<groupId>` under the topic prefix: derived, never configured on its own. */
  dlqTopic: string;
  /** Applied to every event topic and to the DLQ (tests and the CI gate). */
  topicPrefix: string;
  clickhouse: ClickHouseConfig;
  /** Flush when this many rows are buffered… */
  batchSize: number;
  /** …or when the oldest buffered row has waited this long. */
  flushMs: number;
  /** kafkajs partitions handled at once: the buffer fills across them, so the size flush can trigger. */
  concurrency: number;
  once: boolean;
  /** `--once`: quiet for this long after the last batch = drained. */
  idleMs: number;
  /** `--once`: never stop before this (a fresh group needs time to join). */
  minRunMs: number;
  /** `--once`: hard stop. */
  maxRunMs: number;
  /** Health endpoint for the container contract (`GET /health`); 0 = none. */
  port: number;
  /** #623: HMAC key of the erasure list (ANALYTICS_ERASURE_KEY, from env/Vault). The process refuses to start without it. */
  erasureKey: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer ≥ ${min}`);
  return n;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new ConfigError(`${name} needs a value`);
  return v;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): IngestConfig {
  const groupId = (flag(argv, '--group') ?? env.ANALYTICS_GROUP_ID?.trim()) || DEFAULT_GROUP;
  const topicPrefix = (flag(argv, '--topic-prefix') ?? env.ANALYTICS_TOPIC_PREFIX?.trim()) || '';
  let dlq: string;
  try {
    dlq = dlqTopicName(groupId);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  return {
    groupId,
    dlqTopic: `${topicPrefix}${dlq}`,
    topicPrefix,
    clickhouse: {
      url: env.CLICKHOUSE_URL?.trim() || 'http://127.0.0.1:18123',
      username: env.CLICKHOUSE_USER?.trim() || 'default',
      password: env.CLICKHOUSE_PASSWORD ?? '',
      database: env.CLICKHOUSE_DATABASE?.trim() || 'analytics',
    },
    batchSize: int(env, 'ANALYTICS_BATCH_SIZE', 5_000, 1),
    flushMs: int(env, 'ANALYTICS_FLUSH_MS', 1_000, 1),
    concurrency: int(env, 'ANALYTICS_CONCURRENCY', 8, 1),
    once: argv.includes('--once'),
    idleMs: int(env, 'ANALYTICS_IDLE_MS', 5_000, 1),
    minRunMs: int(env, 'ANALYTICS_MIN_RUN_MS', 15_000, 0),
    maxRunMs: int(env, 'ANALYTICS_MAX_RUN_MS', 600_000, 1),
    port: int(env, 'PORT', 0, 0),
    erasureKey: env.ANALYTICS_ERASURE_KEY?.trim() || undefined,
  };
}
