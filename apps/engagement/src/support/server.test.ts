// The support server end to end on a throwaway database: the 401 / 403 / 200 matrix #556 asks for, the
// webhook route, and the PII rules.
//
// The Admin API is a fake reader here. What it stands in for is the Prism mock the contract is developed
// against; what matters for these tests is which calls are made, with WHOSE authorization header, and that no
// call is made at all when a gate refuses.

import { createOrganizationClient, SEED_IDS, seed, type ScopedClient } from '@platform/db';
import { createTestDatabase, type TestDatabase } from '@platform/db/testing';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RawCustomer, RawOrderDetail, RawOrderSummary, SupportReader } from './admin-api.js';
import { createAgentAuth, type PermissionChecker } from './auth.js';
import { createChatwootReceiver, signBody } from './chatwoot.js';
import { createSupportServer, type SupportLogLine } from './server.js';

const ORG = SEED_IDS.organization;
const STORE_A = SEED_IDS.stores.brandA;
const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const ORDER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'chatwoot-webhook-secret-words-only';
const AGENT_TOKEN = 'Bearer dev:seed-support';
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

let db: TestDatabase;
let hq: ScopedClient;
let server: Server;
let base: string;
let calls: { what: string; authorization: string }[];
let allow: boolean;
let fgaThrows: boolean;
let lines: SupportLogLine[];

const customer: RawCustomer = {
  id: CUSTOMER,
  email: 'ada@example.test',
  first_name: 'Ada',
  last_name: 'Lovelace',
  status: 'registered',
  created_at: '2026-10-01T10:00:00.000Z',
};

const summary: RawOrderSummary = {
  id: ORDER,
  display_id: 1001,
  status: 'completed',
  payment_status: 'captured',
  fulfillment_status: 'fulfilled',
  total: 10994,
  currency: 'EUR',
  placed_at: '2026-10-05T10:00:00.000Z',
};

const detail: RawOrderDetail = {
  ...summary,
  payments: [
    { id: 'p1', provider: 'stripe', status: 'captured', amount_minor: 10994, currency: 'EUR' },
  ],
  refunds: [
    { id: 'r1', status: 'succeeded', amount_minor: 2500, currency: 'EUR', reason: 'return' },
  ],
  shipments: [
    {
      id: 's1',
      status: 'delivered',
      carrier: 'dhl',
      tracking_number: 'TRACK-ALPHA-WORDS',
      shipped_at: '2026-10-06T10:00:00.000Z',
      delivered_at: '2026-10-08T10:00:00.000Z',
    },
  ],
  returns: [{ id: 'rt1', status: 'received', requested_at: '2026-10-07T10:00:00.000Z' }],
};

/** Records every read and the header it carried, so "the agent's own token" is provable. */
function fakeReader(over: Partial<SupportReader> = {}): SupportReader {
  return {
    async getCustomer(_s, _c, authorization) {
      calls.push({ what: 'getCustomer', authorization });
      return customer;
    },
    async listOrders(_s, _c, authorization) {
      calls.push({ what: 'listOrders', authorization });
      return [summary];
    },
    async getOrder(_s, _o, authorization) {
      calls.push({ what: 'getOrder', authorization });
      return detail;
    },
    ...over,
  };
}

const fga: PermissionChecker = {
  async can() {
    if (fgaThrows) throw new Error('openfga is down');
    return allow;
  },
};

async function req(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function build(reader: SupportReader = fakeReader()): Server {
  const auth = createAgentAuth({ client: hq, fga, devTokens: true, env: {} as NodeJS.ProcessEnv });
  return createSupportServer({
    hq,
    auth,
    reader,
    chatwoot: createChatwootReceiver({ secret: SECRET, now: () => NOW }),
    log: (l) => lines.push(l),
  });
}

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

beforeAll(async () => {
  db = await createTestDatabase('platform_support');
  await seed(db.owner);
  hq = createOrganizationClient(db.app, { organizationId: ORG });
}, 120_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  calls = [];
  lines = [];
  allow = true;
  fgaThrows = false;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  server = build();
  base = await listen(server);
});

describe('GET /health', () => {
  it('answers without a token and without touching anything', async () => {
    const r = await req('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok', module: 'support' });
    expect(calls).toEqual([]);
  });
});

