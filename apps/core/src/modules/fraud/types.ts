// Fraud module types (task 2.5, #128). A `FraudProvider` looks at FACTS about a placement — ids, amounts,
// countries, the checkout's `email_hash` — never at an email, a name, an address or a card, and answers
// allow / review / block with a reason CODE. Codes are a closed set: they end up in order metadata, the audit log
// and events, so free text (and with it PII) has no way in.
import type { Queryable } from '@platform/db';
import type { Actor } from '../../lib/audit';

export type FraudOutcomeKind = 'allow' | 'review' | 'block';

export const FRAUD_REASON_CODES = [
  'velocity_email',
  'country_mismatch',
  'radar_elevated',
  'radar_highest',
  'radar_manual_review',
  'radar_review_opened',
  'provider_unavailable',
] as const;
export type FraudReasonCode = (typeof FRAUD_REASON_CODES)[number];

export type FraudProviderName = 'rules' | 'radar';

export interface FraudDecision {
  outcome: FraudOutcomeKind;
  /** Null only for `allow`. */
  reasonCode: FraudReasonCode | null;
  /** The provider that decided (null for `allow`). */
  provider: FraudProviderName | null;
}

export const ALLOW: FraudDecision = { outcome: 'allow', reasonCode: null, provider: null };

/** What the checkout hands to the fraud check BEFORE authorizing (REQUEST to window 1; local seam in ./seam). */
export interface FraudContext {
  /** The placement transaction (RLS scope = the cart's store). */
  tx: Queryable;
  organizationId: string;
  storeId: string;
  cartId: string;
  amountMinor: number;
  currency: string;
  /** The checkout's `emailHash(email)` — sha256 hex of the trimmed, lowercased email. Never the email. */
  emailHash: string | null;
  shippingCountry: string | null;
  billingCountry: string | null;
  /** Payment provider of the cart's session (`stripe`, `manual`) and its session id (`pi_…`). */
  paymentProvider: string;
  providerSessionId: string | null;
  actor: Actor;
}

/**
 * `store.settings.fraud`:
 *
 * - `providers` — which engines run, in order (default both: local rules, then Stripe Radar);
 * - `velocity` — more than `max_orders` orders for one email hash within `window_minutes` → review;
 * - `country_mismatch` — shipping ≠ billing country: `review` (default) or `allow`;
 * - `radar_highest` — Radar risk level `highest`: `block` (default) or `review`.
 */
export interface FraudSettings {
  providers: FraudProviderName[];
  velocity: { maxOrders: number; windowMinutes: number };
  countryMismatch: 'review' | 'allow';
  radarHighest: 'block' | 'review';
}

export const DEFAULT_FRAUD_SETTINGS: FraudSettings = {
  providers: ['rules', 'radar'],
  velocity: { maxOrders: 3, windowMinutes: 60 },
  countryMismatch: 'review',
  radarHighest: 'block',
};

export const FRAUD_SETTINGS_KEY = 'fraud';

const positiveInt = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;

/** Reads `store.settings.fraud`; unknown or malformed fields fall back to the defaults, reading never throws. */
export function fraudSettingsFrom(storeSettings: unknown): FraudSettings {
  const d = DEFAULT_FRAUD_SETTINGS;
  const raw =
    storeSettings && typeof storeSettings === 'object'
      ? (storeSettings as Record<string, unknown>)[FRAUD_SETTINGS_KEY]
      : undefined;
  if (!raw || typeof raw !== 'object') return { ...d, velocity: { ...d.velocity } };
  const f = raw as Record<string, unknown>;
  const providers = Array.isArray(f.providers)
    ? f.providers.filter((p): p is FraudProviderName => p === 'rules' || p === 'radar')
    : null;
  const v = (f.velocity && typeof f.velocity === 'object' ? f.velocity : {}) as Record<
    string,
    unknown
  >;
  return {
    providers: providers ? [...new Set(providers)] : [...d.providers],
    velocity: {
      maxOrders: positiveInt(v.max_orders, d.velocity.maxOrders),
      windowMinutes: positiveInt(v.window_minutes, d.velocity.windowMinutes),
    },
    countryMismatch: f.country_mismatch === 'allow' ? 'allow' : 'review',
    radarHighest: f.radar_highest === 'review' ? 'review' : 'block',
  };
}

export interface FraudProvider {
  readonly name: FraudProviderName;
  evaluate(ctx: FraudContext, settings: FraudSettings): Promise<FraudDecision>;
}

const RANK: Record<FraudOutcomeKind, number> = { allow: 0, review: 1, block: 2 };

/** The worse of two decisions (`block` > `review` > `allow`); the first one wins a tie. */
export function worse(a: FraudDecision, b: FraudDecision): FraudDecision {
  return RANK[b.outcome] > RANK[a.outcome] ? b : a;
}
