// Abandoned-cart job (issue #108). Two ways to run the same function (`markAllAbandonedCarts`, cart module):
//
// 1. As a Medusa scheduled job — this file exports Medusa's job contract (`default` handler + `config` with a cron
//    `schedule`), so `medusa`'s job loader picks it up from `src/jobs` and runs it in-process under
//    MEDUSA_WORKER_MODE = shared | worker (the `server` mode runs no jobs). Env:
//      CORE_ABANDONED_CART_CRON         cron expression, default "0 * * * *" (hourly)
//      CORE_ABANDONED_CART_AFTER_HOURS  idle threshold in hours, default 6
//    One organization-scoped pass (CORE_ORGANIZATION_ID) covers every store: carts are store rows, and the
//    organization client's RLS scope sees them all.
//
// 2. As a one-shot CLI (runbooks, CI, clock injection):
//      pnpm --filter @platform/core exec tsx src/jobs/abandoned-carts.ts [--hours 6] [--now 2026-09-09T10:00:00Z]
import { markAllAbandonedCarts } from '../modules/cart';
import { closePool, initDb, organizationClient } from '../lib/db';
import { coreOrganizationId } from '../http/tenant';

export const DEFAULT_CRON = '0 * * * *';
export const DEFAULT_AFTER_HOURS = 6;

export function thresholdMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.CORE_ABANDONED_CART_AFTER_HOURS ?? DEFAULT_AFTER_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `CORE_ABANDONED_CART_AFTER_HOURS must be a positive number (got ${env.CORE_ABANDONED_CART_AFTER_HOURS})`,
    );
  }
  return Math.round(hours * 3_600_000);
}

/** The pass itself: one organization, every store, injected clock. */
export async function runAbandonedCarts(
  opts: {
    now?: Date | undefined;
    idleForMs?: number | undefined;
    organizationId?: string | undefined;
  } = {},
): Promise<{ abandoned: number; cartIds: string[] }> {
  const client = organizationClient({
    organizationId: opts.organizationId ?? coreOrganizationId(),
  });
  return markAllAbandonedCarts(client, {
    now: opts.now ?? new Date(),
    idleForMs: opts.idleForMs ?? thresholdMsFromEnv(),
  });
}

// ---- Medusa scheduled job contract ----
export const config = {
  name: 'abandoned-carts',
  schedule: process.env.CORE_ABANDONED_CART_CRON?.trim() || DEFAULT_CRON,
};

export default async function abandonedCartsJob(): Promise<void> {
  // The core's pool is opened by src/server.ts (initDb) before Medusa's loaders run; the job shares it.
  const result = await runAbandonedCarts();
  if (result.abandoned > 0) {
    console.info(`[core] abandoned-carts: ${result.abandoned} cart(s) marked abandoned`);
  }
}

// ---- CLI ----
function parseArgs(argv: string[]): { now: Date | undefined; idleForMs: number | undefined } {
  let now: Date | undefined;
  let idleForMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--now') {
      const t = Date.parse(argv[++i] ?? '');
      if (Number.isNaN(t)) throw new Error('--now needs an ISO-8601 timestamp');
      now = new Date(t);
    } else if (a === '--hours') {
      const h = Number(argv[++i]);
      if (!Number.isFinite(h) || h <= 0) throw new Error('--hours needs a positive number');
      idleForMs = Math.round(h * 3_600_000);
    } else {
      throw new Error(`unknown argument ${a}`);
    }
  }
  return { now, idleForMs };
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    await initDb({ startDir: __dirname });
    try {
      const r = await runAbandonedCarts(args);
      console.info(
        `abandoned-carts: ${r.abandoned} cart(s) marked abandoned${r.cartIds.length ? `: ${r.cartIds.join(', ')}` : ''}`,
      );
    } finally {
      await closePool();
    }
  })().catch((err) => {
    console.error('abandoned-carts failed', err);
    process.exit(1);
  });
}
