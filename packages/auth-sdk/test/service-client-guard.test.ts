// Read-only guard (#565 / #622) and operation allowlist (#632) for service-account clients. Unit, always runs: tokens signed with a throw-away
// RS256 key and served from a local JWKS, so every branch is proven without the stack. The live counterpart
// (real Keycloak tokens through the scope middleware) is apps/core/src/modules/hq-rbac/test/service-clients.test.ts.
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createStaffTokenVerifier,
  READ_ONLY_SERVICE_CLIENTS,
  SERVICE_CLIENT_OPERATIONS,
  readOnlyServiceClientOf,
  serviceClientMayCallOperation,
  type ServiceClientRefusal,
  type StaffTokenVerifier,
} from '../src/index.js';

const ISSUER_BASE = 'http://keycloak.unit.test';
const ISSUER = `${ISSUER_BASE}/realms/staff`;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let server: Server;
let key: SigningKey;
let verifier: StaffTokenVerifier;
const refusals: ServiceClientRefusal[] = [];

const token = (claims: Record<string, unknown>) =>
  new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'unit' })
    .setIssuer(ISSUER)
    .setAudience('core-api')
    .setSubject(String(claims.sub ?? 'seed-crm-sync'))
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  key = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'unit', alg: 'RS256', use: 'sig' };
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  verifier = createStaffTokenVerifier({
    keycloakUrl: ISSUER_BASE,
    realm: 'staff',
    jwksUri: `http://127.0.0.1:${a.port}/certs`,
    onServiceClientRefusal: (r) => refusals.push(r),
  });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('read-only service clients (unit, local JWKS)', () => {
  it('the set is exactly crm-sync and analytics-sync, a code constant — no environment can change it', async () => {
    expect([...READ_ONLY_SERVICE_CLIENTS].sort()).toEqual(['analytics-sync', 'crm-sync']);
    // An empty or hostile environment changes nothing: the guard never reads one.
    process.env.READ_ONLY_SERVICE_CLIENTS = '';
    try {
      expect(readOnlyServiceClientOf({ azp: 'crm-sync' })).toBe('crm-sync');
    } finally {
      delete process.env.READ_ONLY_SERVICE_CLIENTS;
    }
    // Mutating the exported set cannot widen (or narrow) the guard: it reads its own private list.
    (READ_ONLY_SERVICE_CLIENTS as Set<string>).delete('crm-sync');
    try {
      expect(readOnlyServiceClientOf({ azp: 'crm-sync' })).toBe('crm-sync');
    } finally {
      (READ_ONLY_SERVICE_CLIENTS as Set<string>).add('crm-sync');
    }
  });

  it.each(['GET', 'HEAD', 'get'])(
    '%s: a service-client token passes and is marked',
    async (method) => {
      const claims = await verifier.verify(await token({ azp: 'crm-sync' }), {
        method,
        api: 'admin',
        operationId: 'getCustomer',
      });
      expect(claims.serviceClient).toBe('crm-sync');
      expect(claims.subject).toBe('seed-crm-sync');
    },
  );

  it.each(['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'])(
    '%s: refused with the guard 403 (reason read_only_service_client), logged without PII',
    async (method) => {
      refusals.length = 0;
      await expect(
        verifier.verify(
          await token({
            azp: 'analytics-sync',
            sub: 'seed-analytics-sync',
            email: 'x@service.invalid',
          }),
          {
            method,
            operationId: 'updateStore',
          },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
        details: {
          reason: 'read_only_service_client',
          client_id: 'analytics-sync',
          method,
          operation_id: 'updateStore',
        },
      });
      expect(refusals).toEqual([
        {
          event: 'service_client_write_refused',
          client_id: 'analytics-sync',
          method,
          operation_id: 'updateStore',
        },
      ]);
      const line = JSON.stringify(refusals);
      expect(line).not.toContain('seed-analytics-sync'); // no subject
      expect(line).not.toContain('@'); // no email
    },
  );

  it('fail closed: a service-client token without a request context is refused', async () => {
    await expect(verifier.verify(await token({ azp: 'crm-sync' }))).rejects.toMatchObject({
      status: 403,
      details: { reason: 'read_only_service_client', method: null },
    });
  });

  it('the client is read from the verified token: client_id is honoured when azp is absent', async () => {
    await expect(
      verifier.verify(await token({ client_id: 'crm-sync' }), { method: 'PATCH' }),
    ).rejects.toMatchObject({ status: 403, details: { reason: 'read_only_service_client' } });
  });

  it('people are unaffected: a human token passes any method, with or without the request context', async () => {
    for (const azp of ['admin-app', 'test-cli', undefined]) {
      const t = await token({ ...(azp ? { azp } : {}), sub: 'seed-support' });
      for (const request of [
        { method: 'PATCH', operationId: 'updateCustomer' },
        { method: 'POST' },
        undefined,
      ]) {
        const claims = await verifier.verify(t, request);
        expect(claims.serviceClient).toBeUndefined();
      }
    }
  });

  it('an unknown service client (not in the set) is not read-only by this guard — its permissions decide', async () => {
    const claims = await verifier.verify(await token({ azp: 'core-admin' }), { method: 'POST' });
    expect(claims.serviceClient).toBeUndefined();
  });

  it('a forged or expired token never reaches the guard: 401 first', async () => {
    const other = (await generateKeyPair('RS256')).privateKey;
    const forged = await new SignJWT({ azp: 'crm-sync' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unit' })
      .setIssuer(ISSUER)
      .setAudience('core-api')
      .setSubject('seed-crm-sync')
      .setExpirationTime('5m')
      .sign(other);
    await expect(verifier.verify(forged, { method: 'GET' })).rejects.toMatchObject({ status: 401 });
  });
});

describe('operation allowlist per service client (#632, unit, local JWKS)', () => {
  const allowed: [string, 'admin' | 'finance', string][] = [
    ['crm-sync', 'admin', 'getCustomer'],
    ['analytics-sync', 'admin', 'getHqSalesReport'],
    ['analytics-sync', 'admin', 'getHqFinanceReport'],
    ['analytics-sync', 'finance', 'listLegalEntityBooks'],
    ['analytics-sync', 'finance', 'listJournalLines'],
    ['analytics-sync', 'finance', 'getTrialBalance'],
    ['analytics-sync', 'finance', 'listPayouts'],
    ['analytics-sync', 'finance', 'listParkedEvents'],
  ];

  it("the lists are exactly the issue's, a code constant — mutating the exported copy changes nothing", () => {
    expect(SERVICE_CLIENT_OPERATIONS).toEqual({
      'crm-sync': { admin: ['getCustomer'], finance: [] },
      'analytics-sync': {
        admin: ['getHqSalesReport', 'getHqFinanceReport'],
        finance: [
          'listLegalEntityBooks',
          'listJournalLines',
          'getTrialBalance',
          'listPayouts',
          'listParkedEvents',
        ],
      },
    });
    SERVICE_CLIENT_OPERATIONS['crm-sync']!.admin.push('listOrders');
    try {
      expect(serviceClientMayCallOperation('crm-sync', 'admin', 'listOrders')).toBe(false);
    } finally {
      SERVICE_CLIENT_OPERATIONS['crm-sync']!.admin.pop();
    }
  });

  it.each(allowed)('%s may call %s %s', async (client, api, operationId) => {
    const claims = await verifier.verify(await token({ azp: client, sub: `seed-${client}` }), {
      method: 'GET',
      api,
      operationId,
    });
    expect(claims.serviceClient).toBe(client);
  });

  it.each([
    ['crm-sync', 'admin', 'listOrders'],
    ['crm-sync', 'admin', 'listCustomers'], // dropped in review: the CRM sync only calls getCustomer
    ['crm-sync', 'admin', 'getHqSalesReport'],
    ['crm-sync', 'finance', 'getTrialBalance'],
    ['analytics-sync', 'admin', 'listOrders'],
    ['analytics-sync', 'admin', 'listCustomers'],
    ['analytics-sync', 'admin', 'listAuditLog'],
    ['analytics-sync', 'finance', 'getPayout'],
    // an allowed operationId under the other API is not allowed
    ['analytics-sync', 'finance', 'getHqSalesReport'],
    ['analytics-sync', 'admin', 'getTrialBalance'],
  ] as const)(
    '%s: %s %s refused 403 service_client_operation_not_allowed, logged without PII',
    async (client, api, operationId) => {
      refusals.length = 0;
      await expect(
        verifier.verify(
          await token({ azp: client, sub: `seed-${client}`, email: 'x@service.invalid' }),
          { method: 'GET', api, operationId },
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
        details: {
          reason: 'service_client_operation_not_allowed',
          client_id: client,
          api,
          operation_id: operationId,
        },
      });
      expect(refusals).toEqual([
        {
          event: 'service_client_operation_refused',
          client_id: client,
          method: 'GET',
          api,
          operation_id: operationId,
        },
      ]);
      const line = JSON.stringify(refusals);
      expect(line).not.toContain(`seed-${client}`);
      expect(line).not.toContain('@');
    },
  );

  it.each([
    ['no api', { method: 'GET', operationId: 'listCustomers' }],
    ['no operationId (unmatched path)', { method: 'GET', api: 'admin' as const }],
    [
      'an unknown api',
      { method: 'GET', api: 'store' as unknown as 'admin', operationId: 'listCustomers' },
    ],
    [
      'an inherited property name',
      { method: 'GET', api: 'admin' as const, operationId: 'constructor' },
    ],
  ])('fail closed: %s is refused', async (_label, request) => {
    await expect(verifier.verify(await token({ azp: 'crm-sync' }), request)).rejects.toMatchObject({
      status: 403,
      details: { reason: 'service_client_operation_not_allowed' },
    });
  });

  it('the read-only check runs first: a write to an allowed operation is still read_only_service_client', async () => {
    await expect(
      verifier.verify(await token({ azp: 'crm-sync' }), {
        method: 'POST',
        api: 'admin',
        operationId: 'listCustomers',
      }),
    ).rejects.toMatchObject({ status: 403, details: { reason: 'read_only_service_client' } });
  });

  it('people are unaffected: a human token passes any operation, with or without api / operationId', async () => {
    const t = await token({ azp: 'admin-app', sub: 'seed-analyst' });
    for (const request of [
      { method: 'GET', api: 'admin' as const, operationId: 'listOrders' },
      { method: 'GET', api: 'finance' as const, operationId: 'getPayout' },
      { method: 'GET' },
    ]) {
      expect((await verifier.verify(t, request)).serviceClient).toBeUndefined();
    }
  });
});
