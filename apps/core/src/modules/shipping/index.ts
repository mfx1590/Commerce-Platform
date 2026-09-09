// Public API of the shipping module (window 8). Nothing outside this folder may import from its other files
// (ADR 0005); other modules import `../modules/shipping`.
export {
  carrierConfigFor,
  DEFAULT_PARCEL,
  easyPostCredentialsFor,
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
export { createCarrierRateProvider, parseRules, registerCarrierProviders } from './rate-shopping';
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
