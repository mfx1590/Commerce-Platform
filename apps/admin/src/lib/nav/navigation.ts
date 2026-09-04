/**
 * Navigation as a pure function of the `Principal` returned by `GET /admin/me`.
 *
 * No imports from `next/*`, no I/O: given the same principal these functions always return the
 * same sections, which is what makes the per-role test matrix in issue #30 possible. UI gating is
 * a convenience — the Admin API re-checks every operation's `x-permission` server-side.
 */

import type { AdminResponse } from '../api/admin-client';
import type { Relation } from './relations';
import { expandOrganizationRelations, expandStoreRelations, satisfies } from './relations';
import type { Section } from './sections';
import { HQ_SECTIONS, STORE_SECTIONS, hqHref, storeHref } from './sections';

export type Principal = AdminResponse<'getMe'>;
export type PrincipalStore = Principal['stores'][number];

export interface NavItem {
  id: string;
  label: string;
  href: string;
}

/** The stores the switcher may offer: exactly what `GET /admin/me` reported, nothing inferred. */
export function allowedStores(principal: Principal): readonly PrincipalStore[] {
  return principal.stores;
}

export function findStore(principal: Principal, storeId: string): PrincipalStore | null {
  return principal.stores.find((store) => store.store_id === storeId) ?? null;
}

/**
 * A store outside `stores[]` is not "hidden", it is forbidden: the caller renders the 403 panel.
 * Holding an organization relation does not widen this — the server already accounted for
 * inheritance when it built `stores[]`.
 */
export function canAccessStore(principal: Principal, storeId: string): boolean {
  return findStore(principal, storeId) !== null;
}

function toItems(sections: readonly Section[], href: (section: Section) => string): NavItem[] {
  return sections.map((section) => ({ id: section.id, label: section.label, href: href(section) }));
}

/** HQ sections the principal may see. Empty for a pure store user — they get no HQ view at all. */
export function visibleHqSections(principal: Principal): readonly Section[] {
  const effective = expandOrganizationRelations(principal.organization_relations as Relation[]);
  return HQ_SECTIONS.filter((section) => satisfies(effective, section.requires));
}

/**
 * Store sections for one store. Relations held directly on the store are unioned with the ones the
 * principal's organization relations imply there (ADR 0002: `owner from organization`,
 * `support from organization`, …), so an HQ principal still gets the right store nav even when the
 * API reports `relations: []` for a store it only reaches by inheritance.
 */
export function visibleStoreSections(principal: Principal, storeId: string): readonly Section[] {
  const store = findStore(principal, storeId);
  if (store === null) return [];
  const effective = expandStoreRelations(
    store.relations as Relation[],
    principal.organization_relations as Relation[],
  );
  return STORE_SECTIONS.filter((section) => satisfies(effective, section.requires));
}

export function hqNavItems(principal: Principal): NavItem[] {
  return toItems(visibleHqSections(principal), hqHref);
}

export function storeNavItems(principal: Principal, storeId: string): NavItem[] {
  return toItems(visibleStoreSections(principal, storeId), (section) =>
    storeHref(storeId, section),
  );
}

export function hasHqView(principal: Principal): boolean {
  return visibleHqSections(principal).length > 0;
}

/**
 * Resolves the store the UI should be scoped to: the remembered one when it is still in `stores[]`,
 * otherwise the first allowed store, otherwise none. A cookie naming a store the principal has lost
 * access to must never be honoured.
 */
export function resolveSelectedStoreId(
  principal: Principal,
  remembered: string | undefined,
): string | null {
  if (remembered !== undefined && canAccessStore(principal, remembered)) {
    return remembered;
  }
  return principal.stores[0]?.store_id ?? null;
}

/**
 * Where `/` should send this principal: their first HQ section, else their first store section,
 * else nowhere (an account with no relations at all, which the 403 panel explains).
 */
export function landingPath(principal: Principal, remembered: string | undefined): string | null {
  const hq = hqNavItems(principal);
  if (hq.length > 0) return hq[0]?.href ?? null;

  const storeId = resolveSelectedStoreId(principal, remembered);
  if (storeId === null) return null;
  return storeNavItems(principal, storeId)[0]?.href ?? null;
}
