// Abandoned carts (issue #108): an `active` cart idle for longer than the threshold becomes `abandoned` and emits
// ONE `cart.abandoned` v1 (no PII: `email_hash` only). Pure in its inputs — the clock and the threshold are
// injected — so the job (src/jobs/abandoned-carts.ts) is a thin adapter and the tests drive it with fake time.
// Idempotent: `abandoned` carts are never selected again; a cart mutated after abandonment is reactivated by the
// cart module (`lockActiveCart`: abandoned → active, `updated_at` touched), so it is only abandoned again after it
// has been idle for the whole threshold once more — and that new abandonment is a new event.
import { createHash } from 'node:crypto';
import type { ScopedClient } from '@platform/db';
import { SYSTEM_ACTOR, type Actor } from '../../lib/audit';
import { buildEvent, eventActor, withEvents } from '../../outbox';

export interface MarkAbandonedInput {
  /** "Now" for the run (injected). */
  now: Date;
  /** A cart is abandoned when `updated_at < now − idleForMs`. */
  idleForMs: number;
  /** Carts per transaction (default 100); the job loops until a batch comes back short. */
  batchSize?: number | undefined;
  actor?: Actor | undefined;
}

export interface MarkAbandonedResult {
  abandoned: number;
  cartIds: string[];
}

interface IdleCartRow {
  id: string;
  organization_id: string;
  store_id: string;
  customer_id: string | null;
  email: string | null;
  currency: string;
  total_minor: string;
  updated_at: Date;
  metadata: Record<string, unknown>;
  line_item_count: number;
}

const emailHash = (email: string | null) =>
  email && email.trim()
    ? createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
    : null;

/**
 * One batch: locks up to `batchSize` idle active carts (`FOR UPDATE SKIP LOCKED` — two workers never double-process),
 * marks them abandoned and writes one event each, in one transaction. Empty carts (no line items) are skipped:
 * there is nothing to recover. Returns what it abandoned.
 */
export async function markAbandonedCarts(
  client: ScopedClient,
  input: MarkAbandonedInput,
): Promise<MarkAbandonedResult> {
  const cutoff = new Date(input.now.getTime() - input.idleForMs);
  const limit = Math.max(1, Math.min(1000, input.batchSize ?? 100));
  const actor = input.actor ?? SYSTEM_ACTOR;
  return client.transaction(async (tx) => {
    const idle = await tx.query<IdleCartRow>(
      `SELECT c.id, c.organization_id, c.store_id, c.customer_id, c.email, c.currency, c.total_minor::text, c.updated_at,
              c.metadata, (SELECT count(*) FROM cart_line_item li WHERE li.cart_id = c.id)::int AS line_item_count
       FROM cart c
       WHERE c.status = 'active' AND c.updated_at < $1
         AND EXISTS (SELECT 1 FROM cart_line_item li WHERE li.cart_id = c.id)
       ORDER BY c.updated_at
       LIMIT $2
       FOR UPDATE OF c SKIP LOCKED`,
      [cutoff, limit],
    );
    const cartIds: string[] = [];
    for (const c of idle.rows) {
      // The schema's app.set_updated_at trigger bumps updated_at on this UPDATE; harmless — abandoned carts are
      // never selected again, and the event carries the customer's real last activity (read above, before the
      // update). A reactivation measures idleness from the customer's next mutation.
      await tx.query(`UPDATE cart SET status = 'abandoned' WHERE id = $1`, [c.id]);
      const attribution = (c.metadata ?? {}).attribution;
      await withEvents(tx, [
        await buildEvent({
          topic: 'cart.abandoned',
          organizationId: c.organization_id,
          storeId: c.store_id,
          aggregateType: 'cart',
          aggregateId: c.id,
          actor: eventActor(actor),
          occurredAt: input.now,
          payload: {
            cart_id: c.id,
            customer_id: c.customer_id,
            email_hash: emailHash(c.email),
            currency: c.currency,
            total_minor: Number(c.total_minor),
            line_item_count: c.line_item_count,
            last_activity_at: c.updated_at.toISOString(),
            abandoned_at: input.now.toISOString(),
            has_attribution:
              attribution !== null &&
              typeof attribution === 'object' &&
              !Array.isArray(attribution),
          },
        }),
      ]);
      cartIds.push(c.id);
    }
    return { abandoned: cartIds.length, cartIds };
  });
}

/** Runs batches until one comes back short of `batchSize`. */
export async function markAllAbandonedCarts(
  client: ScopedClient,
  input: MarkAbandonedInput,
): Promise<MarkAbandonedResult> {
  const batch = Math.max(1, Math.min(1000, input.batchSize ?? 100));
  const all: string[] = [];
  for (;;) {
    const r = await markAbandonedCarts(client, { ...input, batchSize: batch });
    all.push(...r.cartIds);
    if (r.abandoned < batch) break;
  }
  return { abandoned: all.length, cartIds: all };
}
