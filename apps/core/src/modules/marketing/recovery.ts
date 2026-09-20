// Abandoned-cart recovery (#148): consume `cart.abandoned`, keep one record per cart, redeem tokens, and notice
// when a cart came back.
//
// The consumer polls the outbox per store the way window 9's search sync does — `seq > cursor`, batch, advance
// the cursor in the same transaction as the work. Marketing does not publish anything here: window 16 reacts to
// `cart.abandoned` (window 1's event) to send the email, and a recovered cart is visible as an order. Inventing
// `recovery.*` topics would be traffic nobody consumes.
//
// **This module writes no attribution.** The recovery link carries `utm_source=abandoned_cart`, the storefront
// captures it into `cart.metadata.attribution` as it already does, and window 1's placement writes the row. That
// is what keeps the 2.1 attribution report and the recovery rate telling the same story about the same order.
import type { Queryable, ScopedClient } from '@platform/db';
import { SYSTEM_ACTOR, writeAudit, type Actor } from '../../lib/audit';
import { notFound } from '../../lib/errors';
import { DEFAULT_TTL_MS, hashToken, mintToken, redeemToken } from './recovery-token';
import {
  RECOVERY_CURSOR,
  type CartRecovery,
  type CartRecoveryRow,
  type RecoveryStatus,
} from './recovery-types';

const COLUMNS = `id, organization_id, store_id, cart_id, customer_id, email_hash, currency, total_minor,
  line_item_count, abandoned_at, has_attribution, token_hash, token_expires_at, redeemed_at, status,
  recovered_order_id, recovered_at, created_at, updated_at`;

export function toRecovery(row: CartRecoveryRow, now: Date = new Date()): CartRecovery {
  return {
    id: row.id,
    store_id: row.store_id,
    cart_id: row.cart_id,
    customer_id: row.customer_id,
    email_hash: row.email_hash,
    currency: row.currency,
    total: { amount_minor: Number(row.total_minor), currency: row.currency },
    line_item_count: row.line_item_count,
    abandoned_at: row.abandoned_at.toISOString(),
    has_attribution: row.has_attribution,
    token_expires_at: row.token_expires_at.toISOString(),
    redeemed_at: row.redeemed_at ? row.redeemed_at.toISOString() : null,
    status: row.status,
    // Derived, never stored: a status column that needs a cron to stay honest is a bug waiting for an outage.
    expired: row.status === 'pending' && row.token_expires_at.getTime() <= now.getTime(),
    recovered_order_id: row.recovered_order_id,
    recovered_at: row.recovered_at ? row.recovered_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** The `cart.abandoned` v1 payload, as the outbox stores it. */
interface CartAbandonedPayload {
  cart_id: string;
  customer_id: string | null;
  email_hash: string | null;
  currency: string;
  total_minor: number;
  line_item_count: number;
  last_activity_at: string;
  abandoned_at: string;
  has_attribution: boolean;
}

export interface ConsumeOptions {
  /** Outbox rows per run (default 200). `processed === batchSize` means more may be waiting. */
  batchSize?: number;
  /** Token lifetime; default 7 days. */
  ttlMs?: number;
  now?: Date;
}

export interface ConsumeResult {
  processed: number;
  created: number;
  cursor: number;
  /** Plaintext tokens for the records created in this run, keyed by cart id — the only time they exist. */
  tokens: Map<string, string>;
}

async function readCursor(tx: Queryable, storeId: string): Promise<number> {
  const res = await tx.query<{ seq: string }>(
    `SELECT seq::text AS seq FROM marketing_cursor WHERE store_id = $1 AND name = $2`,
    [storeId, RECOVERY_CURSOR],
  );
  return Number(res.rows[0]?.seq ?? 0);
}

async function writeCursor(
  tx: Queryable,
  organizationId: string,
  storeId: string,
  seq: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO marketing_cursor (organization_id, store_id, name, seq)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_id, name) DO UPDATE SET seq = GREATEST(marketing_cursor.seq, EXCLUDED.seq)`,
    [organizationId, storeId, RECOVERY_CURSOR, seq],
  );
}

/**
 * Reads the store's `cart.abandoned` rows after the cursor and creates one recovery record each.
 *
 * Idempotent twice over: the cursor advances only inside the same transaction as the inserts, and
 * `UNIQUE (cart_id)` makes a re-delivered event a no-op rather than a second record (#148). A cart that is
 * abandoned, recovered and abandoned again keeps its original record — deliberately: the rate counts carts, not
 * episodes, and minting a second token would leave the first one live.
 */
export async function consumeAbandonedCarts(
  client: ScopedClient,
  storeId: string,
  options: ConsumeOptions = {},
): Promise<ConsumeResult> {
  const batchSize = options.batchSize ?? 200;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? new Date();
  const organizationId = client.context.organizationId;

  return client.transaction(async (tx) => {
    const cursor = await readCursor(tx, storeId);
    const rows = await tx.query<{ seq: string; payload: CartAbandonedPayload }>(
      `SELECT seq::text AS seq, payload FROM outbox
        WHERE store_id = $1 AND topic = 'cart.abandoned' AND seq > $2
        ORDER BY seq
        LIMIT $3`,
      [storeId, cursor, batchSize],
    );
    if (rows.rows.length === 0) return { processed: 0, created: 0, cursor, tokens: new Map() };

    const tokens = new Map<string, string>();
    let created = 0;

    for (const { payload } of rows.rows) {
      const token = mintToken();
      const inserted = await tx.query<CartRecoveryRow>(
        `INSERT INTO cart_recovery (organization_id, store_id, cart_id, customer_id, email_hash, currency,
                                    total_minor, line_item_count, abandoned_at, has_attribution, token_hash,
                                    token_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (cart_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          organizationId,
          storeId,
          payload.cart_id,
          payload.customer_id,
          payload.email_hash,
          payload.currency,
          payload.total_minor,
          payload.line_item_count,
          payload.abandoned_at,
          payload.has_attribution,
          hashToken(token),
          new Date(now.getTime() + ttlMs),
        ],
      );
      if (inserted.rows.length > 0) {
        created += 1;
        // The only moment the plaintext exists. The caller hands it to whoever sends the link and then drops it.
        tokens.set(payload.cart_id, token);
      }
    }

    const last = Number(rows.rows[rows.rows.length - 1]!.seq);
    await writeCursor(tx, organizationId, storeId, last);
    return { processed: rows.rows.length, created, cursor: last, tokens };
  });
}

