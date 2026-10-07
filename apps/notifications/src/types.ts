// Shared types of @platform/notifications (#360).

/** Outbox topics the worker consumes, and the notification each one produces. */
export const TOPIC_KINDS = {
  'order.placed': 'order_confirmation',
  'shipment.shipped': 'shipment_shipped',
} as const;
export type ConsumedTopic = keyof typeof TOPIC_KINDS;
export type NotificationKind = (typeof TOPIC_KINDS)[ConsumedTopic];
export const CONSUMED_TOPICS = Object.keys(TOPIC_KINDS) as ConsumedTopic[];
export const KINDS = Object.values(TOPIC_KINDS) as NotificationKind[];
export function isKind(value: string): value is NotificationKind {
  return (KINDS as string[]).includes(value);
}

/** Locales with a template. A store locale outside this set falls back (see `pickLocale`). */
export const LOCALES = ['en-GB', 'de-DE'] as const;
export type Locale = (typeof LOCALES)[number];
export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export interface Sender {
  name: string;
  email: string;
}

/** The legal footer every email carries. Placeholders until the owner fills them in at the 2b gate. */
export interface LegalFooter {
  company: string;
  address: string;
  vatNumber: string | null;
  imprintUrl: string;
  privacyUrl: string;
}

export interface BrandProfile {
  storeCode: string;
  name: string;
  sender: Sender;
  replyTo: string | null;
  supportEmail: string;
  websiteUrl: string;
  defaultLocale: Locale;
  legal: LegalFooter;
}

/** `"order".shipping_address` as the Store API `Address` schema writes it. Every key optional: it is jsonb. */
export interface Address {
  first_name?: string;
  last_name?: string;
  company?: string | null;
  line1?: string;
  line2?: string | null;
  city?: string;
  region?: string | null;
  postal_code?: string;
  country?: string;
}

export interface OrderLine {
  title: string;
  variantTitle: string;
  sku: string;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
}

export interface OrderTotals {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export interface OrderConfirmationData {
  displayId: number;
  placedAt: string;
  currency: string;
  shippingAddress: Address;
  lines: OrderLine[];
  totals: OrderTotals;
  shippingMethod: { name: string; carrier: string } | null;
  promotionCodes: string[];
}

export interface ShipmentShippedData {
  displayId: number;
  shippedAt: string;
  carrier: string;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  items: { title: string; variantTitle: string; quantity: number }[];
  shippingAddress: Address;
}

export type NotificationData = {
  order_confirmation: OrderConfirmationData;
  shipment_shipped: ShipmentShippedData;
};

export interface RenderContext {
  brand: BrandProfile;
  locale: Locale;
  /** IANA zone the dates are shown in — the store's timezone. */
  timeZone: string;
}

export interface RenderedContent {
  subject: string;
  text: string;
  html: string;
}

/** The complete message. The ONLY value in this package that carries the recipient's address. */
export interface RenderedEmail extends RenderedContent {
  from: Sender;
  to: string;
  replyTo: string | null;
}

/** What a transport, a log line or /health may know about a delivery. Deliberately no address and no name. */
export interface DeliveryMeta {
  eventId: string;
  kind: NotificationKind;
  storeCode: string;
  locale: Locale;
  displayId: number;
}

export interface SendResult {
  providerMessageId: string | null;
}

export interface Transport {
  readonly name: string;
  /** Resolves when the provider accepted the message; throws `TransportError` when it refused it. */
  send(email: RenderedEmail, meta: DeliveryMeta): Promise<SendResult>;
}

/** A refusal by the transport. The message is a short label (HTTP status + error name), never a body. */
export class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(
    message: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.info(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};
