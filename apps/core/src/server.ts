// Entry point of @platform/core. Equivalent to `medusa start`, with one difference that the contract needs:
// middleware mounted here runs BEFORE everything Medusa registers (Express keeps registration order), so our
// header alias — and, from task 1.3, the tenant-context middleware — sits in front of Medusa's own
// `/store` publishable-key gate and `/admin` auth. Everything else (config, modules, file-based routes in
// src/api, workflows, subscribers, jobs) is Medusa's standard loader chain.
import loaders from '@medusajs/medusa/loaders/index';
import { ContainerRegistrationKeys, GracefulShutdownServer } from '@medusajs/framework/utils';
import type { Logger } from '@medusajs/framework/types';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { aliasPublishableKeyHeader } from './http/publishable-key-alias';
import { closePool, initDb } from './lib/db';

export interface CoreServer {
  app: express.Express;
  shutdown: () => Promise<void>;
  logger: Logger;
}

/**
 * Builds the Express app with Medusa fully loaded. `directory` is the project root Medusa scans for
 * medusa-config.ts and src/{api,modules,workflows,…}: apps/core in development (tsx), .medusa/server after
 * `medusa build`.
 */
export async function createServer(directory = path.resolve(__dirname, '..')): Promise<CoreServer> {
  // Loads the repo-root .env (medusa-config.ts reads process.env only) and opens our platform_app pool.
  await initDb(directory);
  const app = express();

  // Liveness probe: answers before any session/auth middleware, no database round trip.
  app.get('/health', (_req, res) => {
    res.status(200).send('OK');
  });

  // Ahead of Medusa: contract header → Medusa header (see src/http/publishable-key-alias.ts).
  app.use(aliasPublishableKeyHeader);

  const { container, shutdown } = await loaders({ directory, expressApp: app });
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  return {
    app,
    logger,
    shutdown: async () => {
      await shutdown();
      await closePool();
    },
  };
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 9000);
  const host = process.env.HOST;
  const { app, shutdown, logger } = await createServer();

  const server = GracefulShutdownServer.create(
    http.createServer(app).listen(port, host, () => {
      logger.info(`@platform/core ready on http://${host ?? 'localhost'}:${port} (GET /health)`);
    }),
  );

  const stop = (): void => {
    logger.info('Gracefully shutting down @platform/core');
    server
      .shutdown()
      .then(shutdown)
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error('Error while shutting down', err);
        process.exit(1);
      });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error starting @platform/core', err);
    process.exit(1);
  });
}
