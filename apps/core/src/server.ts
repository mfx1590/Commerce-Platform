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
  adminNotFound,
  aliasPublishableKeyHeader,
  coreErrorHandler,
  adminRouter,
  customerTokenVerifierFor,
  composeStaffTokenVerifier,
  contractsVersionHeader,
  coreOrganizationId,
  DEV_TOKENS_FLAG,
  devTokensEnabled,
  DevTokenVerifier,
  hqRbacAdapter,
  KeycloakStaffTokenVerifier,
  loadSpec,
  rateLimitConfigFromEnv,
  rateLimitMiddleware,
  redisRateLimitStore,
  type RateLimitConfig,
  type RateLimitStore,
  moduleAdminRouters,
  moduleStoreRouters,
  moduleWebhookRouters,
  mountStoreRoutes,
  requestIdMiddleware,
  staffAuthMiddleware,
  STORE_API_FALLBACK_ENV,
  storeApiFallbackProxy,
  storeContextMiddleware,
  type CustomerTokenVerifier,
  type StaffTokenVerifier,
} from './http';
import { openFgaStoreRegistrar } from './http/store-registrar';
import type { StoreRegistrar } from './modules/registry';
import { formatReport, verifyBootstrap } from './bootstrap';
import { closePool, initDb, organizationClient } from './lib/db';
import {
  compileRouteMatcher,
  knownStoreSet,
  startTelemetry,
  telemetryActive,
  telemetryMiddleware,
  type KnownStores,
  type RouteMatcher,
} from './telemetry';
import { registerModuleSeams } from './wiring';

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
  /**
   * Store onboarding's OpenFGA side (#413): default the adapter over `fga` (src/http/store-registrar.ts; window 2's
   * `ensureStoreObject` once #415 is on main). Tests pass the registry module's `inMemoryStoreRegistrar()`.
   */
  storeRegistrar?: StoreRegistrar;
  /** Scope-cache invalidation on role changes (`KeycloakStaffTokenVerifier.invalidate`). */
  onRoleChange?: (staffUserId: string) => void;
  /** Scope-cache invalidation after onboarding a store (`KeycloakStaffTokenVerifier.invalidateAll`). */
  onStoreScopeChange?: () => void;
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
  /**
   * Store API routers of other windows' modules (#624), mounted after `mountStoreRoutes` and BEFORE the
   * fallback proxy. createServer() passes `moduleStoreRouters()`; the default is NONE, same rule as
   * `moduleRouters`, so a module's own tests mount their own router.
   */
  storeRouters?: express.Router[];
  /**
   * Test seam for the customers-realm token verifier (src/http/customer-routes.ts). Code only: no environment
   * variable or configuration reaches it, createServer() never passes it, and it is refused in production.
   * Default: `@platform/auth-sdk`'s `verifyCustomerToken`.
   */
  customerTokenVerifier?: CustomerTokenVerifier;
  /**
   * Telemetry (#729): the stores an Admin API `{storeId}` may be labelled with. createServer() passes the
   * registry's stores; the default labels every admin request `none`. Unused unless `startTelemetry` registered.
   */
  knownStores?: KnownStores;
  /**
   * Store API rate limits (#742, src/http/rate-limit.ts). createServer() passes the Redis store with the limits from
   * the environment (unless CORE_RATE_LIMIT=off); the default is NONE, so module and HTTP tests are never limited.
   */
  rateLimit?: { store: RateLimitStore; config: RateLimitConfig };
}

/** The http.route values: every path of the Store and Admin API contracts. */
export function contractRouteMatcher(): RouteMatcher {
  return compileRouteMatcher([
    ...Object.keys(loadSpec('store-api.yaml').doc.paths),
    ...Object.keys(loadSpec('admin-api.yaml').doc.paths),
  ]);
}

/** The staff auth src/server.ts runs: real Keycloak tokens by default, `dev:` tokens only with CORE_DEV_TOKENS=1. */
export interface StaffAuth {
  verifier: StaffTokenVerifier;
  fga: OpenFgaClient;
  onRoleChange: (staffUserId: string) => void;
  /** A store became visible to staff (onboarding): every cached scope is dropped. */
  onStoreScopeChange: () => void;
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
    onStoreScopeChange: keycloak.invalidateAll,
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
  // Refused in production before anything is mounted (code-only test seam, src/http/customer-routes.ts).
  const customerTokenVerifier = customerTokenVerifierFor(opts.customerTokenVerifier);
  const fga = opts.fga ?? createOpenFgaClient();
  const storeRegistrar = opts.storeRegistrar ?? openFgaStoreRegistrar(fga);

  app.use(requestIdMiddleware);
  // Telemetry (#729): the SERVER span and RED metrics, before everything else so the auth chain and the handlers run
  // in the span's context. A pass-through unless startTelemetry() registered providers (never in tests).
  if (telemetryActive()) {
    app.use(
      telemetryMiddleware({
        routes: contractRouteMatcher(),
        ...(opts.knownStores ? { knownStores: opts.knownStores } : {}),
      }),
    );
  }

  // Liveness probe: answers before any session/auth middleware, no database round trip. The body stays the bare
  // `OK`; the contracts version travels as a header (#284).
  app.get('/health', contractsVersionHeader, (_req, res) => {
    res.status(200).send('OK');
  });

