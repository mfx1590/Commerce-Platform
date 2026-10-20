// Process entry point (`pnpm start`, `pnpm once`): boot, serve, poll (#360).
import {
  connectionStringFromEnv,
  createOrganizationClient,
  createPool,
  loadDotenv,
} from '@platform/db';
import { createStaffAuth } from './auth.js';
import { brandProfile } from './brands.js';
import { resolveConfig } from './config.js';
import {
  errorLabel,
  resolveStores,
  runOnce,
  type ConsumerDeps,
  type RunReport,
} from './consumer.js';
import { createNotificationsServer } from './server.js';
import { createTransport } from './transport/index.js';
import { consoleLogger } from './types.js';

async function main(): Promise<void> {
  loadDotenv();
  const config = resolveConfig(process.env, process.argv.slice(2));
  const log = consoleLogger;

  const pool = createPool(connectionStringFromEnv('app'), 5);
  const client = createOrganizationClient(pool, {
    organizationId: config.organizationId,
    actorId: null,
  });
  const stores = await resolveStores(client, config.storeCodes);
  const transport = createTransport(config, process.env);
  const brands = (code: string) => brandProfile(code, process.env);
  const deps: ConsumerDeps = {
    client,
    transport,
    brands,
    log,
    batchSize: config.batchSize,
    maxAttempts: config.maxAttempts,
    lookback: config.lookback,
  };

  if (config.once) {
    const report = await runOnce(deps, stores);
    log.info(`notifications: once ${JSON.stringify(report)}`);
    await pool.end();
    return;
  }

  let lastRun: RunReport | null = null;
  const auth = createStaffAuth({
    client,
    devTokens: config.devTokens,
    keycloakUrl: config.keycloakUrl,
    keycloakRealm: config.keycloakRealm,
  });
  const server = createNotificationsServer({
    auth,
    brands,
    stores,
    log,
    status: () => ({
      transport: transport.name,
      stores: stores.map((s) => s.code),
      last_run: lastRun,
    }),
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log.info(
    `notifications: listening on :${config.port} transport=${transport.name} stores=${config.storeCodes.join(',')} poll=${config.pollMs}ms${config.devTokens ? ' dev-tokens=on' : ''}`,
  );

  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    try {
      lastRun = await runOnce(deps, stores);
    } catch (err) {
      log.error(`notifications: run failed: ${errorLabel(err)}`);
    }
    if (!stopping) timer = setTimeout(() => void tick(), config.pollMs);
  };
  void tick();

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  console.error(`notifications: failed to start: ${errorLabel(err)}`);
  process.exit(1);
});
