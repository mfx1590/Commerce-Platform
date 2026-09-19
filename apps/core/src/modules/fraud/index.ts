// Public API of the fraud module (window 7, task 2.5, #128). Nothing outside this folder may import from its
// other files (ADR 0005).
import { registerWebhookHandler } from '../payments';
import { createFraudCheck, type FraudCheckOptions } from './check';
import { setFraudCheck, type FraudCheck } from './seam';
import { RADAR_WEBHOOK_HANDLERS } from './webhooks';

export {
  ALLOW,
  DEFAULT_FRAUD_SETTINGS,
  FRAUD_REASON_CODES,
  FRAUD_SETTINGS_KEY,
  fraudSettingsFrom,
  worse,
  type FraudContext,
  type FraudDecision,
  type FraudOutcomeKind,
  type FraudProvider,
  type FraudProviderName,
  type FraudReasonCode,
  type FraudSettings,
} from './types';
export { ordersForEmailHash, rulesFraudProvider } from './rules-provider';
export { createRadarFraudProvider, type RadarProviderOptions } from './radar-provider';
export { createFraudCheck, type FraudCheckOptions } from './check';
export { fraudMetrics, type FraudMetricsSnapshot } from './metrics';
export {
  flagOrderForReview,
  readOrderFraud,
  resolveOrderReview,
  type OrderFraudFlag,
  type OrderFraudStatus,
} from './order-flag';
export {
  applyDecisionToOrder,
  currentFraudCheck,
  enforceDecision,
  setFraudCheck,
  type FraudCheck,
} from './seam';
export { RADAR_WEBHOOK_HANDLERS, reviewClosedHandler, reviewOpenedHandler } from './webhooks';

/**
 * Boot mount point (REQUEST to window 1, next to `registerPaymentProviders()` / `registerTaxProvider()`):
 * registers the fraud check with the seam and Radar's `review.*` handlers with the payments webhook receiver.
 * Returns the previous check. A store without settings runs both providers with the defaults; a non-stripe
 * payment is simply `allow` for Radar.
 */
export function registerFraudCheck(opts: FraudCheckOptions = {}): FraudCheck | null {
  for (const [type, handler] of Object.entries(RADAR_WEBHOOK_HANDLERS)) {
    registerWebhookHandler(type, handler);
  }
  return setFraudCheck(createFraudCheck(opts));
}
