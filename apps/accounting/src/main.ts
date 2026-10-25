// Process entry point (`pnpm start`, `pnpm once`, `pnpm dev`): app-role pool, organization-scoped client, the ledger
// consumer, /health. SIGTERM / SIGINT stop the consumer after the message in flight.
import {
  connectionStringFromEnv,
  createOrganizationClient,
  createPool,
  loadDotenv,
} from '@platform/db';
import { createFinanceAuth } from './api/auth.js';
import { createAccountingApi } from './api/server.js';
import { resolveConfig } from './config.js';
import { createLedgerConsumer } from './consumer.js';
import { consoleLogger, errorClassOf } from './log.js';
import { createHealthServer } from './server.js';

async function main(): Promise<void> {
  loadDotenv();
  const config = resolveConfig(process.env, process.argv.slice(2));
  const log = consoleLogger;

  const pool = createPool(connectionStringFromEnv('app'), 5);
  const client = createOrganizationClient(pool, {
    organizationId: config.organizationId,
    actorId: null,
  });

  let lastBatchAt = Date.now();
  const consumer = createLedgerConsumer({
    client,
    log,
    groupId: config.groupId,
    retries: config.retries,
    onBatch: () => {
      lastBatchAt = Date.now();
    },
  });

  const api = createAccountingApi({
    client,
    log,
    auth: createFinanceAuth({
      client,
      devTokens: config.devTokens,
      ...(config.keycloakUrl ? { keycloakUrl: config.keycloakUrl } : {}),
      ...(config.keycloakRealm ? { keycloakRealm: config.keycloakRealm } : {}),
    }),
  });
  const server = createHealthServer(
    () => ({
      group: config.groupId,
      organization_id: config.organizationId,
      stats: consumer.stats,
    }),
    api,
  );
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  await consumer.start();
  log.info({
    event: 'started',
    group: config.groupId,
    organization_id: config.organizationId,
    port: config.port,
    once: config.once,
  });

  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ event: 'stopping', reason, stats: consumer.stats });
    await consumer.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    log.info({ event: 'stopped', stats: consumer.stats });
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));

  if (config.once) {
    // idle = no batch from the bus for onceIdleMs after the start
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (Date.now() - lastBatchAt >= config.onceIdleMs) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
    });
    await shutdown('idle');
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      service: 'accounting',
      event: 'failed_to_start',
      error_class: errorClassOf(err),
    }),
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
