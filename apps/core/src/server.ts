// Entry point of @platform/core. Equivalent to `medusa start`, with one difference that the contract needs:
// middleware mounted here runs BEFORE everything Medusa registers (Express keeps registration order), so our
// request id, header alias, tenant context and staff auth sit in front of Medusa's own `/store` publishable-key
// gate and `/admin` auth. Everything else (config, modules, file-based routes in src/api, workflows, subscribers,
// jobs) is Medusa's standard loader chain.
import loaders from '@medusajs/medusa/loaders/index';
import { ContainerRegistrationKeys, GracefulShutdownServer } from '@medusajs/framework/utils';
import type { Logger } from '@medusajs/framework/types';
import { createOpenFgaClient, type OpenFgaClient } from '@platform/auth-sdk';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import {
  aliasPublishableKeyHeader,
  coreErrorHandler,
  adminRouter,
  composeStaffTokenVerifier,
  DEV_TOKENS_FLAG,
  devTokensEnabled,
  DevTokenVerifier,
  hqRbacAdapter,
  KeycloakStaffTokenVerifier,
  moduleAdminRouters,
  moduleWebhookRouters,
  mountStoreRoutes,
  requestIdMiddleware,
  staffAuthMiddleware,
  STORE_API_FALLBACK_ENV,
  storeApiFallbackProxy,
  storeContextMiddleware,
  type StaffTokenVerifier,
} from './http';
import { formatReport, verifyBootstrap } from './bootstrap';
import { closePool, initDb } from './lib/db';

export interface CoreServer {
  app: express.Express;
  shutdown: () => Promise<void>;
  logger: Logger;
}

export interface CreateServerOptions {
  /** Project root Medusa scans (medusa-config.ts, src/api, …): apps/core in dev, .medusa/server after build. */
  directory?: string;
  /** Staff token verifier override; default `buildStaffAuth()` (Keycloak + OpenFGA, dev tokens opt-in). */
  staffTokenVerifier?: StaffTokenVerifier;
}

export interface CoreMiddlewareOptions {
  /** OpenFGA client for hq-rbac's own checks; default `createOpenFgaClient()` from `OPENFGA_*`. */
  fga?: OpenFgaClient;
  /** Scope-cache invalidation on role changes (`KeycloakStaffTokenVerifier.invalidate`). */
  onRoleChange?: (staffUserId: string) => void;
  /** Non-production only: base URL every unhandled `/store/*` request is proxied to (Integration 1). */
  storeApiFallbackUrl?: string;
  /**
   * Admin routers of other windows' modules, mounted after adminRouter(). createServer() passes
   * `moduleAdminRouters()`; the default is NONE so a module's own tests can mount their router (with fakes)
   * behind the same middleware without the production one answering first.
   */
  moduleRouters?: express.Router[];
  /**
   * Provider webhook routers (raw body, signature = authentication), mounted outside the `/store` and `/admin`
   * chains. createServer() passes `moduleWebhookRouters()`; the default is NONE, same rule as `moduleRouters`.
   */
  webhookRouters?: express.Router[];
}

/** The staff auth src/server.ts runs: real Keycloak tokens by default, `dev:` tokens only with CORE_DEV_TOKENS=1. */
export interface StaffAuth {
  verifier: StaffTokenVerifier;
  fga: OpenFgaClient;
  onRoleChange: (staffUserId: string) => void;
}

/**
 * Builds the default verifier from the environment (KEYCLOAK_URL, KEYCLOAK_REALM_STAFF, OPENFGA_API_URL,
 * OPENFGA_STORE_ID, OPENFGA_MODEL_ID — auth-sdk defaults). Without OPENFGA_STORE_ID no real token can be
 * authorised: production refuses to boot, local dev logs a warning (real tokens → 503, dev tokens keep working).
 */
export function buildStaffAuth(): StaffAuth {
  const production = process.env.NODE_ENV === 'production';
  if (!process.env.OPENFGA_STORE_ID) {
    if (production) {
      throw new Error(
        'OPENFGA_STORE_ID is required in production: staff tokens cannot be authorised without OpenFGA',
      );
    }
    console.warn(
      `[core] OPENFGA_STORE_ID is not set: real staff tokens are refused with 503 until OpenFGA is configured ` +
        `(pnpm --filter @platform/auth-sdk fga:seed, then OPENFGA_STORE_ID in .env)` +
        (devTokensEnabled()
          ? '; dev tokens (CORE_DEV_TOKENS=1) keep working'
          : `; set ${DEV_TOKENS_FLAG}=1 for local dev tokens`),
    );
  }
  const keycloak = new KeycloakStaffTokenVerifier();
  return {
    verifier: composeStaffTokenVerifier(keycloak, new DevTokenVerifier()),
    fga: keycloak.fga,
    onRoleChange: keycloak.invalidate,
  };
}

/** Explicit opt-in for the Store API fallback proxy, same pattern as `CORE_DEV_TOKENS`: `1` enables it. */
export const STORE_API_FALLBACK_FLAG = 'CORE_STORE_API_FALLBACK';

/**
 * The Store API fallback proxy is an Integration 1 stand-in for the Store routes the core does not implement yet.
 * It is on only when `CORE_STORE_API_FALLBACK=1` AND `CORE_STORE_API_FALLBACK_URL` is set, and it is refused
 * unconditionally in production — checked before either variable is read, like the dev-token verifier — so a
 * production environment that carries either variable refuses to boot instead of proxying.
 */
