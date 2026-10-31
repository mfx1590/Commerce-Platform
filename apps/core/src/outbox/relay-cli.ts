// The outbox relay as a long-lived process (issue #531):
//
//   pnpm --filter @platform/core outbox:relay [--once] [--batch 500] [--interval-ms 1000] [--topic-prefix <p>]
//   (the same as: pnpm --filter @platform/core exec tsx src/outbox/relay-cli.ts …)
// --topic-prefix (#579): publish to `<p><topic>` and require the prefixed topics at start; the database side, the
// schema ids (looked up by the unprefixed topic@version) and the headers are unchanged. For tests on a shared broker.
// WARNING: the relay MARKS every row it publishes, so a prefixed relay against the shared dev database would publish
// the real unpublished rows to `<p>*` and hide them from the real consumers for good. Therefore --topic-prefix needs
// --throwaway-db, and --throwaway-db refuses the shared dev database (`platform` and the database the repo-root
// .env names); the other way round, --throwaway-db needs --topic-prefix (#640), so a throwaway database's rows never
// reach the real topics. Recovery after a mistaken run: the rows are published, so an UNPREFIXED
// `outbox:replay --topic <t> --after-seq <s>` republishes them to the real topics (consumers dedupe), where <s> is
// below the LOWEST seq that was still unpublished before the run (`SELECT min(seq) - 1 FROM outbox WHERE
// published_at IS NULL`, taken before; stuck rows can sit far below the high-water mark), or replay the whole topic.
// Argument errors exit 2; a refused start (missing topic, unreachable registry) exits 1.
//
// Env: DATABASE_URL_APP (the app role, organization scope — never the owner), CORE_ORGANIZATION_ID (default: the
// seeded HQ, like every other core job), KAFKA_BROKERS (default 127.0.0.1:19092). Before the first pass it checks
// that every topic the policy derives exists on the broker and refuses to start otherwise (the dev container
// auto-creates topics with the wrong numbers). SIGTERM / SIGINT stop it after the current pass.
// `--once` runs a single pass and exits (runbooks, tests). The per-pass JSON line carries counts only.
// Schema ids (#532): every topic@version is resolved to its registry id at start (SCHEMA_REGISTRY_URL, default
// 127.0.0.1:18081) and stamped as the `schema_id` header; an unreachable registry or a missing schema refuses the
// start. `--no-registry` publishes without the header (runbooks only).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  /** `--throwaway-db`: the database must not be the shared dev database (checked with current_database()). */
  throwawayDb: boolean;
}

/** A usage error (bad or contradictory arguments): the CLIs exit 2 for it, 1 for a refused start. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const PREFIX_NEEDS_THROWAWAY =
  '--topic-prefix on the relay needs --throwaway-db: the relay marks every row it publishes, so a prefixed relay ' +
  'against the shared dev database would hide those rows from the real consumers; and --throwaway-db refuses the ' +
  'shared dev database (platform, or the database the repo-root .env names)';

export const THROWAWAY_NEEDS_PREFIX =
  '--throwaway-db on the relay needs --topic-prefix: a throwaway database holds fixture rows, and an unprefixed ' +
  'relay would publish them to the real topics on the shared broker, where the real consumers would act on them';

const TOPIC_PREFIX = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * `--topic-prefix <p>` (#579): a plain string prefix in Kafka's topic charset, the same rule as the consumer SDK's
 * `topicPrefix` and `planTopics({ prefix })`. Absent = '' (the real topics). Present without a usable value = error.
 */
export function parseTopicPrefix(argv: string[]): string {
  const i = argv.indexOf('--topic-prefix');
  if (i === -1) return '';
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--'))
    throw new CliUsageError('--topic-prefix needs a value');
  if (!TOPIC_PREFIX.test(v)) {
    throw new CliUsageError(
      `--topic-prefix "${v}" is not a Kafka topic prefix (letters, digits, . _ - only)`,
    );
  }
  return v;
}

export function parseArgs(argv: string[]): RelayCliArgs {
  const topicPrefix = parseTopicPrefix(argv);
  const throwawayDb = argv.includes('--throwaway-db');
  if (topicPrefix && !throwawayDb) throw new CliUsageError(PREFIX_NEEDS_THROWAWAY);
  if (throwawayDb && !topicPrefix) throw new CliUsageError(THROWAWAY_NEEDS_PREFIX);
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const n = Number(argv[i + 1]);
    if (!Number.isInteger(n) || n <= 0) throw new CliUsageError(`${flag} needs a positive integer`);
    return n;
  };
  return {
    once: argv.includes('--once'),
    batchSize: num('--batch', DEFAULT_BATCH_SIZE),
    intervalMs: num('--interval-ms', DEFAULT_INTERVAL_MS),
    registry: !argv.includes('--no-registry'),
    topicPrefix,
    throwawayDb,
  };
}

/**
 * The names of the shared dev database: always `platform`, plus the database names in the repo-root .env's
 * DATABASE_URL and DATABASE_URL_APP — read from the FILE, because the process environment may have been pointed at
 * a throwaway database (which is the whole point of the flag).
 */
export function sharedDatabaseNames(startDir = __dirname): Set<string> {
  const names = new Set(['platform']);
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*(DATABASE_URL(?:_APP)?)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        try {
          const name = new URL(m[2]!.replace(/^(['"])(.*)\1$/, '$2')).pathname.replace(/^\//, '');
          if (name) names.add(name);
        } catch {
          /* not a URL: nothing to add */
        }
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return names;
}

/** `--throwaway-db`: refuses (CliUsageError, exit 2) when the connected database is the shared dev database. */
export async function assertThrowawayDatabase(
  q: { query<R extends Record<string, unknown>>(text: string): Promise<{ rows: R[] }> },
  shared: Set<string> = sharedDatabaseNames(),
): Promise<string> {
  const name =
    (await q.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name ?? '';
  if (shared.has(name)) {
    throw new CliUsageError(
      `--throwaway-db: the database is "${name}", the shared dev database (refused: ${[...shared].join(', ')}). Point DATABASE_URL_APP at a throwaway database.`,
    );
  }
  return name;
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
  if (args.throwawayDb) {
    // before anything is read or published: a prefixed relay never touches the shared dev database
    await assertThrowawayDatabase(organizationClient({ organizationId }));
  }
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
    process.exit(err instanceof CliUsageError ? 2 : 1);
  });
}
