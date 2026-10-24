// The support reader: the exact URLs it builds, and how it maps the core's answers.
//
// EVERY FIXTURE HERE IS TYPED FROM THE CONTRACT (`components['schemas']` of `@platform/contracts/admin`,
// generated from admin-api.yaml). That is the point of this file after the #573 review: the first version used
// hand-written fakes, which let the reader read `body.orders` where `listOrders` returns a `Page` of `items`,
// and treat `total` as a scalar where `OrderSummary.total` is `Money`. Against the real core every customer
// showed zero orders. With the fixtures typed, that drift is a COMPILE error here.
//
// The URL assertions pin the request shape — in particular `customer_id` from CONTRACT CHANGE #569. They prove
// the parameter is spelled and placed correctly; they cannot prove the core honours it, and that live check is
// on the Integration 4 list.

import type { components } from '@platform/contracts/admin';
import { describe, expect, it } from 'vitest';
import { createSupportReader, type FetchLike } from './admin-api.js';
import { SupportError } from './types.js';

type Schemas = components['schemas'];

const STORE = '00000000-0000-4000-8000-000000000031';
const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const ORDER = '11111111-1111-4111-8111-111111111111';
const BASE = 'http://localhost:9000';
const AGENT = 'Bearer agent-token-in-words';

// --- bodies the contract itself describes -------------------------------------------------------------------

const customer: Schemas['Customer'] = {
  id: CUSTOMER,
  identity_id: null,
  email: 'ada@example.test',
  first_name: 'Ada',
  last_name: 'Lovelace',
  phone: null,
  customer_group_id: null,
  status: 'registered',
  consent: {},
  created_at: '2026-10-01T10:00:00.000Z',
};

const orderSummary: Schemas['OrderSummary'] = {
  id: ORDER,
  display_id: 1001,
  email: 'ada@example.test',
  customer_id: CUSTOMER,
  status: 'completed',
  payment_status: 'captured',
  fulfillment_status: 'fulfilled',
  // Money, not a scalar — and the ONLY place a summary carries a currency.
  total: { amount_minor: 10994, currency: 'EUR' },
  placed_at: '2026-10-05T10:00:00.000Z',
};

