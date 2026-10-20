// The outbox relay as a long-lived process (issue #531):
//
//   pnpm --filter @platform/core exec tsx src/outbox/relay-cli.ts [--once] [--batch 500] [--interval-ms 1000]
//
// Env: DATABASE_URL_APP (the app role, organization scope — never the owner), CORE_ORGANIZATION_ID (default: the
// seeded HQ, like every other core job), KAFKA_BROKERS (default 127.0.0.1:19092). Before the first pass it checks
// that every topic the policy derives exists on the broker and refuses to start otherwise (the dev container
// auto-creates topics with the wrong numbers). SIGTERM / SIGINT stop it after the current pass.
// `--once` runs a single pass and exits (runbooks, tests). The per-pass JSON line carries counts only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertTopicsPresent,
  createKafka,
  createKafkaPublisher,
  planTopics,
  type TopicPolicy,
} from '@platform/events';
import { closePool, initDb, organizationClient } from '../lib/db';
import { coreOrganizationId } from '../http/tenant';
import { DEFAULT_BATCH_SIZE, DEFAULT_INTERVAL_MS, relayOnce, runRelayLoop } from './relay';

export const POLICY_PATH = resolve(__dirname, '../../../../infra/redpanda/topics.policy.json');

export interface RelayCliArgs {
  once: boolean;
  batchSize: number;
  intervalMs: number;
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
  };
}

/** The topics the broker must have before the relay publishes: every event topic of the policy. */
export function requiredTopics(policyPath = POLICY_PATH): string[] {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as TopicPolicy;
  return planTopics(policy)
    .filter((s) => s.kind === 'event')
    .map((s) => s.name);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const organizationId = coreOrganizationId();
  await initDb({ startDir: __dirname });
  const kafka = createKafka({ clientId: 'core-outbox-relay' });
  const admin = kafka.admin();
  const publisher = createKafkaPublisher(kafka);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await admin.connect();
    await assertTopicsPresent(admin, requiredTopics());
    await admin.disconnect();
    await publisher.connect();
    const client = organizationClient({ organizationId });
    if (args.once) {
      await relayOnce(client, publisher, { organizationId, batchSize: args.batchSize });
    } else {
      console.info(
        JSON.stringify({
          relay: 'outbox',
          state: 'started',
          organization_id: organizationId,
          batch_size: args.batchSize,
          interval_ms: args.intervalMs,
        }),
      );
      const totals = await runRelayLoop(client, publisher, {
        organizationId,
        batchSize: args.batchSize,
        intervalMs: args.intervalMs,
        signal: controller.signal,
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
