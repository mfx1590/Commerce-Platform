// Public API of @platform/notifications. Nothing outside this package may import from src/* directly.
export const PACKAGE_NAME = '@platform/notifications' as const;

export {
  claimEvents,
  CURSOR_NAME,
  deliverPending,
  errorLabel,
  resolveStores,
  runOnce,
} from './consumer.js';
export type {
  ClaimResult,
  ConsumerDeps,
  ConsumerOptions,
  DeliverResult,
  RunReport,
  StoreRunReport,
  StoreTarget,
} from './consumer.js';
export { fixtureFor, FIXTURES, pickLocale, render, strings } from './templates/index.js';
export { applyLegalEntity, BRAND_CODES, brandProfile, envKeyFor, parseSender } from './brands.js';
export { formatDate, formatMinor, escapeHtml } from './format.js';
export { loadOrderConfirmation, loadShipmentShipped } from './render-data.js';
export type { Loaded } from './render-data.js';
export {
  createTransport,
  DevSinkTransport,
  isTransportName,
  RESEND_KEY_ENV,
  ResendTransport,
} from './transport/index.js';
export type {
  FetchInit,
  FetchLike,
  FetchResponse,
  ResendTransportOptions,
  TransportName,
} from './transport/index.js';
export { AuthError, createStaffAuth, DEV_TOKENS_FLAG } from './auth.js';
export type { StaffAuth, StaffAuthOptions } from './auth.js';
export { createNotificationsHandler, createNotificationsServer } from './server.js';
export type { HealthStatus, NotificationsServerOptions } from './server.js';
export { resolveConfig } from './config.js';
export type { NotificationsConfig } from './config.js';
export {
  CONSUMED_TOPICS,
  consoleLogger,
  isKind,
  isLocale,
  KINDS,
  LOCALES,
  TOPIC_KINDS,
  TransportError,
} from './types.js';
export type {
  Address,
  BrandProfile,
  ConsumedTopic,
  DeliveryMeta,
  LegalFooter,
  Locale,
  Logger,
  NotificationData,
  NotificationKind,
  OrderConfirmationData,
  OrderLine,
  OrderTotals,
  RenderContext,
  RenderedContent,
  RenderedEmail,
  Sender,
  SendResult,
  ShipmentShippedData,
  Transport,
} from './types.js';
