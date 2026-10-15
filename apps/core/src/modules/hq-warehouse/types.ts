// The allocation seam's shapes. The inventory module owns them since #456 (REQUEST #454); this file re-exports
// what the policy takes and adds what it promises on top: a decision whose rules are a closed set.
import type { AllocationCandidate, AllocationContext, AllocationLine } from '../inventory';

export type { AllocationCandidate, AllocationContext, AllocationLine };

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
