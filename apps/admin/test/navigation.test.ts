import { describe, expect, it } from 'vitest';
import {
  allowedStores,
  canAccessStore,
  hasHqView,
  hqNavItems,
  landingPath,
  resolveSelectedStoreId,
  storeNavItems,
  visibleHqSections,
  visibleStoreSections,
} from '@/lib/nav/navigation';
import { expandOrganizationRelations, expandStoreRelations } from '@/lib/nav/relations';
import { SEED, principals } from './fixtures/principals';
import type { PrincipalKey } from './fixtures/principals';

const ids = (sections: readonly { id: string }[]) => sections.map((section) => section.id);

describe('HQ navigation per role fixture', () => {
  const cases: Array<[PrincipalKey, string[]]> = [
    ['owner', ['stores', 'warehouse', 'finance', 'bi', 'roles', 'onboarding']],
    ['finance', ['stores', 'finance']],
    ['operations', ['stores', 'warehouse']],
    ['support', ['stores']],
    ['analyst', ['stores', 'bi']],
    ['storeAdmin', []],
    ['storeStaff', []],
    ['unassigned', []],
  ];

  it.each(cases)('%s sees exactly %j', (key, expected) => {
    expect(ids(visibleHqSections(principals[key]))).toEqual(expected);
  });

  it('shows Finance only to finance and owner', () => {
    const withFinance = cases
      .filter(([, sections]) => sections.includes('finance'))
      .map(([key]) => key);
    expect(withFinance).toEqual(['owner', 'finance']);
  });

  it('gives a pure store user no HQ view at all', () => {
    expect(hasHqView(principals.storeAdmin)).toBe(false);
    expect(hasHqView(principals.storeStaff)).toBe(false);
    expect(hasHqView(principals.owner)).toBe(true);
  });

  it('builds hrefs without a store segment', () => {
    expect(hqNavItems(principals.analyst)).toEqual([
      { id: 'stores', label: 'Stores', href: '/stores' },
      { id: 'bi', label: 'BI', href: '/bi' },
    ]);
  });
});

describe('store navigation per role fixture', () => {
  const brandA = SEED.stores.brandA;
  const cases: Array<[PrincipalKey, string[]]> = [
    // owner is store_admin everywhere (owner from organization)
    ['owner', ['catalog', 'orders', 'customers', 'promotions', 'content', 'settings']],
    // store_admin implies store_staff, so Content and Settings are both there
    ['storeAdmin', ['catalog', 'orders', 'customers', 'promotions', 'content', 'settings']],
    // store_staff authors content but does not administer the store
    ['storeStaff', ['catalog', 'orders', 'customers', 'promotions', 'content']],
    // organization relations only ever imply store viewer, never staff or admin
    ['finance', ['catalog', 'orders', 'customers', 'promotions']],
    ['operations', ['catalog', 'orders', 'customers', 'promotions']],
    ['support', ['catalog', 'orders', 'customers', 'promotions']],
    ['analyst', ['catalog', 'orders', 'customers', 'promotions']],
  ];

  it.each(cases)('%s sees exactly %j on brand-a', (key, expected) => {
    expect(ids(visibleStoreSections(principals[key], brandA))).toEqual(expected);
  });

  it('returns nothing for a store outside stores[]', () => {
    expect(visibleStoreSections(principals.storeAdmin, SEED.stores.brandC)).toEqual([]);
    expect(storeNavItems(principals.storeStaff, SEED.stores.brandB)).toEqual([]);
  });

  it('scopes hrefs to the store', () => {
    expect(storeNavItems(principals.storeStaff, brandA)[0]).toEqual({
      id: 'catalog',
      label: 'Catalog',
      href: `/${brandA}/catalog`,
    });
  });

  it('never shows Settings to a store_staff user, on any of their stores', () => {
    for (const store of principals.storeStaff.stores) {
      expect(ids(visibleStoreSections(principals.storeStaff, store.store_id))).not.toContain(
        'settings',
      );
    }
  });
});

