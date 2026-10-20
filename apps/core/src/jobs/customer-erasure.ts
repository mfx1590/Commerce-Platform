// Customer erasure job (#483 / REQUEST #513, window 2's consumer, window 13's job file): the consumer of
// `customer.erased`. Deletes the customers-realm Keycloak user of an erased row once no live row of the
// organization carries its subject — the tombstone subject (#482) is what names the user. Two ways to run the same
// function, as `customer-export.ts`:
//
// 1. As a Medusa scheduled job — this file exports Medusa's job contract (`default` handler + `config` with a
//    cron `schedule`), picked up from `src/jobs` under MEDUSA_WORKER_MODE = shared | worker. Env:
//      CORE_CUSTOMER_ERASURE_CRON              cron expression, default "*/5 * * * *"
//      KEYCLOAK_CUSTOMERS_ADMIN_CLIENT_ID      service-account client of the CUSTOMERS realm (REQUEST #509)
//      KEYCLOAK_CUSTOMERS_ADMIN_CLIENT_SECRET  its secret (env / Vault, never committed)
//      KEYCLOAK_REALM_CUSTOMERS                the realm name, default "customers"
//    One organization-scoped pass (CORE_ORGANIZATION_ID). Everything else — the unclaimed `customer.erased` rows
//    in `seq` order, the cross-store subject check, the Keycloak delete, the claim row after a definitive outcome
//    (a Keycloak outage leaves no claim, so the next tick retries) — lives in `@platform/auth-sdk`.
//
// 2. As a one-shot CLI (runbooks):
//      pnpm --filter @platform/core exec tsx src/jobs/customer-erasure.ts [--limit 100]
//
// The summary line carries counts only — never a customer, a subject or an email.
import {
  createCustomerErasureConsumer,
  createKeycloakAdmin,
  type CustomerErasureConsumerOptions,
  type CustomerErasureRunResult,
} from '@platform/auth-sdk';
import { closePool, getPool, initDb } from '../lib/db';
import { coreOrganizationId } from '../http/tenant';

export const DEFAULT_CRON = '*/5 * * * *';
export const DEFAULT_LIMIT = 100;

/** The customers-realm service client from the environment (the secret never appears in code or logs). */
export function customersRealmAdmin(
  env: NodeJS.ProcessEnv = process.env,
): CustomerErasureConsumerOptions['keycloak'] {
  return createKeycloakAdmin({
    realm: env.KEYCLOAK_REALM_CUSTOMERS?.trim() || 'customers',
    clientId: env.KEYCLOAK_CUSTOMERS_ADMIN_CLIENT_ID?.trim() || 'core-admin',
    // exactOptionalPropertyTypes: an unset secret is left out, not passed as undefined
    ...(env.KEYCLOAK_CUSTOMERS_ADMIN_CLIENT_SECRET
      ? { clientSecret: env.KEYCLOAK_CUSTOMERS_ADMIN_CLIENT_SECRET }
      : {}),
  });
}

export async function runCustomerErasure(
  opts: {
    limit?: number | undefined;
    organizationId?: string | undefined;
    /** Test seam: a fake customers-realm client. Production builds the real one from the environment. */
    keycloak?: CustomerErasureConsumerOptions['keycloak'] | undefined;
  } = {},
): Promise<CustomerErasureRunResult> {
  const consumer = createCustomerErasureConsumer({
    pool: getPool(),
    organizationId: opts.organizationId ?? coreOrganizationId(),
    keycloak: opts.keycloak ?? customersRealmAdmin(),
  });
  return consumer.runOnce({ limit: opts.limit ?? DEFAULT_LIMIT });
}

function summary(r: CustomerErasureRunResult): string {
  const outcomes = Object.entries(r.outcomes)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  return `customer-erasure: ${r.processed} settled${outcomes ? ` (${outcomes})` : ''}, ${r.retry} to retry, ${r.skipped} already claimed`;
}

// ---- Medusa scheduled job contract ----
export const config = {
  name: 'customer-erasure',
  schedule: process.env.CORE_CUSTOMER_ERASURE_CRON?.trim() || DEFAULT_CRON,
};

export default async function customerErasureJob(): Promise<void> {
  // The core's pool is opened by src/server.ts (initDb) before Medusa's loaders run; the job shares it.
  const r = await runCustomerErasure();
  if (r.processed > 0 || r.retry > 0) console.info(`[core] ${summary(r)}`);
}

// ---- CLI ----
function parseArgs(argv: string[]): { limit?: number } {
  const out: { limit?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--limit needs a positive integer');
      out.limit = n;
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return out;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    await initDb({ startDir: __dirname });
    try {
      console.info(summary(await runCustomerErasure(args)));
    } finally {
      await closePool();
    }
  })().catch((err) => {
    console.error('customer-erasure failed', err);
    process.exit(1);
  });
}