/** `listOrders` answers the shared `Page` wrapper plus `items`. `Page.total` is a COUNT, not money. */
const ordersPage: Schemas['Page'] & { items: Schemas['OrderSummary'][] } = {
  page: 1,
  limit: 25,
  total: 1,
  items: [orderSummary],
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

const reader = (fetchImpl: FetchLike, maxOrders?: number) =>
  createSupportReader({ baseUrl: BASE, fetchImpl, ...(maxOrders ? { maxOrders } : {}) });

describe('the URLs it builds', () => {
  it('requires a base URL', () => {
    expect(() => createSupportReader({ baseUrl: '' })).toThrow(/base URL/);
  });

  it('getCustomer: the store customer path, with the AGENT s header', async () => {
    const r = recorder({ ok: true, status: 200, body: customer });
    await reader(r.fetchImpl).getCustomer(STORE, CUSTOMER, AGENT);
    expect(r.calls[0]!.url).toBe(`${BASE}/admin/stores/${STORE}/customers/${CUSTOMER}`);
    expect(r.calls[0]!.headers.authorization).toBe(AGENT);
    expect(r.calls[0]!.headers.accept).toBe('application/json');
  });

  it('listOrders: filters by CUSTOMER_ID (#569), newest first, with a limit', async () => {
    const r = recorder({ ok: true, status: 200, body: ordersPage });
    await reader(r.fetchImpl).listOrders(STORE, CUSTOMER, AGENT);

    const url = new URL(r.calls[0]!.url);
    expect(url.pathname).toBe(`/admin/stores/${STORE}/orders`);
    // The parameter name is the contract's. If #569 ever renames it, this is the test that says so.
    expect(url.searchParams.get('customer_id')).toBe(CUSTOMER);
    expect(url.searchParams.get('sort')).toBe('placed_at');
    expect(url.searchParams.get('order')).toBe('desc');
    expect(url.searchParams.get('limit')).toBe('25');
    // And NOT the workaround that #569 exists to avoid: no e-mail and no `q` in the query string, ever.
    expect(url.searchParams.get('q')).toBeNull();
    expect(r.calls[0]!.url).not.toContain('@');
  });

  it('listOrders: honours a configured order cap', async () => {
    const r = recorder({ ok: true, status: 200, body: ordersPage });
    await reader(r.fetchImpl, 5).listOrders(STORE, CUSTOMER, AGENT);
    expect(new URL(r.calls[0]!.url).searchParams.get('limit')).toBe('5');
  });

  it('listOrders: encodes the customer id rather than interpolating it raw', async () => {
    const r = recorder({ ok: true, status: 200, body: ordersPage });
    await reader(r.fetchImpl).listOrders(STORE, 'not a/uuid&limit=9999', AGENT);
    const url = new URL(r.calls[0]!.url);
    // The whole value is one parameter: an id cannot smuggle a second one in.
    expect(url.searchParams.get('customer_id')).toBe('not a/uuid&limit=9999');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('ENCODES EVERY PATH SEGMENT: %2F..%2F cannot climb out of the resource', async () => {
    // The route rejects a non-uuid before reaching here, but a reader must be safe on its own terms: an
    // unencoded `/../` in a path segment would hit another Admin API route with the agent's own token.
    const evil = '../../stores/other/customers';
    const r = recorder({ ok: true, status: 200, body: customer });
    await reader(r.fetchImpl).getCustomer(STORE, evil, AGENT);

    const url = r.calls[0]!.url;
    expect(url).toBe(`${BASE}/admin/stores/${STORE}/customers/${encodeURIComponent(evil)}`);
    // The decoded path must still be the customers path of THIS store: no traversal, no second resource.
    expect(new URL(url).pathname).toBe(
      `/admin/stores/${STORE}/customers/${encodeURIComponent(evil)}`,
    );
    expect(url).not.toContain('/../');
    expect(url).not.toContain('%2F..%2F'.toLowerCase());

    // Same on the order path, and with an already-encoded traversal.
    const r2 = recorder({ ok: true, status: 200, body: { ...orderSummary } });
    await reader(r2.fetchImpl).getOrder(STORE, '%2F..%2Fadmin', AGENT);
    expect(new URL(r2.calls[0]!.url).pathname).toBe(
      `/admin/stores/${STORE}/orders/${encodeURIComponent('%2F..%2Fadmin')}`,
    );
  });

  it('getOrder: the store order path', async () => {
    const r = recorder({ ok: true, status: 200, body: orderSummary });
    await reader(r.fetchImpl).getOrder(STORE, ORDER, AGENT);
    expect(r.calls[0]!.url).toBe(`${BASE}/admin/stores/${STORE}/orders/${ORDER}`);
  });

  it('trims a trailing slash off the base URL', async () => {
    const r = recorder({ ok: true, status: 200, body: orderSummary });
    await createSupportReader({ baseUrl: `${BASE}/`, fetchImpl: r.fetchImpl }).getOrder(
      STORE,
      ORDER,
      AGENT,
    );
    expect(r.calls[0]!.url).toBe(`${BASE}/admin/stores/${STORE}/orders/${ORDER}`);
  });
});

describe('the response shapes the contract defines', () => {
  it('getCustomer reads the Customer body DIRECTLY (no envelope)', async () => {
    const r = recorder({ ok: true, status: 200, body: customer });
    const c = await reader(r.fetchImpl).getCustomer(STORE, CUSTOMER, AGENT);
    expect(c?.id).toBe(CUSTOMER);
    expect(c?.email).toBe('ada@example.test');
    expect(c?.status).toBe('registered');
  });

  it('listOrders reads `items` from the Page wrapper, NOT `orders`', async () => {
    const r = recorder({ ok: true, status: 200, body: ordersPage });
    const orders = await reader(r.fetchImpl).listOrders(STORE, CUSTOMER, AGENT);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.id).toBe(ORDER);
    // The regression that shipped in the first version: a body keyed `orders` yields nothing, correctly.
    const wrong = recorder({ ok: true, status: 200, body: { orders: [orderSummary] } });
    expect(await reader(wrong.fetchImpl).listOrders(STORE, CUSTOMER, AGENT)).toEqual([]);
  });

  it('OrderSummary.total is Money, and carries the currency', async () => {
    const r = recorder({ ok: true, status: 200, body: ordersPage });
    const [order] = await reader(r.fetchImpl).listOrders(STORE, CUSTOMER, AGENT);
    expect(order!.total).toEqual({ amount_minor: 10994, currency: 'EUR' });
  });

  it('getOrder reads the Order body DIRECTLY (no envelope)', async () => {
    const r = recorder({ ok: true, status: 200, body: orderSummary });
    const o = await reader(r.fetchImpl).getOrder(STORE, ORDER, AGENT);
    expect(o?.id).toBe(ORDER);
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
    const r = recorder({ ok: false, status: 500, body: customer });
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

  it('refuses a customer shape it cannot read, without echoing it', async () => {
    const r = recorder({ ok: true, status: 200, body: { nope: 'ada@example.test' } });
    const err = (await reader(r.fetchImpl)
      .getCustomer(STORE, CUSTOMER, AGENT)
      .catch((e: unknown) => e)) as SupportError;
    expect(err.message).toBe('Unexpected customer shape');
    expect(err.message).not.toContain('ada@example.test');
  });

  it('a listOrders answer without items is an empty list, not a crash', async () => {
    const r = recorder({ ok: true, status: 200, body: { page: 1, limit: 25, total: 0 } });
    expect(await reader(r.fetchImpl).listOrders(STORE, CUSTOMER, AGENT)).toEqual([]);
  });

  it('a getOrder answer with no id is null rather than a half order', async () => {
    const r = recorder({ ok: true, status: 200, body: { display_id: 1 } });
    expect(await reader(r.fetchImpl).getOrder(STORE, ORDER, AGENT)).toBeNull();
  });
});
