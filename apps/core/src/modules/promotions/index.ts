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
// ---- promotions / coupon rule engine (task 2.5, #138; contract change #189) ----
export {
  allocateAcrossLines,
  eligibleLines,
  evaluatePromotions,
  type AppliedPromotion,
  type CartLineInput,
  type EvaluationContext,
  type EvaluationResult,
  type RejectedPromotion,
  type RejectReason,
} from './engine';
export {
  createPromotion,
  getPromotion,
  listPromotions,
  loadCandidatePromotions,
  promotionReportData,
  recordPromotionUse,
  updatePromotion,
  type PromotionListQuery,
  type PromotionReportItem,
} from './promotions';
export {
  normalizeCode,
  parsePromotionInput,
  parsePromotionPatch,
  PROMOTION_INPUT_SCHEMA,
  PROMOTION_PATCH_SCHEMA,
  type Promotion,
  type PromotionInput,
  type PromotionPatch,
  type PromotionRules,
  type PromotionStatus,
  type PromotionType,
} from './promotions-types';
export { promotionsRouter } from './promotions-http';
