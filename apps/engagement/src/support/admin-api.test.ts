// The support reader: the exact URLs it builds, and how it maps the core's answers.
//
// The URL assertions exist because the rest of the support suite drives a FAKE reader (it is testing the gates
// and the assembly, not the wire). So this file is the only place that pins the request shape to the
// contract — in particular the `customer_id` parameter from CONTRACT CHANGE #569. It proves the parameter is
// spelled and placed correctly; it cannot prove the core honours it, and that live check is on the
// Integration 4 list.

import { describe, expect, it } from 'vitest';
import { createSupportReader, type FetchLike } from './admin-api.js';
import { SupportError } from './types.js';

const STORE = '00000000-0000-4000-8000-000000000031';
const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const ORDER = '11111111-1111-4111-8111-111111111111';
const BASE = 'http://localhost:9000';
const AGENT = 'Bearer agent-token-in-words';

function recorder(reply: { ok: boolean; status: number; body?: unknown; throws?: Error }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (reply.throws) throw reply.throws;
    return { ok: reply.ok, status: reply.status, json: async () => reply.body ?? {} };
  };
  return { calls, fetchImpl };
}

const reader = (fetchImpl: FetchLike, maxOrders?: number) =>
  createSupportReader({ baseUrl: BASE, fetchImpl, ...(maxOrders ? { maxOrders } : {}) });

