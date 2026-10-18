// Customer export delivery job (#472, window 13): the consumer of `customer.export_requested`. Two ways to run the
// same function (`runCustomerExports`), as `abandoned-carts.ts`:
//
// 1. As a Medusa scheduled job — this file exports Medusa's job contract (`default` handler + `config` with a
//    cron `schedule`), picked up from `src/jobs` under MEDUSA_WORKER_MODE = shared | worker. Env:
//      CORE_CUSTOMER_EXPORT_CRON       cron expression, default "*/5 * * * *"
//      CORE_CUSTOMER_EXPORT_TTL_DAYS   how long a ready bundle is downloadable, default 30
//      CORE_CUSTOMER_EXPORT_MAX_BYTES  hard cap on the compressed bundle, default 8 MiB (above: expired / too_large)
//    One organization-scoped pass (CORE_ORGANIZATION_ID) visits every store with a store-scoped client, because
//    the bundle and its row live under the store's RLS: claim → build → purge (export-delivery.ts).
//
// 2. As a one-shot CLI (runbooks, CI, clock injection):
//      pnpm --filter @platform/core exec tsx src/jobs/customer-export.ts [--now 2026-11-18T10:00:00Z] [--ttl-days 30] [--max-bytes 8388608]
//
// The summary line carries counts and ids only — never a customer, never a bundle.
import {
  buildPendingExports,
  claimExportRequests,
  DEFAULT_EXPORT_MAX_BYTES,
  DEFAULT_EXPORT_TTL_DAYS,
  purgeExpiredExports,
} from '../modules/customers';
import { closePool, initDb, organizationClient, tenantClient } from '../lib/db';
import { coreOrganizationId } from '../http/tenant';

export const DEFAULT_CRON = '*/5 * * * *';

function positiveNumberFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${name} must be a positive number (got ${raw})`);
  return n;
}

export function ttlDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return positiveNumberFromEnv('CORE_CUSTOMER_EXPORT_TTL_DAYS', DEFAULT_EXPORT_TTL_DAYS, env);
}

export function maxBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(
    positiveNumberFromEnv('CORE_CUSTOMER_EXPORT_MAX_BYTES', DEFAULT_EXPORT_MAX_BYTES, env),
  );
}

export interface ExportRunResult {
  stores: number;
  claimed: number;
  built: string[];
  expired: Array<{ id: string; reason: 'customer_gone' | 'too_large' }>;
  purged: number;
}

export async function runCustomerExports(
  opts: {
    now?: Date | undefined;
    ttlDays?: number | undefined;
    maxBytes?: number | undefined;
    organizationId?: string | undefined;
  } = {},
): Promise<ExportRunResult> {
  const organizationId = opts.organizationId ?? coreOrganizationId();
  const now = opts.now ?? new Date();
  const ttlDays = opts.ttlDays ?? ttlDaysFromEnv();
  const maxBytes = opts.maxBytes ?? maxBytesFromEnv();
  const org = organizationClient({ organizationId });
  const stores = await org.query<{ id: string }>('SELECT id FROM store ORDER BY code');
  const result: ExportRunResult = { stores: 0, claimed: 0, built: [], expired: [], purged: 0 };
  for (const store of stores.rows) {
    const client = tenantClient({ organizationId, storeIds: [store.id] });
    result.stores += 1;
    result.claimed += (await claimExportRequests(client, store.id)).claimed;
    const built = await buildPendingExports(client, store.id, { now, ttlDays, maxBytes });
    result.built.push(...built.built);
    result.expired.push(...built.expired);
    result.purged += await purgeExpiredExports(client, store.id, now);
  }
  return result;
}

function summary(r: ExportRunResult): string {
  const expired = r.expired.length
    ? ` expired ${r.expired.map((e) => `${e.id} (${e.reason})`).join(', ')};`
    : '';
  return `customer-export: ${r.stores} store(s), ${r.claimed} claimed, ${r.built.length} built,${expired} ${r.purged} purged`;
}

// ---- Medusa scheduled job contract ----
export const config = {
  name: 'customer-export',
  schedule: process.env.CORE_CUSTOMER_EXPORT_CRON?.trim() || DEFAULT_CRON,
};

export default async function customerExportJob(): Promise<void> {
  // The core's pool is opened by src/server.ts (initDb) before Medusa's loaders run; the job shares it.
  const r = await runCustomerExports();
  if (r.claimed > 0 || r.built.length > 0 || r.expired.length > 0 || r.purged > 0) {
    console.info(`[core] ${summary(r)}`);
  }
}

// ---- CLI ----
function parseArgs(argv: string[]): { now?: Date; ttlDays?: number; maxBytes?: number } {
  const out: { now?: Date; ttlDays?: number; maxBytes?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--now') {
      const t = Date.parse(argv[++i] ?? '');
      if (Number.isNaN(t)) throw new Error('--now needs an ISO-8601 timestamp');
      out.now = new Date(t);
    } else if (a === '--ttl-days') {
      const d = Number(argv[++i]);
      if (!Number.isFinite(d) || d <= 0) throw new Error('--ttl-days needs a positive number');
      out.ttlDays = d;
    } else if (a === '--max-bytes') {
      const b = Number(argv[++i]);
      if (!Number.isInteger(b) || b <= 0) throw new Error('--max-bytes needs a positive integer');
      out.maxBytes = b;
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
      console.info(summary(await runCustomerExports(args)));
    } finally {
      await closePool();
    }
  })().catch((err) => {
    console.error('customer-export failed', err);
    process.exit(1);
  });
}
