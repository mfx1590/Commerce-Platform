// Public API of the shipping module (window 8). Nothing outside this folder may import from its other files
// (ADR 0005); other modules import `../modules/shipping`.
export {
  carrierConfigFor,
  DEFAULT_PARCEL,
  easyPostCredentialsFor,
  easyPostWebhookSecretFor,
  envSuffix,
  isTestModeKey,
} from './config';
export {
  createEasyPostProvider,
  EASYPOST_BASE_URL,
  easyPostTrackingStatus,
  trackingEventOf,
} from './easypost-provider';
export {
  createManualCarrierProvider,
  DEFAULT_MANUAL_CONFIG,
  manualCarrierProvider,
} from './manual-provider';
export { currencyExponent, fromMinorUnits, toMinorUnits } from './money';
export {
  coreInventoryPort,
  coreOrdersPort,
  currentInventoryPort,
  currentOrdersPort,
  setInventoryPort,
  setOrdersPort,
} from './ports';
export { createCarrierRateProvider, parseRules, registerCarrierProviders } from './rate-shopping';
export {
  applyTransition,
  buyShipmentLabel,
  canTransition,
  createShipment,
  getShipment,
  iso,
  listOrderShipments,
  readShipmentMetadata,
  renderShipment,
  updateShipment,
  writeShipmentMetadata,
} from './shipments';
export {
  applyTrackingEvent,
  extractEasyPostWebhook,
  handleEasyPostWebhook,
  verifyEasyPostSignature,
} from './tracking';
export {
  CREATE_SHIPMENT_PATH,
  EASYPOST_WEBHOOK_BODY_LIMIT,
  EASYPOST_WEBHOOK_PATH,
  shippingAdminRouter,
  shippingWebhookRouter,
  UPDATE_SHIPMENT_PATH,
} from './http';
export type { ShippingWebhookRouterOptions } from './http';
export {
  finishWebhookEvent,
  payloadHashOf,
  recordWebhookEvent,
  TRACKING_WEBHOOK_PROVIDER,
} from './webhook-events';
export { CarrierError, isRetryableStatus, redactAddress, toCarrierAddress } from './redact';
export {
  carrierProvider,
  carrierProviderOrManual,
  registeredCarrierProviders,
  resetCarrierProviders,
  setCarrierProvider,
} from './registry';
export { BoundedTtlMap } from './bounded-map';
export type { BoundedTtlMapOptions } from './bounded-map';
export type { CarrierCredentials } from './config';
export type { EasyPostOptions } from './easypost-provider';
export type { ManualCarrierConfig, ManualProviderLimits, ManualService } from './manual-provider';
export type {
  CarrierRateProvider,
  RateShoppingOptions,
  ShippingOptionRules,
} from './rate-shopping';
export type {
  InventoryCall,
  InventoryPort,
  OrdersCall,
  OrdersOutcome,
  OrdersPort,
  ShipmentLineRef,
} from './ports';
export type {
  CreateShipmentInput,
  ShipmentItem,
  ShipmentRow,
  ShipmentStatus,
  StoreShipment,
  TransitionInput,
  UpdateShipmentInput,
} from './shipments';
export type { ApplyTrackingInput, WebhookRequest, WebhookResult } from './tracking';
export type { RecordInput, TrackingExtract, WebhookEventStatus } from './webhook-events';
export type {
  AddressValidation,
  BuyLabelRequest,
  CarrierAddress,
  CarrierLabel,
  CarrierProvider,
  CarrierProviderName,
  CarrierRate,
  ContractAddress,
  LabelFormat,
  Parcel,
  RateRequest,
  StoreCarrierConfig,
  TrackRequest,
  TrackingEvent,
  TrackingStatus,
  VoidLabelRequest,
  VoidLabelResult,
} from './types';
