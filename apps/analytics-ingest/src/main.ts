// The process: `pnpm start` (long-running) or `pnpm once` (drain to idle, report, exit 0; 1 on a failure).
// The schema is not migrated here: `pnpm ch:migrate` runs first (deploy step / CI), so a consumer never races a
// migration.
import { createServer, type Server } from 'node:http';
import { createKafka, readDeadLetters } from '@platform/events';
import { createChClient, createRawEventsSink } from './clickhouse.js';
import { ConfigError, loadConfig } from './config.js';
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
  const telemetry = startTelemetry(); // before the instruments are created, or they stay no-ops
  const client = createChClient(config.clickhouse);
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
    // the container contract (apps/analytics-ingest/Dockerfile): GET /health on $PORT
    server = createServer((req, res) => {
      res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(
        req.url === '/health' ? JSON.stringify({ ok: true, group_id: config.groupId }) : '{}',
      );
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
