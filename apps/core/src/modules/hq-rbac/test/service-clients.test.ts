// Service clients (#565 crm-sync, #622 analytics-sync): confidential staff-realm service accounts for jobs with no
// human in the request. End to end through this window's real stack, the gate.test.ts pattern: Keycloak mints a
// client-credentials token → createStaffScopeMiddleware verifies it (aud core-api) and looks the subject up in
// staff_user → OpenFGA resolves the scope → the x-permission guards of the CONTRACTS (admin-api.yaml and
// accounting.yaml, parsed here, not hardcoded) decide. Allowed reads resolve; anything outside the client's scope
// is the contract 403. On top: the read-only guard (#565 / #622) and the per-client operation allowlist (#632) in
// the verifier, and hq-rbac's second layer. Throw-away Postgres database + throw-away OpenFGA store
// (tuples.seed.json) per run.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOpenFgaClient,
  requirePermission,
  SERVICE_CLIENT_OPERATIONS,
  ScopeCache,
  seedOpenFga,
  type OpenFgaClient,
  type PermissionRelation,
  type StaffScope,
} from '@platform/auth-sdk';
import { staffToken } from '@platform/auth-sdk/testing';
import { seed, SEED_IDS } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHqRbac, createStaffScopeMiddleware } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const KC = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const API = process.env.OPENFGA_API_URL ?? 'http://localhost:8081';
const ORG = SEED_IDS.organization;
const S = SEED_IDS.stores;

/**
 * The service accounts (#565, #622): their staff_user rows and role_assignment mirrors come with the db seed
 * (`SEED_IDS.serviceAccounts`), their tuples with tuples.seed.json, their Keycloak clients with the realm export.
 */
const CLIENTS = {
  'crm-sync': {
    staffUserId: SEED_IDS.serviceAccounts.crmSync,
    subject: 'seed-crm-sync',
    // Env first (CRM_SYNC_CLIENT_*); the dev realm export's dev-only value otherwise (CI has no .env).
    clientId: process.env.CRM_SYNC_CLIENT_ID ?? 'crm-sync',
    secret: process.env.CRM_SYNC_CLIENT_SECRET ?? 'dev-only-crm-sync-secret',
  },
  'analytics-sync': {
    staffUserId: SEED_IDS.serviceAccounts.analyticsSync,
    subject: 'seed-analytics-sync',
    clientId: process.env.ANALYTICS_SYNC_CLIENT_ID ?? 'analytics-sync',
    secret: process.env.ANALYTICS_SYNC_CLIENT_SECRET ?? 'dev-only-analytics-sync-secret',
  },
} as const;

/** x-permission per operationId, from both contracts (the gate.test.ts block parser). */
function permissionsOf(file: string): Map<string, { relation: string; object: string }> {
  const spec = readFileSync(
    resolve(here, '../../../../../../packages/contracts/openapi', file),
    'utf8',
  );
  const paths = spec.slice(spec.indexOf('\npaths:'), spec.indexOf('\ncomponents:'));
  const out = new Map<string, { relation: string; object: string }>();
  for (const m of paths.matchAll(/operationId: (\w+)\n([\s\S]*?)(?=\n\s+operationId: |$)/g)) {
    const xp = m[2]!.match(/x-permission:\s*\{\s*relation:\s*(\w+),\s*object:\s*'([^']+)'\s*\}/);
    if (xp) out.set(m[1]!, { relation: xp[1]!, object: xp[2]! });
  }
  return out;
}
const PERMISSIONS = new Map([
  ...permissionsOf('admin-api.yaml'),
  ...permissionsOf('accounting.yaml'),
]);

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

