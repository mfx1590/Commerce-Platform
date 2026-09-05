/**
 * `Principal` fixtures for the seven seeded staff users.
 *
 * Ids and relations mirror `SEED_IDS` and the `role_assignment` rows in `packages/db/src/seed`
 * exactly, so a test that passes here describes the real local environment. Reused by issue #30.
 *
 * Note what the HQ fixtures assert: their stores carry `relations: []`. Those users reach every
 * store *by inheritance* through `organization:hq` (ADR 0002), and the API is free to report the
 * derived relations or not. Modelling the emptier of the two shapes proves the navigation derives
 * store access from the organization relations rather than relying on the server to expand them.
 */

import type { Principal } from '@/lib/nav/navigation';

export const SEED = {
  organization: '00000000-0000-4000-8000-000000000001',
  stores: {
    brandA: '00000000-0000-4000-8000-000000000031',
    brandB: '00000000-0000-4000-8000-000000000032',
    brandC: '00000000-0000-4000-8000-000000000033',
  },
  users: {
    owner: '00000000-0000-4000-8000-000000000041',
    finance: '00000000-0000-4000-8000-000000000042',
    operations: '00000000-0000-4000-8000-000000000043',
    storeAdmin: '00000000-0000-4000-8000-000000000044',
    storeStaff: '00000000-0000-4000-8000-000000000045',
    support: '00000000-0000-4000-8000-000000000046',
    analyst: '00000000-0000-4000-8000-000000000047',
  },
} as const;

const ORGANIZATION = { id: SEED.organization, slug: 'hq', name: 'HQ' } as const;

type Store = Principal['stores'][number];

function store(id: string, code: string, name: string, relations: Store['relations']): Store {
  return { store_id: id, code, name, relations };
}

/** Every store, reachable only through the organization — hence no direct relations. */
function allStoresByInheritance(): Store[] {
  return [
    store(SEED.stores.brandA, 'brand-a', 'Brand A', []),
    store(SEED.stores.brandB, 'brand-b', 'Brand B', []),
    store(SEED.stores.brandC, 'brand-c', 'Brand C', []),
  ];
}

function principal(
  id: string,
  key: string,
  displayName: string,
  organizationRelations: Principal['organization_relations'],
  stores: Store[],
): Principal {
  return {
    user: { id, email: `${key}@example.com`, display_name: displayName },
    organization: ORGANIZATION,
    organization_relations: organizationRelations,
    stores,
  };
}

export const principals = {
  owner: principal(SEED.users.owner, 'owner', 'Olivia Owner', ['owner'], allStoresByInheritance()),
  finance: principal(
    SEED.users.finance,
    'finance',
    'Fin Finance',
    ['finance'],
    allStoresByInheritance(),
  ),
  operations: principal(
    SEED.users.operations,
    'operations',
    'Otto Operations',
    ['operations'],
    allStoresByInheritance(),
  ),
  support: principal(
    SEED.users.support,
    'support',
    'Sue Support',
    ['support'],
    allStoresByInheritance(),
  ),
  analyst: principal(
    SEED.users.analyst,
    'analyst',
    'Ana Analyst',
    ['analyst'],
    allStoresByInheritance(),
  ),
  /** store_admin on brand-a and brand-b only — never brand-c, and no HQ view. */
  storeAdmin: principal(
    SEED.users.storeAdmin,
    'store-admin',
    'Sam StoreAdmin',
    [],
    [
      store(SEED.stores.brandA, 'brand-a', 'Brand A', ['store_admin']),
      store(SEED.stores.brandB, 'brand-b', 'Brand B', ['store_admin']),
    ],
  ),
  /** store_staff on brand-a only. */
  storeStaff: principal(
    SEED.users.storeStaff,
    'store-staff',
    'Stef StoreStaff',
    [],
    [store(SEED.stores.brandA, 'brand-a', 'Brand A', ['store_staff'])],
  ),
  /** An account that exists but holds nothing — the empty-state case. */
  unassigned: principal(
    '00000000-0000-4000-8000-000000000048',
    'unassigned',
    'Una Unassigned',
    [],
    [],
  ),
} satisfies Record<string, Principal>;

export type PrincipalKey = keyof typeof principals;