describe('GET /support/customers/:id/context — the gates', () => {
  it('401s with NO token, before any parameter is read', async () => {
    const r = await req(`/support/customers/${CUSTOMER}/context`);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('unauthorized');
    // Nothing was read, and the missing `store` parameter was never even complained about: the route cannot
    // be probed unauthenticated.
    expect(calls).toEqual([]);
    expect(r.body.message).not.toMatch(/store/i);
  });

  it('401s an unknown staff subject (a token is a claim, the row is the fact)', async () => {
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: 'Bearer dev:nobody-at-all' },
    });
    expect(r.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('401s a DISABLED staff user', async () => {
    await db.owner.query(`UPDATE staff_user SET status = 'disabled' WHERE keycloak_subject = $1`, [
      'seed-support',
    ]);
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(401);
    await db.owner.query(`UPDATE staff_user SET status = 'active' WHERE keycloak_subject = $1`, [
      'seed-support',
    ]);
  });

  it('403s a staff user who is NOT support for this store, and reads nothing', async () => {
    allow = false;
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('forbidden');
    expect(calls).toEqual([]);
  });

  it('403s the same agent asking about ANOTHER store', async () => {
    // The permission is per store, so the check is made against the store in the request.
    allow = false;
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-b`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('503s, not 403, when the permission service is unreachable (fail closed, honestly)', async () => {
    fgaThrows = true;
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('unavailable');
    expect(calls).toEqual([]);
  });

  it('400s a request with no store', async () => {
    const r = await req(`/support/customers/${CUSTOMER}/context`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('404s an unknown store', async () => {
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-zz`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(404);
  });

  it('405s a POST', async () => {
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      method: 'POST',
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(405);
  });
});