/**
 * Marks the recoveries whose carts have since become orders. Reads `cart.order_id`, which window 1's placement
 * sets — marketing never decides what an order is.
 *
 * Idempotent on the target state: a record already `recovered` is skipped, so a cart counts once however many
 * times this runs (#148).
 */
export async function reconcileRecoveries(
  client: ScopedClient,
  storeId: string,
  options: { now?: Date } = {},
): Promise<{ recovered: number }> {
  const now = options.now ?? new Date();
  return client.transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE cart_recovery r
          SET status = 'recovered', recovered_order_id = c.order_id, recovered_at = $2
         FROM cart c
        WHERE c.id = r.cart_id
          AND r.store_id = $1
          AND c.order_id IS NOT NULL
          AND r.status <> 'recovered'`,
      [storeId, now],
    );
    return { recovered: updated.rowCount ?? 0 };
  });
}

/**
 * Redeems a recovery token and returns the cart it belongs to — the function window 1's Store API route calls
 * (REQUEST #246). Single-use, expiring, and it reactivates the cart so checkout can continue.
 *
 * Throws `not_found` for unknown, expired and already-redeemed tokens alike, and `conflict` when the cart was
 * already completed. See `recovery-token.ts` for why.
 */
export async function validateRecoveryToken(
  client: ScopedClient,
  storeId: string,
  token: string,
  options: { now?: Date; actor?: Actor } = {},
): Promise<{ cartId: string }> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? SYSTEM_ACTOR;
  const organizationId = client.context.organizationId;

  return client.transaction(async (tx) => {
    const { recoveryId, cartId } = await redeemToken(tx, storeId, token, now);
    await writeAudit(tx, {
      organizationId,
      storeId,
      actor,
      action: 'cart_recovery.redeem',
      entityType: 'cart_recovery',
      entityId: recoveryId,
      // No token, plaintext or hashed, in the audit trail.
      after: { cart_id: cartId, redeemed_at: now.toISOString() },
    });
    return { cartId };
  });
}

export async function getRecoveryByCart(
  client: ScopedClient,
  storeId: string,
  cartId: string,
): Promise<CartRecovery> {
  const res = await client.query<CartRecoveryRow>(
    `SELECT ${COLUMNS} FROM cart_recovery WHERE store_id = $1 AND cart_id = $2`,
    [storeId, cartId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('recovery record for cart', cartId);
  return toRecovery(row);
}

export async function listRecoveries(
  client: ScopedClient,
  storeId: string,
  query: { status?: RecoveryStatus; limit?: number } = {},
): Promise<CartRecovery[]> {
  const params: unknown[] = [storeId];
  let where = 'store_id = $1';
  if (query.status) {
    params.push(query.status);
    where += ` AND status = $${params.length}`;
  }
  params.push(Math.min(query.limit ?? 50, 500));
  const res = await client.query<CartRecoveryRow>(
    `SELECT ${COLUMNS} FROM cart_recovery WHERE ${where} ORDER BY abandoned_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((r) => toRecovery(r));
}