  // Contract header → Medusa header (Medusa's own gate still runs after ours; task 1.8 mirrors the keys).
  app.use(aliasPublishableKeyHeader);
  // Store API: 401 without a valid X-Publishable-Key; req.tenant otherwise (ADR 0001).
  app.use('/store', storeContextMiddleware);
  // Rate limits (#742): after the tenant (an unknown key is a 401 and costs no Redis call), before every Store API
  // route — so before body parsing and customer-token verification. 429 `rate_limited` + Retry-After; fail-open.
  if (opts.rateLimit) app.use('/store', rateLimitMiddleware(opts.rateLimit));
  // The Store API routes window 1 owns (contracts store-api.yaml: GET /store, /store/categories,
  // /store/products, /store/products/{handle}) answer here, ahead of Medusa's own routes of the same paths and
  // of its publishable-key gate — our tenant middleware is the contract's key check.
  mountStoreRoutes(app, customerTokenVerifier);
  // Store API routers other modules export (src/http/module-routers.ts). Before the fallback proxy, which is a
  // catch-all on /store: a router mounted after it would never be reached.
  for (const router of opts.storeRouters ?? []) app.use(router);
  // Integration 1 (non-production): every other /store/* request goes verbatim to the Prism mock instead of
  // Medusa. Without the variable it falls through to Medusa as before.
  if (opts.storeApiFallbackUrl) {
    app.use('/store', storeApiFallbackProxy(opts.storeApiFallbackUrl));
  }
  // Provider webhooks (src/http/module-routers.ts): before any JSON body parser and outside /store and /admin —
  // each router reads the raw body itself and authenticates the provider's signature (#176 part 3).
  for (const router of opts.webhookRouters ?? []) app.use(router);
  // Admin API: 401 without a valid staff token; req.principal otherwise. Our admin route files opt out of
  // Medusa's auth (`export const AUTHENTICATE = false`). X-Contracts-Version is stamped first, so the 401 / 503
  // of the staff auth and every later answer carry it (#284).
  app.use('/admin', contractsVersionHeader);
  app.use('/admin', staffAuthMiddleware(verifier));
  app.use('/admin', express.json({ limit: '1mb' }));
  // hq-rbac (window 2): /admin/users, /admin/users/{id}/roles, /admin/audit-log, /admin/finance/ping — gets the
  // principal + scope resolved above, checks permissions against OpenFGA itself; null → next().
  app.use(
    hqRbacAdapter({ fga, ...(opts.onRoleChange ? { onRoleChange: opts.onRoleChange } : {}) }),
  );
  // Admin API routes window 1 owns (registry + catalog, admin-api.yaml): x-permission from the spec (OpenFGA
  // for real tokens), then the module services. Every other /admin path ends in createServer()'s terminal 404.
  app.use(
    adminRouter({
      storeRegistrar,
      ...(opts.onStoreScopeChange ? { onStoreScopeChange: opts.onStoreScopeChange } : {}),
    }),
  );
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
  // OpenTelemetry (#729): only with an OTLP endpoint in the standard OTEL_* environment; one warning if the
  // collector is absent, never a failed boot.
  const telemetry = startTelemetry();
  const knownStores = telemetry.enabled
    ? knownStoreSet(async () => {
        const { rows } = await organizationClient({ organizationId: coreOrganizationId() }).query<{
          id: string;
        }>('SELECT id FROM store');
        return rows.map((r) => r.id);
      })
    : undefined;
  // Payments, carrier rates, price lists: other modules' implementations behind our seams (src/wiring.ts).
  registerModuleSeams();
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
  const rateLimitConfig = rateLimitConfigFromEnv();
  const rateLimit = rateLimitConfig
    ? { store: redisRateLimitStore(), config: rateLimitConfig }
    : undefined;
  if (!rateLimit)
    console.warn('[core] rate limit: CORE_RATE_LIMIT=off, the Store API is not rate limited');
  const app = express();
  if (opts.staffTokenVerifier) {
    mountCoreMiddleware(app, opts.staffTokenVerifier, {
      moduleRouters: moduleAdminRouters(),
      storeRouters: moduleStoreRouters(),
      webhookRouters: moduleWebhookRouters(),
      ...(storeApiFallbackUrl ? { storeApiFallbackUrl } : {}),
      ...(knownStores ? { knownStores } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    });
  } else {
    const auth = buildStaffAuth();
    mountCoreMiddleware(app, auth.verifier, {
      fga: auth.fga,
      onRoleChange: auth.onRoleChange,
      onStoreScopeChange: auth.onStoreScopeChange,
      moduleRouters: moduleAdminRouters(),
      storeRouters: moduleStoreRouters(),
      webhookRouters: moduleWebhookRouters(),
      ...(storeApiFallbackUrl ? { storeApiFallbackUrl } : {}),
      ...(knownStores ? { knownStores } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    });
  }
  // #265: an /admin path none of the routers above answered is the contract's 404 — decided here, before
  // Medusa's loaders register its own admin auth (which answers 401 to a signed-in staff user). Not part of
  // mountCoreMiddleware: module tests mount their router after that chain.
  app.use('/admin', adminNotFound);

  const { container, shutdown } = await loaders({ directory, expressApp: app });
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);

  return {
    app,
    logger,
    shutdown: async () => {
      await shutdown();
      await telemetry.shutdown();
      await rateLimit?.store.close?.();
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
