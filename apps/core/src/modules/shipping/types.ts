// Carrier abstraction of the shipping module (window 8, issue #129). Everything a provider exchanges is ids,
// amounts in integer minor units and addresses that never reach a log (see redact.ts). Label artefacts are held
// as URLs only — no PDF bytes are stored or passed around.
import type { StoreComponents } from '@platform/contracts';

/** The Store/Admin API address shape (`order.shipping_address`, `cart.shipping_address`). */
export type ContractAddress = StoreComponents['schemas']['Address'];

/** Built-in provider names. Others may register under their own name (`setCarrierProvider`). */
export type CarrierProviderName = 'manual' | 'easypost' | (string & {});

/** Address as a carrier wants it: one `name`, no first/last split, country as ISO-3166 alpha-2. */
export interface CarrierAddress {
  name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
  phone: string | null;
  email: string | null;
}

/** One physical box. Dimensions in centimetres, weight in grams (integers, like every quantity we store). */
export interface Parcel {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightG: number;
}

export interface RateRequest {
  from: CarrierAddress;
  to: CarrierAddress;
  parcels: Parcel[];
  /** Currency the rates must be expressed in (ISO-4217, upper case). A provider that cannot quote it returns []. */
  currency: string;
  /** Provider-side carrier accounts to shop (per store, from `carrierConfigFor`). Empty = the account default. */
  carrierAccountIds?: string[];
  /** Restrict the shopping to these carrier service codes (`UPSGround`, `Priority`, …). Empty = all. */
  services?: string[];
}

export interface CarrierRate {
  /** The provider that produced it (`manual`, `easypost`). */
  provider: CarrierProviderName;
  /** Provider-side id, the handle `buyLabel` takes. Stable for the lifetime of the provider's quote. */
  rateId: string;
  carrier: string;
  /** Carrier service code (`UPSGround`). */
  service: string;
  /** Human label for the checkout (`UPS Ground`). */
  serviceName: string;
  priceMinor: number;
  currency: string;
  /** Carrier's delivery estimate in days, or null when it does not give one. */
  estimatedDays: number | null;
}

export interface BuyLabelRequest {
  /** A `rateId` from `rates()` of the same provider. */
  rateId: string;
  /**
   * Provider-side shipment the rate belongs to. Providers that need it (EasyPost) remember it from `rates()`
   * within the process; pass it explicitly when the label is bought in another process than the quote.
   */
  providerShipmentId?: string;
  /** Our `shipment.id`; passed to the carrier as a reference so a support case can be traced back. */
  reference?: string;
  /** `pdf` (default), `png` or `zpl`. */
  labelFormat?: LabelFormat;
}

export type LabelFormat = 'pdf' | 'png' | 'zpl';

export interface CarrierLabel {
  provider: CarrierProviderName;
  /** Provider-side shipment id — what `voidLabel` and the tracking webhook refer to. */
  providerShipmentId: string;
  rateId: string;
  carrier: string;
  service: string;
  trackingNumber: string;
  trackingUrl: string | null;
  /** URL of the label artefact. We store the reference, never the bytes. */
  labelUrl: string;
  labelFormat: LabelFormat;
  /** What the carrier charges us, in minor units of `currency`. */
  costMinor: number;
  currency: string;
}

export interface VoidLabelRequest {
  providerShipmentId: string;
}

export interface VoidLabelResult {
  voided: boolean;
  /** Provider wording for the refund state (`submitted`, `refunded`, `not_applicable`). */
  refundStatus: string;
}

/** Normalised carrier tracking states. Anything a provider does not map lands on `unknown`. */
export type TrackingStatus =
  | 'unknown'
  | 'pre_transit'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'available_for_pickup'
  | 'return_to_sender'
  | 'failure'
  | 'cancelled';

export interface TrackingEvent {
  /** Provider-side id of this tracking detail — the idempotency key of task 2.3's webhook receiver. */
  eventId: string;
  trackingNumber: string;
  carrier: string;
  status: TrackingStatus;
  /** Carrier's own wording, kept for support (`Delivered, In/At Mailbox`). Never an address. */
  statusDetail: string | null;
  /** ISO-8601 instant the carrier scanned it. */
  occurredAt: string;
  /** City and country of the scan only — no street level, so it is safe to store on the shipment. */
  location: { city: string | null; region: string | null; country: string | null } | null;
}

export interface TrackRequest {
  trackingNumber: string;
  carrier?: string;
}

export interface AddressValidation {
  valid: boolean;
  /** The carrier's normalised address when it returned one, else null. Never logged. */
  normalized: CarrierAddress | null;
  /** Provider messages, e.g. `street-level match not found`. Must not echo the address itself. */
  messages: string[];
}

/**
 * What a carrier can do for us. `manual` (in-memory, deterministic) and `easypost` ship in this module; a 3PL that
 * buys its own labels is a `FulfillmentProvider` instead (task 2.4). Implementations must throw `CarrierError`
 * and never put an address in the message.
 */
export interface CarrierProvider {
  readonly name: CarrierProviderName;
  rates(request: RateRequest): Promise<CarrierRate[]>;
  buyLabel(request: BuyLabelRequest): Promise<CarrierLabel>;
  voidLabel(request: VoidLabelRequest): Promise<VoidLabelResult>;
  track(request: TrackRequest): Promise<TrackingEvent[]>;
  /** Optional hook: callers fall back to their own validation when a provider does not implement it. */
  validateAddress?(address: CarrierAddress): Promise<AddressValidation>;
}

/** Per-store carrier configuration (`store.settings.shipping`), resolved by `carrierConfigFor`. */
export interface StoreCarrierConfig {
  /** Provider to use for this store. Defaults to `manual`. */
  provider: CarrierProviderName;
  /** Provider-side carrier accounts to shop. */
  carrierAccountIds: string[];
  /** Restrict shopping to these service codes; empty = all. */
  services: string[];
  /** Default parcel used when nothing better is known (task 2.2 derives one from the cart). */
  defaultParcel: Parcel;
  /** Label format to buy. */
  labelFormat: LabelFormat;
}