describe('the URLs it builds', () => {
  it('requires a base URL', () => {
    expect(() => createSupportReader({ baseUrl: '' })).toThrow(/base URL/);
  });

  it('getCustomer: the store customer path, with the AGENT s header', async () => {
    const r = recorder({
      ok: true,
      status: 200,
      body: {
        customer: {
          id: CUSTOMER,
          email: 'a@b.test',
          first_name: null,
          last_name: null,
          status: 'registered',
        },
      },
    });
    await reader(r.fetchImpl).getCustomer(STORE, CUSTOMER, AGENT);
    expect(r.calls[0]!.url).toBe(`${BASE}/admin/stores/${STORE}/customers/${CUSTOMER}`);
    expect(r.calls[0]!.headers.authorization).toBe(AGENT);
    expect(r.calls[0]!.headers.accept).toBe('application/json');
  });

  it('listOrders: filters by CUSTOMER_ID (#569), newest first, with a limit', async () => {
    const r = recorder({ ok: true, status: 200, body: { orders: [] } });
    await reader(r.fetchImpl).listOrders(STORE, CUSTOMER, AGENT);

    const url = new URL(r.calls[0]!.url);
    expect(url.pathname).toBe(`/admin/stores/${STORE}/orders`);
    // The parameter name is the contract's. If #569 ever renames it, this is the test that says so.
    expect(url.searchParams.get('customer_id')).toBe(CUSTOMER);
    expect(url.searchParams.get('sort')).toBe('placed_at');
    expect(url.searchParams.get('order')).toBe('desc');
    expect(url.searchParams.get('limit')).toBe('25');
    // And NOT the workaround that #569 exists to avoid: no e-mail in the query string, ever.
    expect(url.searchParams.get('q')).toBeNull();
    expect(r.calls[0]!.url).not.toContain('@');
  });

  it('listOrders: honours a configured order cap', async () => {
    const r = recorder({ ok: true, status: 200, body: { orders: [] } });
    await reader(r.fetchImpl, 5).listOrders(STORE, CUSTOMER, AGENT);
    expect(new URL(r.calls[0]!.url).searchParams.get('limit')).toBe('5');
  });

  it('listOrders: encodes the customer id rather than interpolating it raw', async () => {
    const r = recorder({ ok: true, status: 200, body: { orders: [] } });
    await reader(r.fetchImpl).listOrders(STORE, 'not a/uuid&limit=9999', AGENT);
    const url = new URL(r.calls[0]!.url);
    // The whole value is one parameter: an id cannot smuggle a second one in.
    expect(url.searchParams.get('customer_id')).toBe('not a/uuid&limit=9999');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('getOrder: the store order path', async () => {
    const r = recorder({ ok: true, status: 200, body: { order: { id: ORDER } } });
    await reader(r.fetchImpl).getOrder(STORE, ORDER, AGENT);
    expect(r.calls[0]!.url).toBe(`${BASE}/admin/stores/${STORE}/orders/${ORDER}`);
  });

  it('trims a trailing slash off the base URL', async () => {
    const r = recorder({ ok: true, status: 200, body: { order: { id: ORDER } } });
    await createSupportReader({ baseUrl: `${BASE}/`, fetchImpl: r.fetchImpl }).getOrder(
      STORE,
      ORDER,
      AGENT,
    );
    expect(r.calls[0]!.url).toBe(`${BASE}/admin/stores/${STORE}/orders/${ORDER}`);
  });
});

describe('how it maps the core s answers', () => {
  it('404 on the customer is null, not an error', async () => {
    const r = recorder({ ok: false, status: 404, body: { code: 'not_found' } });
    expect(await reader(r.fetchImpl).getCustomer(STORE, CUSTOMER, AGENT)).toBeNull();
  });

  it('404 on listOrders is an empty list', async () => {
    const r = recorder({ ok: false, status: 404 });
    expect(await reader(r.fetchImpl).listOrders(STORE, CUSTOMER, AGENT)).toEqual([]);
  });

  it('404 on getOrder is null', async () => {
    const r = recorder({ ok: false, status: 404 });
    expect(await reader(r.fetchImpl).getOrder(STORE, ORDER, AGENT)).toBeNull();
  });

  it('PASSES THROUGH a 401 or 403 unchanged: the core refused the AGENT', async () => {
    for (const status of [401, 403]) {
      const r = recorder({ ok: false, status, body: { code: 'forbidden' } });
      const err = (await reader(r.fetchImpl)
        .getCustomer(STORE, CUSTOMER, AGENT)
        .catch((e: unknown) => e)) as SupportError;
      expect(err).toBeInstanceOf(SupportError);
      expect(err.status).toBe(status);
      expect(err.code).toBe(status === 401 ? 'unauthorized' : 'forbidden');
    }
  });

  it('any other failure becomes a 502, with no body in the message', async () => {
    const r = recorder({
      ok: false,
      status: 500,
      body: { customer: { email: 'ada@example.test', last_name: 'Lovelace' } },
    });
    const err = (await reader(r.fetchImpl)
      .getCustomer(STORE, CUSTOMER, AGENT)
      .catch((e: unknown) => e)) as SupportError;
    expect(err.status).toBe(502);
    expect(err.message).toBe('The core answered 500 (customer)');
    expect(err.message).not.toContain('ada@example.test');
    expect(err.message).not.toContain('Lovelace');
  });

  it('a thrown fetch becomes a 502 that names neither the URL nor the token', async () => {
    const r = recorder({
      ok: false,
      status: 0,
      throws: new TypeError(`fetch failed for ${BASE} with ${AGENT}`),
    });
    const err = (await reader(r.fetchImpl)
      .getCustomer(STORE, CUSTOMER, AGENT)
      .catch((e: unknown) => e)) as SupportError;
    expect(err.status).toBe(502);
    expect(err.code).toBe('upstream_unavailable');
    expect(err.message).not.toContain('agent-token-in-words');
  });

  it('an unreadable body is a 502, not a half-built answer', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    });
    const err = (await reader(fetchImpl)
      .getCustomer(STORE, CUSTOMER, AGENT)
      .catch((e: unknown) => e)) as SupportError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unreadable/);
  });

  it('accepts a wrapped or a bare customer, and refuses a shape it cannot read', async () => {
    const wrapped = recorder({
      ok: true,
      status: 200,
      body: {
        customer: {
          id: CUSTOMER,
          email: 'a@b.test',
          first_name: null,
          last_name: null,
          status: 'guest',
        },
      },
    });
    expect((await reader(wrapped.fetchImpl).getCustomer(STORE, CUSTOMER, AGENT))?.status).toBe(
      'guest',
    );

    const bare = recorder({
      ok: true,
      status: 200,
      body: {
        id: CUSTOMER,
        email: 'a@b.test',
        first_name: null,
        last_name: null,
        status: 'registered',
      },
    });
    expect((await reader(bare.fetchImpl).getCustomer(STORE, CUSTOMER, AGENT))?.id).toBe(CUSTOMER);

    const nonsense = recorder({ ok: true, status: 200, body: { customer: { nope: true } } });
    await expect(reader(nonsense.fetchImpl).getCustomer(STORE, CUSTOMER, AGENT)).rejects.toThrow(
      /Unexpected customer shape/,
    );
  });

  it('a listOrders answer without an orders array is an empty list, not a crash', async () => {
    const r = recorder({ ok: true, status: 200, body: { page: 1 } });
    expect(await reader(r.fetchImpl).listOrders(STORE, CUSTOMER, AGENT)).toEqual([]);
  });

  it('a getOrder answer with no id is null rather than a half order', async () => {
    const r = recorder({ ok: true, status: 200, body: { order: { display_id: 1 } } });
    expect(await reader(r.fetchImpl).getOrder(STORE, ORDER, AGENT)).toBeNull();
  });
});
