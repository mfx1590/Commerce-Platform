// Public API of the inventory module. Nothing outside this folder may import from its other files (ADR 0005).
// `on_hand` changes only through moveStock (append-only stock_movement + one stock.moved); reservations are the
// placement stock check (checkout), released on cancel (orders module), consumed on shipment (window 8).
export {
  createStockMovement,
  ensureLevel,
  listInventoryLevels,
  moveStock,
  toAdminLevel,
} from './service';
export { consumeForShipment, releaseForOrder, reserveForOrder } from './reservations';
export { ADMIN_MOVEMENT_REASONS, LEVEL_SORT_FIELDS } from './types';
export type {
  AdminInventoryLevel,
  Allocation,
  ConsumeForShipmentInput,
  ConsumeLine,
  ConsumeResult,
  LevelRow,
  LevelSortField,
  ListLevelsQuery,
  MovementReason,
  MoveStockInput,
  MoveStockResult,
  Page,
  ReservationResult,
  ReserveForOrderInput,
  ReserveLine,
} from './types';
