// Public API of the checkout module. Nothing outside this folder may import from its other files (ADR 0005).
export {
  assertCartVisible,
  completeCart,
  createPaymentSession,
  emailHash,
  listShippingOptions,
} from './service';
// The order read (`getStoreOrder`, `renderStoreOrder`, `customerIdForSubject`) lives in `src/modules/orders` since 2.3.
// Payment providers: window 7 registers `stripe` (#127) with setPaymentProvider at boot; `manual` ships here.
export {
  manualPaymentProvider,
  paymentProvider,
  registeredPaymentProviders,
  setPaymentProvider,
} from './payment';
export type {
  AuthorizeInput,
  AuthorizeResult,
  CompleteCartInput,
  CompleteCartResult,
  CreatePaymentSessionInput,
  PaymentCartRef,
  PaymentProvider,
  PaymentProviderName,
  PaymentSessionResult,
  PaymentSessionStatus,
  RefundInput,
  RefundResult,
  StorePaymentSession,
  StoreShippingOption,
  VoidInput,
  VoidResult,
} from './types';
// Fraud seam (#231): window 7 registers its check at boot; a block is a plain 402 `payment_failed`, a review places
// the order and flags it through the orders module.
export { currentFraudCheck, FRAUD_ALLOW, setFraudCheck } from '../../lib/fraud-seam';
export type { FraudCheck, FraudContext, FraudDecision, FraudOutcome } from '../../lib/fraud-seam';
