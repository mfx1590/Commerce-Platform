/**
 * Which order actions a principal may be *offered*, derived from the relation algebra.
 *
 * Each flag mirrors one operation's `x-permission` in the contract. UI gating is a convenience —
 * the Admin API re-checks every mutation and a refusal renders as `ActionRefusal` — but offering a
 * button that will certainly be refused is worse than not offering it. Pure, so the seven role
 * fixtures can be asserted in a table.
 */

import type { Principal } from '../nav/navigation';
import { findStore } from '../nav/navigation';
import type { Relation } from '../nav/relations';
import { expandOrganizationRelations, expandStoreRelations } from '../nav/relations';

export interface OrderPermissions {
  /** `cancelOrder`, `updateOrderLineItem`, `cancelOrderLineItem` — store_admin on the store. */
  canEditOrder: boolean;
  /** `createRefund`, `createReturn` — support on the store. */
  canRefund: boolean;
  canRequestReturn: boolean;
  /** `createShipment`, `updateShipment`, `pickShipment`, `packShipment`, `listPickLists`, `receiveReturn` — operations on organization:hq. */
  canFulfil: boolean;
  canReceiveReturn: boolean;
}

export function orderPermissions(principal: Principal, storeId: string): OrderPermissions {
  const organization = expandOrganizationRelations(principal.organization_relations as Relation[]);
  const store = findStore(principal, storeId);
  const onStore = expandStoreRelations(
    (store?.relations ?? []) as Relation[],
    principal.organization_relations as Relation[],
  );
  const fulfil = organization.has('operations');
  return {
    canEditOrder: onStore.has('store_admin'),
    canRefund: onStore.has('support'),
    canRequestReturn: onStore.has('support'),
    canFulfil: fulfil,
    canReceiveReturn: fulfil,
  };
}
