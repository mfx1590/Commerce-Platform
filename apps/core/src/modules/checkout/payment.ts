// The payment provider registry moved to src/lib/payment-seam.ts (task 2.5, #174 review: no checkout ↔ orders cycle).
// Re-exported here so the checkout module's public API is unchanged.
export {
  manualPaymentProvider,
  paymentProvider,
  registeredPaymentProviders,
  setPaymentProvider,
} from '../../lib/payment-seam';
