// Public API of the fraud module (window 7, task 2.5, #128). Nothing outside this folder may import from its
// other files (ADR 0005).
import { registerWebhookHandler } from '../payments';
import { createFraudCheck, type FraudCheckOptions, type ModuleFraudCheck } from './check';
import { setFraudCheck } from './seam';
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
export {
  createFraudCheck,
  type BlockedPlacement,
  type FraudCheckOptions,
  type ModuleFraudCheck,
} from './check';
export { fraudMetrics, type FraudMetricsSnapshot } from './metrics';
export {
  flagOrderForReview,
  readOrderFraud,
  resolveOrderReview,
  type OrderFraudFlag,
  type OrderFraudStatus,
} from './order-flag';
// The checkout's real seam (core #236), re-exported: `currentFraudCheck()` here IS the checkout's.
export { currentFraudCheck, setFraudCheck, type FraudCheck } from './seam';
export { RADAR_WEBHOOK_HANDLERS, reviewClosedHandler, reviewOpenedHandler } from './webhooks';

/**
 * Boot mount point — `registerModuleSeams()` in `src/wiring.ts` calls it: registers the fraud check with the
 * CHECKOUT's seam (`setFraudCheck`, the registry `completeCart` reads) and Radar's `review.*` handlers with the
 * payments webhook receiver. Returns the check it registered. A store without settings runs both providers with
 * the defaults; a non-stripe payment is simply `allow` for Radar. The registered check always opts in to the
 * checkout's post-rollback hook (`recordsBlockedAfterRollback`, core #253) and never runs the deferred interim:
 * `deferredRecord` is forced off here so a block is recorded exactly once, by the checkout.
 */
export function registerFraudCheck(opts: FraudCheckOptions = {}): ModuleFraudCheck {
  for (const [type, handler] of Object.entries(RADAR_WEBHOOK_HANDLERS)) {
    registerWebhookHandler(type, handler);
  }
  const check = createFraudCheck({ ...opts, deferredRecord: false });
  setFraudCheck(check);
  return check;
}
