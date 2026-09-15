// Public API of the orders module. Nothing outside this folder may import from its other files (ADR 0005).
// Windows 7 (payments) and 8 (shipping) call the mark* wrappers with a scoped client and ids — never provider
// objects; every status change goes through `transition()` and writes exactly one event.
export {
  cancelOrder,
  confirmOrder,
  markDelivered,
  markPaymentAuthorized,
  markPaymentCaptured,
  markPaymentFailed,
  markPaymentPartiallyRefunded,
  markPaymentRefunded,
  markReturned,
  markReturnedIn,
  markShipmentCreated,
  mergeOrderMetadataIn,
  movePaymentStatusIn,
  markShipped,
  transition,
} from './service';
export { cancelLine, decreaseLineQuantity } from './edits';
export type { OrderEdit } from './edits';
export {
  customerIdForSubject,
  getAdminOrder,
  getStoreOrder,
  listAdminOrders,
  loadOrder,
  loadOrderLines,
  renderAdminOrder,
  renderStoreOrder,
  toAdminSummary,
} from './read-model';
export { applyOrderEvent, projectOrder } from './projection';
export type { OrderProjection, ProjectedEvent } from './projection';
export {
  allowed,
  FULFILLMENT_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  STATUS_TRANSITIONS,
  transitionTableMarkdown,
} from './transitions';
export { FULFILLMENT_STATUSES, ORDER_SORT_FIELDS, ORDER_STATUSES, PAYMENT_STATUSES } from './types';
export type {
  AdminOrder,
  AdminOrderSummary,
  FulfillmentStatus,
  LineQuantity,
  ListOrdersQuery,
  OrderAccess,
  OrderLineRow,
  OrderRow,
  OrderSortField,
  OrderStatus,
  Page,
  PaymentStatus,
  StatusField,
  StoreOrder,
  TransitionChange,
  TransitionHooks,
} from './types';
