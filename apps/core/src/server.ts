// Entry point of @platform/core. Equivalent to `medusa start`, with one difference that the contract needs:
// middleware mounted here runs BEFORE everything Medusa registers (Express keeps registration order), so our
// request id, header alias, tenant context and staff auth sit in front of Medusa's own `/store` publishable-key
// gate and `/admin` auth. Everything else (config, modules, file-based routes in src/api, workflows, subscribers,
// jobs) is Medusa's standard loader chain.
import loaders from '@medusajs/medusa/loaders/index';
import { ContainerRegistrationKeys, GracefulShutdownServer } from '@medusajs/framework/utils';
import type { Logger } from '@medusajs/framework/types';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import {
  aliasPublishableKeyHeader,
  coreErrorHandler,
  DevTokenVerifier,
  mountStoreRoutes,
  requestIdMiddleware,
  staffAuthMiddleware,
  storeContextMiddleware,
  type StaffTokenVerifier,
} from './http';
import { closePool, initDb } from './lib/db';

export interface CoreServer {
  app: express.Express;
  shutdown: () => Promise<void>;
  logger: Logger;
}

export interface CreateServerOptions {
  /** Project root Medusa scans (medusa-config.ts, src/api, …): apps/core in dev, .medusa/server after build. */
  directory?: string;
  /** Staff token verifier; @platform/auth-sdk replaces the Phase 1 dev-token verifier here. */
  staffTokenVerifier?: StaffTokenVerifier;
}

/**
 * Mounts our pre-Medusa middleware on an Express app. Exported so tests can exercise the exact chain the server
 * runs (with their own routes) without booting Medusa.
 */
export function mountCoreMiddleware(
  app: express.Express,
  verifier: StaffTokenVerifier = new DevTokenVerifier(),
): void {
  app.use(requestIdMiddleware);

  // Liveness probe: answers before any session/auth middleware, no database round trip.
  app.get('/health', (_req, res) => {
    res.status(200).send('OK');
  });

  // Contract header → Medusa header (Medusa's own gate still runs after ours; task 1.8 mirrors the keys).
  app.use(aliasPublishableKeyHeader);
  // Store API: 401 without a valid X-Publishable-Key; req.tenant otherwise (ADR 0001).
  app.use('/store', storeContextMiddleware);
  // The Store API routes window 1 owns (contracts store-api.yaml: GET /store, /store/categories,
  // /store/products, /store/products/{handle}) answer here, ahead of Medusa's own routes of the same paths and
  // of its publishable-key gate — our tenant middleware is the contract's key check. Every other Store API path
  // falls through to Medusa (and, in Phase 1, stays on the Prism mock for clients).
  mountStoreRoutes(app);
  // Admin API: 401 without a valid staff token; req.principal otherwise. Our admin route files opt out of
  // Medusa's auth (`export const AUTHENTICATE = false`).
  app.use('/admin', staffAuthMiddleware(verifier));
  // Renders AppError as the contract's { code, message, details } for everything above.
  app.use(coreErrorHandler);
}

/** Builds the Express app with our middleware and Medusa fully loaded. */
export async function createServer(opts: CreateServerOptions = {}): Promise<CoreServer> {
  const directory = opts.directory ?? path.resolve(__dirname, '..');
  // Loads the repo-root .env (medusa-config.ts reads process.env only) and opens our platform_app pool.
  await initDb({ startDir: directory });
  const app = express();
  mountCoreMiddleware(app, opts.staffTokenVerifier);

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
