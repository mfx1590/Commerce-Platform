// In-process counters of the fraud check (task 2.5, #128). The core has no metrics registry yet (requested with
// the fraud seam): until it does, these counters are what an exporter or a health endpoint reads, and every
// provider outage ALSO writes one log line — an outage sends every order to review, which must be visible
// within minutes, not discovered in the review queue. Labels are closed sets (outcomes, provider names, reason
// codes): no ids, no PII, bounded cardinality.
import type { FraudOutcomeKind, FraudProviderName, FraudReasonCode } from './types';

export interface FraudMetricsSnapshot {
  /** `fraud_evaluations_total{outcome}` */
  evaluations: Record<FraudOutcomeKind, number>;
  /** `fraud_decisions_total{reason_code}` for review/block decisions */
  reasons: Partial<Record<FraudReasonCode, number>>;
  /** `fraud_provider_outages_total{provider}` */
  outages: Partial<Record<FraudProviderName, number>>;
}

const zero = (): FraudMetricsSnapshot => ({
  evaluations: { allow: 0, review: 0, block: 0 },
  reasons: {},
  outages: {},
});

let state = zero();

export const fraudMetrics = {
  evaluation(outcome: FraudOutcomeKind, reason: FraudReasonCode | null): void {
    state.evaluations[outcome] += 1;
    if (reason) state.reasons[reason] = (state.reasons[reason] ?? 0) + 1;
  },
  outage(provider: FraudProviderName): void {
    state.outages[provider] = (state.outages[provider] ?? 0) + 1;
  },
  snapshot(): FraudMetricsSnapshot {
    return {
      evaluations: { ...state.evaluations },
      reasons: { ...state.reasons },
      outages: { ...state.outages },
    };
  },
  reset(): void {
    state = zero();
  },
};
