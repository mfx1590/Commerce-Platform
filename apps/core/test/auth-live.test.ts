// Integration 1: real staff auth through the FULL middleware chain src/server.ts mounts — docker Keycloak mints
// real tokens (password grant on the dev-only test-cli client), `KeycloakStaffTokenVerifier` verifies them and
// resolves the OpenFGA scope, `requirePermission` asks OpenFGA, hq-rbac answers its own routes. Throw-away
// Postgres database + throw-away OpenFGA store per run; skipped when Keycloak or OpenFGA is unreachable (same
// convention as packages/auth-sdk/test/guard.test.ts and src/modules/hq-rbac/test/gate.test.ts).
import express from 'express';
import request from 'supertest';
import {
  createOpenFgaClient,
  ScopeCache,
  seedOpenFga,
  type OpenFgaClient,
} from '@platform/auth-sdk';
import { forgetStaffToken, staffToken } from '@platform/auth-sdk/testing';
import { CONTRACTS_VERSION } from '@platform/contracts';
import { SEED_IDS, seed } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeStaffTokenVerifier, KeycloakStaffTokenVerifier } from '../src/http';
import { closePool, initDb } from '../src/lib/db';
import { mountCoreMiddleware } from '../src/server';
import { specValidator } from './helpers/openapi';

const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
const ORG = SEED_IDS.organization;
const S = SEED_IDS.stores;
const U = SEED_IDS.users;
const spec = specValidator('admin-api.yaml');

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
const live =
  (await up(`${KC}/realms/staff/.well-known/openid-configuration`)) &&
  (await up(`${API}/healthz`)) &&
  Boolean(process.env.DATABASE_URL);

const tokenCache = new Map<string, string>();
/**
 * Real staff-realm token via the test-cli password grant (password = username for the seeded users).
 * `owner` is pre-enrolled with TOTP (#43) and Keycloak refuses a used code: `staffToken` signs owner in once per
 * machine and shares the token through a per-user file with every other live suite (#346), so this
 * suite, hq-rbac's scope test and auth-sdk's realm test never need the same one-time code, in any order.
 */
async function realToken(username: string): Promise<string> {
  const cached = tokenCache.get(username);
  if (cached) return cached;
  const token = await staffToken(username, { keycloakUrl: KC });
  tokenCache.set(username, token);
  return token;
}

