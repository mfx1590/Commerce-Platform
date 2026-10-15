// Stock-aware allocation over the shared pool (#435, part B): which warehouse(s) each line of an order is reserved
// in. A pure function over the candidates the inventory module hands it (the LOCKED pool rows), so every rule is
// testable without a database and the same input always gives the same decision.
//
// Each line's candidates are ranked by the fulfillment module's routing rules, in its order (the ranking reads
// only the destination, the store's settings and the warehouses, so it is the same order for every line):
//
//   1. store override for the destination country   routing.countries[CC]
//   2. store default                                routing.default
//   3. warehouses in the destination country
//   4. warehouses in the destination's region
//   5. the rest
//
// with `priority`, then `code`, then id breaking ties inside a rule. Then, per line:
//
//   * the first ranked warehouse that covers the WHOLE line takes it — one shipment beats a nearer split;
//   * when none can, the line is split greedily down the ranking;
//   * what is left when the shelves are empty is the line's `shortfall` (out of stock or backorder: the
//     inventory module's call, not this function's).
//
// It never allocates more than a candidate's `available`, and what one line takes is gone for the next line of the
// same stock item — two variants of one order can map to one item.
import { regionOf, routingSettingsFrom } from '../fulfillment';
import type {
  AllocationCandidate,
  AllocationContext,
  AllocationDecision,
  AllocationLine,
  AllocationPolicy,
  LineAllocation,
  RoutingRule,
} from './types';

interface Ranked {
  candidate: AllocationCandidate;
  rule: RoutingRule;
}

const RULE_ORDER: readonly RoutingRule[] = [
  'store_country',
  'store_default',
  'same_country',
  'same_region',
  'priority',
];

function ruleFor(
  candidate: AllocationCandidate,
  country: string | null,
  settings: ReturnType<typeof routingSettingsFrom>,
): RoutingRule {
  if (country !== null && settings.countries[country] === candidate.warehouseCode) {
    return 'store_country';
  }
  if (settings.default === candidate.warehouseCode) return 'store_default';
  if (country !== null) {
    if (candidate.country.toUpperCase() === country) return 'same_country';
    const region = regionOf(country);
    if (region !== null && regionOf(candidate.country) === region) return 'same_region';
  }
  return 'priority';
}

/** The line's candidates in the order they are tried, each with the rule that put it there. */
export function rankWarehouses(
  context: Pick<AllocationContext, 'destinationCountry' | 'routingSettings'>,
  candidates: readonly AllocationCandidate[],
): Ranked[] {
  const country = context.destinationCountry?.toUpperCase() ?? null;
  const settings = routingSettingsFrom({ fulfillment: { routing: context.routingSettings } });
  return candidates
    .map((candidate) => ({ candidate, rule: ruleFor(candidate, country, settings) }))
    .sort(
      (a, b) =>
        RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) ||
        a.candidate.priority - b.candidate.priority ||
        compare(a.candidate.warehouseCode, b.candidate.warehouseCode) ||
        compare(a.candidate.warehouseId, b.candidate.warehouseId),
    );
}

// Code-unit order, not localeCompare: the decision must not depend on the process's locale.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const poolKey = (line: AllocationLine, warehouseId: string): string =>
  `${line.stockItemId}:${warehouseId}`;

function allocateLine(
  context: AllocationContext,
  line: AllocationLine,
  taken: Map<string, number>,
): AllocationDecision {
  // Bad numbers are a caller's bug, and an allocation is no place to guess: NaN, Infinity, fractions and
  // integers past 2^53 are refused, as are two candidates for one warehouse (which shelf would be the truth?).
  if (!Number.isSafeInteger(line.quantity) || line.quantity < 0) {
    throw new RangeError(
      `allocation quantity must be a non-negative safe integer, got ${line.quantity}`,
    );
  }
  const seen = new Set<string>();
  for (const candidate of line.candidates) {
    if (!Number.isSafeInteger(candidate.available)) {
      throw new RangeError(
        `candidate ${candidate.warehouseCode}: available must be a safe integer, got ${candidate.available}`,
      );
    }
    if (seen.has(candidate.warehouseId)) {
      throw new RangeError(`two candidates for warehouse ${candidate.warehouseCode} on one line`);
    }
    seen.add(candidate.warehouseId);
  }
  // What is left of each pool row after the earlier lines of this order.
  const left = (candidate: AllocationCandidate): number =>
    Math.max(0, candidate.available - (taken.get(poolKey(line, candidate.warehouseId)) ?? 0));
  const take = (allocation: LineAllocation): LineAllocation => {
    const key = poolKey(line, allocation.warehouseId);
    taken.set(key, (taken.get(key) ?? 0) + allocation.quantity);
    return allocation;
  };

  if (line.quantity === 0) return { variantId: line.variantId, allocations: [], shortfall: 0 };
  const ranked = rankWarehouses(context, line.candidates);

  const whole = ranked.find(({ candidate }) => left(candidate) >= line.quantity);
  if (whole) {
    const allocation = take({
      warehouseId: whole.candidate.warehouseId,
      quantity: line.quantity,
      rule: whole.rule,
    });
    return { variantId: line.variantId, allocations: [allocation], shortfall: 0 };
  }

  const allocations: LineAllocation[] = [];
  let remaining = line.quantity;
  for (const { candidate, rule } of ranked) {
    if (remaining === 0) break;
    const quantity = Math.min(remaining, left(candidate));
    if (quantity <= 0) continue;
    allocations.push(
      take({
        warehouseId: candidate.warehouseId,
        quantity,
        rule: allocations.length === 0 ? rule : `split:${rule}`,
      }),
    );
    remaining -= quantity;
  }
  return { variantId: line.variantId, allocations, shortfall: remaining };
}

/** The policy registered behind the inventory module's `setAllocationPolicy` seam (REQUEST #454). */
export const stockAwareAllocationPolicy: AllocationPolicy = (context, lines) => {
  const taken = new Map<string, number>();
  return lines.map((line) => allocateLine(context, line, taken));
};
