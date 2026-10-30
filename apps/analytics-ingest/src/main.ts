// The process: `pnpm start` (long-running) or `pnpm once` (drain to idle, report, exit 0; 1 on a failure).
// The schema is not migrated here: `pnpm ch:migrate` runs first (deploy step / CI), so a consumer never races a
// migration.
import { createServer, type Server } from 'node:http';
import { createKafka, readDeadLetters } from '@platform/events';
import { createChClient, createRawEventsSink } from './clickhouse.js';
import { ConfigError, loadConfig } from './config.js';
import { healthAnswer } from './health.js';
import { createIngest } from './ingest.js';
import { createIngestMetrics } from './metrics.js';
import { waitForIdle, type OnceReport } from './once.js';
import { startTelemetry } from './telemetry.js';

async function main(): Promise<number> {
  const config = loadConfig();
  // #623: an ingest that cannot honour customer.erased must not run at all
  if (!config.erasureKey)
    throw new ConfigError(
      'ANALYTICS_ERASURE_KEY is required (the erasure list key, from env/Vault)',
    );
  // #648: the ingest writes as analytics_ingest (least privilege), never as the ClickHouse admin
  if (config.ingestAsAdmin) {
    if (process.env.NODE_ENV === 'production')
      throw new ConfigError(
        'CLICKHOUSE_INGEST_USER is required in production: the ingest never runs as the ClickHouse admin',
      );
    console.warn(
      JSON.stringify({
        service: 'analytics-ingest',
        event: 'writer_is_admin',
        message: 'CLICKHOUSE_INGEST_USER is not set: writing as CLICKHOUSE_USER (dev only)',
      }),
    );
  }
  const telemetry = startTelemetry(); // before the instruments are created, or they stay no-ops
  const client = createChClient(config.ingestClickhouse);
  const kafka = createKafka({ clientId: `analytics-ingest-${config.groupId}` });
  const ingest = createIngest({
    config,
    kafka,
    sink: createRawEventsSink(client),
    metrics: createIngestMetrics(),
    erasure: { key: config.erasureKey, ch: client },
  });

  let server: Server | undefined;
  if (config.port > 0) {
    // the container contract (apps/analytics-ingest/Dockerfile): GET /health on $PORT, 503 until joined and while
    // stuck (#641; README "Deploying")
    server = createServer((req, res) => {
      const a = healthAnswer(req.url, config.groupId, ingest.health(config.readyStaleMs));
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(a.body);
    }).listen(config.port);
  }

  const shutdown = async (): Promise<void> => {
    await ingest.stop();
    await client.close();
    await telemetry.shutdown();
    server?.close();
  };

  const startedAt = Date.now();
  await ingest.start();

  if (!config.once) {
    await new Promise<void>((done) => {
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => done());
    });
    await shutdown();
    return 0;
  }

  const outcome = await waitForIdle({
    lastBatchAt: ingest.lastBatchAt,
    startedAt,
    idleMs: config.idleMs,
    minRunMs: config.minRunMs,
    maxRunMs: config.maxRunMs,
  });
  await shutdown();
  const dlq = await readDeadLetters(config.groupId, { kafka, topicPrefix: config.topicPrefix });
  const report: OnceReport = {
    service: 'analytics-ingest',
    mode: 'once',
    group_id: config.groupId,
    dlq_topic: config.dlqTopic,
    outcome,
    duration_ms: Date.now() - startedAt,
    batches: ingest.stats.batches,
    rows: ingest.stats.rows,
    rows_by_topic: ingest.stats.rows_by_topic,
    dead_lettered_this_run: ingest.stats.dead_lettered,
    dlq_records: dlq.length,
  };
  console.info(JSON.stringify(report));
  return outcome === 'idle' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      JSON.stringify({
        service: 'analytics-ingest',
        event: 'fatal',
        error_class: (err as Error)?.name ?? 'Error',
        message: (err as Error)?.message,
      }),
    );
    process.exit(1);
  },
);
