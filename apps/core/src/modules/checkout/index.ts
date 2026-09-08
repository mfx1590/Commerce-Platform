// Public API of the checkout module. Nothing outside this folder may import from its other files (ADR 0005).
export {
  assertCartVisible,
  completeCart,
  createPaymentSession,
  emailHash,
  listShippingOptions,
} from './service';
export { customerIdForSubject, getStoreOrder, renderOrder } from './orders-read';
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
  OrderAccess,
  PaymentCartRef,
  PaymentProvider,
  PaymentProviderName,
  PaymentSessionResult,
  PaymentSessionStatus,
  RefundInput,
  RefundResult,
  StoreOrder,
  StoreOrderSummary,
  StorePaymentSession,
  StoreShippingOption,
} from './types';
