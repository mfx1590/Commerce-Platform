// Abandoned-cart recovery types (#148). Schema: `proposed/0170_cart_recovery.sql` (CONTRACT CHANGE #244) —
// `packages/db` is frozen, so the module tests apply that file to their own throwaway database until it lands.
//
// The report shape mirrors `AbandonedCartReport` in CONTRACT CHANGE #245; it is declared here rather than
// imported from `@platform/contracts` because the component does not exist in 0.4.3 yet. When #245 lands this
// becomes `AdminComponents['schemas']['AbandonedCartReport']`, exactly as `ProductFeed` did after #194.
import type { Money } from './types';

export type RecoveryStatus = 'pending' | 'redeemed' | 'recovered';

export const RECOVERY_STATUSES: readonly RecoveryStatus[] = ['pending', 'redeemed', 'recovered'];

/** Name of this consumer's row in `marketing_cursor`. */
export const RECOVERY_CURSOR = 'cart_recovery';

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

export interface AbandonedCartReport {
  from: string;
  to: string;
  currency: string;
  abandoned_count: number;
  /** Recovery links that were opened (token redeemed). */
  redeemed_count: number;
  /** Abandoned carts that became an order. */
  recovered_count: number;
  recovery_rate: number;
  abandoned_value: Money;
  recovered_value: Money;
}

export interface AbandonedCartReportQuery {
  from: string;
  to: string;
}