describe('store switcher scope', () => {
  it('offers store-admin exactly brand-a and brand-b', () => {
    expect(allowedStores(principals.storeAdmin).map((store) => store.code)).toEqual([
      'brand-a',
      'brand-b',
    ]);
  });

  it('refuses brand-c for store-admin but allows it for HQ roles', () => {
    expect(canAccessStore(principals.storeAdmin, SEED.stores.brandC)).toBe(false);
    expect(canAccessStore(principals.owner, SEED.stores.brandC)).toBe(true);
  });

  it('refuses an unknown id', () => {
    expect(canAccessStore(principals.owner, 'not-a-store')).toBe(false);
  });

  it('offers nothing to a principal with no stores', () => {
    expect(allowedStores(principals.unassigned)).toEqual([]);
  });
});

describe('remembered store resolution', () => {
  it('honours a remembered store that is still allowed', () => {
    expect(resolveSelectedStoreId(principals.storeAdmin, SEED.stores.brandB)).toEqual(
      SEED.stores.brandB,
    );
  });

  it('falls back to the first allowed store when the cookie names one that is not', () => {
    expect(resolveSelectedStoreId(principals.storeAdmin, SEED.stores.brandC)).toEqual(
      SEED.stores.brandA,
    );
  });

  it('ignores a malformed cookie', () => {
    expect(resolveSelectedStoreId(principals.storeAdmin, 'garbage')).toEqual(SEED.stores.brandA);
    expect(resolveSelectedStoreId(principals.storeAdmin, undefined)).toEqual(SEED.stores.brandA);
  });

  it('returns null when the principal has no stores', () => {
    expect(resolveSelectedStoreId(principals.unassigned, SEED.stores.brandA)).toBeNull();
  });
});

describe('landing path', () => {
  it('sends an HQ principal to their first HQ section', () => {
    expect(landingPath(principals.finance, undefined)).toEqual('/stores');
  });

  it('sends a store principal to their remembered store', () => {
    expect(landingPath(principals.storeAdmin, SEED.stores.brandB)).toEqual(
      `/${SEED.stores.brandB}/catalog`,
    );
  });

  it('sends a store principal with no cookie to their first store', () => {
    expect(landingPath(principals.storeStaff, undefined)).toEqual(`/${SEED.stores.brandA}/catalog`);
  });

  it('has nowhere to send a principal with no relations', () => {
    expect(landingPath(principals.unassigned, undefined)).toBeNull();
  });
});

describe('relation implication (ADR 0002)', () => {
  it('expands organization owner to every organization relation', () => {
    expect([...expandOrganizationRelations(['owner'])].sort()).toEqual([
      'analyst',
      'finance',
      'operations',
      'owner',
      'support',
      'viewer',
    ]);
  });

  it('does not let a store relation imply finance', () => {
    // ADR 0002 decision 5: finance is organization-only by construction.
    expect(expandStoreRelations(['store_admin'], []).has('finance')).toBe(false);
  });

  it('expands store_admin to store_staff and support', () => {
    const effective = expandStoreRelations(['store_admin'], []);
    expect(effective.has('store_staff')).toBe(true);
    expect(effective.has('support')).toBe(true);
    expect(effective.has('viewer')).toBe(true);
  });

  it('makes an organization owner a store admin everywhere', () => {
    expect(expandStoreRelations([], ['owner']).has('store_admin')).toBe(true);
  });

  it('makes any organization relation a store viewer, but no more', () => {
    for (const relation of ['finance', 'operations', 'analyst', 'support'] as const) {
      const effective = expandStoreRelations([], [relation]);
      expect(effective.has('viewer')).toBe(true);
      expect(effective.has('store_admin')).toBe(false);
      expect(effective.has('store_staff')).toBe(false);
    }
  });

  it('grants nothing for an empty relation set', () => {
    expect(expandOrganizationRelations([]).size).toBe(0);
    expect(expandStoreRelations([], []).size).toBe(0);
  });
});
