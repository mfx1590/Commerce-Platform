// Public API of the promotions module (window 9). Nothing outside this folder may import from its other files.
// Phase 2: task 2.4 price lists (the pricing half the cart consumes); task 2.5 adds the promotion/coupon rule
// engine to this same module.
export {
  createPriceList,
  listPriceLists,
  resolvePrices,
  upsertPrices,
  type PriceList,
  type PriceListInput,
  type PriceListType,
  type PriceUpsertRow,
  type ResolvedPrice,
  type ResolveQuery,
} from './pricing';
export { pricingRouter } from './pricing-http';
