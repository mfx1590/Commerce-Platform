// The outbox relay as a long-lived process (issue #531):
//
//   pnpm --filter @platform/core outbox:relay [--once] [--batch 500] [--interval-ms 1000] [--topic-prefix <p>]
//   (the same as: pnpm --filter @platform/core exec tsx src/outbox/relay-cli.ts …)
// --topic-prefix (#579): publish to `<p><topic>` and require the prefixed topics at start; the database side, the
// schema ids (looked up by the unprefixed topic@version) and the headers are unchanged. For tests on a shared broker.
//
// Env: DATABASE_URL_APP (the app role, organization scope — never the owner), CORE_ORGANIZATION_ID (default: the
// seeded HQ, like every other core job), KAFKA_BROKERS (default 127.0.0.1:19092). Before the first pass it checks
// that every topic the policy derives exists on the broker and refuses to start otherwise (the dev container
// auto-creates topics with the wrong numbers). SIGTERM / SIGINT stop it after the current pass.
// `--once` runs a single pass and exits (runbooks, tests). The per-pass JSON line carries counts only.
// Schema ids (#532): every topic@version is resolved to its registry id at start (SCHEMA_REGISTRY_URL, default
// 127.0.0.1:18081) and stamped as the `schema_id` header; an unreachable registry or a missing schema refuses the
// start. `--no-registry` publishes without the header (runbooks only).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertTopicsPresent,
  createKafka,
  createKafkaPublisher,
  createRegistryClient,
  planTopics,
  resolveSchemaIds,
  type TopicPolicy,
} from '@platform/events';
import { closePool, getPool, initDb, organizationClient } from '../lib/db';
import { coreOrganizationId } from '../http/tenant';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_INTERVAL_MS,
  guardPoolClients,
  relayOnce,
  runRelayLoop,
} from './relay';

export const POLICY_PATH = resolve(__dirname, '../../../../infra/redpanda/topics.policy.json');

export interface RelayCliArgs {
  once: boolean;
  batchSize: number;
  intervalMs: number;
  /** Resolve and stamp schema ids (default true; `--no-registry` turns it off). */
  registry: boolean;
  /** #579: every publish goes to `<topicPrefix><topic>` (tests on a shared broker); empty = the real topics. */
  topicPrefix: string;
}

const TOPIC_PREFIX = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * `--topic-prefix <p>` (#579): a plain string prefix in Kafka's topic charset, the same rule as the consumer SDK's
 * `topicPrefix` and `planTopics({ prefix })`. Absent = '' (the real topics). Present without a usable value = error.
 */
export function parseTopicPrefix(argv: string[]): string {
  const i = argv.indexOf('--topic-prefix');
  if (i === -1) return '';
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error('--topic-prefix needs a value');
  if (!TOPIC_PREFIX.test(v)) {
    throw new Error(
      `--topic-prefix "${v}" is not a Kafka topic prefix (letters, digits, . _ - only)`,
    );
  }
  return v;
}

export function parseArgs(argv: string[]): RelayCliArgs {
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const n = Number(argv[i + 1]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} needs a positive integer`);
    return n;
  };
  return {
    once: argv.includes('--once'),
    batchSize: num('--batch', DEFAULT_BATCH_SIZE),
    intervalMs: num('--interval-ms', DEFAULT_INTERVAL_MS),
    registry: !argv.includes('--no-registry'),
    topicPrefix: parseTopicPrefix(argv),
  };
}

/**
 * The topics the broker must have before the relay publishes: every event topic of the policy, with the
 * `--topic-prefix` applied (#579 rule 2: a prefixed run never needs the real topics, and a missing prefixed
 * topic still refuses the start). Dead-letter topics are never required.
 */
export function requiredTopics(policyPath = POLICY_PATH, topicPrefix = ''): string[] {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as TopicPolicy;
  return planTopics(policy, { prefix: topicPrefix })
    .filter((s) => s.kind === 'event')
    .map((s) => s.name);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const organizationId = coreOrganizationId();
  await initDb({ startDir: __dirname });
  guardPoolClients(getPool());
  const kafka = createKafka({ clientId: 'core-outbox-relay' });
  const admin = kafka.admin();
  const publisher = createKafkaPublisher(kafka);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await admin.connect();
    await assertTopicsPresent(admin, requiredTopics(POLICY_PATH, args.topicPrefix));
    await admin.disconnect();
    let schemaIds: Record<string, number> | undefined;
    if (args.registry) {
      const registry = createRegistryClient();
      if (!(await registry.reachable())) {
        throw new Error(
          `schema registry at ${registry.url} is unreachable (SCHEMA_REGISTRY_URL; or --no-registry for a runbook)`,
        );
      }
      schemaIds = await resolveSchemaIds(registry);
    }
    await publisher.connect();
    const client = organizationClient({ organizationId });
    if (args.once) {
      await relayOnce(client, publisher, {
        organizationId,
        batchSize: args.batchSize,
        topicPrefix: args.topicPrefix,
        ...(schemaIds ? { schemaIds } : {}),
      });
    } else {
      console.info(
        JSON.stringify({
          relay: 'outbox',
          state: 'started',
          organization_id: organizationId,
          batch_size: args.batchSize,
          interval_ms: args.intervalMs,
          topic_prefix: args.topicPrefix,
          schema_ids: schemaIds ? Object.keys(schemaIds).length : 0,
        }),
      );
      const totals = await runRelayLoop(client, publisher, {
        organizationId,
        batchSize: args.batchSize,
        intervalMs: args.intervalMs,
        signal: controller.signal,
        topicPrefix: args.topicPrefix,
        ...(schemaIds ? { schemaIds } : {}),
      });
      console.info(JSON.stringify({ relay: 'outbox', state: 'stopped', ...totals }));
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await publisher.disconnect().catch(() => {});
    await closePool();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    // the class and message of a start-up failure (missing topic, unreachable broker); never a row
    console.error(`outbox-relay failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
