// Replay historical outbox rows to the bus (issue #534):
//
//   pnpm --filter @platform/core outbox:replay --topic order.placed [--from 2026-10-01T00:00:00Z] [--to <ts>]
//                                              [--store <store id>] [--after-seq <seq>] [--dry-run] [--batch 500]
//                                              [--no-registry] [--topic-prefix <p>]
//
// Republishes PUBLISHED rows of one topic in seq order with the relay's wire format plus `replay: 1` and
// `replayed_at` headers; writes nothing to the database. `--dry-run` prints the counts only. Same env as the
// relay: DATABASE_URL_APP, CORE_ORGANIZATION_ID, KAFKA_BROKERS, SCHEMA_REGISTRY_URL. The summary line carries
// counts, ids and timestamps only.
import {
  assertTopicsPresent,
  createKafka,
  createKafkaPublisher,
  createRegistryClient,
  resolveSchemaIds,
} from '@platform/events';
import { closePool, getPool, initDb, organizationClient } from '../lib/db';
import { coreOrganizationId } from '../http/tenant';
import { guardPoolClients } from './relay';
import { parseTopicPrefix } from './relay-cli';
import { DEFAULT_REPLAY_BATCH, replayOutbox, type ReplayOptions } from './replay';

export interface ReplayCliArgs {
  topic: string;
  from?: Date;
  to?: Date;
  storeId?: string;
  dryRun: boolean;
  batchSize: number;
  registry: boolean;
  /** #579: publish to `<topicPrefix><topic>`; --topic stays the unprefixed event topic. */
  topicPrefix: string;
  afterSeq?: string;
}

export function parseReplayArgs(argv: string[]): ReplayCliArgs {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const date = (flag: string): Date | undefined => {
    const v = value(flag);
    if (v === undefined) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime()))
      throw new Error(`${flag} needs an RFC-3339 timestamp (got ${v})`);
    return d;
  };
  const topic = value('--topic');
  if (!topic) throw new Error('--topic <event topic> is required');
  const batchRaw = value('--batch');
  const batchSize = batchRaw === undefined ? DEFAULT_REPLAY_BATCH : Number(batchRaw);
  if (!Number.isInteger(batchSize) || batchSize <= 0)
    throw new Error('--batch needs a positive integer');
  const from = date('--from');
  const to = date('--to');
  const storeId = value('--store');
  const afterSeq = value('--after-seq');
  if (afterSeq !== undefined && !/^\d{1,19}$/.test(afterSeq)) {
    throw new Error(`--after-seq needs a non-negative integer seq (got ${afterSeq})`);
  }
  return {
    topic,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(storeId ? { storeId } : {}),
    dryRun: argv.includes('--dry-run'),
    batchSize,
    registry: !argv.includes('--no-registry'),
    topicPrefix: parseTopicPrefix(argv),
    ...(afterSeq !== undefined ? { afterSeq } : {}),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseReplayArgs(argv);
  const organizationId = coreOrganizationId();
  await initDb({ startDir: __dirname });
  guardPoolClients(getPool());
  const kafka = createKafka({ clientId: 'core-outbox-replay' });
  const publisher = createKafkaPublisher(kafka);
  try {
    const client = organizationClient({ organizationId });
    const base: ReplayOptions = {
      organizationId,
      topic: args.topic,
      batchSize: args.batchSize,
      dryRun: args.dryRun,
      ...(args.from ? { from: args.from } : {}),
      ...(args.to ? { to: args.to } : {}),
      ...(args.storeId ? { storeId: args.storeId } : {}),
      ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
      topicPrefix: args.topicPrefix,
    };
    if (args.dryRun) {
      console.info(JSON.stringify(await replayOutbox(client, { send: async () => {} }, base)));
      return;
    }
    const admin = kafka.admin();
    await admin.connect();
    await assertTopicsPresent(admin, [`${args.topicPrefix}${args.topic}`]);
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
    const summary = await replayOutbox(client, publisher, {
      ...base,
      ...(schemaIds ? { schemaIds } : {}),
    });
    console.info(JSON.stringify(summary));
  } finally {
    await publisher.disconnect().catch(() => {});
    await closePool();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`outbox-replay failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
