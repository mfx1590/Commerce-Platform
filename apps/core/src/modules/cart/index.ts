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
// Cart internals the checkout module (window 1) builds placement on: same tables, same transaction.
export {
  assertLinesInStock,
  loadCart,
  loadLines,
  lockActiveCart,
  recalculate,
  renderCart,
} from './service';
// Abandoned carts (task 2.6): the job in src/jobs/abandoned-carts.ts calls these with an injected clock.
export { markAbandonedCarts, markAllAbandonedCarts } from './abandoned';
export type { MarkAbandonedInput, MarkAbandonedResult } from './abandoned';
// Pricing providers: windows 7 (tax, #127) and 8 (shipping rates, #130) replace the table-backed defaults at boot.
export {
  currentShippingRateProvider,
  currentTaxCalculator,
  lineTaxOf,
  lineTotalWith,
  pricesIncludeTaxFor,
  setShippingRateProvider,
  setTaxCalculator,
  tableShippingRates,
  tableTaxCalculator,
  taxOn,
} from './providers';
export type {
  Address,
  CartLineRow,
  CartRow,
  CartStatus,
  CartStoreContext,
  CreateCartInput,
  LineTaxRecord,
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
  TaxMode,
  TaxLine,
  UpdateCartInput,
} from './types';
