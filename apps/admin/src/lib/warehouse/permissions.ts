/**
 * HQ warehouse (#468): the operations the warehouse screens call and the `x-permission` each
 * carries in `admin-api.yaml` (Admin API 0.4.16). Mutations are read by the guard
 * (`../permissions/guard.ts`, refusal before the API); reads by the pages (what to offer). Pinned
 * against the yaml in a unit test.
 */

import type { Principal } from '../nav/navigation';
import { expandOrganizationRelations, VIEWER, type Relation } from '../nav/relations';
import type { PermissionRule } from '../permissions/rules';

export const WAREHOUSE_PERMISSIONS = {
  mapVariantToStockItem: { relation: 'operations', object: 'organization' },
  createCycleCount: { relation: 'operations', object: 'organization' },
  reconcileCycleCount: { relation: 'operations', object: 'organization' },
  // A read, but called from a server action (the approve dialog), so it is guarded like one.
  previewCycleCountReconcile: { relation: 'operations', object: 'organization' },
} as const satisfies Record<string, PermissionRule>;

/** The reads, as the yaml writes them (`viewer` = any relation on the object). */
export const WAREHOUSE_READS = {
  listStockItems: { relation: 'viewer', object: 'organization:hq' },
  listCycleCounts: { relation: 'operations', object: 'organization:hq' },
  listInventoryLevels: { relation: 'viewer', object: 'store:{store_id}' },
  listStockItemMovements: { relation: 'viewer', object: 'organization:hq' },
  listStockItemReservations: { relation: 'viewer', object: 'organization:hq' },
} as const;

export type WarehouseOperation = keyof typeof WAREHOUSE_PERMISSIONS;

/** What the warehouse screens may offer this principal (a convenience: the server decides). */
export interface WarehouseAccess {
  /** `listStockItems` — viewer on organization:hq. Also gates the "shared with N brands" badge. */
  canReadStockItems: boolean;
  /** `mapVariantToStockItem`, and every cycle-count operation — operations on organization:hq. */
  canOperate: boolean;
}

export function warehouseAccess(principal: Principal): WarehouseAccess {
  const held = expandOrganizationRelations(principal.organization_relations as Relation[]);
  return { canReadStockItems: held.has(VIEWER), canOperate: held.has('operations') };
}