describe.runIf(live)(
  'Integration 1: real Keycloak tokens + OpenFGA through mountCoreMiddleware',
  () => {
    let db: TestDatabase;
    let fga: OpenFgaClient;
    let fgaStoreId: string;
    let app: express.Express;
    const bearer = async (username: string) => `Bearer ${await realToken(username)}`;

    beforeAll(async () => {
      db = await createTestDatabase('core_auth_live');
      await seed(db.owner, { productsPerStore: 3, log: () => {} });
      process.env.CORE_ORGANIZATION_ID = ORG;
      process.env.CORE_DEV_TOKENS = '1';
      await initDb({ connectionString: db.app.options.connectionString! });
      const seeded = await seedOpenFga({ apiUrl: API, storeName: `core-auth-live-${Date.now()}` });
      fga = seeded.client;
      fgaStoreId = seeded.storeId;

      const keycloak = new KeycloakStaffTokenVerifier({
        pool: db.app,
        organizationId: ORG,
        fga,
        cache: new ScopeCache(0),
      });
      app = express();
      mountCoreMiddleware(app, composeStaffTokenVerifier(keycloak), {
        fga,
        onRoleChange: keycloak.invalidate,
      });
    }, 180_000);

    afterAll(async () => {
      await forgetStaffToken(); // the owner-token file is ours to remove when we created it (#346; kept in CI for the job)
      await closePool();
      await db?.drop();
      if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
    });

    it('GET /admin/me: store-admin → 200 Principal with brand-a and brand-b from OpenFGA', async () => {
      const res = await request(app)
        .get('/admin/me')
        .set('Authorization', await bearer('store-admin'));
      expect(res.status).toBe(200);
      spec.assertSchema('Principal', res.body);
      expect(res.body.user).toEqual({
        id: U.storeAdmin,
        email: 'store-admin@example.com',
        display_name: expect.any(String),
      });
      expect(res.body.organization_relations).toEqual([]);
      expect(
        res.body.stores.map((s: { code: string; relations: string[] }) => [s.code, s.relations]),
      ).toEqual([
        ['brand-a', ['store_admin']],
        ['brand-b', ['store_admin']],
      ]);
    });

    it('GET /admin/stores/{brand-a}/products: store-admin → 200 (x-permission viewer via OpenFGA); brand-c → 403', async () => {
      const ok = await request(app)
        .get(`/admin/stores/${S.brandA}/products`)
        .set('Authorization', await bearer('store-admin'));
      expect(ok.status).toBe(200);
      spec.assertPage('Product', ok.body);
      expect(ok.body.total).toBe(3);

      const outside = await request(app)
        .get(`/admin/stores/${S.brandC}/products`)
        .set('Authorization', await bearer('store-admin'));
      expect(outside.status).toBe(403);
      spec.assertSchema('Error', outside.body);
    });

    it('GET /admin/stores/{brand-a}/orders (task 2.3): store-admin → 200 Page<OrderSummary> via OpenFGA viewer; brand-c → 403', async () => {
      const ok = await request(app)
        .get(`/admin/stores/${S.brandA}/orders`)
        .set('Authorization', await bearer('store-admin'));
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ page: 1, limit: 20 });
      expect(Array.isArray(ok.body.items)).toBe(true);
      const foreign = await request(app)
        .get(`/admin/stores/${S.brandC}/orders`)
        .set('Authorization', await bearer('store-admin'));
      expect(foreign.status).toBe(403);
      expect(foreign.body).toMatchObject({ code: 'forbidden' });
    });

    it('GET /admin/inventory/levels (task 2.4): store-admin → 200 with store_id=brand-a and without (store:*); brand-c → 403', async () => {
      const own = await request(app)
        .get(`/admin/inventory/levels?store_id=${S.brandA}&limit=1`)
        .set('Authorization', await bearer('store-admin'));
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ page: 1, limit: 1 });
      const any = await request(app)
        .get('/admin/inventory/levels?limit=1')
        .set('Authorization', await bearer('store-admin'));
      expect(any.status).toBe(200);
      const foreign = await request(app)
        .get(`/admin/inventory/levels?store_id=${S.brandC}&limit=1`)
        .set('Authorization', await bearer('store-admin'));
      expect(foreign.status).toBe(403);
    });

    it('POST /admin/stores/{brand-c}/orders/{id}/returns (task 2.5): store-admin → 403 through OpenFGA (support on a store outside the scope)', async () => {
      const foreign = await request(app)
        .post(`/admin/stores/${S.brandC}/orders/00000000-0000-4000-8000-0000000000aa/returns`)
        .set('Authorization', await bearer('store-admin'))
        .send({
          items: [{ order_line_item_id: '00000000-0000-4000-8000-0000000000ab', quantity: 1 }],
        });
      expect(foreign.status).toBe(403);
      expect(foreign.body).toMatchObject({ code: 'forbidden', details: { relation: 'support' } });
      // in scope the permission passes and the (unknown) order answers 404 — the route is live behind OpenFGA
      const own = await request(app)
        .post(`/admin/stores/${S.brandA}/orders/00000000-0000-4000-8000-0000000000aa/returns`)
        .set('Authorization', await bearer('store-admin'))
        .send({
          items: [{ order_line_item_id: '00000000-0000-4000-8000-0000000000ab', quantity: 1 }],
        });
      expect(own.status).toBe(404);
    });

    it('GATE: store-admin gets 403 with the contract body on a finance-gated route; finance gets 200', async () => {
      const denied = await request(app)
        .get('/admin/legal-entities')
        .set('Authorization', await bearer('store-admin'));
      expect(denied.status).toBe(403);
      spec.assertSchema('Error', denied.body);
      expect(denied.body).toEqual({
        code: 'forbidden',
        message: 'requires finance on organization:hq',
        details: { relation: 'finance', object: 'organization:hq' },
      });

      const allowed = await request(app)
        .get('/admin/legal-entities')
        .set('Authorization', await bearer('finance'));
      expect(allowed.status).toBe(200);
      spec.assertItems('LegalEntity', allowed.body);

      // hq-rbac's own finance gate (test double for the Phase 4 accounting routes), same principal.
      const ping = await request(app)
        .get('/admin/finance/ping')
        .set('Authorization', await bearer('store-admin'));
      expect(ping.status).toBe(403);
      expect(ping.body).toEqual({
        code: 'forbidden',
        message: 'requires finance on organization:hq',
        details: { relation: 'finance', object: 'organization:hq' },
      });
    });

    it('GET /admin/users (hq-rbac): owner → 200 Page<StaffUser>; store-admin → 403', async () => {
      const owner = await request(app)
        .get('/admin/users')
        .set('Authorization', await bearer('owner'));
      expect(owner.status).toBe(200);
      spec.assertPage('StaffUser', owner.body);
      expect(owner.body.items.map((u: { email: string }) => u.email)).toContain(
        'store-admin@example.com',
      );

      const denied = await request(app)
        .get('/admin/users')
        .set('Authorization', await bearer('store-admin'));
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({
        code: 'forbidden',
        details: { relation: 'owner', object: 'organization:hq' },
      });
    }, 90_000);

    it('#413 onboarding (live): the onboarded store is registered in OpenFGA — owner lists, reads and activates it; store-admin → 403', async () => {
      const owner = await bearer('owner');
      const created = await request(app)
        .post('/admin/onboarding/stores')
        .set('Authorization', owner)
        .send({
          legal_entity: {
            code: 'brand-live-bv',
            name: 'Brand Live B.V.',
            country: 'NL',
            currency: 'EUR',
          },
          code: 'brand-live',
          name: 'Brand Live',
          default_currency: 'EUR',
          default_locale: 'en-GB',
          default_country: 'NL',
          domain: { hostname: 'brand-live.localhost' },
        });
      expect(created.status).toBe(201);
      spec.assertSchema('StoreOnboarded', created.body);
      const id = created.body.store.id as string;

      // scope resolution (OpenFGA ListObjects, no cache in this suite) now shows the store to the seeded owner
      const listed = await request(app).get('/admin/stores?limit=100').set('Authorization', owner);
      expect(listed.status).toBe(200);
      expect(listed.body.items.map((s: { code: string }) => s.code)).toContain('brand-live');
      expect(
        (await request(app).get(`/admin/stores/${id}`).set('Authorization', owner)).status,
      ).toBe(200);

      // ... and not to a store admin of brand-a / brand-b
      const outside = await request(app)
        .get(`/admin/stores/${id}`)
        .set('Authorization', await bearer('store-admin'));
      expect(outside.status).toBe(403);
      spec.assertSchema('Error', outside.body);

      // the fga_object prerequisite is read from the real OpenFGA: activation passes
      const active = await request(app)
        .post(`/admin/stores/${id}/activate`)
        .set('Authorization', owner);
      expect(active.status).toBe(200);
      expect(active.body.status).toBe('active');
    });

    it('GET /admin/audit-log (hq-rbac) receives the scope the middleware resolved: store-admin → 200', async () => {
      const res = await request(app)
        .get('/admin/audit-log')
        .set('Authorization', await bearer('store-admin'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, items: expect.any(Array) });
    });

    it('invalid JWT → 401; a dev token without the opt-in goes to Keycloak and is refused', async () => {
      const garbage = await request(app)
        .get('/admin/me')
        .set('Authorization', 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.bm9wZQ');
      expect(garbage.status).toBe(401);
      spec.assertSchema('Error', garbage.body);
      expect(garbage.body).toMatchObject({ code: 'unauthorized', message: 'Invalid bearer token' });

      const withFlag = await request(app)
        .get('/admin/me')
        .set('Authorization', 'Bearer dev:seed-store-admin');
      expect(withFlag.status).toBe(200);

      delete process.env.CORE_DEV_TOKENS;
      try {
        const withoutFlag = await request(app)
          .get('/admin/me')
          .set('Authorization', 'Bearer dev:seed-store-admin');
        expect(withoutFlag.status).toBe(401);
        expect(withoutFlag.body.code).toBe('unauthorized');
      } finally {
        process.env.CORE_DEV_TOKENS = '1';
      }
    });

    it('fails closed with 503 when OpenFGA is unreachable', async () => {
      const dead = createOpenFgaClient({ apiUrl: 'http://127.0.0.1:9', storeId: fgaStoreId });
      const keycloak = new KeycloakStaffTokenVerifier({
        pool: db.app,
        organizationId: ORG,
        fga: dead,
        cache: new ScopeCache(0),
      });
      const isolated = express();
      mountCoreMiddleware(isolated, composeStaffTokenVerifier(keycloak), { fga: dead });
      const res = await request(isolated)
        .get('/admin/me')
        .set('Authorization', await bearer('store-admin'));
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: 'internal',
        message: 'authorization service unavailable',
      });
      expect(res.headers['x-contracts-version']).toBe(CONTRACTS_VERSION); // #284: on the 503 too
    });
  },
);
