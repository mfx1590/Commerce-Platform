// Process configuration from the environment and the command line. No secrets here: the database URL is read by
// @platform/db's connectionStringFromEnv, the brokers by @platform/events' brokersFromEnv.
import { SEED_IDS } from '@platform/db';

export interface AccountingConfig {
  organizationId: string;
  port: number;
  /** `--once`: consume until the bus has been idle for `onceIdleMs`, then exit. */
  once: boolean;
  onceIdleMs: number;
  retries: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intOf(raw: string | undefined, fallback: number, what: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${what} must be a positive integer, got "${raw}"`);
  return n;
}

export function resolveConfig(env: NodeJS.ProcessEnv, argv: string[]): AccountingConfig {
  const organizationId = env.CORE_ORGANIZATION_ID ?? SEED_IDS.organization;
  if (!UUID.test(organizationId)) throw new Error('CORE_ORGANIZATION_ID must be a uuid');
  return {
    organizationId,
    port: intOf(env.ACCOUNTING_PORT ?? env.PORT, 9003, 'PORT'),
    once: argv.includes('--once'),
    onceIdleMs: intOf(env.ACCOUNTING_ONCE_IDLE_MS, 5_000, 'ACCOUNTING_ONCE_IDLE_MS'),
    retries: intOf(env.ACCOUNTING_RETRIES, 5, 'ACCOUNTING_RETRIES'),
  };
}
