/**
 * The section catalogue: the single place that says which relation reveals which part of the app.
 *
 * `requires` is derived from the `x-permission` of the operation each section's landing screen
 * calls (packages/contracts/openapi/admin-api.yaml, contracts-v0.1). Where a section has no
 * operation of its own yet, the choice is spelled out in `why`.
 */

import type { EffectiveRelation } from './relations';
import { VIEWER } from './relations';

export type SectionScope = 'hq' | 'store';

export interface Section {
  id: string;
  label: string;
  scope: SectionScope;
  /** Any one of these effective relations reveals the section. */
  requires: readonly EffectiveRelation[];
  /** Which contract operation (or decision) this gate comes from. */
  why: string;
}

/** HQ view. Relations here are held on `organization:hq`. */
export const HQ_SECTIONS: readonly Section[] = [
  {
    id: 'stores',
    label: 'Stores',
    scope: 'hq',
    requires: [VIEWER],
    why: 'listStores — x-permission viewer on store:*',
  },
  {
    id: 'warehouse',
    label: 'Warehouse',
    scope: 'hq',
    requires: ['operations'],
    why: 'createStockMovement / receiveReturn — x-permission operations on organization:hq',
  },
  {
    id: 'finance',
    label: 'Finance',
    scope: 'hq',
    requires: ['finance'],
    why: 'listLegalEntities — x-permission finance on organization:hq (owner implies finance)',
  },
  {
    id: 'bi',
    label: 'BI',
    scope: 'hq',
    requires: ['analyst'],
    why: 'window 12 embeds here; analyst is the reporting relation in ADR 0002',
  },
  {
    id: 'marketing',
    label: 'Marketing',
    scope: 'hq',
    requires: ['analyst'],
    why: 'reserved for window 17 (docs/marketing-scope.md); analyst is the cross-store reporting relation, and owner implies it',
  },
  {
    id: 'roles',
    label: 'Roles',
    scope: 'hq',
    requires: ['owner'],
    why: 'listUsers / assignRole — x-permission owner on organization:hq',
  },
  {
    id: 'onboarding',
    label: 'Onboarding',
    scope: 'hq',
    requires: ['owner'],
    why: 'createStore — x-permission owner on organization:hq',
  },
] as const;

/** Store view. Relations here are held on `store:{storeId}`, directly or by implication. */
export const STORE_SECTIONS: readonly Section[] = [
  {
    id: 'catalog',
    label: 'Catalog',
    scope: 'store',
    requires: [VIEWER],
    why: 'listProducts — x-permission viewer on store:{storeId}',
  },
  {
    id: 'orders',
    label: 'Orders',
    scope: 'store',
    requires: [VIEWER],
    why: 'listOrders — x-permission viewer on store:{storeId}',
  },
  {
    id: 'customers',
    label: 'Customers',
    scope: 'store',
    requires: ['support'],
    why: 'listCustomers / getCustomer — x-permission support on store:{storeId} (Admin API 0.2.1 raised this from viewer: customer records are personal data, so reading them is no longer implied by merely holding a relation on the store)',
  },
  {
    id: 'promotions',
    label: 'Promotions',
    scope: 'store',
    requires: [VIEWER],
    why: 'listPromotions — x-permission viewer on store:{storeId}',
  },
  {
    id: 'content',
    label: 'Content',
    scope: 'store',
    requires: ['store_staff'],
    why: 'no Admin API operation yet (window 6 owns the CMS); gated like catalog authoring, which is store_staff',
  },
  {
    id: 'marketing',
    label: 'Marketing',
    scope: 'store',
    requires: ['store_staff'],
    why: 'reserved for window 17 (docs/marketing-scope.md); campaigns and segments are authoring work, so store_staff — store_admin implies it',
  },
  {
    id: 'settings',
    label: 'Settings',
    scope: 'store',
    requires: ['store_admin'],
    why: 'updateStore / createSalesChannel / listApiKeys — x-permission store_admin on store:{storeId}',
  },
] as const;

export function hqHref(section: Section): string {
  return `/${section.id}`;
}

export function storeHref(storeId: string, section: Section): string {
  return `/${encodeURIComponent(storeId)}/${section.id}`;
}
