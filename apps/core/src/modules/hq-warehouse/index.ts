// hq-warehouse public API (window 11).
//   * Allocation: `stockAwareAllocationPolicy`, registered behind the inventory module's `setAllocationPolicy`
//     seam (REQUEST #454) by one line in `src/wiring.ts`.
//   * Cycle counts (#436): the service functions, `cycleCountsAdminRouter()` (one line in
//     `src/http/module-routers.ts`), and `setStockMover`, which `src/wiring.ts` points at the inventory module's
//     pool-addressed `moveStock`.
//   * WMS boundary: `WmsAdapter` and the in-memory implementation.
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
export {
  countTolerance,
  createCycleCount,
  CYCLE_COUNT_STATUSES,
  listCycleCounts,
  planOpenCounts,
  planReconciliation,
  reconcileCycleCount,
  resetStockMover,
  setStockMover,
} from './cycle-counts';
export type {
  CreateCycleCountInput,
  CycleCount,
  CycleCountStatus,
  ListCycleCountsQuery,
  PlannedReconciliation,
  ReconcileOptions,
  ReconciliationPlan,
  StockMover,
} from './cycle-counts';
export { cycleCountsAdminRouter } from './http';
export { createMemoryWmsAdapter, recordWmsCounts } from './wms';
export type { MemoryWmsAdapter, WmsAdapter, WmsCount, WmsPullResult } from './wms';
