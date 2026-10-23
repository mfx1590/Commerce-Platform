// The CRM adapters: the in-memory one, and Twenty against an injected fetch.
//
// The point of most of these is the upsert key: #555 says upsert by OUR customer id, never by e-mail.
// Test keys are WORDS (the gitleaks rule).

import { describe, expect, it } from 'vitest';
import { CrmError, type CrmContact } from '../types.js';
import { MemoryCrmAdapter } from './memory.js';
import { TwentyCrmAdapter, type FetchLike } from './twenty.js';

const CUSTOMER = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';
const API_KEY = 'twenty-api-key-words-only';
const BASE = 'https://crm.example/rest';

const contact = (over: Partial<CrmContact> = {}): CrmContact => ({
  externalId: CUSTOMER,
  storeCode: 'brand-a',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  ordersCount: 2,
  netRevenueMinor: 12599,
  currency: 'EUR',
  lastOrderAt: '2026-10-05T10:00:00.000Z',
  ...over,
});

function recorder(replies: { ok: boolean; status: number; body?: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
    [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body ? { body: init.body } : {}),
    });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return {
      ok: r.ok,
      status: r.status,
      text: async () => JSON.stringify(r.body ?? {}),
      json: async () => r.body ?? {},
    };
  };
  return { calls, fetchImpl };
}

const noPeople = { ok: true, status: 200, body: { data: { people: [] } } };
const onePerson = {
  ok: true,
  status: 200,
  body: { data: { people: [{ id: 'twenty-person-1' }] } },
};
const written = { ok: true, status: 200, body: {} };

describe('memory adapter', () => {
  it('upserts by external id: twice is one contact, and the second wins', async () => {
    const a = new MemoryCrmAdapter();
    expect(a.name).toBe('memory');
    await a.upsert(contact({ ordersCount: 1 }));
    await a.upsert(contact({ ordersCount: 2 }));

    expect(a.contacts.size).toBe(1);
    expect(a.get(CUSTOMER)?.ordersCount).toBe(2);
    // Both writes are visible, so a test can prove a redelivery wrote the SAME thing rather than nothing.
    expect(a.upserts).toHaveLength(2);
  });

  it('keeps two customers who share an e-mail as two contacts', async () => {
    const a = new MemoryCrmAdapter();
    await a.upsert(contact({ externalId: CUSTOMER, email: 'shared@example.test' }));
    await a.upsert(contact({ externalId: OTHER, email: 'shared@example.test' }));
    expect(a.contacts.size).toBe(2);
  });

  it('removes by external id, and removing twice is fine', async () => {
    const a = new MemoryCrmAdapter();
    await a.upsert(contact());
    await a.remove(CUSTOMER);
    await a.remove(CUSTOMER);
    expect(a.get(CUSTOMER)).toBeUndefined();
    expect(a.removed).toEqual([CUSTOMER, CUSTOMER]);
  });

  it('fails both calls when asked to, so retry paths are testable', async () => {
    const a = new MemoryCrmAdapter();
    a.failWith = new Error('boom');
    await expect(a.upsert(contact())).rejects.toThrow('boom');
    await expect(a.remove(CUSTOMER)).rejects.toThrow('boom');
    expect(a.contacts.size).toBe(0);
  });
});

