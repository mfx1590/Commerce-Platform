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
  /**
   * The consumer group: `accounting.ledger` unless `--group <id>` / `--group=<id>` or `ACCOUNTING_GROUP_ID` names another
   * (the flag wins). A fresh group re-reads the topics from the beginning into the same ledger, e.g. Integration 4
   * (#594). Same shape as `consumer_processed.group_id`.
   */
  groupId: string;
  /** `--allow-new-group` / `ACCOUNTING_ALLOW_NEW_GROUP=1`: a non-default group on a ledger another accounting group filled (#658). */
  allowNewGroup: boolean;
  /** `Bearer dev:<subject>` accepted on the read API (never in production). */
  devTokens: boolean;
  keycloakUrl: string | undefined;
  keycloakRealm: string | undefined;
}

/** The default ledger group (= consumer.ts LEDGER_GROUP; kept literal so config stays dependency-free). */
export const DEFAULT_GROUP_ID = 'accounting.ledger';
const GROUP_ID = /^[a-z][a-z0-9_.-]*$/;

function flagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === name) return argv[i + 1] ?? '';
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
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
  const groupId = flagValue(argv, '--group') ?? (env.ACCOUNTING_GROUP_ID || DEFAULT_GROUP_ID);
  if (!GROUP_ID.test(groupId))
    throw new Error(`the consumer group must match ${GROUP_ID.source}, got "${groupId}"`);
  return {
    organizationId,
    port: intOf(env.ACCOUNTING_PORT ?? env.PORT, 9003, 'PORT'),
    once: argv.includes('--once'),
    onceIdleMs: intOf(env.ACCOUNTING_ONCE_IDLE_MS, 5_000, 'ACCOUNTING_ONCE_IDLE_MS'),
    retries: intOf(env.ACCOUNTING_RETRIES, 5, 'ACCOUNTING_RETRIES'),
    groupId,
    allowNewGroup: argv.includes('--allow-new-group') || env.ACCOUNTING_ALLOW_NEW_GROUP === '1',
    devTokens: env.ACCOUNTING_DEV_TOKENS === '1' && env.NODE_ENV !== 'production',
    keycloakUrl: env.KEYCLOAK_URL,
    keycloakRealm: env.KEYCLOAK_REALM_STAFF,
  };
}
