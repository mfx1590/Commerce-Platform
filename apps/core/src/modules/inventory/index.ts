// Public API of the inventory module. Nothing outside this folder may import from its other files (ADR 0005).
// Stock lies in the shared pool, per (stock item, warehouse); a variant sells from the pool row of the item it
// maps (#456). `on_hand` changes only through moveStock (append-only stock_movement + one stock.moved v2);
// reservations are the placement stock check (checkout), released on cancel (orders module), consumed on shipment
// (window 8). WHICH warehouse serves a line is the allocation policy (setAllocationPolicy, #454).
export {
  availableByVariant,
  createStockMovement,
  ensureLevel,
  listInventoryLevels,
  listStockItems,
  mapVariantToStockItem,
  moveStock,
  toAdminLevel,
} from './service';
export {
  consumeForShipment,
  consumeReservationsForShipment,
  lockStock,
  releaseForOrder,
  releaseReservationsForShipment,
  reserveForOrder,
} from './reservations';
export { currentAllocationPolicy, priorityGreedyPolicy, setAllocationPolicy } from './allocation';
export type { LockStockInput } from './reservations';
export type {
  AllocationCandidate,
  AllocationContext,
  AllocationDecision,
  AllocationLine,
  AllocationPolicy,
} from './allocation';
export { ADMIN_MOVEMENT_REASONS, LEVEL_SORT_FIELDS } from './types';
export type {
  AdminInventoryLevel,
  AdminStockItem,
  Allocation,
  ConsumeForShipmentInput,
  ConsumeLine,
  ConsumeResult,
  LevelRow,
  LevelSortField,
  ListLevelsQuery,
  ListStockItemsQuery,
  MovementReason,
  MoveStockInput,
  MoveStockResult,
  Page,
  PoolLevel,
  ReservationResult,
  ReserveForOrderInput,
  ReserveLine,
} from './types';
