/**
 * One operation's `x-permission`, as the tables in `src/lib/settings` (registry) and
 * `src/lib/orders/permissions.ts` (orders and fulfilment) write it, and the two questions every
 * caller asks of it: does this principal hold it, and what object would a 403 name.
 *
 * Pure, so the page (what to offer) and the server-side guard (what to refuse before the API) read
 * the same answer. Each table is pinned against `admin-api.yaml` in a unit test.
 */

import { findStore, type Principal } from '../nav/navigation';
import { expandOrganizationRelations, expandStoreRelations, type Relation } from '../nav/relations';

export interface PermissionRule {
  relation: Relation;
  /** `organization` = `organization:hq`; `store` = `store:{storeId}`. */
  object: 'organization' | 'store';
}

export function ruleObject(rule: PermissionRule, storeId: string): string {
  return rule.object === 'organization' ? 'organization:hq' : `store:${storeId}`;
}

/** Whether the principal holds the rule's relation (implied relations included). */
export function holds(principal: Principal, rule: PermissionRule, storeId: string): boolean {
  const organizationRelations = principal.organization_relations as Relation[];
  const held =
    rule.object === 'organization'
      ? expandOrganizationRelations(organizationRelations)
      : expandStoreRelations(
          (findStore(principal, storeId)?.relations ?? []) as Relation[],
          organizationRelations,
        );
  return held.has(rule.relation);
}
