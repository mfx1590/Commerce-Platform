/**
 * Which order actions a principal may be *offered*, and which the server actions refuse before the
 * Admin API is called — one table, `ORDER_PERMISSIONS`, mirroring each operation's `x-permission`
 * in Admin API 0.4.9 and pinned against `admin-api.yaml` in `test/orders-actions.test.ts`.
 *
 * UI gating is a convenience; the guard (`../permissions/guard.ts`) and the Admin API are the
 * checks. Offering a button that will certainly be refused is still worse than not offering it.
 * Pure, so the role fixtures can be asserted in a table.
 */

import type { Principal } from '../nav/navigation';
import { holds, type PermissionRule } from '../permissions/rules';

export const ORDER_PERMISSIONS = {
  cancelOrder: { relation: 'store_admin', object: 'store' },
  updateOrderLineItem: { relation: 'store_admin', object: 'store' },
  cancelOrderLineItem: { relation: 'store_admin', object: 'store' },
  capturePayment: { relation: 'store_admin', object: 'store' },
  createRefund: { relation: 'support', object: 'store' },
  createReturn: { relation: 'support', object: 'store' },
  receiveReturn: { relation: 'operations', object: 'organization' },
  createShipment: { relation: 'operations', object: 'organization' },
  updateShipment: { relation: 'operations', object: 'organization' },
  pickShipment: { relation: 'operations', object: 'organization' },
  packShipment: { relation: 'operations', object: 'organization' },
  buyShipmentLabel: { relation: 'operations', object: 'organization' },
} as const satisfies Record<string, PermissionRule>;

export type OrderOperation = keyof typeof ORDER_PERMISSIONS;

export interface OrderPermissions {
  /** `cancelOrder`, `updateOrderLineItem`, `cancelOrderLineItem` — store_admin on the store. */
  canEditOrder: boolean;
  /** `capturePayment` — store_admin on the store. */
  canCapture: boolean;
  /** `createRefund`, `createReturn` — support on the store. */
  canRefund: boolean;
  canRequestReturn: boolean;
  /** `createShipment`, `updateShipment`, `pickShipment`, `packShipment`, `listPickLists`, `receiveReturn` — operations on organization:hq. */
  canFulfil: boolean;
  canReceiveReturn: boolean;
  /** `buyShipmentLabel` — operations on organization:hq. */
  canBuyLabel: boolean;
}

export function orderPermissions(principal: Principal, storeId: string): OrderPermissions {
  const may = (operation: OrderOperation) =>
    holds(principal, ORDER_PERMISSIONS[operation], storeId);
  return {
    canEditOrder: may('cancelOrder'),
    canCapture: may('capturePayment'),
    canRefund: may('createRefund'),
    canRequestReturn: may('createReturn'),
    canFulfil: may('createShipment'),
    canReceiveReturn: may('receiveReturn'),
    canBuyLabel: may('buyShipmentLabel'),
  };
}
