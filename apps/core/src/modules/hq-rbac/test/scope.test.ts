// Staff scope middleware against docker Keycloak (real tokens via test-cli), a throw-away Postgres db and a
// throw-away OpenFGA store. Issue #13.
import { createHmac } from 'node:crypto';
import {
  createOpenFgaClient,
  createStaffTokenVerifier,
  ScopeCache,
  SCOPE_CACHE_MAX_TTL_MS,
  seedOpenFga,
  type OpenFgaClient,
} from '@platform/auth-sdk';
import { createOrganizationClient, seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHqRbac, createStaffScopeMiddleware, toTenantContext } from '../index.js';

const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
const ORG = SEED_IDS.organization;
const U = SEED_IDS.users;
const S = SEED_IDS.stores;

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

/** Dev TOTP of the pre-enrolled `owner` (#43; infra/keycloak/README.md). RFC 6238, HmacSHA1/6/30. */
const OWNER_DEV_TOTP_SECRET = 'owner-dev-totp-secret-20260905';
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

const tokenCache = new Map<string, string>();
async function token(realm: string, username: string, password = username): Promise<string> {
  // Memoized per user: tokens live 15 min, and re-granting `owner` inside one 30 s TOTP window would trip
  // the realm's code-reuse protection (otpPolicyCodeReusable: false).
  const key = `${realm}/${username}`;
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const grant = async (otpAt?: number) => {
    const body = new URLSearchParams({
      client_id: 'test-cli',
      grant_type: 'password',
      username,
      password,
    });
    // Keycloak's built-in direct-grant flow validates OTP conditionally: since #43 pre-enrolled `owner`,
    // its password grant must carry a code (the other seeded users have no OTP credential).
    if (username === 'owner') body.set('otp', totp(OWNER_DEV_TOTP_SECRET, otpAt));
    const res = await fetch(`${KC}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return (await res.json()) as { access_token?: string; error?: string };
  };
  // The look-ahead of 1 accepts the previous window's code; using it here leaves the CURRENT window's code
  // for keycloak-realms.test.ts's browser login, so the two files never trip code-reuse protection.
  let json = await grant(Date.now() - 30_000);
  if (!json.access_token && username === 'owner') {
    json = await grant(Date.now());
  }
  if (!json.access_token) throw new Error(`token for ${username}: ${json.error}`);
  tokenCache.set(key, json.access_token);
  return json.access_token;
}

describe.runIf(live)('staff scope middleware (live Keycloak + Postgres + OpenFGA)', () => {
  let db: TestDatabase;
  let fga: OpenFgaClient;
  let fgaStoreId: string;
  let calls = 0;
  const now = { t: 1_000_000 };

  const build = (opts: { fga?: OpenFgaClient; cache?: ScopeCache } = {}) =>
    createStaffScopeMiddleware({
      pool: db.app,
      fga: opts.fga ?? fga,
      organizationId: ORG,
      cache: opts.cache ?? new ScopeCache(SCOPE_CACHE_MAX_TTL_MS, () => now.t),
    });

  beforeAll(async () => {
    db = await createTestDatabase('platform_scope');
    await seed(db.owner, { productsPerStore: 1, log: () => {} });
    const seeded = await seedOpenFga({ apiUrl: API, storeName: `scope-test-${Date.now()}` });
    fgaStoreId = seeded.storeId;
    // Count OpenFGA round trips to prove the cache.
    fga = new Proxy(seeded.client, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === 'listObjects' || prop === 'listRelations') {
          return (...args: unknown[]) => {
            calls++;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as OpenFgaClient;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
  });

  it('store-admin → storeIds [brand-a, brand-b], no organization relations, store scope', async () => {
    const mw = build();
    const scope = await mw.resolve(`Bearer ${await token('staff', 'store-admin')}`);
    expect(scope).toMatchObject({
      userId: U.storeAdmin,
      subject: 'seed-store-admin',
      email: 'store-admin@example.com',
      organizationId: ORG,
      organizationRelations: [],
      scope: 'store',
    });
    expect(scope.storeIds).toEqual([S.brandA, S.brandB].sort());
    expect(toTenantContext(scope)).toEqual({
      organizationId: ORG,
      storeIds: [S.brandA, S.brandB].sort(),
      actorId: U.storeAdmin,
      scope: 'store',
    });
  });

  it('finance → organization scope with finance (and only finance) among the assignable relations', async () => {
    const scope = await build().resolve(await token('staff', 'finance'));
    expect(scope.scope).toBe('organization');
    expect(scope.organizationRelations).toEqual(['finance']);
    expect(scope.storeIds).toEqual([S.brandA, S.brandB, S.brandC].sort()); // finance from organization → viewer
  });

  it('owner → every organization relation (owner implies the rest)', async () => {
    const scope = await build().resolve(await token('staff', 'owner'));
    expect(scope.organizationRelations.sort()).toEqual(
      ['owner', 'finance', 'operations', 'analyst', 'support'].sort(),
    );
    expect(scope.storeIds).toHaveLength(3);
  });

  it('caches per subject for ≤ 30 s and drops the entry on role change (invalidate)', async () => {
    const mw = build();
    const t = await token('staff', 'store-staff');
    calls = 0;
    await mw.resolve(t);
    await mw.resolve(t);
    expect(calls).toBe(2); // one listObjects + one listRelations, second resolve served from cache
    expect(SCOPE_CACHE_MAX_TTL_MS).toBeLessThanOrEqual(30_000);
    expect(new ScopeCache(99_999).ttlMs).toBe(30_000);

    // Role change through the tuple API invalidates: store-staff becomes store_admin of brand-c.
    const rbac = createHqRbac({ pool: db.app, fga, onRoleChange: mw.invalidate });
    const owner = { userId: U.owner, subject: 'seed-owner', organizationId: ORG };
    const res = await rbac.handle({
      method: 'POST',
      path: `/admin/users/${U.storeStaff}/roles`,
      principal: owner,
      body: { relation: 'store_admin', object_type: 'store', object_id: S.brandC },
    });
    expect(res?.status).toBe(201);
    const after = await mw.resolve(t);
    expect(calls).toBe(4);
    expect(after.storeIds).toEqual([S.brandA, S.brandC].sort());

    // TTL expiry
    now.t += SCOPE_CACHE_MAX_TTL_MS + 1;
    await mw.resolve(t);
    expect(calls).toBe(6);
  });

  it('unknown sub (valid token, no staff_user row) → 401; disabled user → 401', async () => {
    const hq = createOrganizationClient(db.app, { organizationId: ORG });
    await hq.query('DELETE FROM staff_user WHERE id = $1', [U.analyst]);
    const mw = build();
    await expect(mw.resolve(await token('staff', 'analyst'))).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
      details: { reason: 'no_staff_user' },
    });
    await hq.query("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [U.support]);
    await expect(mw.resolve(await token('staff', 'support'))).rejects.toMatchObject({
      status: 401,
      details: { reason: 'disabled' },
    });
  });

  it('missing, garbage, wrong-realm and wrong-audience tokens → 401', async () => {
    const mw = build();
    await expect(mw.resolve(undefined)).rejects.toMatchObject({ status: 401 });
    await expect(mw.resolve('Bearer not.a.jwt')).rejects.toMatchObject({ status: 401 });
    await expect(
      mw.resolve(await token('customers', 'jane@example.com', 'jane')),
    ).rejects.toMatchObject({
      status: 401,
      details: { reason: expect.stringMatching(/^ERR_/) },
    });
    const strict = createStaffScopeMiddleware({
      pool: db.app,
      fga,
      organizationId: ORG,
      verifier: createStaffTokenVerifier({ audience: 'something-else' }),
      cache: new ScopeCache(0),
    });
    await expect(strict.resolve(await token('staff', 'owner'))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('OpenFGA down → 503 (fail closed), nothing cached', async () => {
    const cache = new ScopeCache();
    const mw = build({
      fga: createOpenFgaClient({ apiUrl: 'http://127.0.0.1:9', storeId: fgaStoreId }),
      cache,
    });
    await expect(mw.resolve(await token('staff', 'owner'))).rejects.toMatchObject({
      status: 503,
      code: 'internal',
    });
    expect(cache.size).toBe(0);
  });
});
