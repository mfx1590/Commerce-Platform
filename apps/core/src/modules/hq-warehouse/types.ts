// The allocation seam's shapes, exactly as asked of the inventory module in REQUEST #454. They live here until
// that module exports them; the day it does, these become re-exports and nothing else changes.

/** One warehouse that could serve a line: the locked pool row's numbers at decision time. */
export interface AllocationCandidate {
  warehouseId: string;
  warehouseCode: string;
  country: string;
  priority: number;
  /** on_hand − reserved of the (stock item, warehouse) row, read under the lock; may be ≤ 0. */
  available: number;
}

export interface AllocationLine {
  variantId: string;
  stockItemId: string;
  quantity: number;
  allowBackorder: boolean;
  /** Every active warehouse of the organization, including those with no level row yet (available 0). */
  candidates: readonly AllocationCandidate[];
}

export interface AllocationContext {
  organizationId: string;
  storeId: string;
  orderId: string;
  /** The order's shipping country (ISO 3166-1 alpha-2), null when the order has none. */
  destinationCountry: string | null;
  /** `store.settings.fulfillment.routing` as stored: untrusted jsonb, validated by the policy. */
  routingSettings: unknown;
}

/**
 * Why a warehouse was chosen. The first allocation of a line carries the rule that ranked its warehouse; every
 * further one — the line did not fit in one warehouse — carries the same rule prefixed with `split:`.
 */
export type RoutingRule =
  'store_country' | 'store_default' | 'same_country' | 'same_region' | 'priority';
export type AllocationRule = RoutingRule | `split:${RoutingRule}`;

export interface LineAllocation {
  warehouseId: string;
  quantity: number;
  rule: AllocationRule;
}

export interface AllocationDecision {
  variantId: string;
  /** Sum ≤ line.quantity; each quantity > 0; at most one entry per warehouse. */
  allocations: readonly LineAllocation[];
  /** line.quantity − sum(allocations): what no warehouse could cover. */
  shortfall: number;
}

/** Pure and synchronous: no database, no clock, no randomness. One decision per line, in the lines' order. */
export type AllocationPolicy = (
  context: AllocationContext,
  lines: readonly AllocationLine[],
) => AllocationDecision[];