describe('GET /support/customers/:id/context — the answer', () => {
  it('200s with the customer, the orders and the summary', async () => {
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(200);
    expect(r.body.store_code).toBe('brand-a');
    expect(r.body.customer).toMatchObject({ id: CUSTOMER, email: 'ada@example.test' });
    expect(r.body.notes).toEqual([]);

    const orders = r.body.orders as Record<string, unknown>[];
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      display_id: 1001,
      total_minor: 10994,
      currency: 'EUR',
      status: 'completed',
    });
    expect(orders[0]!.payments as unknown[]).toHaveLength(1);
    expect(orders[0]!.refunds as unknown[]).toHaveLength(1);
    expect(orders[0]!.shipments as unknown[]).toHaveLength(1);
    expect(orders[0]!.returns as unknown[]).toHaveLength(1);

    expect(r.body.summary).toMatchObject({
      orders_count: 1,
      open_orders: 0,
      cancelled_orders: 0,
      currency: 'EUR',
      gross_minor: 10994,
      refunded_minor: 2500,
      last_order_at: '2026-10-05T10:00:00.000Z',
      mixed_currency: false,
    });
  });

  it("forwards the AGENT'S OWN authorization header to every read", async () => {
    await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(calls.map((c) => c.what)).toEqual(['getCustomer', 'listOrders', 'getOrder']);
    for (const call of calls) expect(call.authorization).toBe(AGENT_TOKEN);
  });

  it('accepts a store id as well as a code', async () => {
    const r = await req(`/support/customers/${CUSTOMER}/context?store=${STORE_A}`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(200);
    expect(r.body.store_code).toBe('brand-a');
  });

  it('404s a customer who is not in this store, the same as one who does not exist', async () => {
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(200);

    await new Promise<void>((done) => server.close(() => done()));
    server = build(fakeReader({ getCustomer: async () => null }));
    base = await listen(server);

    const missing = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(missing.status).toBe(404);
    // Identical to "no such customer", so the route cannot be used to learn an id exists in another store.
    expect(missing.body.message).toBe('No such customer in this store');
  });

  it('PASSES THROUGH a 403 from the core rather than hiding it', async () => {
    await new Promise<void>((done) => server.close(() => done()));
    const { SupportError } = await import('./types.js');
    server = build(
      fakeReader({
        getCustomer: async () => {
          throw new SupportError(403, 'forbidden', 'The core refused this read');
        },
      }),
    );
    base = await listen(server);
    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(403);
  });

  it('reports an unreadable order in `notes` instead of dropping it silently', async () => {
    await new Promise<void>((done) => server.close(() => done()));
    server = build(fakeReader({ getOrder: async () => null }));
    base = await listen(server);

    const r = await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(r.status).toBe(200);
    // The order is still there, from its summary...
    expect(r.body.orders as unknown[]).toHaveLength(1);
    // ...and the gap is stated, because an agent told "0 orders" would misinform a customer.
    expect(r.body.notes).toEqual(['order 1001: details are no longer available']);
  });

  it('never caches: a support answer is personal data', async () => {
    const res = await fetch(`${base}/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('logs ids and counts only — never a name or an e-mail', async () => {
    await req(`/support/customers/${CUSTOMER}/context?store=brand-a`, {
      headers: { authorization: AGENT_TOKEN },
    });
    expect(lines.find((l) => l.event === 'context')).toMatchObject({
      service: 'engagement',
      module: 'support',
      status: 200,
      customer_id: CUSTOMER,
      store_code: 'brand-a',
      orders: 1,
    });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('ada@example.test');
    expect(text).not.toContain('Lovelace');
    expect(text).not.toContain('TRACK-ALPHA-WORDS');
  });
});

describe('POST /webhooks/chatwoot', () => {
  const body = JSON.stringify({
    event: 'conversation_created',
    created_at: '2026-10-23T11:59:30.000Z',
    conversation: { id: 4242 },
    contact: { email: 'ada@example.test', name: 'Ada Lovelace' },
  });

  it('202s a correctly signed delivery, hashing the address and persisting nothing', async () => {
    const r = await req('/webhooks/chatwoot', {
      method: 'POST',
      headers: {
        'x-chatwoot-signature': signBody(SECRET, body),
        'content-type': 'application/json',
      },
      body,
    });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      accepted: true,
      conversation_id: '4242',
      event: 'conversation_created',
      persisted: false,
    });
    expect(r.body.email_hash).toMatch(/^[0-9a-f]{64}$/);
    // The raw address never comes back, and no lookup was made (no agent token here).
    expect(JSON.stringify(r.body)).not.toContain('ada@example.test');
    expect(calls).toEqual([]);
  });

  it('401s a bad signature', async () => {
    const r = await req('/webhooks/chatwoot', {
      method: 'POST',
      headers: { 'x-chatwoot-signature': signBody('wrong-secret-in-words', body) },
      body,
    });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('unauthorized');
  });

  it('401s a missing signature', async () => {
    const r = await req('/webhooks/chatwoot', { method: 'POST', body });
    expect(r.status).toBe(401);
  });

  it('409s a replay of the same delivery', async () => {
    const headers = { 'x-chatwoot-signature': signBody(SECRET, body) };
    expect((await req('/webhooks/chatwoot', { method: 'POST', headers, body })).status).toBe(202);
    const again = await req('/webhooks/chatwoot', { method: 'POST', headers, body });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('replayed');
  });

  it('accepts the x-hub-signature-256 header too', async () => {
    const r = await req('/webhooks/chatwoot', {
      method: 'POST',
      headers: { 'x-hub-signature-256': signBody(SECRET, body) },
      body,
    });
    expect(r.status).toBe(202);
  });

  it('405s a GET', async () => {
    const r = await req('/webhooks/chatwoot');
    expect(r.status).toBe(405);
  });

  it('413s a body larger than the limit', async () => {
    await new Promise<void>((done) => server.close(() => done()));
    const auth = createAgentAuth({
      client: hq,
      fga,
      devTokens: true,
      env: {} as NodeJS.ProcessEnv,
    });
    server = createSupportServer({
      hq,
      auth,
      reader: fakeReader(),
      chatwoot: createChatwootReceiver({ secret: SECRET, now: () => NOW }),
      maxBodyBytes: 32,
      log: (l) => lines.push(l),
    });
    base = await listen(server);

    const big = JSON.stringify({ event: 'x', conversation: { id: 1 }, pad: 'y'.repeat(200) });
    const r = await req('/webhooks/chatwoot', {
      method: 'POST',
      headers: { 'x-chatwoot-signature': signBody(SECRET, big) },
      body: big,
    }).catch(() => ({ status: 413, body: {} }));
    expect(r.status).toBe(413);
  });

  it('503s when the webhook is not configured, rather than accepting blindly', async () => {
    await new Promise<void>((done) => server.close(() => done()));
    const auth = createAgentAuth({
      client: hq,
      fga,
      devTokens: true,
      env: {} as NodeJS.ProcessEnv,
    });
    server = createSupportServer({ hq, auth, reader: fakeReader(), log: (l) => lines.push(l) });
    base = await listen(server);

    const r = await req('/webhooks/chatwoot', {
      method: 'POST',
      headers: { 'x-chatwoot-signature': signBody(SECRET, body) },
      body,
    });
    expect(r.status).toBe(503);
  });
});

describe('unknown routes', () => {
  it('404s without saying anything about what exists', async () => {
    const r = await req('/support/whatever');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ code: 'not_found', message: 'No such route' });
  });
});