export function storeApiFallbackUrlFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const flag = env[STORE_API_FALLBACK_FLAG]?.trim();
  const url = env[STORE_API_FALLBACK_ENV]?.trim();
  if (env.NODE_ENV === 'production') {
    if (flag || url) {
      throw new Error(
        `${STORE_API_FALLBACK_FLAG} / ${STORE_API_FALLBACK_ENV} must not be set in production`,
      );
    }
    return undefined;
  }
  if (flag !== '1') return undefined;
  if (!url) throw new Error(`${STORE_API_FALLBACK_FLAG}=1 requires ${STORE_API_FALLBACK_ENV}`);
  return url;
}

/**
 * Mounts our pre-Medusa middleware on an Express app. Exported so tests can exercise the exact chain the server
 * runs (with their own routes) without booting Medusa.
 */
export function mountCoreMiddleware(
  app: express.Express,
  verifier: StaffTokenVerifier = new DevTokenVerifier(),
  opts: CoreMiddlewareOptions = {},
): void {
  if (opts.storeApiFallbackUrl && process.env.NODE_ENV === 'production') {
    throw new Error(
      `${STORE_API_FALLBACK_FLAG} / ${STORE_API_FALLBACK_ENV} must not be set in production`,
    );
  }
  const fga = opts.fga ?? createOpenFgaClient();

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
  // of its publishable-key gate — our tenant middleware is the contract's key check.
  mountStoreRoutes(app);
  // Integration 1 (non-production): every other /store/* request goes verbatim to the Prism mock instead of
  // Medusa. Without the variable it falls through to Medusa as before.
  if (opts.storeApiFallbackUrl) {
    app.use('/store', storeApiFallbackProxy(opts.storeApiFallbackUrl));
  }
  // Provider webhooks (src/http/module-routers.ts): before any JSON body parser and outside /store and /admin —
  // each router reads the raw body itself and authenticates the provider's signature (#176 part 3).
  for (const router of opts.webhookRouters ?? []) app.use(router);
  // Admin API: 401 without a valid staff token; req.principal otherwise. Our admin route files opt out of
  // Medusa's auth (`export const AUTHENTICATE = false`).
  app.use('/admin', staffAuthMiddleware(verifier));
  app.use('/admin', express.json({ limit: '1mb' }));
  // hq-rbac (window 2): /admin/users, /admin/users/{id}/roles, /admin/audit-log, /admin/finance/ping — gets the
  // principal + scope resolved above, checks permissions against OpenFGA itself; null → next().
  app.use(
    hqRbacAdapter({ fga, ...(opts.onRoleChange ? { onRoleChange: opts.onRoleChange } : {}) }),
  );
  // Admin API routes window 1 owns (registry + catalog, admin-api.yaml): x-permission from the spec (OpenFGA
  // for real tokens), then the module services. Every other /admin path falls through to Medusa.
  app.use(adminRouter());
  // Admin routers other modules export (src/http/module-routers.ts — the named mount point, #162 part 3).
  for (const router of opts.moduleRouters ?? []) app.use(router);
  // Renders AppError as the contract's { code, message, details } for everything above.
  app.use(coreErrorHandler);
}

/** Builds the Express app with our middleware and Medusa fully loaded. */
export async function createServer(opts: CreateServerOptions = {}): Promise<CoreServer> {
  const directory = opts.directory ?? path.resolve(__dirname, '..');
  // Loads the repo-root .env (medusa-config.ts reads process.env only) and opens our platform_app pool.
  await initDb({ startDir: directory });
  // Readiness (issue #8): migrations + seed/onboarding present, every store resolvable, Medusa schema migrated.
  // Findings are logged; the boot aborts only with CORE_BOOTSTRAP_STRICT=1 (staging/production).
  const readiness = await verifyBootstrap();
  if (!readiness.ok) {
    console.warn(`[core] bootstrap check failed:\n${formatReport(readiness)}`);
    if (process.env.CORE_BOOTSTRAP_STRICT === '1') {
      throw new Error('bootstrap: database not ready (CORE_BOOTSTRAP_STRICT=1)');
    }
  } else {
    console.info(`[core] bootstrap check: ready (${readiness.stores.length} store(s))`);
  }
  const storeApiFallbackUrl = storeApiFallbackUrlFromEnv();
  if (storeApiFallbackUrl) {
    console.info(
      `[core] store api fallback: unhandled /store/* requests go to ${storeApiFallbackUrl}`,
    );
  }
  const app = express();
  if (opts.staffTokenVerifier) {
    mountCoreMiddleware(app, opts.staffTokenVerifier, {
      moduleRouters: moduleAdminRouters(),
      webhookRouters: moduleWebhookRouters(),
      ...(storeApiFallbackUrl ? { storeApiFallbackUrl } : {}),
    });
  } else {
    const auth = buildStaffAuth();
    mountCoreMiddleware(app, auth.verifier, {
      fga: auth.fga,
      onRoleChange: auth.onRoleChange,
      moduleRouters: moduleAdminRouters(),
      webhookRouters: moduleWebhookRouters(),
      ...(storeApiFallbackUrl ? { storeApiFallbackUrl } : {}),
    });
  }

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
