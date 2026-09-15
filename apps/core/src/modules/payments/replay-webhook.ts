// Replay CLI (task 2.2, #125): reprocesses one stored Stripe event idempotently.
//
//   pnpm --filter @platform/core exec tsx src/modules/payments/replay-webhook.ts evt_…
//
// Exit codes: 0 processed/skipped, 2 refused (payload no longer matches its payload_hash) or failed after
// reprocessing (reason printed, ids only), 1 anything else. Reads the repo-root .env like src/server.ts; the
// row is found through the organization scope, then reprocessed through a tenant client of ITS store so RLS
// and the store's credentials apply exactly as on the live path. Registers the payment providers first: a
// `payment_intent.canceled` replay cancels the order through the orders module, which voids via the provider.
import { closePool, initDb, organizationClient, tenantClient } from '../../lib/db';
import { coreOrganizationId } from '../../http/tenant';
import { registerPaymentProviders } from './index';
import { replayWebhookEvent, WEBHOOK_PROVIDER } from './webhook-receiver';
import { AppError } from '../../lib/errors';

export async function replayCli(argv: string[]): Promise<number> {
  const eventId = argv.find((a) => !a.startsWith('-'));
  if (!eventId) {
    console.error('usage: replay-webhook.ts <provider_event_id>   (a Stripe evt_… id)');
    return 1;
  }
  await initDb();
  try {
    registerPaymentProviders();
    const organizationId = coreOrganizationId();
    const org = organizationClient({ organizationId });
    const located = await org.query<{ store_id: string; status: string }>(
      `SELECT store_id, status FROM webhook_event WHERE provider = $1 AND provider_event_id = $2`,
      [WEBHOOK_PROVIDER, eventId],
    );
    const row = located.rows[0];
    if (!row) {
      console.error(`replay: webhook event ${eventId} not found`);
      return 1;
    }
    const client = tenantClient({ organizationId, storeIds: [row.store_id] });
    const outcome = await replayWebhookEvent(client, eventId);
    if (outcome.kind === 'duplicate') return 0; // not reachable on the replay path; typed for completeness
    console.info(
      `replay: ${outcome.eventId} ${outcome.type} → ${outcome.kind}${outcome.reason ? ` (${outcome.reason})` : ''}`,
    );
    return outcome.kind === 'failed' ? 2 : 0;
  } catch (err) {
    if (err instanceof AppError && err.code === 'conflict') {
      console.error(`replay refused: ${err.message}`);
      return 2;
    }
    throw err;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  replayCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('replay failed', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
