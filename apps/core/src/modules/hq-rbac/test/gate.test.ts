// PHASE 1 GATE (issue #16, Memory-main gate row "store admin cannot open Finance").
// End to end through this window's real stack: docker Keycloak mints real tokens (password grant on the
// dev-only test-cli client) → createStaffScopeMiddleware verifies and resolves the scope → the x-permission
// guards from @platform/auth-sdk decide. Throw-away Postgres db + throw-away OpenFGA store per run.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  can,
  requirePermission,
  ScopeCache,
  seedOpenFga,
  createOpenFgaClient,
  type OpenFgaClient,
  type StaffScope,
} from '@platform/auth-sdk';
import { seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHqRbac, createStaffScopeMiddleware } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
const ORG = SEED_IDS.organization;
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

async function realToken(username: string): Promise<string> {
  const res = await fetch(`${KC}/realms/staff/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'test-cli',
      grant_type: 'password',
      username,
      password: username,
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`token for ${username}: ${json.error}`);
  return json.access_token;
}

/**
 * Every x-permission of the frozen contract, parsed from the spec itself: the `paths:` section is cut into
 * operation blocks (from one `operationId:` to the next) and each block's `x-permission` is taken wherever it
 * sits — after `summary`, a multi-line `description`, `tags`, anything. The earlier regex only matched an
 * `x-permission` directly under `operationId` (one `summary` line allowed) and silently skipped four
 * operations with longer descriptions (#90); the static test below now pins the count.
 */
const SPEC = readFileSync(
  resolve(here, '../../../../../../packages/contracts/openapi/admin-api.yaml'),
  'utf8',
);
const SPEC_PATHS = SPEC.slice(SPEC.indexOf('\npaths:'), SPEC.indexOf('\ncomponents:'));
/** Every operation under paths, with its permission or null when it declares none. */
const SPEC_OPERATIONS = [
  ...SPEC_PATHS.matchAll(/operationId: (\w+)\n([\s\S]*?)(?=\n\s+operationId: |$)/g),
].map((m) => {
  const xp = m[2]!.match(/x-permission:\s*\{\s*relation:\s*(\w+),\s*object:\s*'([^']+)'\s*\}/);
  return { operationId: m[1]!, permission: xp ? { relation: xp[1]!, object: xp[2]! } : null };
});
const SPEC_PERMISSIONS = SPEC_OPERATIONS.flatMap((o) =>
  o.permission ? [{ operationId: o.operationId, ...o.permission }] : [],
);
/**
 * Operations that legitimately carry no x-permission (#402). Only the caller's own identity today; adding a
 * name here is a deliberate review decision, and a stale entry (an operation that gained a permission, or
 * left the spec) fails the test too.
 */
const UNGUARDED_OPERATIONS = ['getMe'];

describe('x-permission sweep of admin-api.yaml is exhaustive (#90, static)', () => {
  it('attributes every x-permission line under paths to exactly one operation', () => {
    const lines = SPEC_PATHS.match(/^\s+x-permission:/gm) ?? [];
    expect(SPEC_PATHS.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThanOrEqual(100);
    expect(SPEC_PERMISSIONS).toHaveLength(lines.length);
    expect(new Set(SPEC_PERMISSIONS.map((p) => p.operationId)).size).toBe(SPEC_PERMISSIONS.length);
    // The four the old regex skipped: a multi-line description sits between operationId and x-permission.
    for (const id of ['updateDomain', 'revokeApiKey', 'capturePayment', 'buyShipmentLabel']) {
      expect(
        SPEC_PERMISSIONS.map((p) => p.operationId),
        id,
      ).toContain(id);
    }
    expect(SPEC_PERMISSIONS.filter((p) => p.relation === 'finance').length).toBeGreaterThan(0);
  });

  it('every operation under paths carries an x-permission unless allowlisted (#402)', () => {
    const ids = SPEC_OPERATIONS.map((o) => o.operationId);
    expect(ids).toHaveLength((SPEC_PATHS.match(/^\s+operationId: /gm) ?? []).length);
    expect(new Set(ids).size).toBe(ids.length);
    const unguarded = SPEC_OPERATIONS.filter((o) => o.permission === null).map(
      (o) => o.operationId,
    );
    // Exact equality in both directions: an unguarded operation outside the allowlist fails, and so does an
    // allowlist entry that is guarded after all or no longer exists.
    expect(unguarded.sort()).toEqual([...UNGUARDED_OPERATIONS].sort());
    expect(SPEC_PERMISSIONS).toHaveLength(ids.length - UNGUARDED_OPERATIONS.length);
  });
});

describe.runIf(live)('PHASE 1 GATE (real tokens, live OpenFGA)', () => {
  let db: TestDatabase;
  let fga: OpenFgaClient;
  let fgaStoreId: string;
  const scopes = new Map<string, StaffScope>();
  let rbac: ReturnType<typeof createHqRbac>;

  beforeAll(async () => {
    db = await createTestDatabase('platform_gate');
    await seed(db.owner, { productsPerStore: 1, log: () => {} });
    const seeded = await seedOpenFga({ apiUrl: API, storeName: `gate-test-${Date.now()}` });
    fga = seeded.client;
    fgaStoreId = seeded.storeId;
    const mw = createStaffScopeMiddleware({
      pool: db.app,
      fga,
      organizationId: ORG,
      cache: new ScopeCache(0),
    });
    rbac = createHqRbac({ pool: db.app, fga, financePing: true }); // the test double, explicit (#90)
    for (const username of ['store-admin', 'finance', 'analyst', 'support']) {
      scopes.set(username, await mw.resolve(`Bearer ${await realToken(username)}`));
    }
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
  });

  it('sanity: the spec sweep found the gate routes', () => {
    const byOp = Object.fromEntries(SPEC_PERMISSIONS.map((p) => [p.operationId, p]));
    expect(byOp.listStores).toMatchObject({ relation: 'viewer', object: 'store:*' });
    expect(byOp.listLegalEntities).toMatchObject({
      relation: 'finance',
      object: 'organization:hq',
    });
    // CONTRACT CHANGE #77 accepted in Admin API 0.2.1: customer reads are support-gated.
    expect(byOp.listCustomers).toMatchObject({ relation: 'support', object: 'store:{storeId}' });
    expect(byOp.getCustomer).toMatchObject({ relation: 'support', object: 'store:{storeId}' });
  });

  it('store-admin of two stores: GET /admin/stores would answer 200 with both stores listed', async () => {
    const scope = scopes.get('store-admin')!;
    // listStores x-permission: viewer on store:* — allowed…
    await expect(can(scope, 'viewer', 'store:*', { fga })).resolves.toBe(true);
    // …and the tenant scope that drives the listing contains exactly brand-a and brand-b.
    expect(scope.scope).toBe('store');
    expect(scope.storeIds).toEqual([S.brandA, S.brandB].sort());
  });

  it('GATE: store-admin gets 403 on EVERY finance-gated operation of the contract', async () => {
    const scope = scopes.get('store-admin')!;
    const financeOps = SPEC_PERMISSIONS.filter((p) => p.relation === 'finance');
    expect(financeOps.map((p) => p.operationId)).toContain('listLegalEntities');
    for (const op of financeOps) {
      const gate = requirePermission('finance', op.object);
      await expect(
        gate(scope, { storeId: S.brandA, store_id: S.brandA }, { fga }),
        op.operationId,
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
        message: `requires finance on ${op.object}`,
        details: { relation: 'finance', object: op.object },
      });
    }
  });

  it('GATE: store-admin gets 403 on /admin/finance/ping (test double for Phase 4 accounting routes; never in production, #90)', async () => {
    const scope = scopes.get('store-admin')!;
    const denied = await rbac.handle({
      method: 'GET',
      path: '/admin/finance/ping',
      principal: { userId: scope.userId, subject: scope.subject, organizationId: ORG },
    });
    expect(denied).toEqual({
      status: 403,
      body: {
        code: 'forbidden',
        message: 'requires finance on organization:hq',
        details: { relation: 'finance', object: 'organization:hq' },
      },
    });
    const finance = scopes.get('finance')!;
    const allowed = await rbac.handle({
      method: 'GET',
      path: '/admin/finance/ping',
      principal: { userId: finance.userId, subject: finance.subject, organizationId: ORG },
    });
    expect(allowed).toEqual({ status: 200, body: { ok: true } });
  });

  it('analyst: 200 on read-only store routes (viewer), organization scope over all three stores', async () => {
    const scope = scopes.get('analyst')!;
    expect(scope.scope).toBe('organization');
    expect(scope.storeIds).toHaveLength(3);
    for (const object of ['store:*', `store:${S.brandA}`]) {
      await expect(can(scope, 'viewer', object, { fga }), object).resolves.toBe(true);
    }
  });

  it('GATE: analyst cannot read customer PII — 403 per Admin API 0.2.1 (support on the store, #77)', async () => {
    // The gate is built from the CONTRACT, not hardcoded: listCustomers carries support since 0.2.1 (#77).
    const spec = SPEC_PERMISSIONS.find((x) => x.operationId === 'listCustomers')!;
    const customersGate = requirePermission(spec.relation as 'support', spec.object);
    await expect(
      customersGate(scopes.get('analyst')!, { storeId: S.brandA }, { fga }),
    ).rejects.toMatchObject({
      status: 403,
      details: { relation: 'support', object: `store:${S.brandA}` },
    });
    // The right people still get through: org support everywhere, store-admin on its own stores only.
    await expect(
      customersGate(scopes.get('support')!, { storeId: S.brandC }, { fga }),
    ).resolves.toBeUndefined();
    await expect(
      customersGate(scopes.get('store-admin')!, { storeId: S.brandA }, { fga }),
    ).resolves.toBeUndefined();
    await expect(
      customersGate(scopes.get('store-admin')!, { storeId: S.brandC }, { fga }),
    ).rejects.toMatchObject({ status: 403 });
    // And finance holds no support anywhere either (PII minimisation cuts both ways).
    await expect(
      can(scopes.get('finance')!, 'support', `store:${S.brandA}`, { fga }),
    ).resolves.toBe(false);
  });

  it('GATE: analyst gets 403 on every finance-gated operation too', async () => {
    const scope = scopes.get('analyst')!;
    for (const op of SPEC_PERMISSIONS.filter((p) => p.relation === 'finance')) {
      await expect(can(scope, 'finance', op.object, { fga }), op.operationId).resolves.toBe(false);
    }
  });
});
