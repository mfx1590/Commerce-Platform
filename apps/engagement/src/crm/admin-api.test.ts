// The Admin API reader and the injected token provider.
//
// This is the one reader in the service that handles PII, so most of these tests are about what must NOT
// happen to it: no body in an error, no token in a body, a 404 answered rather than thrown.

import { describe, expect, it } from 'vitest';
import { createAdminApiReader, mockTokenProvider, type FetchLike } from './admin-api.js';
import { CrmError, type TokenProvider } from './types.js';

const STORE = '00000000-0000-4000-8000-000000000031';
const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const BASE = 'http://localhost:9000';
const TOKEN = 'mock-staff-token-words-only';

const customerBody = {
  customer: {
    id: CUSTOMER,
    identity_id: null,
    email: 'ada@example.test',
    first_name: 'Ada',
    last_name: 'Lovelace',
    phone: '+44 7700 900123',
    customer_group_id: null,
    status: 'registered',
    consent: { marketing_email: { granted: true } },
    created_at: '2026-10-01T10:00:00.000Z',
  },
};

function recorder(reply: { ok: boolean; status: number; body?: unknown; throws?: Error }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (reply.throws) throw reply.throws;
    return { ok: reply.ok, status: reply.status, json: async () => reply.body ?? {} };
  };
  return { calls, fetchImpl };
}

describe('mockTokenProvider', () => {
  it('names itself so nothing can mistake it for a real principal', async () => {
    const p = mockTokenProvider();
    expect(p.name).toBe('mock');
    expect(await p.token()).toBe(TOKEN);
  });

  it('takes a caller-supplied token', async () => {
    expect(await mockTokenProvider('another-token-in-words').token()).toBe(
      'another-token-in-words',
    );
  });
});

describe('createAdminApiReader', () => {
  it('requires a base URL', () => {
    expect(() => createAdminApiReader({ baseUrl: '', tokens: mockTokenProvider() })).toThrow(
      /base URL/,
    );
  });

  it('calls getCustomer on the store path with a bearer token', async () => {
    const r = recorder({ ok: true, status: 200, body: customerBody });
    const reader = createAdminApiReader({
      baseUrl: BASE,
      tokens: mockTokenProvider(),
      fetchImpl: r.fetchImpl,
    });
    const c = await reader.getCustomer(STORE, CUSTOMER);

    expect(r.calls[0]!.url).toBe(`${BASE}/admin/stores/${STORE}/customers/${CUSTOMER}`);
    expect(r.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Only the fields the CRM uses; `phone` is in the response and deliberately not carried over.
    expect(c).toEqual({
      id: CUSTOMER,
      email: 'ada@example.test',
      first_name: 'Ada',
      last_name: 'Lovelace',
      status: 'registered',
    });
    expect(JSON.stringify(c)).not.toContain('900123');
  });

  it('asks the provider for a token on every call, so a rotation needs no restart', async () => {
    let n = 0;
    const tokens: TokenProvider = { name: 'counting', token: async () => `token-number-${++n}` };
    const r = recorder({ ok: true, status: 200, body: customerBody });
    const reader = createAdminApiReader({ baseUrl: BASE, tokens, fetchImpl: r.fetchImpl });
    await reader.getCustomer(STORE, CUSTOMER);
    await reader.getCustomer(STORE, CUSTOMER);
    expect(r.calls.map((c) => c.headers.authorization)).toEqual([
      'Bearer token-number-1',
      'Bearer token-number-2',
    ]);
  });

  it('accepts a bare customer object as well as a wrapped one', async () => {
    const r = recorder({ ok: true, status: 200, body: customerBody.customer });
    const reader = createAdminApiReader({
      baseUrl: BASE,
      tokens: mockTokenProvider(),
      fetchImpl: r.fetchImpl,
    });
    expect((await reader.getCustomer(STORE, CUSTOMER))?.email).toBe('ada@example.test');
  });

  it('answers null for a 404: an erased or unknown customer is not a failure', async () => {
    const r = recorder({ ok: false, status: 404, body: { code: 'not_found' } });
    const reader = createAdminApiReader({
      baseUrl: BASE,
      tokens: mockTokenProvider(),
      fetchImpl: r.fetchImpl,
    });
    expect(await reader.getCustomer(STORE, CUSTOMER)).toBeNull();
  });

  it('treats 401 and 403 as RETRYABLE: an unseeded service principal is a deploy-order problem', async () => {
    for (const status of [401, 403]) {
      const r = recorder({ ok: false, status, body: { code: 'forbidden' } });
      const reader = createAdminApiReader({
        baseUrl: BASE,
        tokens: mockTokenProvider(),
        fetchImpl: r.fetchImpl,
      });
      const err = (await reader.getCustomer(STORE, CUSTOMER).catch((e: unknown) => e)) as CrmError;
      expect(err).toBeInstanceOf(CrmError);
      expect(err.message).toBe(`admin api: HTTP ${status}`);
      expect(err.retryable).toBe(true);
    }
  });

  it('marks 429 and 5xx retryable and a 400 not', async () => {
    for (const [status, retryable] of [
      [429, true],
      [503, true],
      [400, false],
    ] as [number, boolean][]) {
      const r = recorder({ ok: false, status, body: {} });
      const reader = createAdminApiReader({
        baseUrl: BASE,
        tokens: mockTokenProvider(),
        fetchImpl: r.fetchImpl,
      });
      const err = (await reader.getCustomer(STORE, CUSTOMER).catch((e: unknown) => e)) as CrmError;
      expect(err.retryable).toBe(retryable);
    }
  });

  it('never puts the response body in an error: it is full of personal data', async () => {
    const r = recorder({ ok: false, status: 500, body: customerBody });
    const reader = createAdminApiReader({
      baseUrl: BASE,
      tokens: mockTokenProvider(),
      fetchImpl: r.fetchImpl,
    });
    const err = (await reader.getCustomer(STORE, CUSTOMER).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('admin api: HTTP 500');
    expect(err.message).not.toContain('ada@example.test');
    expect(err.message).not.toContain('Lovelace');
  });

  it('refuses an unexpected shape without echoing it', async () => {
    const r = recorder({ ok: true, status: 200, body: { customer: { nope: 'ada@example.test' } } });
    const reader = createAdminApiReader({
      baseUrl: BASE,
      tokens: mockTokenProvider(),
      fetchImpl: r.fetchImpl,
    });
    const err = (await reader.getCustomer(STORE, CUSTOMER).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('admin api: unexpected customer shape');
    expect(err.message).not.toContain('ada@example.test');
  });

  it('a thrown fetch becomes a retryable error with the class only', async () => {
    const r = recorder({
      ok: false,
      status: 0,
      throws: new TypeError(`fetch failed for ${BASE} with ${TOKEN}`),
    });
    const reader = createAdminApiReader({
      baseUrl: BASE,
      tokens: mockTokenProvider(),
      fetchImpl: r.fetchImpl,
    });
    const err = (await reader.getCustomer(STORE, CUSTOMER).catch((e: unknown) => e)) as CrmError;
    expect(err.message).toBe('admin api: request failed TypeError');
    expect(err.message).not.toContain(TOKEN);
    expect(err.retryable).toBe(true);
  });

  it('an unreadable body is retryable rather than a half-built contact', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    });
    const reader = createAdminApiReader({ baseUrl: BASE, tokens: mockTokenProvider(), fetchImpl });
    const err = (await reader.getCustomer(STORE, CUSTOMER).catch((e: unknown) => e)) as CrmError;
    expect(err.message).toBe('admin api: unreadable response');
    expect(err.retryable).toBe(true);
  });
});
