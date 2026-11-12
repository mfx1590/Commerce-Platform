// #809 follow-up: a just-onboarded store is in the owner's scope at once. `/admin/me` lists `stores` from the staff
// scope the Keycloak verifier caches for 30 s (hq-rbac's ScopeCache); onboarding writes the store's OpenFGA object,
// so without an invalidation the owner — and every other organization-level user — keeps the old list for up to
// 30 s (the admin e2e used to wait it out). Here: the REAL verifier with the DEFAULT 30 s cache, a JWT verifier that
// answers for the seeded owner, and an OpenFGA fake whose visible stores grow when the registrar writes an object.
import express from 'express';
import request from 'supertest';
import { type OpenFgaClient, ScopeCache } from '@platform/auth-sdk';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeycloakStaffTokenVerifier } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import type { StoreRegistrar } from '../src/modules/registry';
import { mountCoreMiddleware } from '../src/server';

const ORG = SEED_IDS.organization;

let db: TestDatabase;
let ownerSubject: string;

beforeAll(async () => {
  db = await createTestDatabase('core_scope_invalidate');
  await seed(db.owner, { productsPerStore: 1, log: () => {} });
  process.env.CORE_ORGANIZATION_ID = ORG;
  await initDb({ connectionString: db.app.options.connectionString! });
  const r = await db.owner.query<{ keycloak_subject: string }>(
    `SELECT keycloak_subject FROM staff_user WHERE id = $1`,
    [SEED_IDS.users.owner],
  );
  ownerSubject = r.rows[0]!.keycloak_subject;
}, 180_000);

afterAll(async () => {
  await closePool();
  await db?.drop();
});

/** An app on the real verifier (default ScopeCache, 30 s) over an OpenFGA where the owner sees `visible`. */
async function ownerApp(wireInvalidation: boolean) {
  const seeded = await db.owner.query<{ id: string }>(`SELECT id FROM store`);
  const visible = new Set(seeded.rows.map((s) => s.id));
  const fga = {
    check: async () => ({ allowed: true }), // the owner holds every relation (owner ⊇ all, ADR 0002)
    listObjects: async () => ({ objects: [...visible].map((id) => `store:${id}`) }),
    listRelations: async () => ({ relations: ['owner'] }),
  } as unknown as OpenFgaClient;
  const registrar: StoreRegistrar = {
    // what the real registrar does in OpenFGA: the store object appears, so the owner now sees the store
    ensureStoreObject: async (storeId: string) => {
      visible.add(storeId);
    },
    hasStoreObject: async (storeId: string) => visible.has(storeId),
  } as StoreRegistrar;
  const keycloak = new KeycloakStaffTokenVerifier({
    fga,
    pool: db.app,
    organizationId: ORG,
    cache: new ScopeCache(), // the production default: 30 s
    jwtVerifier: {
      issuer: 'test',
      verify: async () => ({ subject: ownerSubject }),
    } as never,
  });
  const app = express();
  mountCoreMiddleware(app, keycloak, {
    fga,
    storeRegistrar: registrar,
    ...(wireInvalidation ? { onStoreScopeChange: keycloak.invalidateAll } : {}),
  });
  const owner = {
    get: (path: string) => request(app).get(path).set('Authorization', 'Bearer real-owner-token'),
    post: (path: string, body: unknown) =>
      request(app).post(path).set('Authorization', 'Bearer real-owner-token').send(body),
  };
  return { owner, keycloak };
}

const onboarding = (code: string) => ({
  legal_entity: { code: `${code}-bv`, name: `${code} B.V.`, country: 'NL', currency: 'EUR' },
  code,
  name: code,
  default_currency: 'EUR',
  default_locale: 'en-GB',
  default_country: 'NL',
  domain: { hostname: `${code}.localhost` },
});

const storeIdsOf = (me: request.Response) =>
  (me.body.stores as Array<{ store_id: string }>).map((s) => s.store_id);

describe('scope cache after onboarding (#809 follow-up)', () => {
  it('the onboarded store is in the owner’s /admin/me at once: onboarding drops the cached scopes', async () => {
    const { owner } = await ownerApp(true);
    const before = await owner.get('/admin/me'); // resolves and caches the owner's scope (30 s)
    expect(before.status).toBe(200);
    const onboarded = await owner.post('/admin/onboarding/stores', onboarding('brand-scope-1'));
    expect(onboarded.status).toBe(201);
    const id = onboarded.body.store.id as string;
    expect(storeIdsOf(before)).not.toContain(id);
    expect(storeIdsOf(await owner.get('/admin/me'))).toContain(id);
  });

  it('control: without the invalidation the cached scope still lacks the store (what the e2e used to wait out)', async () => {
    const { owner, keycloak } = await ownerApp(false);
    await owner.get('/admin/me');
    const onboarded = await owner.post('/admin/onboarding/stores', onboarding('brand-scope-2'));
    expect(onboarded.status).toBe(201);
    const id = onboarded.body.store.id as string;
    expect(storeIdsOf(await owner.get('/admin/me'))).not.toContain(id); // stale for up to 30 s
    keycloak.invalidateAll();
    expect(storeIdsOf(await owner.get('/admin/me'))).toContain(id);
  });

  it('a refused onboarding (400) drops nothing', async () => {
    const { owner, keycloak } = await ownerApp(true);
    let cleared = 0;
    const clear = keycloak.invalidateAll;
    keycloak.invalidateAll = () => {
      cleared++;
      clear();
    };
    const { domain: _omit, ...noDomain } = onboarding('brand-scope-3');
    expect((await owner.post('/admin/onboarding/stores', noDomain)).status).toBe(400);
    expect(cleared).toBe(0);
  });
});
