// Abandoned-cart recovery types (#148). Schema: `packages/db/migrations/0170_cart_recovery.sql` (#244,
// landed in contracts-v0.4.5).
//
// The report shape comes from the contract since #245 landed in contracts-v0.4.5.
import type { AdminComponents } from '@platform/contracts';
import type { Money } from './types';

export type RecoveryStatus = 'pending' | 'redeemed' | 'recovered';

export const RECOVERY_STATUSES: readonly RecoveryStatus[] = ['pending', 'redeemed', 'recovered'];

/** Name of this consumer's row in `marketing_cursor`. */
export const RECOVERY_CURSOR = 'cart_recovery';

/**
 * The `utm_source` a recovery link carries.
 *
 * Exported so window 16 (which builds the link) and window 3/10 (which capture the touch) pin a value rather
 * than copying one out of prose. Changing it would silently split every recovered order's attribution across
 * two sources in the 2.1 report, so it is a constant, in one place.
 */
export const RECOVERY_UTM_SOURCE = 'abandoned_cart';

/** A row of `cart_recovery`. `token_hash` never leaves this process. */
export interface CartRecoveryRow {
  id: string;
  organization_id: string;
  store_id: string;
  cart_id: string;
  customer_id: string | null;
  email_hash: string | null;
  currency: string;
  total_minor: string;
  line_item_count: number;
  abandoned_at: Date;
  has_attribution: boolean;
  token_hash: string;
  token_expires_at: Date;
  redeemed_at: Date | null;
  status: RecoveryStatus;
  recovered_order_id: string | null;
  recovered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A recovery record as anything outside this module may see it. **No `token_hash` and no plaintext token**: the
 * token is handed to the caller once, by `createRecovery`, and never appears in a read model again.
 */
export interface CartRecovery {
  id: string;
  store_id: string;
  cart_id: string;
  customer_id: string | null;
  email_hash: string | null;
  currency: string;
  total: Money;
  line_item_count: number;
  abandoned_at: string;
  has_attribution: boolean;
  token_expires_at: string;
  redeemed_at: string | null;
  status: RecoveryStatus;
  /** Derived, never stored: `pending` past its expiry. See the note in the proposed migration. */
  expired: boolean;
  recovered_order_id: string | null;
  recovered_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The contract's own component since contracts-v0.4.5 (#245). */
export type AbandonedCartReport = AdminComponents['schemas']['AbandonedCartReport'];

export interface AbandonedCartReportQuery {
  from: string;
  to: string;
}
