import { describe, expect, it } from 'vitest';
import {
  canAccessStore,
  hasHqView,
  visibleHqSections,
  visibleStoreSections,
} from '@/lib/nav/navigation';
import { HQ_SECTIONS, STORE_SECTIONS } from '@/lib/nav/sections';
import { SEED, principals, type PrincipalKey } from './fixtures/principals';

/**
 * Route access per role fixture — the other half of issue #30. `navigation.test.ts` asserts what
 * each role *sees*; this asserts what each role may *open*, because the two are only the same if the
 * section guards agree with the navigation, and a URL can be typed.
 *
 * Every route in the app appears here for every one of the seven seeded roles, so adding a section
 * without deciding who may reach it fails a test rather than shipping.
 */

const ROLES: PrincipalKey[] = [
  'owner',
  'finance',
  'operations',
  'support',
  'analyst',
  'storeAdmin',
  'storeStaff',
];

/** Whether a principal may open an HQ section — the same check `HqSectionGuard` makes. */
function canOpenHq(role: PrincipalKey, sectionId: string): boolean {
  return visibleHqSections(principals[role]).some((section) => section.id === sectionId);
}

/** Whether a principal may open a store section — the same check `StoreSectionGuard` makes. */
function canOpenStore(role: PrincipalKey, storeId: string, sectionId: string): boolean {
  return visibleStoreSections(principals[role], storeId).some(
    (section) => section.id === sectionId,
  );
}

function allowedHq(role: PrincipalKey): string[] {
  return HQ_SECTIONS.filter((section) => canOpenHq(role, section.id)).map((s) => s.id);
}

function allowedStore(role: PrincipalKey, storeId: string): string[] {
  return STORE_SECTIONS.filter((section) => canOpenStore(role, storeId, section.id)).map(
    (s) => s.id,
  );
}

describe('HQ route access, per role', () => {
  const expected: Record<PrincipalKey, string[]> = {
    owner: ['stores', 'warehouse', 'finance', 'bi', 'marketing', 'roles', 'onboarding'],
    finance: ['stores', 'finance'],
    operations: ['stores', 'warehouse'],
    support: ['stores'],
    analyst: ['stores', 'bi', 'marketing'],
    storeAdmin: [],
    storeStaff: [],
    unassigned: [],
  };

  it.each(ROLES)('%s may open exactly the sections they can see', (role) => {
    expect(allowedHq(role)).toEqual(expected[role]);
    // The guard and the navigation must agree, or a hidden link is still reachable by URL.
    expect(allowedHq(role)).toEqual(visibleHqSections(principals[role]).map((s) => s.id));
  });

  it('Finance is reachable only by finance and owner', () => {
    const reachable = ROLES.filter((role) => canOpenHq(role, 'finance'));
    expect(reachable).toEqual(['owner', 'finance']);
  });

  it('Roles and Onboarding are owner-only', () => {
    for (const section of ['roles', 'onboarding']) {
      expect(ROLES.filter((role) => canOpenHq(role, section))).toEqual(['owner']);
    }
  });

  it('Warehouse is operations and owner', () => {
    expect(ROLES.filter((role) => canOpenHq(role, 'warehouse'))).toEqual(['owner', 'operations']);
  });

  it('BI is analyst and owner — window 12 embeds there in Phase 3', () => {
    expect(ROLES.filter((role) => canOpenHq(role, 'bi'))).toEqual(['owner', 'analyst']);
  });

  it('Marketing is analyst and owner — reserved for window 17 (#63)', () => {
    expect(ROLES.filter((role) => canOpenHq(role, 'marketing'))).toEqual(['owner', 'analyst']);
  });

  it('a pure store user has no HQ view to open at all', () => {
    for (const role of ['storeAdmin', 'storeStaff'] as const) {
      expect(hasHqView(principals[role])).toBe(false);
      expect(allowedHq(role)).toEqual([]);
    }
  });
});

describe('store route access, per role', () => {
  // Admin API 0.2.1 raised customer reads from `viewer` to `support`, so Customers is no longer
  // part of what merely holding a relation on the store gets you.
  const viewerOnly = ['catalog', 'orders', 'promotions'];
  const withCustomers = ['catalog', 'orders', 'customers', 'promotions'];
  const staff = [...viewerOnly, 'content', 'marketing'];
  const everything = [...withCustomers, 'content', 'marketing', 'settings'];

  const expected: Record<PrincipalKey, string[]> = {
    // owner is store_admin everywhere (owner from organization)
    owner: everything,
    storeAdmin: everything,
    // store_staff authors content and marketing but does not administer the store
    storeStaff: staff,
    // an organization `support` is `support` on every store, so it reaches customer records
    support: withCustomers,
    // the other organization relations imply store viewer and nothing more
    finance: viewerOnly,
    operations: viewerOnly,
    analyst: viewerOnly,
    unassigned: [],
  };

  it.each(ROLES)('%s may open exactly their sections on brand-a', (role) => {
    expect(allowedStore(role, SEED.stores.brandA)).toEqual(expected[role]);
  });

  it('store Marketing is store_staff and up — reserved for window 17 (#63)', () => {
    const reachable = ROLES.filter((role) => canOpenStore(role, SEED.stores.brandA, 'marketing'));
    expect(reachable).toEqual(['owner', 'storeAdmin', 'storeStaff']);
  });

  it('Customers is support and up — Admin API 0.2.1 raised it from viewer', () => {
    const reachable = ROLES.filter((role) => canOpenStore(role, SEED.stores.brandA, 'customers'));
    expect(reachable).toEqual(['owner', 'support', 'storeAdmin']);
  });

  it('Settings is store_admin, so no organization relation short of owner reaches it', () => {
    const reachable = ROLES.filter((role) => canOpenStore(role, SEED.stores.brandA, 'settings'));
    expect(reachable).toEqual(['owner', 'storeAdmin']);
  });

  it('nothing at all is open on a store outside stores[]', () => {
    // store-admin holds brand-a and brand-b; brand-c is someone else's.
    expect(canAccessStore(principals.storeAdmin, SEED.stores.brandC)).toBe(false);
    expect(allowedStore('storeAdmin', SEED.stores.brandC)).toEqual([]);
  });

  it('store-staff reaches only brand-a, not brand-b', () => {
    expect(allowedStore('storeStaff', SEED.stores.brandA)).not.toEqual([]);
    expect(canAccessStore(principals.storeStaff, SEED.stores.brandB)).toBe(false);
    expect(allowedStore('storeStaff', SEED.stores.brandB)).toEqual([]);
  });

  it('HQ roles reach every seeded store', () => {
    for (const storeId of Object.values(SEED.stores)) {
      expect(canAccessStore(principals.owner, storeId)).toBe(true);
      expect(allowedStore('owner', storeId)).toEqual(everything);
    }
  });
});

describe('the matrix covers the whole app', () => {
  it('every section in the catalogue is decided for every role', () => {
    const decisions = ROLES.flatMap((role) => [
      ...HQ_SECTIONS.map((section) => canOpenHq(role, section.id)),
      ...STORE_SECTIONS.map((section) => canOpenStore(role, SEED.stores.brandA, section.id)),
    ]);
    expect(decisions).toHaveLength(ROLES.length * (HQ_SECTIONS.length + STORE_SECTIONS.length));
    expect(decisions.every((value) => typeof value === 'boolean')).toBe(true);
  });

  it('an unknown section id is never reachable', () => {
    for (const role of ROLES) {
      expect(canOpenHq(role, 'not-a-section')).toBe(false);
      expect(canOpenStore(role, SEED.stores.brandA, 'not-a-section')).toBe(false);
    }
  });
});
