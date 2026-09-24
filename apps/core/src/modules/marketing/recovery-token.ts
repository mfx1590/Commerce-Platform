// Recovery tokens (#148): mint, and redeem exactly once.
//
// A recovery link is a **bearer credential** — whoever holds it gets the cart. Three consequences, all of them
// decisions rather than accidents:
//
// 1. **The token carries nothing.** 32 random bytes, base64url. No cart id, customer id or email is encoded in
//    it, so a link that ends up in a referrer header, a support ticket or a screenshot gives away only itself.
//    That is also why redemption has to be a server round trip: nothing but the database can turn it back into
//    a cart. (Manager decision 2026-09-19 — the Store API route, REQUEST #246.)
// 2. **Only `sha256(token)` is stored**, the same treatment as `store_api_key.key_hash`. The plaintext is
//    returned once, at mint, and never written down; a database leak does not hand anyone working links.
// 3. **Unknown, expired and already-redeemed answer identically.** Telling them apart would let someone holding
//    a guessed token learn whether it ever existed.
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '@platform/db';
import { conflict, notFound } from '../../lib/errors';

/** 32 bytes ≈ 43 base64url characters. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;
export const DEFAULT_TTL_MS = 7 * 24 * 3_600_000;

export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// There is deliberately no constant-time hash comparison here. The lookup is `WHERE token_hash = $2` on an
// indexed column, so the database decides the timing and a `timingSafeEqual` in front of it protected nothing —
// it only read like a security measure, which is worse than not having one (#250 review).

export interface RedeemedRecovery {
  recoveryId: string;
  cartId: string;
}

interface RedeemRow {
  id: string;
  cart_id: string;
  status: string;
  token_expires_at: Date;
  redeemed_at: Date | null;
  cart_status: string;
}

/**
 * Redeems a token and returns the cart it belongs to. One transaction: check, stamp, reactivate.
 *
 * Errors, and why they are what they are:
 * - unknown, expired, already redeemed → **the same** `404` (see the header note);
 * - the cart was already completed → `409`, because that customer is confused rather than lost and the
 *   storefront should say "you already placed this order". It leaks nothing: the caller already proved they
 *   hold a valid token.
 *
 * Single use is enforced by the `UPDATE … WHERE redeemed_at IS NULL` returning no row, not by the read above
 * it: two requests arriving together must not both succeed, and a check-then-write would let them.
 */
export async function redeemToken(
  tx: Queryable,
  storeId: string,
  token: string,
  now: Date = new Date(),
): Promise<RedeemedRecovery> {
  if (typeof token !== 'string' || token.length < 16) throw notFound('recovery link');
  const hash = hashToken(token);

  const found = await tx.query<RedeemRow>(
    `SELECT r.id, r.cart_id, r.status, r.token_expires_at, r.redeemed_at, c.status AS cart_status
       FROM cart_recovery r
       JOIN cart c ON c.id = r.cart_id
      WHERE r.store_id = $1 AND r.token_hash = $2`,
    [storeId, hash],
  );
  const row = found.rows[0];
  if (!row) throw notFound('recovery link');
  if (row.redeemed_at !== null) throw notFound('recovery link');
  if (row.token_expires_at.getTime() <= now.getTime()) throw notFound('recovery link');

  // A cart that already became an order is a different story from a dead link, and the caller has earned it.
  if (row.cart_status === 'completed')
    throw conflict('cart already completed', { cart_id: row.cart_id });

  const claimed = await tx.query<{ id: string; cart_id: string }>(
    `UPDATE cart_recovery
        SET redeemed_at = $3, status = 'redeemed'
      WHERE id = $1 AND store_id = $2 AND redeemed_at IS NULL
      RETURNING id, cart_id`,
    [row.id, storeId, now],
  );
  const claimedRow = claimed.rows[0];
  // Lost the race: someone else redeemed it between the read and the update. Same answer as a used link.
  if (!claimedRow) throw notFound('recovery link');

  // Reactivate the cart so the storefront can carry straight on to checkout. `abandoned` → `active` is the same
  // transition window 1's own reactivation makes when a customer touches an abandoned cart.
  await tx.query(
    `UPDATE cart SET status = 'active' WHERE id = $1 AND store_id = $2 AND status = 'abandoned'`,
    [claimedRow.cart_id, storeId],
  );

  return { recoveryId: claimedRow.id, cartId: claimedRow.cart_id };
}
