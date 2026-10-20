// Configuration from the environment (#360). Every production refusal is explicit and happens at boot: a worker
// that starts with a sink instead of a provider, or serves no store, or accepts dev tokens, is a worker that
// looks healthy while doing the wrong thing.
import { SEED_IDS } from '@platform/db';
import { BRAND_CODES } from './brands.js';
import { isTransportName, type TransportName } from './transport/index.js';

export interface NotificationsConfig {
  port: number;
  /** Store codes this worker serves (`NOTIFICATIONS_STORE_CODES`); every one needs a brand profile. */
  storeCodes: string[];
  /** One process serves one organization (`NOTIFICATIONS_ORGANIZATION_ID`, default the seeded HQ). */
  organizationId: string;
  pollMs: number;
  batchSize: number;
  maxAttempts: number;
  /** Outbox rows re-read below the cursor on every run (`NOTIFICATIONS_LOOKBACK`, default 500; see consumer.ts). */
  lookback: number;
  transport: TransportName;
  /** The dev sink's directory (`NOTIFICATIONS_DIR`, default `.notifications`, git-ignored). */
  dir: string;
  devTokens: boolean;
  /** `--once`: one pass, print the report, exit. */
  once: boolean;
  keycloakUrl: string;
  keycloakRealm: string;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  return n;
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): NotificationsConfig {
  const production = env.NODE_ENV === 'production';

  const storeCodes = list(env.NOTIFICATIONS_STORE_CODES);
  if (storeCodes.length === 0) {
    if (production) {
      throw new Error(
        'NOTIFICATIONS_STORE_CODES must list the store codes this worker serves (refusing to guess in production)',
      );
    }
    storeCodes.push(...BRAND_CODES);
  }
  for (const code of storeCodes) {
    if (!BRAND_CODES.includes(code)) {
      throw new Error(
        `NOTIFICATIONS_STORE_CODES names "${code}" but no brand profile exists for it (src/brands.ts)`,
      );
    }
  }

  const transport = env.NOTIFICATIONS_TRANSPORT ?? 'dev';
  if (!isTransportName(transport)) {
    throw new Error(`NOTIFICATIONS_TRANSPORT must be "dev" or "resend", got "${transport}"`);
  }
  if (production && transport === 'dev') {
    throw new Error(
      'NOTIFICATIONS_TRANSPORT=dev writes emails to disk and is refused in production',
    );
  }

  const devTokens = env.NOTIFICATIONS_DEV_TOKENS === '1';
  if (production && devTokens) {
    throw new Error('NOTIFICATIONS_DEV_TOKENS=1 is refused in production');
  }

  return {
    port: integer(env.PORT, 4030, 'PORT'),
    storeCodes,
    organizationId: env.NOTIFICATIONS_ORGANIZATION_ID?.trim() || SEED_IDS.organization,
    pollMs: integer(env.NOTIFICATIONS_POLL_MS, 5000, 'NOTIFICATIONS_POLL_MS'),
    batchSize: Math.max(1, integer(env.NOTIFICATIONS_BATCH_SIZE, 100, 'NOTIFICATIONS_BATCH_SIZE')),
    maxAttempts: Math.max(
      1,
      integer(env.NOTIFICATIONS_MAX_ATTEMPTS, 5, 'NOTIFICATIONS_MAX_ATTEMPTS'),
    ),
    lookback: integer(env.NOTIFICATIONS_LOOKBACK, 500, 'NOTIFICATIONS_LOOKBACK'),
    transport,
    dir: env.NOTIFICATIONS_DIR?.trim() || '.notifications',
    devTokens,
    once: argv.includes('--once'),
    keycloakUrl: env.KEYCLOAK_URL?.trim() || 'http://localhost:8180',
    keycloakRealm: env.KEYCLOAK_REALM_STAFF?.trim() || 'staff',
  };
}
