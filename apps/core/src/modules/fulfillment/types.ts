// The 3PL boundary. A fulfilment provider is whoever physically picks, packs and hands parcels to a carrier: our
// own warehouse staff today (window 11 owns that side in Phase 3), a third-party logistics company later. This
// module only speaks to them through `FulfillmentProvider`, and only in ids, SKUs and quantities — the delivery
// address travels to the provider because it must, but never into a log, an error or an event.

/** Where a fulfilment request stands at the provider. Facts it reports, not our shipment status. */
export type FulfillmentState =
  | 'accepted' // the provider has the request and has not started
  | 'picking' // someone is taking goods off the shelf — too late to cancel for free
  | 'packed' // boxed, waiting for the carrier
  | 'shipped' // handed to the carrier, tracking known
  | 'cancelled'
  | 'failed';

export interface FulfillmentLine {
  orderLineItemId: string;
  sku: string;
  quantity: number;
}

export interface FulfillmentAddress {
  name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
  phone: string | null;
}

export interface FulfillmentRequest {
  /** Our shipment id. Providers echo it back on every update, so no lookup table is needed. */
  reference: string;
  orderId: string;
  warehouseCode: string;
  lines: FulfillmentLine[];
  shipTo: FulfillmentAddress;
  carrier: string | null;
  service: string | null;
}

export interface FulfillmentAck {
  externalId: string;
  state: FulfillmentState;
}

export interface FulfillmentUpdate {
  externalId: string;
  /** Our shipment id, as sent in `FulfillmentRequest.reference`. */
  reference: string;
  state: FulfillmentState;
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  /** The provider's own timestamp for this state. */
  occurredAt: string;
}

export interface CancelResult {
  cancelled: boolean;
  /** Present when the provider refused, e.g. picking has started. */
  reason?: string;
}

export interface FulfillmentProvider {
  readonly name: string;
  /** Hands a fulfilment request to the provider. Throws `FulfillmentError` when it cannot be accepted. */
  push(request: FulfillmentRequest): Promise<FulfillmentAck>;
  /** Current state as the provider sees it (pull). Push callbacks arrive as `FulfillmentUpdate` too. */
  status(externalId: string): Promise<FulfillmentUpdate>;
  /** Asks the provider to stop. Refused, not thrown, once goods are being picked. */
  cancel(externalId: string): Promise<CancelResult>;
}

/** A provider-side failure. Carries the provider name and a reason, never an address. */
export class FulfillmentError extends Error {
  constructor(
    readonly provider: string,
    readonly operation: string,
    message: string,
    readonly retryable = false,
  ) {
    super(`${provider} ${operation} failed: ${message}`);
    this.name = 'FulfillmentError';
  }
}

/** What this module keeps on `shipment.metadata.fulfillment`. */
export interface FulfillmentRef {
  provider: string;
  external_id: string;
  state: FulfillmentState;
  warehouse_code: string;
  updated_at: string;
}

export interface WarehouseCandidate {
  id: string;
  code: string;
  country: string;
  priority: number;
}

/**
 * `store.settings.fulfillment.routing`. Both keys are optional; codes are `warehouse.code` (stable and readable,
 * unlike ids). A code that names no active warehouse is ignored rather than failing an order.
 */
export interface RoutingSettings {
  /** Destination country → warehouse code. Wins over everything else. */
  countries: Record<string, string>;
  /** Used when no country entry matches, before the automatic rules. */
  default: string | null;
}

export interface RoutingDecision {
  warehouse: WarehouseCandidate;
  /** Why this warehouse won — shown in the admin and asserted by tests. */
  rule: 'store_country' | 'store_default' | 'same_country' | 'same_region' | 'priority';
}
