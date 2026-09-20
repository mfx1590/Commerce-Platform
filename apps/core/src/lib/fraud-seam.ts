// Fraud seam of the checkout (#231, window 7's REQUEST): the types and the registry live here, next to the payment
// seam, so neither the checkout nor the orders module ever imports window 7's fraud module — it imports these and
// registers its check at boot (src/wiring.ts). Facts and codes only: no email, no address, no card data.
import type { Queryable } from '@platform/db';
import type { Actor } from './audit';

export type FraudOutcome = 'allow' | 'review' | 'block';

export interface FraudDecision {
  outcome: FraudOutcome;
  /** A code from the fraud module's closed set; null only for `allow`. */
  reasonCode: string | null;
  /** The engine that decided (`rules`, `radar`, …); null for `allow`. */
  provider: string | null;
}

/** What the checkout hands to the check BEFORE authorizing, inside the placement transaction. */
export interface FraudContext {
  /** The placement transaction (RLS scope = the cart's store). */
  tx: Queryable;
  organizationId: string;
  storeId: string;
  cartId: string;
  amountMinor: number;
  currency: string;
  /** sha256 hex of the trimmed, lowercased email — never the email. */
  emailHash: string | null;
  shippingCountry: string | null;
  billingCountry: string | null;
  paymentProvider: string;
  providerSessionId: string | null;
  actor: Actor;
}

export interface FraudCheck {
  evaluate(ctx: FraudContext): Promise<FraudDecision>;
}

export const FRAUD_ALLOW: FraudDecision = { outcome: 'allow', reasonCode: null, provider: null };
/** Reason recorded when the registered check itself throws: an outage is a review — never a block, never a pass. */
export const FRAUD_CHECK_UNAVAILABLE = 'provider_unavailable';

/**
 * Provider recorded for an outage of the check as a whole. It stays inside the fraud module's provider-name set
 * (`rules` | `radar`): `rules` is the local engine that always runs first, so an outage we cannot attribute is
 * booked on it (#236 review — `checkout` was outside the set).
 */
export const FRAUD_OUTAGE_PROVIDER = 'rules';

let current: FraudCheck | null = null;

/** Registers the fraud check (null = none: every placement is allowed). Returns the previous one. */
export function setFraudCheck(next: FraudCheck | null): FraudCheck | null {
  const previous = current;
  current = next;
  return previous;
}

export function currentFraudCheck(): FraudCheck | null {
  return current;
}

/**
 * Runs the registered check. No check → allow. A check that throws → `review` (manager decision 2026-09-19: a
 * fraud provider outage never blocks a customer and never passes silently); the error is not logged with any
 * request data — the fraud module owns its own outage log and metrics.
 */
export async function evaluateFraud(ctx: FraudContext): Promise<FraudDecision> {
  const check = current;
  if (!check) return FRAUD_ALLOW;
  try {
    return await check.evaluate(ctx);
  } catch {
    return {
      outcome: 'review',
      reasonCode: FRAUD_CHECK_UNAVAILABLE,
      provider: FRAUD_OUTAGE_PROVIDER,
    };
  }
}
