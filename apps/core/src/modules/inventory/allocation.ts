// The allocation seam (REQUEST #454, bundled into #456): WHICH warehouse serves a line is a policy; that the
// decision is honest is the module's job. `reserveForOrder` locks the pool rows first, builds the candidates from
// the LOCKED rows, calls the policy once per placement, validates what comes back and writes the reservations.
// A policy never reads stock itself, so it cannot decide on stale numbers; a decision that spends more than a
// locked row holds, names a warehouse that was not offered, or does not add up is a BUG in the policy — a 500,
// never a customer error.
//
// Same shape as the cart's `setPriceResolver` / `setDiscountEvaluator`: a registry write that returns the previous
// value; no I/O, no configuration. Window 11's stock-aware engine registers itself from `src/wiring.ts`.
import { AppError } from '../../lib/errors';

/** One warehouse that could serve a line: the locked pool row's numbers at decision time. */
export interface AllocationCandidate {
  warehouseId: string;
  warehouseCode: string;
  /** `warehouse.country` */
  country: string;
  /** `warehouse.priority` */
  priority: number;
  /** on_hand − reserved of the (stock item, warehouse) row, under the lock; may be ≤ 0. */
  available: number;
}

export interface AllocationLine {
  variantId: string;
  stockItemId: string;
  quantity: number;
  allowBackorder: boolean;
  /** Every ACTIVE warehouse of the organization, including those with no level row yet (available 0). */
  candidates: readonly AllocationCandidate[];
}

export interface AllocationContext {
  organizationId: string;
  storeId: string;
  orderId: string;
  /** The order's shipping country (ISO 3166-1 alpha-2), null when the order has none. */
  destinationCountry: string | null;
  /** `store.settings.fulfillment.routing` as stored (untrusted jsonb; the policy validates it). */
  routingSettings: unknown;
}

export interface AllocationDecision {
  variantId: string;
  /** Sum ≤ line.quantity; each quantity > 0; at most one entry per warehouse. */
  allocations: readonly { warehouseId: string; quantity: number; rule: string }[];
  /** line.quantity − sum(allocations): what no warehouse could cover. */
  shortfall: number;
}

/** Pure and synchronous: no database, no clock, no randomness. Same input, same output. */
export type AllocationPolicy = (
  context: AllocationContext,
  lines: readonly AllocationLine[],
) => AllocationDecision[];

/** The canonical warehouse order: priority, then code (what "the priority warehouse" means everywhere here). */
export const byPriority = (a: AllocationCandidate, b: AllocationCandidate): number =>
  a.priority - b.priority || a.warehouseCode.localeCompare(b.warehouseCode);

const poolKey = (stockItemId: string, warehouseId: string) => `${stockItemId}:${warehouseId}`;

/**
 * The default: warehouses in priority order, each giving what it has ("priority order, greedy" — the behaviour
 * before the seam existed). Two lines of one placement that map the SAME stock item draw from one running balance
 * per (stock item, warehouse), so a unit is never promised twice. The first allocation of a line is `priority`,
 * every further one `split:priority` (window 11's naming).
 */
export const priorityGreedyPolicy: AllocationPolicy = (_context, lines) => {
  const left = new Map<string, number>();
  return lines.map((line) => {
    let remaining = line.quantity;
    const allocations: { warehouseId: string; quantity: number; rule: string }[] = [];
    for (const c of [...line.candidates].sort(byPriority)) {
      if (remaining === 0) break;
      const key = poolKey(line.stockItemId, c.warehouseId);
      const available = left.get(key) ?? Math.max(0, c.available);
      const take = Math.min(remaining, available);
      if (take <= 0) continue;
      left.set(key, available - take);
      allocations.push({
        warehouseId: c.warehouseId,
        quantity: take,
        rule: allocations.length === 0 ? 'priority' : 'split:priority',
      });
      remaining -= take;
    }
    return { variantId: line.variantId, allocations, shortfall: remaining };
  });
};

let policy: AllocationPolicy = priorityGreedyPolicy;

/** Replaces the allocation policy (default: `priorityGreedyPolicy`). Returns the previous one. */
export function setAllocationPolicy(next: AllocationPolicy): AllocationPolicy {
  const previous = policy;
  policy = next;
  return previous;
}

export function currentAllocationPolicy(): AllocationPolicy {
  return policy;
}

const bug = (message: string, details: Record<string, unknown>) =>
  new AppError('internal', `allocation policy returned an invalid decision: ${message}`, details);

/**
 * Checks a policy's answer against the lines it was given: exactly one decision per line, only offered
 * warehouses, positive integer quantities, at most one entry per warehouse, `sum + shortfall = quantity`, and —
 * summed per (stock item, warehouse) ACROSS lines — never more than the locked row had available. Returns the
 * decisions in line order. Throws 500 `internal` on any violation.
 */
export function validateDecisions(
  lines: readonly AllocationLine[],
  decisions: readonly AllocationDecision[],
): AllocationDecision[] {
  if (!Array.isArray(decisions) || decisions.length !== lines.length) {
    throw bug('one decision per line is required', {
      lines: lines.length,
      decisions: Array.isArray(decisions) ? decisions.length : null,
    });
  }
  const byVariant = new Map<string, AllocationDecision>();
  for (const d of decisions) {
    if (byVariant.has(d.variantId))
      throw bug('two decisions for one line', { variant_id: d.variantId });
    byVariant.set(d.variantId, d);
  }
  const spent = new Map<string, number>();
  const ordered: AllocationDecision[] = [];
  for (const line of lines) {
    const d = byVariant.get(line.variantId);
    if (!d) throw bug('no decision for a line', { variant_id: line.variantId });
    const offered = new Map(line.candidates.map((c) => [c.warehouseId, c]));
    const seen = new Set<string>();
    let sum = 0;
    for (const a of d.allocations) {
      const candidate = offered.get(a.warehouseId);
      if (!candidate) {
        throw bug('a warehouse that was not offered', {
          variant_id: line.variantId,
          warehouse_id: a.warehouseId,
        });
      }
      if (seen.has(a.warehouseId)) {
        throw bug('two allocations on one warehouse', {
          variant_id: line.variantId,
          warehouse_id: a.warehouseId,
        });
      }
      seen.add(a.warehouseId);
      if (!Number.isInteger(a.quantity) || a.quantity < 1) {
        throw bug('quantities must be positive integers', {
          variant_id: line.variantId,
          warehouse_id: a.warehouseId,
        });
      }
      if (typeof a.rule !== 'string' || a.rule === '') {
        throw bug('every allocation names its rule', { variant_id: line.variantId });
      }
      const key = poolKey(line.stockItemId, a.warehouseId);
      const total = (spent.get(key) ?? 0) + a.quantity;
      if (total > Math.max(0, candidate.available)) {
        throw bug('more than the warehouse has available', {
          variant_id: line.variantId,
          stock_item_id: line.stockItemId,
          warehouse_id: a.warehouseId,
          available: candidate.available,
          allocated: total,
        });
      }
      spent.set(key, total);
      sum += a.quantity;
    }
    if (!Number.isInteger(d.shortfall) || d.shortfall < 0 || sum + d.shortfall !== line.quantity) {
      throw bug('allocations and shortfall must add up to the quantity', {
        variant_id: line.variantId,
        quantity: line.quantity,
        allocated: sum,
        shortfall: d.shortfall,
      });
    }
    ordered.push(d);
  }
  return ordered;
}