/** A client-credentials token; the secret goes to Keycloak only, never into an assertion or a log line. */
async function serviceToken(name: keyof typeof CLIENTS): Promise<string> {
  const c = CLIENTS[name];
  const res = await fetch(`${KC}/realms/staff/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: c.clientId,
      client_secret: c.secret,
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`token for ${name}: ${res.status} ${json.error ?? ''}`);
  return json.access_token;
}

const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

describe('service clients: the contract operations they need exist with the expected x-permission (static)', () => {
  it.each([
    ['listCustomers', 'support', 'store:{storeId}'],
    ['getCustomer', 'support', 'store:{storeId}'],
    ['getHqSalesReport', 'analyst', 'organization:hq'],
    ['getHqFinanceReport', 'finance', 'organization:hq'],
    ['listJournalLines', 'finance', 'organization:hq'],
    ['getTrialBalance', 'finance', 'organization:hq'],
    ['listPayouts', 'finance', 'organization:hq'],
    ['listParkedEvents', 'finance', 'organization:hq'],
    ['listOrders', 'viewer', 'store:{storeId}'],
    ['eraseCustomer', 'store_admin', 'store:{storeId}'],
    ['updateStore', 'store_admin', 'store:{storeId}'],
  ])('%s: %s on %s', (operationId, relation, object) => {
    expect(PERMISSIONS.get(operationId)).toEqual({ relation, object });
  });
});

describe.runIf(live)('service clients (real client-credentials tokens, live OpenFGA)', () => {
  let db: TestDatabase;
  let fga: OpenFgaClient;
  let fgaStoreId: string;
  const scopes = new Map<keyof typeof CLIENTS, StaffScope>();
  const tokens = new Map<keyof typeof CLIENTS, string>();
  let mw: ReturnType<typeof createStaffScopeMiddleware>;

  /** Decides one operation for a scope, as the core's permission middleware does (the contract 403 or pass). */
  const decide = (scope: StaffScope, operationId: string, storeId: string = S.brandA) => {
    const p = PERMISSIONS.get(operationId);
    if (!p) throw new Error(`no x-permission for ${operationId}`);
    return requirePermission(p.relation as PermissionRelation, p.object)(
      scope,
      { storeId, store_id: storeId },
      { fga },
    );
  };

  beforeAll(async () => {
    db = await createTestDatabase('platform_service_clients');
    await seed(db.owner, { productsPerStore: 1, log: () => {} });
    // The seed carries both staff_user rows and their role_assignment mirrors (SEED_IDS.serviceAccounts).
    const rows = await db.owner.query<{ id: string; keycloak_subject: string }>(
      'SELECT id, keycloak_subject FROM staff_user WHERE id = ANY($1) ORDER BY id',
      [Object.values(CLIENTS).map((c) => c.staffUserId)],
    );
    expect(rows.rows).toEqual(
      Object.values(CLIENTS)
        .map((c) => ({ id: c.staffUserId, keycloak_subject: c.subject }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    const seeded = await seedOpenFga({ apiUrl: API, storeName: `service-clients-${Date.now()}` });
    fga = seeded.client;
    fgaStoreId = seeded.storeId;
    mw = createStaffScopeMiddleware({
      pool: db.app,
      fga,
      organizationId: ORG,
      cache: new ScopeCache(0),
    });
    for (const name of Object.keys(CLIENTS) as (keyof typeof CLIENTS)[]) {
      const token = await serviceToken(name);
      tokens.set(name, token);
      // One of its allowed reads, as the core's middleware will present it (method + api + operation, #632).
      scopes.set(
        name,
        await mw.resolve(`Bearer ${token}`, {
          method: 'GET',
          api: 'admin',
          operationId: SERVICE_CLIENT_OPERATIONS[name]!.admin[0],
        }),
      );
    }
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    if (fgaStoreId) await createOpenFgaClient({ apiUrl: API, storeId: fgaStoreId }).deleteStore();
  });

  it.each(Object.keys(CLIENTS) as (keyof typeof CLIENTS)[])(
    '%s: the token is a service account — sub = its staff_user subject, aud core-api, no Keycloak role',
    (name) => {
      const claims = claimsOf(tokens.get(name)!);
      expect(claims.sub).toBe(CLIENTS[name].subject);
      expect([claims.aud].flat()).toContain('core-api');
      expect(claims.azp).toBe(CLIENTS[name].clientId);
      expect((claims.realm_access as { roles?: string[] } | undefined)?.roles ?? []).toEqual([]);
      expect(claims.resource_access ?? {}).toEqual({});
      expect(scopes.get(name)!.userId).toBe(CLIENTS[name].staffUserId);
      expect(scopes.get(name)!.serviceClient).toBe(CLIENTS[name].clientId);
    },
  );

  it('crm-sync: support on brand A only — store scope [brand-a], no organization relation', () => {
    const scope = scopes.get('crm-sync')!;
    expect(scope.scope).toBe('store');
    expect(scope.storeIds).toEqual([S.brandA]);
    expect(scope.organizationRelations).toEqual([]);
  });

  it('crm-sync: listCustomers and getCustomer on brand A are allowed', async () => {
    const scope = scopes.get('crm-sync')!;
    await expect(decide(scope, 'listCustomers')).resolves.toBeUndefined();
    await expect(decide(scope, 'getCustomer')).resolves.toBeUndefined();
  });

  it('crm-sync: the contract 403 on brand B, on eraseCustomer and on every HQ finance/sales read', async () => {
    const scope = scopes.get('crm-sync')!;
    await expect(decide(scope, 'listCustomers', S.brandB)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      details: { relation: 'support', object: `store:${S.brandB}` },
    });
    await expect(decide(scope, 'eraseCustomer')).rejects.toMatchObject({
      status: 403,
      details: { relation: 'store_admin', object: `store:${S.brandA}` },
    });
    for (const op of [
      'getHqSalesReport',
      'getHqFinanceReport',
      'listJournalLines',
      'updateStore',
    ]) {
      await expect(decide(scope, op), op).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    }
  });

  it('analytics-sync: organization scope with exactly analyst + finance', () => {
    const scope = scopes.get('analytics-sync')!;
    expect(scope.scope).toBe('organization');
    expect([...scope.organizationRelations].sort()).toEqual(['analyst', 'finance']);
  });

  it('analytics-sync: the two HQ reports and the four Finance API reads are allowed', async () => {
    const scope = scopes.get('analytics-sync')!;
    for (const op of [
      'getHqSalesReport',
      'getHqFinanceReport',
      'listJournalLines',
      'getTrialBalance',
      'listPayouts',
      'listParkedEvents',
    ]) {
      await expect(decide(scope, op), op).resolves.toBeUndefined();
    }
  });

  it('analytics-sync: the contract 403 on a store write (updateStore) and on every customer route', async () => {
    const scope = scopes.get('analytics-sync')!;
    await expect(decide(scope, 'updateStore')).rejects.toMatchObject({
      status: 403,
      details: { relation: 'store_admin', object: `store:${S.brandA}` },
    });
    for (const op of ['listCustomers', 'getCustomer', 'eraseCustomer']) {
      for (const store of [S.brandA, S.brandB, S.brandC]) {
        await expect(decide(scope, op, store), `${op} ${store}`).rejects.toMatchObject({
          status: 403,
          code: 'forbidden',
        });
      }
    }
  });

  // The read-only guard (#565 / #622): refused by the VERIFIER before any x-permission check — the 403's
  // details.reason names the layer (an x-permission 403 carries { relation, object } instead).
  it.each([
    ['PATCH', 'updateCustomer'],
    ['POST', 'createRefund'],
    ['POST', 'createReturn'],
  ])(
    'crm-sync: %s %s is refused by the read-only guard, although support on brand A would allow it',
    async (method, operationId) => {
      // The permission alone WOULD let it through — which is exactly why the guard exists.
      await expect(decide(scopes.get('crm-sync')!, operationId)).resolves.toBeUndefined();
      await expect(
        mw.resolve(`Bearer ${tokens.get('crm-sync')!}`, { method, operationId }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
        details: {
          reason: 'read_only_service_client',
          client_id: 'crm-sync',
          method,
          operation_id: operationId,
        },
      });
    },
  );

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'analytics-sync: any %s is refused by the guard',
    async (method) => {
      await expect(
        mw.resolve(`Bearer ${tokens.get('analytics-sync')!}`, {
          method,
          operationId: 'updateStore',
        }),
      ).rejects.toMatchObject({
        status: 403,
        details: { reason: 'read_only_service_client', client_id: 'analytics-sync' },
      });
    },
  );

  it('fail closed: a service-client token presented without the request method is refused', async () => {
    await expect(mw.resolve(`Bearer ${tokens.get('crm-sync')!}`)).rejects.toMatchObject({
      status: 403,
      details: { reason: 'read_only_service_client', method: null },
    });
  });

  it('second layer: hq-rbac refuses a write from a service-client scope even when handed one', async () => {
    const rbac = createHqRbac({ pool: db.app, fga });
    const scope = scopes.get('analytics-sync')!;
    const res = await rbac.handle({
      method: 'POST',
      path: '/admin/users',
      principal: { userId: scope.userId, subject: scope.subject, organizationId: ORG },
      scope,
      body: { email: 'nobody@service.invalid', display_name: 'Nobody' },
    });
    expect(res).toMatchObject({
      status: 403,
      body: { code: 'forbidden', details: { reason: 'read_only_service_client' } },
    });
  });

  it('a human support user on the same routes is unaffected by the guard (only its permissions decide)', async () => {
    const human = await mw.resolve(`Bearer ${await staffToken('support')}`, {
      method: 'PATCH',
      operationId: 'updateCustomer',
    });
    expect(human.serviceClient).toBeUndefined();
    for (const op of ['updateCustomer', 'createRefund', 'createReturn']) {
      await expect(decide(human, op), op).resolves.toBeUndefined();
    }
  });

  // The operation allowlist (#632): refused by the VERIFIER, after the read-only check and before any x-permission.
  it.each(Object.keys(CLIENTS) as (keyof typeof CLIENTS)[])(
    '%s: every allowed operation passes the verifier AND its x-permission',
    async (name) => {
      for (const [api, ids] of Object.entries(SERVICE_CLIENT_OPERATIONS[name]!) as [
        'admin' | 'finance',
        string[],
      ][]) {
        for (const operationId of ids) {
          const scope = await mw.resolve(`Bearer ${tokens.get(name)!}`, {
            method: 'GET',
            api,
            operationId,
          });
          expect(scope.serviceRequest).toEqual({ api, operationId });
          await expect(decide(scope, operationId), operationId).resolves.toBeUndefined();
        }
      }
    },
  );

  it.each(Object.keys(CLIENTS) as (keyof typeof CLIENTS)[])(
    '%s: listOrders is refused by THIS layer (service_client_operation_not_allowed) although viewer would allow it',
    async (name) => {
      // The permission alone WOULD let it through (org analyst / finance and store support imply viewer).
      await expect(decide(scopes.get(name)!, 'listOrders')).resolves.toBeUndefined();
      await expect(
        mw.resolve(`Bearer ${tokens.get(name)!}`, {
          method: 'GET',
          api: 'admin',
          operationId: 'listOrders',
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
        details: {
          reason: 'service_client_operation_not_allowed',
          client_id: CLIENTS[name].clientId,
          api: 'admin',
          operation_id: 'listOrders',
        },
      });
    },
  );

  it('fail closed: a service-client read whose operation was not resolved is refused', async () => {
    await expect(
      mw.resolve(`Bearer ${tokens.get('analytics-sync')!}`, { method: 'GET', api: 'admin' }),
    ).rejects.toMatchObject({
      status: 403,
      details: { reason: 'service_client_operation_not_allowed', operation_id: null },
    });
  });

  it('the scope cache never carries a request: two operations in a row each get their own serviceRequest', async () => {
    const cached = createStaffScopeMiddleware({
      pool: db.app,
      fga,
      organizationId: ORG,
      cache: new ScopeCache(30_000),
    });
    const t = `Bearer ${tokens.get('analytics-sync')!}`;
    const a = await cached.resolve(t, {
      method: 'GET',
      api: 'admin',
      operationId: 'getHqSalesReport',
    });
    const b = await cached.resolve(t, { method: 'GET', api: 'finance', operationId: 'listPayouts' });
    expect(a.serviceRequest).toEqual({ api: 'admin', operationId: 'getHqSalesReport' });
    expect(b.serviceRequest).toEqual({ api: 'finance', operationId: 'listPayouts' });
  });

  it('a human analyst on listOrders is unaffected (only its permissions decide)', async () => {
    const human = await mw.resolve(`Bearer ${await staffToken('analyst')}`, {
      method: 'GET',
      api: 'admin',
      operationId: 'listOrders',
    });
    expect(human.serviceClient).toBeUndefined();
    expect(human.serviceRequest).toBeUndefined();
    await expect(decide(human, 'listOrders')).resolves.toBeUndefined();
  });

  it('second layer: hq-rbac refuses a service client whose resolved operation is not the one it matched', async () => {
    const rbac = createHqRbac({ pool: db.app, fga });
    const scope = scopes.get('analytics-sync')!; // resolved for getHqSalesReport
    const res = await rbac.handle({
      method: 'GET',
      path: '/admin/users',
      principal: { userId: scope.userId, subject: scope.subject, organizationId: ORG },
      scope,
    });
    expect(res).toMatchObject({
      status: 403,
      body: {
        code: 'forbidden',
        details: {
          reason: 'service_client_operation_mismatch',
          resolved_operation_id: 'getHqSalesReport',
          operation_id: 'listUsers',
        },
      },
    });
  });

  it('second layer: hq-rbac refuses its own operations to a service client even when they agree', async () => {
    const rbac = createHqRbac({ pool: db.app, fga });
    const scope: StaffScope = {
      ...scopes.get('analytics-sync')!,
      serviceRequest: { api: 'admin', operationId: 'listAuditLog' },
    };
    const res = await rbac.handle({
      method: 'GET',
      path: '/admin/audit-log',
      principal: { userId: scope.userId, subject: scope.subject, organizationId: ORG },
      scope,
    });
    expect(res).toMatchObject({
      status: 403,
      body: {
        details: { reason: 'service_client_operation_not_allowed', operation_id: 'listAuditLog' },
      },
    });
  });
});
