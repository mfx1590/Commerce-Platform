// Public API of the cart module. Nothing outside this folder may import from its other files (ADR 0005).
export {
  addLineItem,
  createCart,
  getCart,
  normalizePromotionCodes,
  removeLineItem,
  updateCart,
  updateLineItem,
} from './service';
// Pricing providers: windows 7 (tax, #127) and 8 (shipping rates, #130) replace the table-backed defaults at boot.
export {
  currentShippingRateProvider,
  currentTaxCalculator,
  setShippingRateProvider,
  setTaxCalculator,
  tableShippingRates,
  tableTaxCalculator,
  taxOn,
} from './providers';
export type {
  Address,
  CartStatus,
  CartStoreContext,
  CreateCartInput,
  Money,
  PricingContext,
  PricingLine,
  ShippingRate,
  ShippingRateProvider,
  StoreCart,
  StoreLineItem,
  StorePaymentSession,
  StoreShippingOption,
  TaxCalculation,
  TaxCalculator,
  TaxLine,
  UpdateCartInput,
} from './types';
