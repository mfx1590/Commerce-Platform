// Public API of the fulfillment module (window 8). Nothing outside this folder may import from its other files
// (ADR 0005); other modules import `../modules/fulfillment`.
export { createMemoryFulfillmentProvider } from './memory-provider';
export type { MemoryFulfillmentProvider } from './memory-provider';
export {
  DEFAULT_FULFILLMENT_PROVIDER,
  fulfillmentProvider,
  fulfillmentProviderFor,
  resetFulfillmentProviders,
  setFulfillmentProvider,
} from './registry';
export { regionOf, routeFulfillment, routingSettingsFrom } from './routing';
export {
  applyFulfillmentUpdate,
  cancelFulfillment,
  FULFILLMENT_METADATA_KEY,
  requestFulfillment,
} from './service';
export type { RequestFulfillmentInput, RequestFulfillmentResult } from './service';
export { FulfillmentError } from './types';
export type {
  CancelResult,
  FulfillmentAck,
  FulfillmentAddress,
  FulfillmentLine,
  FulfillmentProvider,
  FulfillmentRef,
  FulfillmentRequest,
  FulfillmentState,
  FulfillmentUpdate,
  RoutingDecision,
  RoutingSettings,
  WarehouseCandidate,
} from './types';
