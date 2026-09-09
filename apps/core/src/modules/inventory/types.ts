import type { AdminComponents } from '@platform/contracts';
import type { Actor } from '../../lib/audit';

export type AdminInventoryLevel = AdminComponents['schemas']['InventoryLevel'];

/** `stock_movement.reason` (0007). `sale` and `return` are written by the system (shipment / return flows only). */
export type MovementReason =
  'receipt' | 'sale' | 'return' | 'adjustment' | 'transfer_in' | 'transfer_out' | 'cycle_count';
export const ADMIN_MOVEMENT_REASONS = [
  'receipt',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'cycle_count',
] as const;

export interface MoveStockInput {
  organizationId: string;
  storeId: string;
  variantId: string;
  warehouseId: string;
  /** Signed change of `on_hand`; never 0. */
  delta: number;
  reason: MovementReason;
  referenceType?: string | null | undefined;
  referenceId?: string | null | undefined;
  note?: string | null | undefined;
  actor: Actor;
}

export interface LevelRow {
  id: string;
  organization_id: string;
  store_id: string;
  variant_id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  incoming: number;
  available: number;
  sku: string;
}

export interface MoveStockResult {
  movementId: string;
  level: LevelRow;
}

export interface ReserveLine {
  variantId: string;
  quantity: number;
}

export interface ReserveForOrderInput {
  organizationId: string;
  storeId: string;
  orderId: string;
  lines: readonly ReserveLine[];
}

export interface Allocation {
  warehouseId: string;
  quantity: number;
}

export interface ReservationResult {
  variantId: string;
  /** Empty when the variant does not manage inventory. */
  allocations: Allocation[];
  /** Part of the quantity that exceeded `available` (backorderable variants only). */
  backorderQuantity: number;
}

export interface ConsumeLine {
  variantId: string;
  quantity: number;
  /** Take from this warehouse's reservation first; default: reservation order (priority). */
  warehouseId?: string | undefined;
}

export interface ConsumeForShipmentInput {
  organizationId: string;
  storeId: string;
  orderId: string;
  /** `shipment.id` when known (becomes the movement's reference). */
  shipmentId?: string | null | undefined;
  lines: readonly ConsumeLine[];
  actor: Actor;
}

export interface ConsumeResult {
  variantId: string;
  warehouseId: string;
  quantity: number;
  movementId: string;
}

export const LEVEL_SORT_FIELDS = ['sku', 'available', 'on_hand'] as const;
export type LevelSortField = (typeof LEVEL_SORT_FIELDS)[number];

export interface ListLevelsQuery {
  store_id?: string | undefined;
  warehouse_id?: string | undefined;
  variant_id?: string | undefined;
  sku?: string | undefined;
  below_available?: number | undefined;
  sort?: LevelSortField | undefined;
  order?: 'asc' | 'desc' | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

export interface Page<T> {
  page: number;
  limit: number;
  total: number;
  items: T[];
}
