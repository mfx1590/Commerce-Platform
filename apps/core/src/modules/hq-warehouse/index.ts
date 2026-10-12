// hq-warehouse public API (window 11). The allocation policy is registered behind the inventory module's
// `setAllocationPolicy` seam (REQUEST #454) by one line in `src/wiring.ts` once that seam exists.
export { rankWarehouses, stockAwareAllocationPolicy } from './allocation';
export type {
  AllocationCandidate,
  AllocationContext,
  AllocationDecision,
  AllocationLine,
  AllocationPolicy,
  AllocationRule,
  LineAllocation,
  RoutingRule,
} from './types';
