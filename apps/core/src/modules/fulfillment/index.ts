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
export {
  clearPendingLifecycleEvents,
  currentLifecycleEmitter,
  emitLifecycleEvent,
  lifecycleEmitter,
  LIFECYCLE_TOPICS,
  pendingLifecycleEvents,
  setLifecycleEmitter,
  topicIsKnown,
} from './lifecycle-events';
export type {
  LifecycleEmitter,
  LifecycleEvent,
  LifecycleLine,
  LifecycleTopic,
} from './lifecycle-events';
export { listPickLists, packShipment, pickShipment, PICK_LIST_STATUSES } from './lifecycle';
export {
  fulfillmentAdminRouter,
  PACK_SHIPMENT_PATH,
  PICK_LISTS_PATH,
  PICK_SHIPMENT_PATH,
} from './http';
export type { PickListGroup, PickListPage, PickListQuery } from './lifecycle';
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
