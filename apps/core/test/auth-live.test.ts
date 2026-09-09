// Integration 1: real staff auth through the FULL middleware chain src/server.ts mounts — docker Keycloak mints
// real tokens (password grant on the dev-only test-cli client), `KeycloakStaffTokenVerifier` verifies them and
// resolves the OpenFGA scope, `requirePermission` asks OpenFGA, hq-rbac answers its own routes. Throw-away
// Postgres database + throw-away OpenFGA store per run; skipped when Keycloak or OpenFGA is unreachable (same
// convention as packages/auth-sdk/test/guard.test.ts and src/modules/hq-rbac/test/gate.test.ts).
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  createOpenFgaClient,
  ScopeCache,
  seedOpenFga,
  type OpenFgaClient,
} from '@platform/auth-sdk';
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

/** Dev TOTP of the pre-enrolled `owner` (infra/keycloak/README.md). RFC 6238, HmacSHA1/6/30. */
const OWNER_DEV_TOTP_SECRET = 'owner-dev-totp-secret-20260905';
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

const tokenCache = new Map<string, string>();
/** Real staff-realm token via the test-cli password grant (password = username for the seeded users). */
async function realToken(username: string): Promise<string> {
  const cached = tokenCache.get(username);
  if (cached) return cached;
  const grant = async (otpAt?: number) => {
    const body = new URLSearchParams({
      client_id: 'test-cli',
      grant_type: 'password',
      username,
      password: username,
    });
    // `owner` is pre-enrolled with TOTP (#43): the direct grant must carry a code; the look-ahead of 1 accepts
    // the previous window's code, leaving the current one for other suites (code reuse is refused).
    if (username === 'owner') body.set('otp', totp(OWNER_DEV_TOTP_SECRET, otpAt));
    const res = await fetch(`${KC}/realms/staff/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return (await res.json()) as { access_token?: string; error?: string };
  };
  let json = await grant(Date.now() - 30_000);
  if (!json.access_token && username === 'owner') json = await grant(Date.now());
  if (!json.access_token && username === 'owner') {
    await new Promise((r) => setTimeout(r, 30_500 - (Date.now() % 30_000)));
    json = await grant(Date.now());
  }
  if (!json.access_token) throw new Error(`token for ${username}: ${json.error}`);
  tokenCache.set(username, json.access_token);
  return json.access_token;
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
    });
  },
);