describe('twenty adapter', () => {
  it('refuses to exist without a key or a base URL', () => {
    expect(() => new TwentyCrmAdapter({ baseUrl: BASE, apiKey: '' })).toThrow(/TWENTY_API_KEY/);
    expect(() => new TwentyCrmAdapter({ baseUrl: ' ', apiKey: API_KEY })).toThrow(/base URL/);
  });

  it('CREATES when no person carries our external id', async () => {
    const r = recorder([noPeople, written]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    await a.upsert(contact());

    // The lookup filters on the external-id field, never on the e-mail.
    expect(r.calls[0]!.method).toBe('GET');
    expect(decodeURIComponent(r.calls[0]!.url)).toContain(`externalId[eq]:${CUSTOMER}`);
    expect(decodeURIComponent(r.calls[0]!.url)).not.toContain('ada@example.test');
    // Then a POST.
    expect(r.calls[1]!.method).toBe('POST');
    expect(r.calls[1]!.url).toBe(`${BASE}/people`);
    const body = JSON.parse(r.calls[1]!.body!);
    expect(body).toMatchObject({
      externalId: CUSTOMER,
      emails: { primaryEmail: 'ada@example.test' },
      name: { firstName: 'Ada', lastName: 'Lovelace' },
      storeCode: 'brand-a',
      ordersCount: 2,
      netRevenueMinor: 12599,
      revenueCurrency: 'EUR',
      lastOrderAt: '2026-10-05T10:00:00.000Z',
    });
  });

  it('UPDATES the person already carrying our external id', async () => {
    const r = recorder([onePerson, written]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    await a.upsert(contact());
    expect(r.calls[1]!.method).toBe('PATCH');
    expect(r.calls[1]!.url).toBe(`${BASE}/people/twenty-person-1`);
  });

  it('honours a custom external-id field name', async () => {
    const r = recorder([noPeople, written]);
    const a = new TwentyCrmAdapter({
      baseUrl: BASE,
      apiKey: API_KEY,
      externalIdField: 'platformCustomerId',
      fetchImpl: r.fetchImpl,
    });
    await a.upsert(contact());
    expect(decodeURIComponent(r.calls[0]!.url)).toContain(`platformCustomerId[eq]:${CUSTOMER}`);
    expect(JSON.parse(r.calls[1]!.body!).platformCustomerId).toBe(CUSTOMER);
  });

  it('omits lastOrderAt for a customer who has never ordered', async () => {
    const r = recorder([noPeople, written]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    await a.upsert(contact({ lastOrderAt: null, ordersCount: 0, netRevenueMinor: 0 }));
    const body = JSON.parse(r.calls[1]!.body!);
    expect(body).not.toHaveProperty('lastOrderAt');
    expect(body.ordersCount).toBe(0);
  });

  it('sends empty strings rather than nulls for a missing name', async () => {
    const r = recorder([noPeople, written]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    await a.upsert(contact({ firstName: null, lastName: null }));
    expect(JSON.parse(r.calls[1]!.body!).name).toEqual({ firstName: '', lastName: '' });
  });

  it('DELETES the matching person on remove', async () => {
    const r = recorder([onePerson, written]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    await a.remove(CUSTOMER);
    expect(r.calls[1]!.method).toBe('DELETE');
    expect(r.calls[1]!.url).toBe(`${BASE}/people/twenty-person-1`);
  });

  it('remove is idempotent: a contact already gone is a no-op, not an error', async () => {
    const r = recorder([noPeople]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    await expect(a.remove(CUSTOMER)).resolves.toBeUndefined();
    // Only the lookup happened: no DELETE against a person that is not there.
    expect(r.calls).toHaveLength(1);
  });

  it('a DELETE that 404s after a successful lookup counts as ALREADY GONE, not a failure', async () => {
    // The race: the lookup found the person, something deleted it before our DELETE landed. The outcome we
    // wanted has happened, so an erasure must not fail (#568 review).
    const r = recorder([onePerson, { ok: false, status: 404, body: { message: 'not found' } }]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    await expect(a.remove(CUSTOMER)).resolves.toBeUndefined();
    expect(r.calls[1]!.method).toBe('DELETE');
  });

  it('a DELETE that fails for any other reason still throws', async () => {
    const r = recorder([onePerson, { ok: false, status: 500 }]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    const err = (await a.remove(CUSTOMER).catch((e: unknown) => e)) as CrmError;
    expect(err.message).toBe('twenty remove: HTTP 500');
    expect(err.retryable).toBe(true);
  });

  it('a PATCH that 404s is RETRYABLE, so the retry creates instead of updating', async () => {
    // Same race on the write path: the person vanished between the lookup and the PATCH. Retrying re-runs the
    // lookup, finds nothing and POSTs — so the contact still ends up correct.
    const r = recorder([onePerson, { ok: false, status: 404 }]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    const err = (await a.upsert(contact()).catch((e: unknown) => e)) as CrmError;
    expect(err).toBeInstanceOf(CrmError);
    expect(err.message).toBe('twenty upsert: HTTP 404');
    expect(err.retryable).toBe(true);
  });

  it('a POST that 404s is NOT treated as gone: it is a wrong base URL, not a race', async () => {
    const r = recorder([noPeople, { ok: false, status: 404 }]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    const err = (await a.upsert(contact()).catch((e: unknown) => e)) as CrmError;
    expect(err.message).toBe('twenty upsert: HTTP 404');
    expect(err.retryable).toBe(false);
  });

  it('sends the key as a bearer header and nowhere else', async () => {
    const r = recorder([noPeople, written]);
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
    await a.upsert(contact());
    expect(r.calls[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(r.calls[1]!.body).not.toContain(API_KEY);
    expect(r.calls[1]!.url).not.toContain(API_KEY);
    expect(JSON.stringify(a)).not.toContain(API_KEY);
  });

  it('trims a trailing slash off the base URL', async () => {
    const r = recorder([noPeople, written]);
    const a = new TwentyCrmAdapter({
      baseUrl: `${BASE}/`,
      apiKey: API_KEY,
      fetchImpl: r.fetchImpl,
    });
    await a.upsert(contact());
    expect(r.calls[1]!.url).toBe(`${BASE}/people`);
  });

  it('a refusal is a CrmError with the status only, and 429/5xx are retryable', async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [400, false],
      [401, false],
    ] as [number, boolean][]) {
      const r = recorder([
        { ok: false, status, body: { message: 'the key twenty-api-key-words-only is bad' } },
      ]);
      const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl: r.fetchImpl });
      const err = (await a.upsert(contact()).catch((e: unknown) => e)) as CrmError;
      expect(err).toBeInstanceOf(CrmError);
      expect(err.message).toBe(`twenty find: HTTP ${status}`);
      expect(err.retryable).toBe(retryable);
      // The body is never in the error: here it would have carried the key back.
      expect(err.message).not.toContain(API_KEY);
    }
  });

  it('a thrown fetch never leaks the URL or the key', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError(`fetch failed for ${BASE}?key=${API_KEY}`);
    };
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl });
    const err = (await a.upsert(contact()).catch((e: unknown) => e)) as CrmError;
    expect(err.message).toBe('twenty request: failed TypeError');
    expect(err.message).not.toContain(API_KEY);
    expect(err.retryable).toBe(true);
  });

  it('an unreadable lookup response is retryable, not a silent create', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(init.method);
      return {
        ok: true,
        status: 200,
        text: async () => 'not json',
        json: async () => {
          throw new Error('bad json');
        },
      };
    };
    const a = new TwentyCrmAdapter({ baseUrl: BASE, apiKey: API_KEY, fetchImpl });
    await expect(a.upsert(contact())).rejects.toThrow(/unreadable response/);
    // Crucially it did NOT fall through to a POST, which would duplicate the person.
    expect(calls).toEqual(['GET']);
  });
});
