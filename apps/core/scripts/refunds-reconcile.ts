// `pnpm --filter @platform/core refunds:reconcile -- --store <code> [--since <ISO date>]` (#918)
//
// Records the PSP refunds of a store's captured Stripe payments that have no refund row of ours (an orphan: Stripe
// refunded, our transaction did not commit; a Dashboard refund) — refund row + `refund.issued` per refund, amount
// and currency from Stripe. The `charge.refunded` webhook does the same per payment; this covers missed webhooks.
// Idempotent. A WRITE: on a shared database the owner runs it.
import path from 'node:path';
import { SEED_IDS } from '@platform/db';
import { SYSTEM_ACTOR } from '../src/lib/audit';
import { closePool, initDb, organizationClient } from '../src/lib/db';
import {
  reconcilePaymentRefunds,
  StripeClient,
  stripeCredentialsFor,
} from '../src/modules/payments';

function args(argv: string[]) {
  let store: string | undefined;
  let since: Date | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') store = String(argv[++i] ?? '');
    else if (a === '--since') since = new Date(String(argv[++i] ?? ''));
    else throw new Error(`unknown argument ${a}`);
  }
  if (!store) throw new Error('--store <code> is required');
  if (since && Number.isNaN(since.getTime())) throw new Error('--since must be an ISO date');
  return { store, since };
}

async function main(): Promise<void> {
  const opts = args(process.argv.slice(2));
  await initDb({ startDir: path.resolve(__dirname, '..') });
  const organizationId = process.env.CORE_ORGANIZATION_ID ?? SEED_IDS.organization;
  const client = organizationClient({ organizationId });
  const store = await client.query<{ id: string }>(`SELECT id FROM store WHERE code = $1`, [
    opts.store,
  ]);
  if (!store.rows[0]) throw new Error(`unknown store code ${opts.store}`);
  const payments = await client.query<{ id: string }>(
    `SELECT id FROM payment
     WHERE store_id = $1 AND provider = 'stripe' AND status = 'captured'
       AND ($2::timestamptz IS NULL OR captured_at >= $2)
     ORDER BY captured_at`,
    [store.rows[0].id, opts.since ?? null],
  );
  const api = new StripeClient({ secretKey: stripeCredentialsFor(opts.store).secretKey });
  let created = 0;
  for (const p of payments.rows) {
    const ids = await reconcilePaymentRefunds(client, {
      paymentId: p.id,
      api,
      actor: SYSTEM_ACTOR,
    });
    created += ids.length;
    for (const id of ids) console.info(`refunds:reconcile payment ${p.id}: recorded refund ${id}`);
  }
  console.info(
    `refunds:reconcile store ${opts.store}: ${payments.rows.length} captured payment(s) checked, ${created} refund(s) recorded`,
  );
  await closePool();
}

main().catch(async (err) => {
  console.error('refunds:reconcile failed:', err instanceof Error ? err.message : err);
  await closePool().catch(() => {});
  process.exit(1);
});
